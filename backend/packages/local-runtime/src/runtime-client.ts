/**
 * Runtime Client
 *
 * Manages the WebSocket connection to the CAST backend.
 * Handles the LocalRuntime protocol: authentication, message routing,
 * and agent lifecycle coordination.
 */

import WebSocket from 'ws';
import { join } from 'node:path';
import { FrameOutbox } from './frame-outbox.js';
import { AgentManager } from './agent-manager.js';
import { getMachineInfo } from './config.js';
import type {
  RuntimeConfig,
  BackendToRuntimeMessage,
  RuntimeToBackendMessage,
  RuntimeReadyMessage,
  AgentCheckinMessage,
  AgentHeartbeatMessage,
  AgentFrameMessage,
  PongMessage,
  ActivateAgentMessage,
  DeliverMessageMessage,
  SuspendAgentMessage,
} from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface RuntimeClientConfig {
  config: RuntimeConfig;
  /** Idle timeout in minutes - exit after this many minutes of inactivity */
  idleTimeoutMinutes?: number;
  onConnected?: () => void;
  onDisconnected?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
  /** Called when idle timeout is reached (before exit) */
  onIdleTimeout?: () => void;
}

export type RuntimeStatus = 'disconnected' | 'connecting' | 'connected' | 'ready';

// =============================================================================
// Runtime Client
// =============================================================================

export class RuntimeClient {
  private readonly runtimeConfig: RuntimeConfig;
  private readonly frameOutbox?: FrameOutbox;
  private readonly agentManager: AgentManager;

  private ws: WebSocket | null = null;
  private status: RuntimeStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** Heartbeat interval in milliseconds (30 seconds) */
  private static readonly HEARTBEAT_INTERVAL_MS = 30000;
  /** Idle check interval in milliseconds (60 seconds) */
  private static readonly IDLE_CHECK_INTERVAL_MS = 60000;

  /** Timestamp of last "proper" message (not heartbeat/ping) */
  private lastActivityTime: number = Date.now();
  /** Idle timeout in milliseconds (0 = disabled) */
  private readonly idleTimeoutMs: number;

  private readonly onConnected?: () => void;
  private readonly onDisconnected?: (code: number, reason: string) => void;
  private readonly onError?: (error: Error) => void;
  private readonly onIdleTimeout?: () => void;

  constructor(config: RuntimeClientConfig) {
    this.runtimeConfig = config.config;
    if (process.env.MIRIAD_RELIABLE_FRAMES === '1') this.frameOutbox = new FrameOutbox(join(config.config.workspace.basePath,'.miriad-frame-outbox'));
    this.onConnected = config.onConnected;
    this.onDisconnected = config.onDisconnected;
    this.onError = config.onError;
    this.onIdleTimeout = config.onIdleTimeout;
    this.idleTimeoutMs = (config.idleTimeoutMinutes ?? 0) * 60 * 1000;

    // Create agent manager
    this.agentManager = new AgentManager({
      workspaceBasePath: this.runtimeConfig.workspace.basePath,
      onFrame: (message) => this.sendFrame(message),
      onCheckin: (agentId) => this.sendCheckin(agentId),
      onError: (agentId, error) => {
        console.error(`[RuntimeClient] Agent ${agentId} error:`, error);
      },
    });
  }

  /**
   * Get current runtime status.
   */
  getStatus(): RuntimeStatus {
    return this.status;
  }

  /**
   * Get agent manager for status queries.
   */
  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  /**
   * Connect to the backend.
   */
  async connect(): Promise<void> {
    if (this.ws) {
      console.log('[RuntimeClient] Already connected');
      return;
    }

    this.status = 'connecting';
    const { credentials } = this.runtimeConfig;
    // Use query param for protocol - works with both local dev and AWS Lambda
    // (API Gateway doesn't have /runtimes/connect route, uses $connect with query param)
    const url = `${credentials.wsUrl}?protocol=runtime`;

    console.log(`[RuntimeClient] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Server ${credentials.secret}`,
        },
      });

      this.ws.on('open', () => {
        console.log('[RuntimeClient] Connected');
        this.status = 'connected';
        this.reconnectAttempts = 0;
        this.sendRuntimeReady();
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[RuntimeClient] Disconnected: ${code} ${reason.toString()}`);
        this.status = 'disconnected';
        this.ws = null;
        this.stopHeartbeatInterval();
        this.onDisconnected?.(code, reason.toString());
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        // Log connection errors cleanly without full stack traces
        const errorMsg = this.formatConnectionError(error);
        if (errorMsg) {
          console.error(`[RuntimeClient] ${errorMsg}`);
        } else {
          console.error('[RuntimeClient] WebSocket error:', error);
        }
        this.onError?.(error);
        if (this.status === 'connecting') {
          reject(error);
        }
      });
    });
  }

  /**
   * Disconnect from the backend.
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Stop heartbeat interval
    this.stopHeartbeatInterval();

    // Stop idle check interval
    this.stopIdleCheck();

    // Suspend all agents
    await this.agentManager.suspendAll();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.status = 'disconnected';
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private handleMessage(data: string): void {
    let message: BackendToRuntimeMessage;
    try {
      message = JSON.parse(data);
    } catch {
      console.error('[RuntimeClient] Invalid JSON:', data);
      return;
    }

    if ((message as {type:string}).type === 'frame_ack') {
      const id = (message as unknown as {operationId?:unknown}).operationId;
      if (typeof id === 'string') this.frameOutbox?.ack(id);
      return;
    }
    switch (message.type) {
      case 'runtime_connected':
        console.log(`[RuntimeClient] Runtime connected: ${message.runtimeId} (protocol ${message.protocolVersion})`);
        this.status = 'ready';
        this.onConnected?.();
        // Re-checkin all active agents on reconnect
        // This ensures backend knows about agents that survived the disconnect
        this.reCheckinActiveAgents();
        // Start heartbeat interval for agent liveness
        this.startHeartbeatInterval();
        this.resendFrames();
        // Start idle timeout check if configured
        this.startIdleCheck();
        break;

      case 'activate':
        this.markActivity(); // Real work - reset idle timer
        this.handleActivate(message);
        break;

      case 'message':
        this.markActivity(); // Real work - reset idle timer
        this.handleDeliverMessage(message);
        break;

      case 'suspend':
        this.markActivity(); // Real work - reset idle timer
        this.handleSuspend(message);
        break;

      case 'ping':
        // Don't mark activity for ping/pong - these are keepalive, not work
        this.sendPong(message.timestamp);
        break;

      case 'error':
        console.error(`[RuntimeClient] Backend error: ${message.code} - ${message.message}`);
        break;

      default:
        console.log(`[RuntimeClient] Unknown message type: ${(message as { type: string }).type}`);
    }
  }

  private async handleActivate(message: ActivateAgentMessage): Promise<void> {
    console.log(`[RuntimeClient] Activate agent: ${message.agentId}`);
    await this.agentManager.activate(message);
  }

  private async handleDeliverMessage(message: DeliverMessageMessage): Promise<void> {
    console.log(`[RuntimeClient] Message for agent: ${message.agentId}`);
    console.log(`[RuntimeClient]   props: ${JSON.stringify(message.props)}`);
    await this.agentManager.deliverMessage(message);
  }

  private async handleSuspend(message: SuspendAgentMessage): Promise<void> {
    console.log(`[RuntimeClient] Suspend agent: ${message.agentId}`);
    await this.agentManager.suspend(message);
  }

  // ===========================================================================
  // Outgoing Messages
  // ===========================================================================

  private send(message: RuntimeToBackendMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.error('[RuntimeClient] Cannot send: WebSocket not open');
    }
  }

  private sendRuntimeReady(): void {
    const { credentials, spaceId, name } = this.runtimeConfig;
    const machineInfo = getMachineInfo();

    const message: RuntimeReadyMessage = {
      type: 'runtime_ready',
      runtimeId: credentials.runtimeId,
      spaceId,
      name,
      machineInfo,
    };

    console.log(`[RuntimeClient] Sending runtime_ready: ${name} (${credentials.runtimeId})`);
    this.send(message);
  }

  private sendCheckin(agentId: string): void {
    const message: AgentCheckinMessage = {
      type: 'agent_checkin',
      agentId,
    };
    console.log(`[RuntimeClient] Agent checkin: ${agentId}`);
    this.send(message);
  }

  private sendFrame(frameMessage: AgentFrameMessage): void {
    if (this.frameOutbox && 'i' in frameMessage.frame && 'v' in frameMessage.frame) {
      this.frameOutbox.put(`${this.runtimeConfig.credentials.runtimeId}:${frameMessage.frame.i}`,frameMessage);
    }
    this.send(frameMessage);
  }

  private sendPong(timestamp: string): void {
    const message: PongMessage = {
      type: 'pong',
      timestamp,
    };
    this.send(message);
  }

  /**
   * Re-checkin all active agents after reconnection.
   * This notifies the backend about agents that survived the disconnect.
   */
  private reCheckinActiveAgents(): void {
    const agents = this.agentManager.getAgents();
    const activeAgents = agents.filter((a) => a.status !== 'offline');

    if (activeAgents.length === 0) {
      console.log('[RuntimeClient] No active agents to re-checkin');
      return;
    }

    console.log(`[RuntimeClient] Re-checking in ${activeAgents.length} active agent(s)`);
    for (const agent of activeAgents) {
      this.sendCheckin(agent.agentId);
    }
  }

  // ===========================================================================
  // Heartbeat
  // ===========================================================================

  /**
   * Start periodic heartbeat for all online agents.
   */
  private resendFrames(): void {
    if (this.status !== 'ready' || this.ws?.readyState !== WebSocket.OPEN) return;
    for (const record of this.frameOutbox?.pending() ?? []) this.ws.send(JSON.stringify(record.frame));
  }
  private startHeartbeatInterval(): void {
    if (this.heartbeatInterval) {
      return; // Already running
    }

    console.log(`[RuntimeClient] Starting heartbeat interval (${RuntimeClient.HEARTBEAT_INTERVAL_MS / 1000}s)`);
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeats();
      this.resendFrames();
    }, RuntimeClient.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop the heartbeat interval.
   */
  private stopHeartbeatInterval(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('[RuntimeClient] Stopped heartbeat interval');
    }
  }

  /**
   * Send heartbeats for all online agents.
   */
  private sendHeartbeats(): void {
    const agents = this.agentManager.getAgents();
    const onlineAgents = agents.filter((a) => a.status === 'online' || a.status === 'busy');

    if (onlineAgents.length === 0) {
      return; // No agents to heartbeat
    }

    for (const agent of onlineAgents) {
      const message: AgentHeartbeatMessage = {
        type: 'agent_heartbeat',
        agentId: agent.agentId,
      };
      this.send(message);
    }
  }

  // ===========================================================================
  // Idle Timeout
  // ===========================================================================

  /**
   * Mark that real activity occurred (not heartbeat/ping).
   * Resets the idle timeout timer.
   */
  private markActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Start the idle timeout check if configured.
   */
  private startIdleCheck(): void {
    if (this.idleTimeoutMs <= 0) {
      return; // Idle timeout disabled
    }

    if (this.idleCheckInterval) {
      return; // Already running
    }

    console.log(`[RuntimeClient] Starting idle check (timeout: ${this.idleTimeoutMs / 60000} minutes)`);
    this.idleCheckInterval = setInterval(() => {
      this.checkIdleTimeout();
    }, RuntimeClient.IDLE_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the idle timeout check.
   */
  private stopIdleCheck(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  /**
   * Check if idle timeout has been reached.
   */
  private checkIdleTimeout(): void {
    const idleTime = Date.now() - this.lastActivityTime;

    if (idleTime >= this.idleTimeoutMs) {
      // Check that no agents are busy (in the middle of processing)
      const agents = this.agentManager.getAgents();
      const busyAgents = agents.filter((a) => a.status === 'busy');

      if (busyAgents.length > 0) {
        console.log(`[RuntimeClient] Idle timeout reached but ${busyAgents.length} agent(s) busy - waiting`);
        return;
      }

      console.log(`[RuntimeClient] Idle timeout reached (${Math.round(idleTime / 60000)} minutes)`);
      this.stopIdleCheck();
      this.onIdleTimeout?.();
    }
  }

  // ===========================================================================
  // Error Formatting
  // ===========================================================================

  /**
   * Format common connection errors into clean single-line messages.
   * Returns null for unexpected errors that should show full stack trace.
   */
  private formatConnectionError(error: Error): string | null {
    const message = error.message || '';
    const code = (error as NodeJS.ErrnoException).code;

    // Handle AggregateError (multiple connection attempts failed)
    if (error.name === 'AggregateError' && 'errors' in error) {
      const aggError = error as AggregateError;
      if (aggError.errors.length > 0) {
        const firstError = aggError.errors[0] as NodeJS.ErrnoException;
        if (firstError.code === 'ECONNREFUSED') {
          return 'Connection refused - server unavailable';
        }
        if (firstError.code === 'ETIMEDOUT') {
          return 'Connection timed out';
        }
      }
    }

    // Handle direct error codes
    if (code === 'ECONNREFUSED') {
      return 'Connection refused - server unavailable';
    }
    if (code === 'ETIMEDOUT') {
      return 'Connection timed out';
    }
    if (code === 'ENOTFOUND') {
      return 'Server not found - check URL';
    }
    if (code === 'ECONNRESET') {
      return 'Connection reset by server';
    }

    // Check message patterns
    if (message.includes('ECONNREFUSED')) {
      return 'Connection refused - server unavailable';
    }
    if (message.includes('ETIMEDOUT')) {
      return 'Connection timed out';
    }

    return null;
  }

  // ===========================================================================
  // Reconnection
  // ===========================================================================

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[RuntimeClient] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.connect();
      } catch {
        // Error already logged by WebSocket error handler
        // Will be scheduled again by close handler
      }
    }, delay);
  }
}

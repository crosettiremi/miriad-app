/**
 * Runtime Protocol Handlers
 *
 * Pure, stateless handlers for the LocalRuntime WebSocket protocol.
 * These work in both AWS Lambda and local dev - no in-memory state,
 * no WebSocket objects, just business logic with injected dependencies.
 *
 * Protocol: See [[local-provider-spec]] section 2.2
 */

import {
  isSetFrame,
  tymbal,
  generateMessageId,
  type TymbalFrame,
  type SetFrame,
  type LocalRuntimeConfig,
  type ConnectionProtocol,
} from '@cast/core';
import type { Storage } from '@cast/storage';
import { parseAgentId } from '@cast/runtime';

// =============================================================================
// Protocol Message Types (from spec section 2.2)
// =============================================================================

/** Protocol version */
export const PROTOCOL_VERSION = '1.0';

// Backend → Runtime (Commands)

export interface RuntimeConnectedMessage {
  type: 'runtime_connected';
  runtimeId: string;
  protocolVersion: string;
}

export interface ActivateAgentMessage {
  type: 'activate';
  agentId: string;
  systemPrompt: string;
  mcpServers?: McpServerConfig[];
  workspacePath: string;
}

export interface DeliverMessageMessage {
  type: 'message';
  agentId: string;
  messageId: string;
  content: string;
  sender: string;
  systemPrompt?: string;
  mcpServers?: McpServerConfig[];
  /** Resolved environment variables and secrets for this request */
  environment?: Record<string, string>;
  /** Agent definition props (engine, nameTheme, etc.) */
  props?: {
    engine?: string;
    nameTheme?: string;
    mcp?: Array<{ slug: string }>;
    [key: string]: unknown;
  };
}

export interface SuspendAgentMessage {
  type: 'suspend';
  agentId: string;
  reason?: string;
}

export interface PingMessage {
  type: 'ping';
  timestamp: string;
}

export type BackendToRuntimeMessage =
  | RuntimeConnectedMessage
  | ActivateAgentMessage
  | DeliverMessageMessage
  | SuspendAgentMessage
  | PingMessage;

// Runtime → Backend (Responses & Events)

export interface RuntimeReadyMessage {
  type: 'runtime_ready';
  runtimeId: string;
  spaceId: string;
  name: string;
  machineInfo?: {
    os: string;
    hostname: string;
  };
}

export interface AgentCheckinMessage {
  type: 'agent_checkin';
  agentId: string;
}

export interface AgentHeartbeatMessage {
  type: 'agent_heartbeat';
  agentId: string;
}

export interface AgentFrameMessage {
  type: 'frame';
  agentId: string;
  frame: TymbalFrame;
}

export interface PongMessage {
  type: 'pong';
  timestamp: string;
}

export type RuntimeToBackendMessage =
  | RuntimeReadyMessage
  | AgentCheckinMessage
  | AgentHeartbeatMessage
  | AgentFrameMessage
  | PongMessage;

// MCP Server Config (matches @cast/runtime)
export interface McpServerConfig {
  name: string;
  slug?: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

// =============================================================================
// Handler Types
// =============================================================================

/**
 * Connection state from the database.
 * This replaces the in-memory RuntimeConnection for Lambda compatibility.
 */
export interface RuntimeConnectionState {
  connectionId: string;
  channelId: string;
  protocol: ConnectionProtocol;
  runtimeId: string | null;
  spaceId: string | null;
  /** Server ID for auth (optional, null in dev mode) */
  serverId?: string;
}

/**
 * Dependencies injected into handlers.
 * This allows the same handlers to work in Lambda and local dev.
 */
export interface RuntimeProtocolDeps {
  /** Propagate persistence failures so an enclosing transaction can roll back. */
  strictPersistence?: boolean;
  /** Storage interface for DB operations */
  storage: Storage;

  /** Broadcast a message to all connections in a channel */
  broadcast: (channelId: string, data: string) => Promise<void>;

  /** Send a message to a specific connection, returns false if stale */
  send: (connectionId: string, data: string) => Promise<boolean>;

  /** Send an error message to a connection */
  sendError: (connectionId: string, code: string, message: string) => Promise<void>;
}

/**
 * Result from handleRuntimeReady
 */
export interface RuntimeReadyResult {
  success: boolean;
  runtimeId?: string;
  error?: { code: string; message: string };
}

/**
 * Runtime protocol handlers interface
 */
export interface RuntimeProtocolHandlers {
  /**
   * Handle runtime_ready message - registers the runtime and updates DB.
   * Returns the runtimeId on success.
   */
  handleRuntimeReady(
    state: RuntimeConnectionState,
    message: RuntimeReadyMessage
  ): Promise<RuntimeReadyResult>;

  /**
   * Handle agent_checkin message - updates roster lastHeartbeat and broadcasts online state.
   */
  handleAgentCheckin(
    state: RuntimeConnectionState,
    message: AgentCheckinMessage
  ): Promise<void>;

  /**
   * Handle agent_heartbeat message - updates roster lastHeartbeat and broadcasts online state.
   */
  handleAgentHeartbeat(
    state: RuntimeConnectionState,
    message: AgentHeartbeatMessage
  ): Promise<void>;

  /**
   * Handle frame message - broadcasts to channel and persists SetFrames.
   */
  handleFrame(
    state: RuntimeConnectionState,
    message: AgentFrameMessage
  ): Promise<void>;

  /**
   * Handle disconnect - marks runtime offline and broadcasts status for bound agents.
   */
  handleDisconnect(runtimeId: string): Promise<void>;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create runtime protocol handlers with injected dependencies.
 *
 * @param deps - Dependencies (storage, broadcast, send functions)
 * @returns Handlers object
 */
export function createRuntimeProtocolHandlers(
  deps: RuntimeProtocolDeps
): RuntimeProtocolHandlers {
  const { storage, broadcast, send, sendError } = deps;

  // ---------------------------------------------------------------------------
  // Helper: Broadcast agent state frame
  // ---------------------------------------------------------------------------

  async function broadcastAgentState(
    channelId: string,
    callsign: string,
    state: 'online' | 'offline',
    timestamp: string
  ): Promise<void> {
    const frame = tymbal.set(generateMessageId(), {
      type: 'agent_state',
      sender: callsign,
      senderType: 'agent',
      state,
      lastHeartbeat: timestamp,
    });
    await broadcast(channelId, frame);
  }

  // ---------------------------------------------------------------------------
  // Helper: Check if frame is idle
  // ---------------------------------------------------------------------------

  function isIdleFrame(frame: TymbalFrame): boolean {
    if (!isSetFrame(frame)) return false;
    const value = frame.v as Record<string, unknown> | undefined;
    return value?.type === 'idle';
  }

  // ---------------------------------------------------------------------------
  // Helper: Persist SetFrame to messages table
  // ---------------------------------------------------------------------------

  async function persistSetFrame(
    runtimeId: string,
    channelId: string,
    callsign: string,
    frame: SetFrame
  ): Promise<void> {
    try {
      const channel = await storage.getChannelById(channelId);
      if (!channel || !frame.v || typeof frame.v !== 'object') return;

      const value = frame.v as Record<string, unknown>;
      const messageType = (value.type as string) ?? 'agent';

      // Handle cost frames - persist to costs table
      if (messageType === 'cost') {
        await storage.saveCostRecord({
          spaceId: channel.spaceId,
          channelId,
          callsign: (value.sender as string) ?? callsign,
          costUsd: value.totalCostUsd as number,
          durationMs: value.durationMs as number,
          numTurns: value.numTurns as number,
          usage: value.usage as {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            cacheCreationInputTokens: number;
          },
          modelUsage: value.modelUsage as
            | Record<
                string,
                {
                  inputTokens: number;
                  outputTokens: number;
                  cacheReadInputTokens: number;
                  cacheCreationInputTokens: number;
                  costUsd: number;
                }
              >
            | undefined,
        });
        return;
      }

      // For tool_call and tool_result, store full value object (storage layer handles serialization)
      let messageContent: string | Record<string, unknown>;
      if (messageType === 'tool_call' || messageType === 'tool_result') {
        messageContent = value as Record<string, unknown>;
      } else {
        messageContent = (value.content as string | Record<string, unknown>) ?? value;
      }

      await storage.saveMessage({
        id: frame.i,
        spaceId: channel.spaceId,
        channelId,
        sender: (value.sender as string) ?? callsign,
        senderType: 'agent',
        type: messageType as
          | 'user'
          | 'agent'
          | 'tool_call'
          | 'tool_result'
          | 'thinking'
          | 'status'
          | 'error'
          | 'idle',
        content: messageContent,
        isComplete: true,
        metadata: { fromLocalRuntime: true, runtimeId },
      });
    } catch (error) {
      console.error('[RuntimeProtocolHandlers] Error persisting frame:', error);
      if (deps.strictPersistence) throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  return {
    async handleRuntimeReady(
      state: RuntimeConnectionState,
      message: RuntimeReadyMessage
    ): Promise<RuntimeReadyResult> {
      const { runtimeId, spaceId, name, machineInfo } = message;

      // Validate required fields
      if (!runtimeId || !spaceId || !name) {
        await sendError(state.connectionId, 'INVALID_MESSAGE', 'runtimeId, spaceId, and name are required');
        return { success: false, error: { code: 'INVALID_MESSAGE', message: 'runtimeId, spaceId, and name are required' } };
      }

      // If we have a serverId (authenticated), verify it matches the space
      // This would need to be done at a higher level where we have auth context

      try {
        const config: LocalRuntimeConfig = {
          wsConnectionId: state.connectionId,
          machineInfo,
        };

        // Check if runtime already exists by ID first
        let runtime = await storage.getRuntime(runtimeId);
        let effectiveRuntimeId = runtimeId;

        if (runtime) {
          // Update existing runtime (same ID reconnecting)
          await storage.updateRuntime(runtimeId, {
            name,
            status: 'online',
            config,
            lastSeenAt: new Date().toISOString(),
          });
          console.log(`[RuntimeProtocolHandlers] Runtime reconnected: ${runtimeId} (${name})`);
        } else {
          // Check if runtime exists by (spaceId, name) - handles case where
          // client generates new runtimeId but same machine name
          const existingByName = await storage.getRuntimeByName(spaceId, name);

          if (existingByName) {
            // Update existing runtime record, use its ID
            effectiveRuntimeId = existingByName.id;
            await storage.updateRuntime(effectiveRuntimeId, {
              status: 'online',
              config,
              lastSeenAt: new Date().toISOString(),
            });
            runtime = existingByName;
            console.log(`[RuntimeProtocolHandlers] Runtime reconnected (by name): ${effectiveRuntimeId} (${name})`);
          } else {
            // Create new runtime
            runtime = await storage.createRuntime({
              id: runtimeId,
              spaceId,
              serverId: state.serverId,
              name,
              type: 'local',
              status: 'online',
              config,
            });
            console.log(`[RuntimeProtocolHandlers] New runtime registered: ${runtimeId} (${name})`);
          }
        }

        // Update connection with runtimeId (use effective ID in case we reused existing)
        await storage.updateConnectionRuntime(state.connectionId, effectiveRuntimeId);

        // Send confirmation (use effective ID so client knows which ID to use)
        const response = JSON.stringify({
          type: 'runtime_connected',
          runtimeId: effectiveRuntimeId,
          protocolVersion: PROTOCOL_VERSION,
        });
        await send(state.connectionId, response);

        return { success: true, runtimeId: effectiveRuntimeId };
      } catch (error) {
        console.error('[RuntimeProtocolHandlers] Error handling runtime_ready:', error);
        await sendError(state.connectionId, 'REGISTRATION_FAILED', 'Failed to register runtime');
        return { success: false, error: { code: 'REGISTRATION_FAILED', message: 'Failed to register runtime' } };
      }
    },

    async handleAgentCheckin(
      state: RuntimeConnectionState,
      message: AgentCheckinMessage
    ): Promise<void> {
      const { agentId } = message;

      if (!state.runtimeId) {
        await sendError(state.connectionId, 'NOT_REGISTERED', 'Must send runtime_ready first');
        return;
      }

      try {
        // Parse agent ID to get channel
        const { channelId, callsign } = parseAgentId(agentId);

        // Update roster lastHeartbeat
        const now = new Date().toISOString();
        const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
        if (rosterEntry) {
          await storage.updateRosterEntry(channelId, rosterEntry.id, {
            lastHeartbeat: now,
          });
        }

        // Broadcast online state to frontend
        await broadcastAgentState(channelId, callsign, 'online', now);

        console.log(`[RuntimeProtocolHandlers] Agent checkin: ${agentId}`);
      } catch (error) {
        console.error('[RuntimeProtocolHandlers] Error handling agent_checkin:', error);
      }
    },

    async handleAgentHeartbeat(
      state: RuntimeConnectionState,
      message: AgentHeartbeatMessage
    ): Promise<void> {
      const { agentId } = message;

      if (!state.runtimeId) {
        await sendError(state.connectionId, 'NOT_REGISTERED', 'Must send runtime_ready first');
        return;
      }

      try {
        // Parse agent ID to get channel and callsign
        const { channelId, callsign } = parseAgentId(agentId);

        const now = new Date().toISOString();

        // Update runtime lastSeenAt so frontend staleness check works
        await storage.updateRuntime(state.runtimeId, {
          lastSeenAt: now,
        });

        // Update roster lastHeartbeat
        const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
        if (rosterEntry) {
          await storage.updateRosterEntry(channelId, rosterEntry.id, {
            lastHeartbeat: now,
          });

          // Broadcast online state with timestamp so frontend can track staleness
          await broadcastAgentState(channelId, callsign, 'online', now);
        }
      } catch (error) {
        console.error('[RuntimeProtocolHandlers] Error handling agent_heartbeat:', error);
      }
    },

    async handleFrame(
      state: RuntimeConnectionState,
      message: AgentFrameMessage
    ): Promise<void> {
      const { agentId, frame } = message;

      if (!state.runtimeId) {
        await sendError(state.connectionId, 'NOT_REGISTERED', 'Must send runtime_ready first');
        return;
      }

      try {
        const { channelId, callsign } = parseAgentId(agentId);

        // Broadcast frame to channel
        const serialized = JSON.stringify(frame);
        await broadcast(channelId, serialized);

        // Persist SetFrames as messages (skip cost frames in persistSetFrame)
        if (isSetFrame(frame)) {
          await persistSetFrame(state.runtimeId, channelId, callsign, frame);
        }

        // Update roster lastHeartbeat on activity (keeps agent marked as online)
        const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
        if (rosterEntry) {
          const now = new Date().toISOString();
          await storage.updateRosterEntry(channelId, rosterEntry.id, {
            lastHeartbeat: now,
          });
        }
      } catch (error) {
        console.error('[RuntimeProtocolHandlers] Error handling frame:', error);
        if (deps.strictPersistence) throw error;
      }
    },

    async handleDisconnect(runtimeId: string): Promise<void> {
      try {
        // Mark runtime as offline
        await storage.updateRuntime(runtimeId, {
          status: 'offline',
          config: { wsConnectionId: null },
        });

        // Get all agents bound to this runtime and mark them offline
        const boundAgents = await storage.getAgentsByRuntime(runtimeId);

        for (const agent of boundAgents) {
          const channelId = agent.channelId;
          const callsign = agent.callsign;

          // Broadcast offline status
          const statusFrame = tymbal.set(generateMessageId(), {
            type: 'status',
            sender: callsign,
            senderType: 'agent',
            content: `offline (runtime disconnected)`,
          });
          await broadcast(channelId, JSON.stringify(statusFrame));
        }

        console.log(`[RuntimeProtocolHandlers] Runtime disconnected: ${runtimeId}`);
      } catch (error) {
        console.error('[RuntimeProtocolHandlers] Error handling disconnect:', error);
      }
    },
  };
}

/**
 * Agent Manager
 *
 * Manages multiple agent instances within a single runtime process.
 * Supports multiple engines: Claude SDK (in-process) and Nuum (subprocess).
 * Handles agent lifecycle: activation, message routing, suspension.
 *
 * Key feature: Streaming input support - messages can be pushed to agents
 * during execution for mid-turn injection.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, type UUID } from 'node:crypto';
import { query, type SDKMessage, type SDKUserMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { TymbalBridge } from './tymbal-bridge.js';
import type {
  AgentState,
  AgentStatus,
  ActivateAgentMessage,
  DeliverMessageMessage,
  SuspendAgentMessage,
  AgentFrameMessage,
  McpServerConfig,
} from './types.js';
import {
  createEngineManager,
  type EngineManager,
  type EngineProcess,
  type EngineConfig,
} from './engines/index.js';

// =============================================================================
// URL Rewriting for Docker
// =============================================================================

/**
 * Check if we're running inside a Docker container.
 * When MIRIAD_CONFIG contains host.docker.internal, we know we're in Docker.
 */
function isRunningInDocker(): boolean {
  const config = process.env.MIRIAD_CONFIG;
  if (!config) return false;
  return config.includes('host.docker.internal');
}

/**
 * Rewrite localhost URLs to host.docker.internal when running in Docker.
 * This is needed because localhost inside a container refers to the container,
 * not the host machine where the backend is running.
 */
function rewriteUrlForDocker(url: string): string {
  if (!isRunningInDocker()) return url;
  return url.replace(/localhost/g, 'host.docker.internal');
}

// =============================================================================
// Types
// =============================================================================

/**
 * Message stream for pushing messages to Claude during execution.
 * Implements AsyncIterable so it can be passed to query().
 */
interface MessageStream {
  /** Push a message to the stream (will be delivered to Claude) */
  push(content: string): void;
  /** Close the stream (no more messages) */
  close(): void;
  /** The async iterable for the SDK */
  iterable: AsyncIterable<SDKUserMessage>;
  /** Session ID for this stream */
  sessionId: string;
}

interface AgentInstance {
  state: AgentState;
  bridge: TymbalBridge;
  messageQueue: DeliverMessageMessage[];
  isProcessing: boolean;
  /** Active message stream for pushing messages during execution (Claude SDK only) */
  messageStream: MessageStream | null;
  /** Engine process for subprocess-based engines (Nuum only) */
  engineProcess: EngineProcess | null;
}

// =============================================================================
// Message Stream Factory
// =============================================================================

/**
 * Create a message stream that can push messages to Claude during execution.
 *
 * The stream works as follows:
 * 1. First call to next() yields the initial message immediately
 * 2. Subsequent calls wait for push() to add messages to the queue
 * 3. When Claude asks for next input, we batch all queued messages and yield
 * 4. close() signals no more messages (ends the stream)
 */
function createMessageStream(initialContent: string): MessageStream {
  const sessionId = randomUUID();
  const queue: string[] = [];
  let closed = false;
  let resolveWaiting: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;

  // Helper to create SDKUserMessage from content
  function makeMessage(content: string): SDKUserMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  const stream: MessageStream = {
    sessionId,

    push(content: string): void {
      if (closed) {
        console.warn('[MessageStream] Cannot push to closed stream');
        return;
      }
      queue.push(content);

      // If Claude is waiting for input, resolve immediately with batched messages
      if (resolveWaiting && queue.length > 0) {
        const batched = queue.splice(0).join('\n\n');
        resolveWaiting({ value: makeMessage(batched), done: false });
        resolveWaiting = null;
      }
    },

    close(): void {
      closed = true;
      // If Claude is waiting, signal end of stream
      if (resolveWaiting) {
        resolveWaiting({ value: undefined as unknown as SDKUserMessage, done: true });
        resolveWaiting = null;
      }
    },

    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        let yieldedInitial = false;

        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            // First call: yield initial message immediately
            if (!yieldedInitial) {
              yieldedInitial = true;
              return { value: makeMessage(initialContent), done: false };
            }

            // If stream is closed and queue is empty, we're done
            if (closed && queue.length === 0) {
              return { value: undefined as unknown as SDKUserMessage, done: true };
            }

            // If there are queued messages, batch and yield them
            if (queue.length > 0) {
              const batched = queue.splice(0).join('\n\n');
              return { value: makeMessage(batched), done: false };
            }

            // Wait for push() or close()
            return new Promise((resolve) => {
              resolveWaiting = resolve;
            });
          },
        };
      },
    },
  };

  return stream;
}

export interface AgentManagerConfig {
  /** Base path for agent workspaces */
  workspaceBasePath: string;
  /** Callback when agent sends a frame */
  onFrame: (message: AgentFrameMessage) => void;
  /** Callback when agent checks in (SDK ready) */
  onCheckin: (agentId: string) => void;
  /** Callback on agent error */
  onError?: (agentId: string, error: Error) => void;
}

// =============================================================================
// Agent ID Parsing
// =============================================================================

export function parseAgentId(agentId: string): {
  spaceId: string;
  channelId: string;
  callsign: string;
} {
  const parts = agentId.split(':');
  if (parts.length !== 3) {
    throw new Error(`Invalid agentId format: ${agentId}. Expected spaceId:channelId:callsign`);
  }
  return {
    spaceId: parts[0],
    channelId: parts[1],
    callsign: parts[2],
  };
}

// =============================================================================
// Agent Manager
// =============================================================================

export class AgentManager {
  private readonly config: AgentManagerConfig;
  private readonly agents = new Map<string, AgentInstance>();
  private readonly engineManager: EngineManager;

  constructor(config: AgentManagerConfig) {
    this.config = config;
    this.engineManager = createEngineManager();
  }

  /**
   * Get all agents.
   */
  getAgents(): AgentState[] {
    return Array.from(this.agents.values()).map((instance) => instance.state);
  }

  /**
   * Get a specific agent's state.
   */
  getAgent(agentId: string): AgentState | null {
    return this.agents.get(agentId)?.state ?? null;
  }

  /**
   * Activate an agent with the specified engine.
   */
  async activate(message: ActivateAgentMessage): Promise<void> {
    const { agentId, systemPrompt, mcpServers, workspacePath, props } = message;
    const { callsign } = parseAgentId(agentId);
    // Extract engine from props, default to claude-sdk
    const engineId = process.env.MIRIAD_ENGINE === 'workers-ai'
      ? 'workers-ai'
      : (props?.engine === 'workers-ai' ? 'workers-ai' : props?.engine === 'nuum' ? 'nuum' : 'claude-sdk');

    console.log(`[AgentManager] Activating ${agentId} with engine: ${engineId}`);
    console.log(`[AgentManager]   mcpServers from message:`, mcpServers ? Object.keys(mcpServers).length : 0);

    // Check if already active
    const existing = this.agents.get(agentId);
    if (existing && existing.state.status !== 'offline') {
      console.log(`[AgentManager] Agent ${agentId} already active (${existing.state.status})`);
      return;
    }

    console.log(`[AgentManager] @${callsign} state: offline → activating`);

    // Always use local config basePath + agentId structure for security
    // (ignore workspacePath from backend to prevent arbitrary path access)
    const resolvedPath = join(this.config.workspaceBasePath, agentId.replace(/:/g, '/'));
    console.log(`[AgentManager] @${callsign} workspace config:`);
    console.log(`[AgentManager]   basePath: ${this.config.workspaceBasePath}`);
    console.log(`[AgentManager]   backend workspacePath (ignored): ${workspacePath || '(none)'}`);
    console.log(`[AgentManager]   resolved: ${resolvedPath}`);
    this.ensureWorkspace(resolvedPath);

    // Create bridge
    const bridge = new TymbalBridge({
      agentId,
      callsign,
      onFrame: this.config.onFrame,
    });

    // Create agent instance
    const instance: AgentInstance = {
      state: {
        agentId,
        status: 'activating',
        workspacePath: resolvedPath,
        systemPrompt,
        mcpServers,
        engine: engineId,
        activatedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      },
      bridge,
      messageQueue: [],
      isProcessing: false,
      messageStream: null,
      engineProcess: null,
    };

    console.log(`[AgentManager]   Stored mcpServers in state:`, instance.state.mcpServers?.length ?? 0);
    this.agents.set(agentId, instance);

    // For Nuum engine, spawn the subprocess now
    if (engineId !== 'claude-sdk') {
      try {
        const nuumEngine = this.engineManager.getEngine(engineId);
        if (!nuumEngine) {
          throw new Error('Nuum engine not registered');
        }

        const engineConfig: EngineConfig = {
          agentId,
          workspacePath: resolvedPath,
          systemPrompt,
          mcpServers,
          environment: instance.state.environment,
        };

        console.log(`[AgentManager] @${callsign} spawning Nuum engine...`);
        instance.engineProcess = await nuumEngine.spawn(engineConfig);

        // Start consuming output and feeding to bridge
        this.consumeEngineOutput(instance);

        console.log(`[AgentManager] @${callsign} Nuum engine spawned (pid: ${instance.engineProcess.pid})`);
      } catch (error) {
        console.error(`[AgentManager] Failed to spawn Nuum engine for ${agentId}:`, error);
        instance.state.status = 'error';
        this.config.onError?.(agentId, error as Error);
        return;
      }
    }

    // Signal checkin (SDK ready)
    instance.state.status = 'online';
    instance.state.lastActivity = new Date().toISOString();
    this.config.onCheckin(agentId);

    console.log(`[AgentManager] @${callsign} state: activating → online`);
  }

  /**
   * Consume output from an engine process and feed to TymbalBridge.
   */
  private async consumeEngineOutput(instance: AgentInstance): Promise<void> {
    if (!instance.engineProcess) return;

    const { callsign } = parseAgentId(instance.state.agentId);

    try {
      for await (const message of instance.engineProcess.output) {
        await instance.bridge.processSDKMessage(message);
        if (message.type === 'result' && instance.state.status !== 'offline') {
          instance.state.status = message.is_error ? 'error' : 'online';
          instance.state.lastActivity = new Date().toISOString();
          if (message.is_error)
            this.config.onError?.(instance.state.agentId, new Error('Agent turn failed; inspect its error result'));
        }
      }
      await instance.bridge.finalize();
      console.log(`[AgentManager] @${callsign} engine output stream ended`);
    } catch (error) {
      console.error(`[AgentManager] @${callsign} engine output error:`, error);
      this.config.onError?.(instance.state.agentId, error as Error);
    }
  }

  /**
   * Format a message with sender header.
   */
  private formatMessage(message: DeliverMessageMessage): string {
    return `--- @${message.sender} says:\n${message.content}`;
  }

  /**
   * Deliver a message to an agent.
   * Auto-activates the agent if it doesn't exist (local runtime is always-on).
   */
  async deliverMessage(message: DeliverMessageMessage): Promise<void> {
    const { agentId, systemPrompt, mcpServers, environment, props } = message;
    let instance = this.agents.get(agentId);

    const { callsign } = parseAgentId(agentId);

    // Auto-activate agent if not found or offline (local runtime is always-on)
    if (!instance || instance.state.status === 'offline') {
      console.log(`[AgentManager] @${callsign} not active, auto-activating for message delivery`);
      if (mcpServers) {
        console.log(`[AgentManager] Auto-activation WITH mcpServers (count: ${mcpServers.length})`);
      } else {
        console.warn(`[AgentManager] WARNING: Auto-activation WITHOUT mcpServers!`);
      }
      if (props?.engine) {
        console.log(`[AgentManager] Auto-activation with engine: ${props.engine}`);
      }
      await this.activate({
        type: 'activate',
        agentId,
        systemPrompt: systemPrompt || '',
        workspacePath: '', // Will be ignored, uses local config
        mcpServers, // Now passed from message
        props, // Pass props from message (includes engine)
      });
      instance = this.agents.get(agentId);
      if (!instance) {
        console.error(`[AgentManager] Failed to auto-activate agent ${agentId}`);
        return;
      }
      console.log(`[AgentManager] @${callsign} auto-activated, proceeding with message`);
    }

    // Update mcpServers if provided in message (keeps config fresh even for online agents)
    if (mcpServers && instance) {
      console.log(`[AgentManager] Updating mcpServers for online agent @${callsign} (count: ${mcpServers.length})`);
      instance.state.mcpServers = mcpServers;
    }

    // Update environment if provided (per-request injection)
    if (environment && instance) {
      console.log(`[AgentManager] Updating environment for @${callsign} (count: ${Object.keys(environment).length})`);
      instance.state.environment = environment;
    }

    // Route based on engine type
    if (instance.state.engine !== 'claude-sdk') {
      await this.deliverMessageToNuum(instance, message);
    } else {
      await this.deliverMessageToClaudeSDK(instance, message);
    }
  }

  /**
   * Deliver message to Nuum engine (subprocess).
   */
  private async deliverMessageToNuum(
    instance: AgentInstance,
    message: DeliverMessageMessage,
  ): Promise<void> {
    const { callsign } = parseAgentId(instance.state.agentId);

    if (!instance.engineProcess) {
      console.error(`[AgentManager] @${callsign} Nuum engine not running`);
      return;
    }

    // Send message to engine process
    instance.engineProcess.send({
      type: 'user',
      content: message.content,
      sender: message.sender,
      systemPrompt: message.systemPrompt,
      mcpServers: message.mcpServers,
      environment: message.environment,
    });

    instance.state.status = 'busy';
    instance.state.lastActivity = new Date().toISOString();
    console.log(`[AgentManager] @${callsign} sent message to Nuum engine`);
  }

  /**
   * Deliver message to Claude SDK engine (in-process).
   */
  private async deliverMessageToClaudeSDK(
    instance: AgentInstance,
    message: DeliverMessageMessage,
  ): Promise<void> {
    const { callsign } = parseAgentId(instance.state.agentId);

    // Format message with sender header
    const formattedContent = this.formatMessage(message);

    // If agent is processing and has an active stream, push to it (mid-execution delivery!)
    if (instance.isProcessing && instance.messageStream) {
      console.log(`[AgentManager] @${callsign} busy with active stream, pushing message mid-execution`);
      instance.messageStream.push(formattedContent);
      return;
    }

    // Legacy fallback: queue message if processing but no stream (shouldn't happen with new code)
    if (instance.isProcessing) {
      console.log(`[AgentManager] @${callsign} busy (no stream), queueing message`);
      instance.messageQueue.push(message);
      return;
    }

    // Process message (will transition to busy)
    console.log(`[AgentManager] @${callsign} calling processMessage with content length: ${formattedContent.length}`);
    await this.processMessage(instance, formattedContent, message.systemPrompt);
    console.log(`[AgentManager] @${callsign} processMessage returned`);
  }

  /**
   * Suspend an agent (tear down engine).
   */
  async suspend(message: SuspendAgentMessage): Promise<void> {
    const { agentId, reason } = message;
    const instance = this.agents.get(agentId);

    if (!instance) {
      console.log(`[AgentManager] Agent ${agentId} not found for suspension`);
      return;
    }

    const { callsign } = parseAgentId(agentId);
    const oldStatus = instance.state.status;
    console.log(`[AgentManager] @${callsign} state: ${oldStatus} → offline (${reason ?? 'no reason'})`);

    // Update state
    instance.state.status = 'offline';
    instance.state.lastActivity = new Date().toISOString();

    // Close any active message stream (Claude SDK)
    if (instance.messageStream) {
      instance.messageStream.close();
      instance.messageStream = null;
    }

    // Terminate engine process (Nuum)
    if (instance.engineProcess) {
      await instance.engineProcess.terminate(reason);
      instance.engineProcess = null;
    }

    // Clear message queue
    instance.messageQueue = [];
    instance.isProcessing = false;

    // Optionally remove from map (or keep for restart)
    // this.agents.delete(agentId);
  }

  /**
   * Suspend all agents (for shutdown).
   */
  async suspendAll(): Promise<void> {
    const agentIds = Array.from(this.agents.keys());
    for (const agentId of agentIds) {
      await this.suspend({ type: 'suspend', agentId, reason: 'runtime shutdown' });
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private ensureWorkspace(workspace: string): void {
    if (!existsSync(workspace)) {
      console.log(`[AgentManager] Creating workspace: ${workspace}`);
      mkdirSync(workspace, { recursive: true });
    }
  }

  private getClaudeConfigDir(workspace: string): string {
    return join(workspace, '.claude');
  }

  private hasExistingSession(workspace: string): boolean {
    return existsSync(this.getClaudeConfigDir(workspace));
  }

  private async processMessage(
    instance: AgentInstance,
    content: string,
    systemPrompt?: string
  ): Promise<void> {
    const { state, bridge } = instance;

    const { callsign } = parseAgentId(state.agentId);
    const oldStatus = instance.state.status;
    instance.isProcessing = true;
    instance.state.status = 'busy';
    instance.state.lastActivity = new Date().toISOString();
    console.log(`[AgentManager] @${callsign} state: ${oldStatus} → busy`);

    const workspace = state.workspacePath;
    const shouldContinue = this.hasExistingSession(workspace);
    const claudeConfigDir = this.getClaudeConfigDir(workspace);

    // Use updated system prompt if provided
    const prompt = systemPrompt ?? state.systemPrompt;

    console.log(`[AgentManager] Processing message for ${state.agentId}`);
    console.log(`[AgentManager] Working directory: ${workspace}`);
    console.log(`[AgentManager] Continue session: ${shouldContinue}`);

    const options: Options = {
      model: 'claude-opus-4-5-20251101',
      systemPrompt: prompt
        ? {
            type: 'preset',
            preset: 'claude_code',
            append: prompt,
          }
        : {
            type: 'preset',
            preset: 'claude_code',
          },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      continue: shouldContinue,
      cwd: workspace,
      // Don't load settings from filesystem - prevents stored API keys from overriding env vars
      // The SDK docs say: "When omitted or empty, no filesystem settings are loaded (SDK isolation mode)"
      settingSources: [],
      env: {
        // Per-request environment variables and secrets (from system.environment artifacts)
        // Applied first so process.env can override sensitive keys
        ...state.environment,
        // Process env takes precedence - filter out PWD/OLDPWD to prevent parent's cwd from leaking
        // This ensures platform-configured keys (ANTHROPIC_API_KEY, etc.) cannot be overridden by artifacts
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !['PWD', 'OLDPWD'].includes(key))
        ),
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
    };

    // Add MCP servers if configured (SDK expects Record<string, McpServerConfig>)
    if (state.mcpServers && state.mcpServers.length > 0) {
      console.log(`[AgentManager] Building MCP config from state.mcpServers (count: ${state.mcpServers.length})`);
      console.log(`[AgentManager]   state.mcpServers:`, state.mcpServers?.length ?? 0);
      // Build MCP servers config - use type assertion since SDK uses discriminated unions
      const mcpServers: Record<string, unknown> = {};
      for (const server of state.mcpServers) {
        if (server.transport === 'stdio' && server.command) {
          // Rewrite localhost URLs in env vars for Docker compatibility
          const rewrittenEnv = server.env
            ? Object.fromEntries(
                Object.entries(server.env).map(([key, value]) => [
                  key,
                  typeof value === 'string' ? rewriteUrlForDocker(value) : value,
                ])
              )
            : undefined;
          mcpServers[server.name] = {
            type: 'stdio' as const,
            command: server.command,
            args: server.args,
            env: rewrittenEnv,
            cwd: server.cwd,
          };
        } else if ((server.transport === 'sse' || server.transport === 'http') && server.url) {
          mcpServers[server.name] = {
            type: server.transport as 'sse' | 'http',
            url: rewriteUrlForDocker(server.url),
            headers: server.headers,
          };
        } else {
          // Skip invalid configs (e.g., stdio without command, http without url)
          console.warn(`[AgentManager] Skipping invalid MCP server '${server.name}': transport=${server.transport}, command=${server.command ?? 'null'}, url=${server.url ?? 'null'}`);
        }
      }
      if (Object.keys(mcpServers).length > 0) {
        console.log(`[AgentManager]   Built SDK mcpServers:`, mcpServers ? Object.keys(mcpServers).length : 0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options.mcpServers = mcpServers as any;
      }
    } else {
      console.warn(`[AgentManager] No MCP servers configured for ${state.agentId} (state.mcpServers: ${state.mcpServers})`);
    }

    // Create message stream for this conversation
    // This allows new messages to be pushed to Claude mid-execution
    const messageStream = createMessageStream(content);
    instance.messageStream = messageStream;
    console.log(`[AgentManager] @${callsign} created message stream (sessionId: ${messageStream.sessionId})`);

    try {
      const q = query({
        prompt: messageStream.iterable,  // Use stream instead of static string!
        options,
      });

      for await (const message of q) {
        await bridge.processSDKMessage(message);
      }

      await bridge.finalize();
      console.log(`[AgentManager] Query completed for ${state.agentId}`);
    } catch (error) {
      console.error(`[AgentManager] Query error for ${state.agentId}:`, error);
      this.config.onError?.(state.agentId, error as Error);
    } finally {
      // Clean up stream
      if (instance.messageStream) {
        instance.messageStream.close();
        instance.messageStream = null;
      }

      instance.isProcessing = false;
      instance.state.status = 'online';
      instance.state.lastActivity = new Date().toISOString();
      console.log(`[AgentManager] @${callsign} state: busy → online`);

      // Process any queued messages that came in via legacy path
      await this.processQueue(instance);
    }
  }

  /**
   * Process the message queue for an agent.
   * Batches all queued messages into a single message to match sandbox behavior.
   */
  private async processQueue(instance: AgentInstance): Promise<void> {
    if (instance.messageQueue.length === 0) {
      return;
    }

    const { callsign } = parseAgentId(instance.state.agentId);

    // Batch all queued messages together
    const queuedMessages = [...instance.messageQueue];
    instance.messageQueue = []; // Clear the queue

    console.log(`[AgentManager] @${callsign} processing ${queuedMessages.length} queued messages as a batch`);

    // Format and combine all message contents with separator
    const combinedContent = queuedMessages.map(msg => this.formatMessage(msg)).join('\n\n');

    // Process as a single message (use first message's metadata)
    await this.processMessage(instance, combinedContent, queuedMessages[0].systemPrompt);
  }
}

/**
 * Agent Engine Abstraction Types
 *
 * Defines the interface for pluggable agent engines. Each engine can spawn
 * agent processes that emit SDK-compatible messages for the TymbalBridge.
 *
 * Current engines:
 * - ClaudeSDKEngine: In-process Claude Code SDK (default)
 * - NuumEngine: Subprocess running @miriad-systems/nuum via bunx
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '../types.js';

// =============================================================================
// Engine Configuration
// =============================================================================

export interface EngineConfig {
  /** Full agent ID (space:channel:callsign) */
  agentId: string;

  /** Filesystem path for agent workspace */
  workspacePath: string;

  /** System prompt (may be updated per-turn) */
  systemPrompt?: string;

  /** MCP servers to connect */
  mcpServers?: McpServerConfig[];

  /** Environment variables (set at spawn, fixed for process lifetime) */
  environment?: Record<string, string>;

  /** Engine-specific options */
  engineOptions?: Record<string, unknown>;
}

// =============================================================================
// Engine Process
// =============================================================================

export type EngineProcessState =
  | 'starting'    // Process spawned, waiting for ready signal
  | 'ready'       // Ready to receive messages
  | 'busy'        // Processing a message
  | 'terminated'; // Process ended

export interface EngineMessage {
  /** Per-turn artifact environment; runtime credentials must take precedence. */
  environment?: Record<string, string>;
  type: 'user' | 'control';
  /** User message content */
  content?: string;
  /** Sender attribution (e.g., "@fox") */
  sender?: string;
  /** Control action */
  action?: 'interrupt' | 'heartbeat';
  /** Updated system prompt for this turn */
  systemPrompt?: string;
  /** Updated MCP servers for this turn */
  mcpServers?: McpServerConfig[];
}

export interface EngineProcess {
  /** OS process ID (null for in-process engines like ClaudeSDK) */
  readonly pid: number | null;

  /** Current process state */
  readonly state: EngineProcessState;

  /** Send a message to the engine */
  send(message: EngineMessage): void;

  /**
   * Stream of SDK-compatible messages.
   * These feed directly into TymbalBridge.processSDKMessage().
   */
  readonly output: AsyncIterable<SDKMessage>;

  /** Terminate the process */
  terminate(reason?: string): Promise<void>;

  /** Register exit handler */
  onExit(handler: (code: number | null) => void): void;
}

// =============================================================================
// Agent Engine Interface
// =============================================================================

export interface AgentEngine {
  /** Unique engine identifier */
  readonly engineId: string;

  /** Human-readable name */
  readonly displayName: string;

  /** Spawn an engine process for an agent */
  spawn(config: EngineConfig): Promise<EngineProcess>;

  /** Check if engine is available (e.g., bunx installed for Nuum) */
  isAvailable(): Promise<boolean>;
}

// =============================================================================
// Engine Selection
// =============================================================================

/** Known engine IDs */
export type EngineId = 'claude-sdk' | 'nuum' | 'workers-ai';

/** Default engine when none specified */
export const DEFAULT_ENGINE_ID: EngineId = 'claude-sdk';

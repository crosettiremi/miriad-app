/**
 * Protocol types for LocalRuntime WebSocket communication.
 * Aligned with backend RuntimeConnectionManager protocol (spec section 2.2)
 */

// =============================================================================
// Backend → Runtime (Commands)
// =============================================================================

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
  /** Agent definition props (engine, nameTheme, etc.) */
  props?: {
    engine?: string;
    nameTheme?: string;
    mcp?: string[];
    [key: string]: unknown;
  };
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
    mcp?: string[];
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

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type BackendToRuntimeMessage =
  | RuntimeConnectedMessage
  | ActivateAgentMessage
  | DeliverMessageMessage
  | SuspendAgentMessage
  | PingMessage
  | ErrorMessage;

// =============================================================================
// Runtime → Backend (Responses & Events)
// =============================================================================

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

// =============================================================================
// MCP Server Config
// =============================================================================

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
// Tymbal Frames (aligned with @cast/core)
// =============================================================================

export interface TymbalFrame {
  i: string;                    // Message ID (ULID)
  t?: string;                   // Timestamp (ISO, for set frames)
  m?: TymbalMetadata;           // Metadata (for start frames)
  a?: string;                   // Append content (for append frames)
  v?: TymbalValue;              // Set value (for set frames)
}

export interface TymbalMetadata {
  type: TymbalValueType;
  sender: string;
  senderType: 'agent';
}

export type TymbalValueType =
  | 'agent'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'idle'
  | 'cost'
  | 'status';

interface TymbalValueBase {
  type: TymbalValueType;
  sender: string;
  senderType: 'agent';
}

export interface AgentValue extends TymbalValueBase {
  type: 'agent';
  content: string;
}

export interface ToolCallValue extends TymbalValueBase {
  type: 'tool_call';
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultValue extends TymbalValueBase {
  type: 'tool_result';
  toolCallId: string;
  content: unknown;
  isError: boolean;
}

export interface ErrorValue extends TymbalValueBase {
  type: 'error';
  content: string;
  /** Another agent turn is queued; this error does not indicate idle. */
  pending?: boolean;
}

export interface IdleValue extends TymbalValueBase {
  type: 'idle';
}

export interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface CostModelUsage extends CostUsage {
  costUsd: number;
}

export interface CostValue extends TymbalValueBase {
  type: 'cost';
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  usage: CostUsage;
  modelUsage?: Record<string, CostModelUsage>;
}

export type TymbalValue =
  | AgentValue
  | ToolCallValue
  | ToolResultValue
  | ErrorValue
  | IdleValue
  | CostValue;

// =============================================================================
// Configuration
// =============================================================================

/** Runtime config stored in ~/.config/miriad/config.json */
export interface RuntimeConfig {
  spaceId: string;
  name: string;
  credentials: {
    runtimeId: string;
    serverId: string;
    secret: string;
    apiUrl: string;
    wsUrl: string;
  };
  workspace: {
    basePath: string;
  };
  createdAt: string;
}

/** Bootstrap exchange response */
export interface BootstrapResponse {
  serverId: string;
  secret: string;
  spaceId: string;
  host: string;
  wsHost: string;
}

/** Parsed connection string */
export interface ParsedConnectionString {
  host: string;
  bootstrapToken: string;
  spaceId: string;
}

// =============================================================================
// Agent State
// =============================================================================

export type AgentStatus = 'activating' | 'online' | 'busy' | 'offline' | 'error';

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  workspacePath: string;
  systemPrompt: string;
  mcpServers?: McpServerConfig[];
  /** Per-request environment variables and secrets */
  environment?: Record<string, string>;
  /** Engine used for this agent */
  engine: 'claude-sdk' | 'nuum' | 'workers-ai';
  activatedAt: string;
  lastActivity: string;
}

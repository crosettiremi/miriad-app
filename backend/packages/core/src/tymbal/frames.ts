/**
 * Tymbal Protocol - Frame Types
 *
 * Core framing layer for the Tymbal streaming protocol.
 * These types define the NDJSON wire format for real-time message streaming.
 *
 * @see /design-notes/agent-server/tymbal-spec.md for the full specification
 */

// =============================================================================
// Frame Types
// =============================================================================

/**
 * Start frame - declares a message exists, optionally with metadata.
 * Sent when a message begins streaming.
 */
export interface StartFrame {
  /** Message ULID - sortable identifier */
  i: string;
  /** Optional metadata describing the message */
  m?: MessageMetadata;
}

/**
 * Append frame - appends text to a message's content buffer.
 * Used for progressive text streaming.
 */
export interface AppendFrame {
  /** Message ULID */
  i: string;
  /** Text fragment to append */
  a: string;
}

/**
 * Set frame - replaces the entire message value.
 * Finalizes a streaming message or sets a complete message at once.
 */
export interface SetFrame {
  /** Message ULID */
  i: string;
  /** ISO 8601 timestamp with milliseconds */
  t: string;
  /** Complete message value (JSON object) */
  v: Record<string, unknown>;
}

/**
 * Reset frame - deletes a message.
 */
export interface ResetFrame {
  /** Message ULID */
  i: string;
  /** Null signals deletion */
  v: null;
}

/**
 * Sync request - client requests message history.
 * Can also be used to switch channels on a persistent connection.
 */
export interface SyncRequest {
  request: 'sync';
  /** Channel to sync/switch to (enables persistent connections) */
  channelId?: string;
  /** Optional cursor - server sends messages after this ID (for real-time sync) */
  since?: string;
  /** Optional cursor - server sends messages before this ID (for loading older messages) */
  before?: string;
  /** Maximum number of messages to return */
  limit?: number;
}

/**
 * Error frame - protocol-level error.
 */
export interface ErrorFrame {
  /** Error code */
  error: string;
  /** Human-readable description */
  message?: string;
}

/**
 * Sync response - server acknowledgment of sync completion.
 */
export interface SyncResponse {
  /** Timestamp cursor for incremental sync */
  sync: string;
}

/**
 * Artifact payload for artifact frames.
 */
export interface ArtifactPayload {
  slug: string;
  type: string;
  title?: string;
  tldr: string;
  status: string;
  path: string;
  assignees?: string[];
}

/**
 * Artifact frame - broadcasts artifact changes.
 */
export interface ArtifactFrame {
  artifact: {
    action: 'create' | 'update' | 'archive';
    channelId: string;
    payload: ArtifactPayload;
  };
}

// =============================================================================
// Union Types
// =============================================================================

/**
 * Any frame that updates a message (has 'i' field).
 */
export type MessageFrame = StartFrame | AppendFrame | SetFrame | ResetFrame;

/**
 * Control frames (no 'i' field).
 */
export type ControlFrame = SyncRequest | SyncResponse | ErrorFrame | ArtifactFrame;

/**
 * Any valid Tymbal frame.
 */
export type TymbalFrame = MessageFrame | ControlFrame;

// =============================================================================
// Metadata Types
// =============================================================================

/**
 * Metadata included in start frames.
 * The 'content' key is reserved and must not appear here.
 */
export interface MessageMetadata {
  /** Message type */
  type: string;
  /** Sender identifier */
  sender?: string;
  /** Sender type */
  senderType?: 'user' | 'agent';
  /** Additional fields allowed */
  [key: string]: unknown;
}

// =============================================================================
// Message Types (from Tymbal/1.1 spec)
// =============================================================================

/**
 * Known message types in the Tymbal protocol.
 */
export type MessageType =
  | 'user'
  | 'agent'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'status'
  | 'error'
  | 'idle'
  | 'structured_ask';

/**
 * Base fields for all SetFrame values.
 */
export interface SetFrameValueBase {
  type: MessageType;
  sender: string;
  senderType: 'user' | 'agent';
}

/**
 * User or assistant message value.
 */
export interface TextMessageValue extends SetFrameValueBase {
  type: 'user' | 'agent';
  content: string;
}

/**
 * Tool call value.
 */
export interface ToolCallValue extends SetFrameValueBase {
  type: 'tool_call';
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Tool result value.
 */
export interface ToolResultValue extends SetFrameValueBase {
  type: 'tool_result';
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

/**
 * Thinking trace value.
 */
export interface ThinkingValue extends SetFrameValueBase {
  type: 'thinking';
  content: string;
}

/**
 * Status update value.
 */
export interface StatusValue extends SetFrameValueBase {
  type: 'status';
  content: string;
}

/**
 * Error message value.
 */
export interface ErrorValue extends SetFrameValueBase {
  type: 'error';
  content: string;
  /** Another agent turn is queued; this error does not indicate idle. */
  pending?: boolean;
}

/**
 * Idle signal value - agent is done with current turn.
 */
export interface IdleValue {
  type: 'idle';
  sender: string;
}

/**
 * Union of all typed SetFrame values.
 */
export type SetFrameValue =
  | TextMessageValue
  | ToolCallValue
  | ToolResultValue
  | ThinkingValue
  | StatusValue
  | ErrorValue
  | IdleValue;

// =============================================================================
// Type Guards
// =============================================================================

export function isStartFrame(frame: TymbalFrame): frame is StartFrame {
  // StartFrame has 'i' and optionally 'm', but no 'a', 'v', 'request', or 'error'
  return 'i' in frame && !('a' in frame) && !('v' in frame) && !('request' in frame) && !('error' in frame);
}

export function isAppendFrame(frame: TymbalFrame): frame is AppendFrame {
  return 'i' in frame && 'a' in frame;
}

export function isSetFrame(frame: TymbalFrame): frame is SetFrame {
  return 'i' in frame && 'v' in frame && frame.v !== null && 't' in frame;
}

export function isResetFrame(frame: TymbalFrame): frame is ResetFrame {
  return 'i' in frame && 'v' in frame && frame.v === null;
}

export function isSyncRequest(frame: TymbalFrame): frame is SyncRequest {
  return 'request' in frame && frame.request === 'sync';
}

export function isErrorFrame(frame: TymbalFrame): frame is ErrorFrame {
  return 'error' in frame;
}

export function isSyncResponse(frame: TymbalFrame): frame is SyncResponse {
  return 'sync' in frame;
}

export function isArtifactFrame(frame: TymbalFrame): frame is ArtifactFrame {
  return 'artifact' in frame;
}

export function isMessageFrame(frame: TymbalFrame): frame is MessageFrame {
  return 'i' in frame;
}

export function isControlFrame(frame: TymbalFrame): frame is ControlFrame {
  return !('i' in frame);
}

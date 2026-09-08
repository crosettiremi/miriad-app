/**
 * Tymbal Bridge for Local Runtime
 *
 * Translates Claude Agent SDK messages to Tymbal protocol frames
 * and sends them to the backend via the runtime's WS connection.
 *
 * Adapted from local-agent-engine for multi-agent support:
 * - Frames are wrapped with agentId for routing
 * - Uses callback instead of direct WS send (runtime manages connection)
 */

import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { TymbalFrame, CostValue, CostModelUsage, AgentFrameMessage } from './types.js';
import { generateId } from './config.js';

// Content block types from Anthropic API
interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string };

// =============================================================================
// TymbalBridge
// =============================================================================

export interface TymbalBridgeConfig {
  /** Agent ID ({spaceId}:{channelId}:{callsign}) */
  agentId: string;
  /** Agent callsign for frame sender attribution */
  callsign: string;
  /** Callback to send frames to runtime */
  onFrame: (message: AgentFrameMessage) => void;
}

export class TymbalBridge {
  private readonly agentId: string;
  private readonly callsign: string;
  private readonly onFrame: (message: AgentFrameMessage) => void;

  // Session state
  private sessionId: string | null = null;

  // Current message tracking
  private currentAssistantMsgId: string | null = null;
  private assistantContent: string = '';
  private startFrameEmitted: boolean = false;

  constructor(config: TymbalBridgeConfig) {
    this.agentId = config.agentId;
    this.callsign = config.callsign;
    this.onFrame = config.onFrame;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getCallsign(): string {
    return this.callsign;
  }

  /**
   * Process an SDK message and emit appropriate Tymbal frames.
   */
  async processSDKMessage(message: SDKMessage): Promise<void> {
    switch (message.type) {
      case 'system':
        await this.handleSystem(message as SDKSystemMessage);
        break;

      case 'assistant':
        await this.handleAssistant(message as SDKAssistantMessage);
        break;

      case 'stream_event':
        await this.handlePartialAssistant(message as SDKPartialAssistantMessage);
        break;

      case 'user':
        await this.handleUser(message as SDKUserMessage);
        break;

      case 'result':
        await this.handleResult(message as SDKResultMessage);
        break;

      case 'tool_progress':
        // Tool progress events (future use)
        break;

      default:
        console.log(`[TymbalBridge] Unhandled message type: ${(message as SDKMessage).type}`);
    }
  }

  private async handleSystem(message: SDKSystemMessage): Promise<void> {
    if (message.subtype === 'init') {
      this.sessionId = message.session_id;
      console.log(`[TymbalBridge:${this.callsign}] Session initialized: ${this.sessionId}`);
    }
  }

  private async handlePartialAssistant(message: SDKPartialAssistantMessage): Promise<void> {
    const event = message.event;

    if (event.type === 'content_block_start') {
      if (!this.currentAssistantMsgId) {
        this.currentAssistantMsgId = generateId();
        this.assistantContent = '';
        this.startFrameEmitted = false;
      }

      if (!this.startFrameEmitted) {
        await this.emitFrame({
          i: this.currentAssistantMsgId,
          m: { type: 'agent', sender: this.callsign, senderType: 'agent' },
        });
        this.startFrameEmitted = true;
      }
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta && 'type' in delta && delta.type === 'text_delta' && 'text' in delta) {
        this.assistantContent += (delta as { text: string }).text;
      }
    }
  }

  private async handleAssistant(message: SDKAssistantMessage): Promise<void> {
    const content = message.message.content as ContentBlock[];
    if (!content) return;

    let textContent = '';
    const toolUseBlocks: ToolUseBlock[] = [];

    for (const block of content) {
      if (block.type === 'text' && 'text' in block) {
        textContent += (block as TextBlock).text;
      } else if (block.type === 'tool_use' && 'id' in block && 'name' in block) {
        toolUseBlocks.push(block as ToolUseBlock);
      }
    }

    if (textContent) {
      const msgId = this.currentAssistantMsgId ?? generateId();

      if (!this.startFrameEmitted) {
        await this.emitFrame({
          i: msgId,
          m: { type: 'agent', sender: this.callsign, senderType: 'agent' },
        });
      }

      await this.emitFrame({
        i: msgId,
        t: new Date().toISOString(),
        v: {
          type: 'agent',
          sender: this.callsign,
          senderType: 'agent',
          content: textContent,
        },
      });

      this.currentAssistantMsgId = null;
      this.assistantContent = '';
      this.startFrameEmitted = false;
    }

    for (const toolBlock of toolUseBlocks) {
      const toolCallId = generateId();
      await this.emitFrame({
        i: toolCallId,
        t: new Date().toISOString(),
        v: {
          type: 'tool_call',
          sender: this.callsign,
          senderType: 'agent',
          toolCallId: toolBlock.id,
          name: toolBlock.name,
          args: toolBlock.input,
        },
      });
    }
  }

  private async handleUser(message: SDKUserMessage): Promise<void> {
    const apiMessage = message.message;
    const content = apiMessage.content;

    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (typeof block === 'object' && block !== null && 'type' in block) {
        const typedBlock = block as ContentBlock;
        if (typedBlock.type === 'tool_result' && 'tool_use_id' in typedBlock) {
          const resultBlock = typedBlock as ToolResultBlock;
          const resultId = generateId();

          const isError = resultBlock.is_error ?? false;
          let resultContent: unknown = resultBlock.content;

          if (Array.isArray(resultContent)) {
            resultContent = resultContent
              .filter(
                (item): item is { type: 'text'; text: string } =>
                  typeof item === 'object' && item !== null && item.type === 'text'
              )
              .map((item) => item.text)
              .join('\n');
          }

          await this.emitFrame({
            i: resultId,
            t: new Date().toISOString(),
            v: {
              type: 'tool_result',
              sender: this.callsign,
              senderType: 'agent',
              toolCallId: resultBlock.tool_use_id,
              content: resultContent,
              isError,
            },
          });
        }
      }
    }
  }

  private async handleResult(message: SDKResultMessage): Promise<void> {
    const pending = (message as SDKResultMessage & { miriad_pending?: boolean }).miriad_pending === true;
    // Finalize pending assistant message
    if (this.currentAssistantMsgId && this.assistantContent) {
      await this.emitFrame({
        i: this.currentAssistantMsgId,
        t: new Date().toISOString(),
        v: {
          type: 'agent',
          sender: this.callsign,
          senderType: 'agent',
          content: this.assistantContent,
        },
      });
      this.currentAssistantMsgId = null;
      this.assistantContent = '';
      this.startFrameEmitted = false;
    }

    // Check for errors
    if (message.subtype !== 'success') {
      const errorMsg = message as { errors?: string[] };
      const errorMessage = errorMsg.errors?.join(', ') ?? `Error: ${message.subtype}`;

      await this.emitFrame({
        i: generateId(),
        t: new Date().toISOString(),
        v: {
          type: 'error',
          sender: this.callsign,
          senderType: 'agent',
          content: errorMessage,
          ...(pending ? { pending: true } : {}),
        },
      });
    }

    // Emit cost frame (handle missing fields from Nuum which doesn't track cost)
    const costValue: CostValue = {
      type: 'cost',
      sender: this.callsign,
      senderType: 'agent',
      totalCostUsd: message.total_cost_usd ?? 0,
      durationMs: message.duration_ms ?? 0,
      durationApiMs: message.duration_api_ms ?? 0,
      numTurns: message.num_turns ?? 1,
      usage: {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
        cacheReadInputTokens: message.usage?.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: message.usage?.cache_creation_input_tokens ?? 0,
      },
    };

    if (message.modelUsage && Object.keys(message.modelUsage).length > 0) {
      const modelUsage: Record<string, CostModelUsage> = {};
      for (const [model, usage] of Object.entries(message.modelUsage)) {
        modelUsage[model] = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          costUsd: usage.costUSD,
        };
      }
      costValue.modelUsage = modelUsage;
    }

    await this.emitFrame({
      i: generateId(),
      t: new Date().toISOString(),
      v: costValue,
    });

    console.log(
      `[TymbalBridge:${this.callsign}] Cost: $${(message.total_cost_usd ?? 0).toFixed(4)} (${message.num_turns ?? 1} turns)`
    );

    // A completed turn can have another turn queued behind it.
    if (pending) return;

    // Emit idle frame (signals processing complete)
    await this.emitFrame({
      i: generateId(),
      t: new Date().toISOString(),
      v: {
        type: 'idle',
        sender: this.callsign,
        senderType: 'agent',
      },
    });
  }

  async finalize(): Promise<void> {
    if (this.currentAssistantMsgId && this.assistantContent) {
      await this.emitFrame({
        i: this.currentAssistantMsgId,
        t: new Date().toISOString(),
        v: {
          type: 'agent',
          sender: this.callsign,
          senderType: 'agent',
          content: this.assistantContent,
        },
      });
      this.currentAssistantMsgId = null;
      this.assistantContent = '';
      this.startFrameEmitted = false;
    }
  }

  /**
   * Emit a frame wrapped with agentId for routing.
   */
  private async emitFrame(frame: TymbalFrame): Promise<void> {
    const message: AgentFrameMessage = {
      type: 'frame',
      agentId: this.agentId,
      frame,
    };

    this.onFrame(message);
  }
}

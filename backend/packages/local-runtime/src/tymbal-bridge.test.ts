import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { TymbalBridge } from './tymbal-bridge.js';
import type { AgentFrameMessage } from './types.js';

describe('queued Workers AI turns', () => {
  it.each([false, true])('keeps queued work active after a result (error=%s)', async (failed) => {
    const frames: AgentFrameMessage[] = [];
    const bridge = new TymbalBridge({ agentId: 'space:channel:verify', callsign: 'verify', onFrame: frame => frames.push(frame) });
    const result = (pending: boolean, error: boolean) => ({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: error, errors: ['Test failure'], miriad_pending: pending }) as unknown as SDKMessage;
    await bridge.processSDKMessage(result(true, failed));
    const values = () => frames.flatMap(({ frame }) => 'v' in frame ? [frame.v] : []);
    expect(values().filter(value => value.type === 'idle')).toHaveLength(0);
    expect(values().filter(value => value.type === 'cost')).toHaveLength(1);
    if (failed) expect(values().find(value => value.type === 'error')).toMatchObject({ pending: true, content: 'Test failure' });
    await bridge.processSDKMessage(result(false, false));
    expect(values().filter(value => value.type === 'idle')).toHaveLength(1);
    expect(values().filter(value => value.type === 'cost')).toHaveLength(2);
  });
});

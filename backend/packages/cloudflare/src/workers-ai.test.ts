import { describe, it, expect, vi } from 'vitest';
import { readInferenceInput, runWorkersAI, MAX_INFERENCE_BYTES } from './workers-ai.js';
const request = (value: unknown) => new Request('https://runtime.example.com/api/ai/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});
describe('Workers AI boundary', () => {
  it('rejects caller-selected providers and excessive output budgets', async () => {
    const messages = [{ role: 'user', content: 'hello' }];
    await expect(readInferenceInput(request({ messages, model: 'anthropic/expensive' }))).rejects.toThrow();
    await expect(readInferenceInput(request({ messages, max_tokens: 100000 }))).rejects.toThrow();
  });
  it('bounds actual streamed body bytes without trusting Content-Length', async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_INFERENCE_BYTES + 1)); c.close(); } });
    const r = new Request('https://runtime.example.com/api/ai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
      body: stream, duplex: 'half',
    } as RequestInit);
    await expect(readInferenceInput(r)).rejects.toThrow('192 KiB');
  });
  it('preserves tool IDs/results and uses the deployment-selected model binding', async () => {
    const input = await readInferenceInput(request({ messages: [
      { role: 'user', content: 'read a file' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"hello"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'hello world' },
    ] }));
    const run = vi.fn(async () => ({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }));
    await runWorkersAI({ AI: { run }, WORKERS_AI_MODEL: '@cf/qwen/qwen3.8-27b' } as unknown as Env, input);
    expect(run).toHaveBeenCalledWith('@cf/qwen/qwen3.8-27b', expect.objectContaining({ messages: input.messages, max_tokens: 2048, stream: false }));
  });
  it('rejects non-chat provider output rather than dropping tools', async () => {
    const env = { AI: { run: vi.fn(async () => ({ response: 'wrong protocol' })) }, WORKERS_AI_MODEL: '@cf/qwen/qwen3.8-27b' } as unknown as Env;
    await expect(runWorkersAI(env, { messages: [{ role: 'user', content: 'hello' }], max_tokens: 20 })).rejects.toThrow('incompatible');
  });
});

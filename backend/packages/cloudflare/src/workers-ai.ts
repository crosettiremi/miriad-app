import { z } from 'zod';

// Text/tool protocol only. The model is selected by deployment configuration,
// never by an untrusted request (which could select a costly provider).
const toolCall = z.object({
  id: z.string().min(1).max(200),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(128), arguments: z.string() }),
});
const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({ role: z.literal('assistant'), content: z.string().nullable().optional(), tool_calls: z.array(toolCall).max(16).optional() }),
  z.object({ role: z.literal('tool'), content: z.string(), tool_call_id: z.string().min(1).max(200) }),
]);
export const inferenceInput = z.object({
  messages: z.array(message).min(1).max(512),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      description: z.string().max(8192).optional(),
      parameters: z.record(z.string(), z.unknown()),
    }),
  })).max(128).optional(),
  stream: z.literal(false).optional(),
  max_tokens: z.number().int().min(1).max(4096).default(2048),
}).strict();
export type InferenceInput = z.infer<typeof inferenceInput>;
export const MAX_INFERENCE_BYTES = 192 * 1024;

export async function readInferenceInput(request: Request): Promise<InferenceInput> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new Error('Expected application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Request body required');
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_INFERENCE_BYTES) {
      await reader.cancel();
      throw new Error('Model input exceeds 192 KiB');
    }
    parts.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  return inferenceInput.parse(JSON.parse(new TextDecoder().decode(data)));
}

export async function runWorkersAI(env: Env, input: InferenceInput) {
  const model = env.WORKERS_AI_MODEL;
  if (!env.AI || !model?.startsWith('@cf/'))
    throw new Error('Workers AI model is not configured');
  const result = await env.AI.run(model, {
    ...input,
    stream: false,
    parallel_tool_calls: false,
    chat_template_kwargs: { enable_thinking: false },
  });
  // Modern Workers AI chat models return the OpenAI-compatible protocol.
  // Reject incompatible model outputs rather than silently dropping tool calls.
  if (!Array.isArray(result.choices) || !result.choices.length)
    throw new Error('Workers AI returned an incompatible response');
  const usage = result.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  // Published Qwen 3.8 27B unit prices; estimate only, Cloudflare billing is authoritative.
  const miriad_cost_usd = ((usage?.prompt_tokens ?? 0) * 0.45 + (usage?.completion_tokens ?? 0) * 3.2) / 1_000_000;
  return { ...result, model, miriad_cost_usd };
}

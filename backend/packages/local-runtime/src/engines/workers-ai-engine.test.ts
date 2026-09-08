import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { WorkersAIEngine, fitContext, recoverPendingTools, type AIMessage } from './workers-ai-engine.js';
import type { EngineProcess, EngineConfig } from './types.js';

let workspace: string;
const processes: EngineProcess[] = [];
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'workers-ai-engine-'));
  vi.stubEnv('MIRIAD_AI_URL', 'https://runtime.example/api/ai/chat/completions');
  vi.stubEnv('MIRIAD_AI_TOKEN', 'private-gateway-token-for-tests');
  vi.stubEnv('MIRIAD_AI_MODEL', '@cf/qwen/test');
});
afterEach(async () => {
  await Promise.all(processes.splice(0).map(process => process.terminate()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(workspace, { recursive: true, force: true });
});
function completion(content: string | null, calls?: Array<{ id: string; name: string; input: unknown }>, finish?: string) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finish ?? (calls?.length ? 'tool_calls' : 'stop'), message: { role: 'assistant', content, ...(calls ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
}
async function engine(config: Partial<EngineConfig> = {}) {
  const process = await new WorkersAIEngine().spawn({ agentId: 'space:channel:test', workspacePath: workspace, ...config });
  processes.push(process);
  return process;
}
async function readTurn(process: EngineProcess, content = 'Do the task') {
  const events: any[] = [];
  process.send({ type: 'user', content });
  for await (const event of process.output) {
    events.push(event);
    if (event.type === 'result') break;
  }
  return events;
}

it('executes tool calls, returns correlated results and persists a resumable session without gateway credentials', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(completion('I will write a file.', [{ id: 'write-1', name: 'Write', input: { path: 'example.txt', content: 'hello' } }]))
    .mockResolvedValueOnce(completion(null, [{ id: 'read-1', name: 'Read', input: { path: 'example.txt' } }]))
    .mockResolvedValueOnce(completion('Verified hello.'));
  vi.stubGlobal('fetch', fetch);
  const process = await engine();
  const events = await readTurn(process);
  expect(await readFile(join(workspace, 'example.txt'), 'utf8')).toBe('hello');
  expect(events.filter(e => e.type === 'user').map(e => e.message.content[0].tool_use_id)).toEqual(['write-1', 'read-1']);
  expect(events.at(-1)).toMatchObject({ subtype: 'success', num_turns: 3, usage: { input_tokens: 30, output_tokens: 15 } });
  const body = JSON.parse(fetch.mock.calls[2][1].body);
  expect(body.messages.map((m: AIMessage) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
  expect(body.messages.at(-1)).toMatchObject({ tool_call_id: 'read-1', content: '1: hello' });
  const saved = await readFile(join(workspace, '.miriad-ai/session.json'), 'utf8');
  expect(saved).not.toContain('private-gateway-token');
  expect((await stat(join(workspace, '.miriad-ai/session.json'))).mode & 0o777).toBe(0o600);
  await process.terminate();
  fetch.mockResolvedValueOnce(completion('I remember hello.'));
  const resumed = await engine();
  const resumedEvents = await readTurn(resumed, 'What did you write?');
  expect(resumedEvents.at(-1).subtype).toBe('success');
  expect(JSON.parse(fetch.mock.calls[3][1].body).messages).toContainEqual({ role: 'assistant', content: 'Verified hello.' });
});

it('repairs pending calls after restart without replaying their side effects', async () => {
  await mkdir(join(workspace, '.miriad-ai'));
  await writeFile(join(workspace, '.miriad-ai/session.json'), JSON.stringify({ version: 1, id: 'existing', messages: [
    { role: 'user', content: 'Create a file' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'pending', type: 'function', function: { name: 'Write', arguments: '{"path":"should-not-exist","content":"bad"}' } }] },
  ] }));
  const fetch = vi.fn().mockResolvedValue(completion('The prior operation is uncertain; I will inspect before repeating it.'));
  vi.stubGlobal('fetch', fetch);
  await readTurn(await engine(), 'Continue carefully');
  await expect(stat(join(workspace, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(fetch.mock.calls[0][1].body).messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'pending', content: expect.stringContaining('effects are unknown') });
});

it('never uses untrusted per-agent gateway credentials or endpoint overrides', async () => {
  const fetch = vi.fn().mockResolvedValue(completion('Done'));
  vi.stubGlobal('fetch', fetch);
  await readTurn(await engine({ environment: { MIRIAD_AI_URL: 'https://attacker.example', MIRIAD_AI_TOKEN: 'untrusted' } }));
  expect(fetch.mock.calls[0][0]).toBe('https://runtime.example/api/ai/chat/completions');
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Server private-gateway-token-for-tests');
});

it('aborts in-flight inference and can receive a later turn without a false successful result', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const fetch = vi.fn().mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    started();
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  })).mockResolvedValueOnce(completion('Next turn completed'));
  vi.stubGlobal('fetch', fetch);
  const process = await engine();
  const events = readTurn(process);
  await ready;
  process.send({ type: 'control', action: 'interrupt' });
  expect((await events).at(-1)).toMatchObject({ subtype: 'error_during_execution', is_error: true });
  // Queueing while the prior turn unwinds must not drop the next turn.
  expect((await readTurn(process, 'Try another task')).at(-1)).toMatchObject({ subtype: 'success' });
});

it('kills a running shell process group on interrupt and seals its unrecorded result', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion(null, [{ id: 'shell', name: 'Bash', input: { command: 'sleep 20; touch should-not-exist' } }])));
  const process = await engine();
  process.send({ type: 'user', content: 'Run command' });
  const events: any[] = [];
  for await (const event of process.output) {
    events.push(event);
    if (event.type === 'assistant') setTimeout(() => process.send({ type: 'control', action: 'interrupt' }), 50);
    if (event.type === 'result') break;
  }
  expect(events.at(-1).subtype).toBe('error_during_execution');
  await expect(stat(join(workspace, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(join(workspace, '.miriad-ai/session.json'), 'utf8')).messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('effects are unknown') });
});

it('reports exhausted tool rounds as failure', async () => {
  let call = 0;
  const fetch = vi.fn().mockImplementation(async () => completion(null, [{ id: `read-${++call}`, name: 'Read', input: { path: 'missing' } }]));
  vi.stubGlobal('fetch', fetch);
  const events = await readTurn(await engine());
  expect(fetch).toHaveBeenCalledTimes(24);
  expect(events.at(-1)).toMatchObject({ subtype: 'error_during_execution', errors: [expect.stringContaining('24-round')] });
  expect(events.some(e => e.type === 'result' && e.subtype === 'success')).toBe(false);
});

it('rejects token-limit completions instead of reporting success', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion('Partial content', undefined, 'length')));
  expect((await readTurn(await engine())).at(-1)).toMatchObject({ subtype: 'error_during_execution', errors: [expect.stringContaining('length')] });
});

describe('bounded history', () => {
  it('preserves complete tool groups and recent user requests under a UTF-8 byte budget', () => {
    const messages: AIMessage[] = [
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old', content: '界'.repeat(200) },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'new', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'new', content: 'recent result' },
    ];
    const result = fitContext(messages, 30, 400);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.messages)) + 30).toBeLessThanOrEqual(400);
    expect(result.messages).toContainEqual({ role: 'user', content: 'new request' });
    expect(result.messages.at(-1)?.tool_call_id).toBe('new');
    expect(recoverPendingTools(result.messages)).toEqual(result.messages);
  });
  it('fails a single overlarge request without cutting a tool protocol group', () => {
    expect(() => fitContext([{ role: 'user', content: 'large'.repeat(1000) }], 100, 200)).toThrow('context budget');
  });
});

it('calls a configured real stdio MCP server and preserves structured/error result semantics', async () => {
  const fixture = join(workspace, 'mcp.mjs');
  const sdkRoot = pathToFileURL(createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/server/index.js')).href;
  const transport = new URL('./stdio.js', sdkRoot).href;
  const schemas = new URL('../types.js', sdkRoot).href;
  await writeFile(fixture, `import {Server} from ${JSON.stringify(sdkRoot)}; import {StdioServerTransport} from ${JSON.stringify(transport)}; import {ListToolsRequestSchema, CallToolRequestSchema} from ${JSON.stringify(schemas)};
  const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'ping',description:'Ping fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}));
  server.setRequestHandler(CallToolRequestSchema, async()=>({content:[{type:'text',text:'fixture error'}],isError:true,structuredContent:{verified:true}}));
  await server.connect(new StdioServerTransport());`);
  let calls = 0;
  const fetch = vi.fn().mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (!calls++) {
      const mcpTool = body.tools.find((t: any) => t.function.name.startsWith('mcp_'));
      return completion(null, [{ id: 'mcp-call', name: mcpTool.function.name, input: {} }]);
    }
    expect(body.messages.at(-1).content).toContain('"structuredContent":{"verified":true}');
    return completion('The fixture reported an error.');
  });
  vi.stubGlobal('fetch', fetch);
  const events = await readTurn(await engine({ mcpServers: [{ name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture] }] }));
  expect(events.find(e => e.type === 'user').message.content[0]).toMatchObject({ tool_use_id: 'mcp-call', is_error: true });
  expect(events.at(-1).subtype).toBe('success');
});

it('trims message count even when short history fits the byte budget without orphaning tool results', () => {
  const messages: AIMessage[] = [];
  for (let i = 0; i < 180; i++) {
    messages.push(
      { role: 'user', content: `request ${i}` },
      { role: 'assistant', content: null, tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `call-${i}`, content: 'ok' },
    );
  }
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(128 * 1024);
  const fitted = fitContext(messages, 100);
  expect(fitted.truncated).toBe(true);
  expect(fitted.messages.length).toBeLessThanOrEqual(510);
  expect(fitted.messages.slice(-3)).toEqual(messages.slice(-3));
  expect(recoverPendingTools(fitted.messages)).toEqual(fitted.messages);
});

it.each([false, true])('marks a result pending when another turn is queued, including failure=%s', async (failFirst) => {
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal('fetch', vi.fn()
    .mockImplementationOnce(() => { started(); return new Promise<Response>(resolve => { release = resolve; }); })
    .mockResolvedValueOnce(completion('Second completed')));
  const process = await engine();
  process.send({ type: 'user', content: 'First turn' });
  await ready;
  process.send({ type: 'user', content: 'Second turn' });
  release(failFirst ? new Response('unavailable', { status: 503 }) : completion('First completed'));
  const results: any[] = [];
  for await (const event of process.output) {
    if (event.type === 'result') results.push(event);
    if (results.length === 2) break;
  }
  expect(results[0]).toMatchObject({ miriad_pending: true, is_error: failFirst });
  expect(results[1]).toMatchObject({ miriad_pending: false, is_error: false });
});

it('rejects too many MCP tools before sending a model request', async () => {
  const fixture = join(workspace, 'many-tools.mjs');
  const sdkRoot = pathToFileURL(createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/server/index.js')).href;
  const transport = new URL('./stdio.js', sdkRoot).href;
  const schemas = new URL('../types.js', sdkRoot).href;
  await writeFile(fixture, `import {Server} from ${JSON.stringify(sdkRoot)}; import {StdioServerTransport} from ${JSON.stringify(transport)}; import {ListToolsRequestSchema} from ${JSON.stringify(schemas)};
  const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:Array.from({length:125},(_,i)=>({name:'tool_'+i,inputSchema:{type:'object',properties:{}}}))}));
  await server.connect(new StdioServerTransport());`);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const events = await readTurn(await engine({ mcpServers: [{ name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture] }] }));
  expect(events.at(-1)).toMatchObject({ is_error: true, errors: [expect.stringContaining('128 tools')] });
  expect(fetch).not.toHaveBeenCalled();
});

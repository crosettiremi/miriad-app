/** Keyless tool-loop engine. Model inference stays behind the authenticated Worker gateway. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { AgentEngine, EngineConfig, EngineMessage, EngineProcess, EngineProcessState } from './types.js';
import type { McpServerConfig } from '../types.js';

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type AIMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type Tool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type Session = { version: 1; id: string; messages: AIMessage[] };
type ToolResult = { text: string; error?: boolean };
const MAX_REQUEST_BYTES = 128 * 1024;
const TOOL_OUTPUT_BYTES = 8_000;
const MAX_ROUNDS = 24;
const INFERENCE_TIMEOUT = 240_000;
const RECOVERED_TOOL = 'Interrupted before the tool result was durably recorded. Its effects are unknown. Do not blindly repeat it; inspect the current state first.';

function bounded(text: string, limit = TOOL_OUTPUT_BYTES): string {
  if (Buffer.byteLength(text) <= limit) return text;
  return Buffer.from(text).subarray(0, Math.max(0, limit - 40)).toString('utf8') + '\n[output truncated]';
}

/** Repair pending calls with explicit unknown outcomes, never replay side effects after restart. */
export function recoverPendingTools(messages: AIMessage[]): AIMessage[] {
  const result: AIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'tool') throw new Error('Invalid session: orphan tool result');
    result.push(message);
    if (!message.tool_calls?.length) continue;
    const observed = new Map<string, AIMessage>();
    while (messages[i + 1]?.role === 'tool') {
      const tool = messages[++i];
      if (!message.tool_calls.some(call => call.id === tool.tool_call_id) || observed.has(tool.tool_call_id!)) throw new Error('Invalid session: mismatched tool result');
      observed.set(tool.tool_call_id!, tool);
    }
    for (const call of message.tool_calls) result.push(observed.get(call.id) ?? { role: 'tool', tool_call_id: call.id, content: RECOVERED_TOOL });
  }
  return result;
}

/** Drop complete old user turns first, then old tool groups in a long current turn. */
export function fitContext(messages: AIMessage[], overheadBytes: number, budget = MAX_REQUEST_BYTES): { messages: AIMessage[]; truncated: boolean } {
  const groups: AIMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'tool' && groups.at(-1)?.[0].tool_calls?.length) groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  let truncated = false;
  const size = () => Buffer.byteLength(JSON.stringify(groups.flat())) + overheadBytes;
  while (size() > budget && groups.length > 1) {
    let lastUser = -1;
    groups.forEach((group, index) => { if (group[0].role === 'user') lastUser = index; });
    // Keep the most recent user request and final group; remove complete call/result groups.
    const removable = groups.findIndex((_, index) => index !== lastUser && index !== groups.length - 1);
    if (removable < 0) break;
    groups.splice(removable, 1);
    truncated = true;
  }
  if (size() > budget) throw new Error('The current request and tool definitions exceed the Workers AI context budget. Shorten the request or reduce the configured MCP tools.');
  return { messages: groups.flat(), truncated };
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
const builtinTools: Tool[] = [
  tool('Bash', 'Run a shell command in the agent workspace. Output and execution time are bounded.', { command: { type: 'string' }, timeout_ms: { type: 'number', maximum: 120000 } }, ['command']),
  tool('Read', 'Read a UTF-8 file, optionally a line range. Output is bounded.', { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['path']),
  tool('Write', 'Create or replace a UTF-8 file. Use Read before changing existing files.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  tool('Edit', 'Replace one exact unique string in a UTF-8 file. Fails on absent or ambiguous matches.', { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, ['path', 'old_string', 'new_string']),
];

export class WorkersAIProcess implements EngineProcess {
  readonly pid = null;
  private _state: EngineProcessState = 'ready';
  private session: Session = { version: 1, id: randomUUID(), messages: [] };
  private readonly sessionFile: string;
  private readonly environment: Record<string, string | undefined>;
  private waiting: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  private outputQueue: SDKMessage[] = [];
  private done = false;
  private queue: EngineMessage[] = [];
  private active?: Promise<void>;
  private abort?: AbortController;
  private exitHandlers: Array<(code: number | null) => void> = [];
  private clients: Client[] = [];
  private mcpTools = new Map<string, { client: Client; name: string }>();
  private tools: Tool[] = builtinTools;
  private toolEnvironment: Record<string, string> = {};
  private currentServers: McpServerConfig[] = [];
  private usage = { input_tokens: 0, output_tokens: 0 };
  private costUsd = 0;

  constructor(private readonly config: EngineConfig) {
    this.environment = { ...process.env, ...config.environment };
    for (const name of ['MIRIAD_AI_URL', 'MIRIAD_AI_TOKEN', 'MIRIAD_AI_MODEL', 'MIRIAD_ENGINE']) this.environment[name] = process.env[name];
    this.sessionFile = join(config.workspacePath, '.miriad-ai', 'session.json');
  }

  async initialize(): Promise<void> {
    if (!this.environment.MIRIAD_AI_URL || !this.environment.MIRIAD_AI_TOKEN) throw new Error('Workers AI gateway URL and token are required');
    const url = new URL(this.environment.MIRIAD_AI_URL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Workers AI gateway must use HTTPS');
    try {
      const data = JSON.parse(await readFile(this.sessionFile, 'utf8')) as Session;
      if (data.version !== 1 || typeof data.id !== 'string' || !Array.isArray(data.messages) || data.messages.some(m => !['user', 'assistant', 'tool'].includes(m.role) || (m.content !== null && typeof m.content !== 'string'))) throw new Error('Invalid Workers AI session');
      this.session = { ...data, messages: recoverPendingTools(data.messages) };
      await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.emit({ type: 'system', subtype: 'init', session_id: this.session.id, model: this.environment.MIRIAD_AI_MODEL ?? 'Workers AI' });
  }

  get state(): EngineProcessState { return this._state; }
  get output(): AsyncIterable<SDKMessage> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => {
      if (this.outputQueue.length) return { value: this.outputQueue.shift()!, done: false };
      if (this.done) return { value: undefined!, done: true };
      return new Promise<IteratorResult<SDKMessage>>(resolve => { this.waiting = resolve; });
    } }) };
  }

  send(message: EngineMessage): void {
    if (this.done) return;
    if (message.type === 'control') {
      if (message.action === 'interrupt') {
        this.queue = [];
        this.abort?.abort(new Error('Agent turn interrupted'));
      }
      return;
    }
    if (!message.content) return;
    this.queue.push(message);
    this.pump();
  }

  private pump(): void {
    if (this.active || this.done || !this.queue.length) return;
    this.active = this.drain().finally(() => { this.active = undefined; this.pump(); });
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.done) {
      const message = this.queue.shift()!;
      this._state = 'busy';
      this.usage = { input_tokens: 0, output_tokens: 0 };
      this.costUsd = 0;
      this.abort = new AbortController();
      const started = Date.now();
      try {
        await this.turn(message, this.abort.signal);
      } catch (error) {
        // Seal pending calls on all failure paths, including cancellation during tool execution.
        this.session.messages = recoverPendingTools(this.session.messages);
        try { await this.save(); } catch { /* report the turn failure even if persistence failed */ }
        this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [this.redact(error instanceof Error ? error.message : String(error))], duration_ms: Date.now() - started, session_id: this.session.id, total_cost_usd: this.costUsd, usage: this.usage });
      } finally {
        await this.closeClients();
        this.abort = undefined;
        if (!this.done) this._state = 'ready';
      }
    }
  }

  private redact(text: string): string {
    const secrets = [this.environment.MIRIAD_AI_TOKEN, ...Object.entries(this.environment).filter(([name]) => /(?:SECRET|TOKEN|PASSWORD|API_KEY)$/.test(name)).map(([, value]) => value)];
    for (const server of this.currentServers) secrets.push(...Object.values(server.headers ?? {}), ...Object.entries(server.env ?? {}).filter(([name]) => /(?:SECRET|TOKEN|PASSWORD|API_KEY)$/.test(name)).map(([, value]) => value));
    secrets.push(...Object.entries(this.toolEnvironment).filter(([name]) => /(?:SECRET|TOKEN|PASSWORD|API_KEY)$/.test(name)).map(([, value]) => value));
    for (const value of secrets) if (value && value.length >= 8) text = text.split(value).join('[redacted]');
    return text;
  }

  private async save(): Promise<void> {
    const dir = dirname(this.sessionFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.sessionFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, this.redact(JSON.stringify(this.session)), { mode: 0o600 });
    await rename(temporary, this.sessionFile);
  }

  private emit(message: Record<string, unknown>): void {
    const event = { uuid: randomUUID(), ...message } as unknown as SDKMessage;
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value: event, done: false }); }
    else this.outputQueue.push(event);
  }

  private childEnvironment(): Record<string, string> {
    // Do not give model-issued shell commands the runtime's gateway/server credentials.
    const result: Record<string, string> = {};
    for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'USER']) if (this.environment[name]) result[name] = this.environment[name]!;
    for (const [name, value] of Object.entries(this.toolEnvironment)) {
      if (!/^(MIRIAD_|CAST_|R2_)/.test(name) && !['JWT_SECRET', 'SECRET_KEY'].includes(name)) result[name] = value;
    }
    return result;
  }

  private async connectMcp(servers: McpServerConfig[], signal: AbortSignal): Promise<void> {
    this.mcpTools.clear();
    this.tools = [...builtinTools];
    for (const [index, server] of servers.entries()) {
      signal.throwIfAborted();
      const client = new Client({ name: 'miriad-workers-ai', version: '1.0.0' });
      this.clients.push(client);
      const transport = server.transport === 'stdio'
        ? new StdioClientTransport({ command: server.command ?? (() => { throw new Error(`MCP ${server.name}: missing command`); })(), args: server.args, env: { ...this.childEnvironment(), ...server.env }, cwd: server.cwd ?? this.config.workspacePath, stderr: 'pipe' })
        : server.transport === 'http'
          ? new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: server.headers } })
          : new SSEClientTransport(new URL(server.url!), { requestInit: { headers: server.headers }, eventSourceInit: { fetch: (url, init) => { const headers = new Headers(init?.headers); for (const [name, value] of Object.entries(server.headers ?? {})) headers.set(name, value); return fetch(url, { ...init, headers }); } } });
      // Drain subprocess diagnostics so a chatty server cannot deadlock on a full pipe.
      if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
      const abort = () => { void client.close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await client.connect(transport, { timeout: 30_000, signal });
        let cursor: string | undefined;
        let pages = 0;
        do {
          if (++pages > 20) throw new Error(`MCP ${server.name}: excessive tool listing pages`);
          const listed = await client.listTools({ cursor }, { signal, timeout: 30_000 });
          for (const definition of listed.tools) {
            const name = `mcp_${index}_${this.mcpTools.size}_${definition.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;
            this.mcpTools.set(name, { client, name: definition.name });
            this.tools.push({ type: 'function', function: { name, description: bounded(`${server.name}: ${definition.description ?? definition.name}`, 1000), parameters: definition.inputSchema as Record<string, unknown> } });
          }
          cursor = listed.nextCursor;
        } while (cursor);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
  }

  private async closeClients(): Promise<void> {
    const clients = this.clients.splice(0);
    await Promise.allSettled(clients.map(client => client.close()));
    this.mcpTools.clear();
  }

  private async turn(message: EngineMessage, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    this.toolEnvironment = { ...this.config.environment, ...message.environment };
    this.currentServers = message.mcpServers ?? this.config.mcpServers ?? [];
    const prompt = message.systemPrompt ?? this.config.systemPrompt ?? 'You are a coding agent. Use the available tools to complete the user request. Verify your work and clearly report failures.';
    const system: AIMessage = { role: 'system', content: prompt };
    this.session.messages.push({ role: 'user', content: this.redact(message.sender ? `@${message.sender}: ${message.content}` : message.content!) });
    await this.save();
    await this.connectMcp(this.currentServers, signal);
    let truncatedNotice = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      signal.throwIfAborted();
      const overhead = Buffer.byteLength(JSON.stringify({ messages: [system], tools: this.tools, max_tokens: 2048 })) + 700;
      const context = fitContext(this.session.messages, overhead);
      if (context.truncated) {
        this.session.messages = context.messages;
        if (!truncatedNotice) {
          this.emitAssistant('[Earlier context was omitted to stay within the model context budget. Workspace files and the recent conversation remain available.]');
          truncatedNotice = true;
        }
        await this.save();
      }
      const requestMessages = context.truncated ? [{ ...system, content: `${prompt}\nOlder context has been omitted. Inspect files when earlier details are needed.` }, ...context.messages] : [system, ...context.messages];
      const response = await fetch(this.environment.MIRIAD_AI_URL!, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Server ${this.environment.MIRIAD_AI_TOKEN}` },
        body: JSON.stringify({ messages: requestMessages, tools: this.tools, max_tokens: 2048, stream: false }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(INFERENCE_TIMEOUT)]),
      });
      if (!response.ok) throw new Error(`Workers AI inference failed (${response.status})`);
      const payload = await response.json() as { choices?: Array<{ message?: AIMessage; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; miriad_cost_usd?: number };
      signal.throwIfAborted();
      this.usage.input_tokens += payload.usage?.prompt_tokens ?? 0;
      this.usage.output_tokens += payload.usage?.completion_tokens ?? 0;
      if (typeof payload.miriad_cost_usd === 'number' && Number.isFinite(payload.miriad_cost_usd) && payload.miriad_cost_usd >= 0) this.costUsd += payload.miriad_cost_usd;
      const choice = payload.choices?.[0];
      const assistant = choice?.message;
      if (!assistant || assistant.role !== 'assistant' || (assistant.content != null && typeof assistant.content !== 'string')) throw new Error('Workers AI returned an invalid assistant message');
      if (!['stop', 'tool_calls'].includes(choice?.finish_reason ?? '')) throw new Error(`Workers AI stopped before completing the response (${choice?.finish_reason ?? 'unknown'})`);
      const calls = assistant.tool_calls ?? [];
      if (!calls.length && choice?.finish_reason !== 'stop') throw new Error('Workers AI stopped for tool calls without returning any calls');
      if (!Array.isArray(calls) || calls.length > 16 || calls.some(call => !call.id || call.type !== 'function' || !call.function?.name || typeof call.function.arguments !== 'string') || new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('Workers AI returned invalid tool calls');
      const clean: AIMessage = { role: 'assistant', content: this.redact(assistant.content ?? ''), ...(calls.length ? { tool_calls: calls } : {}) };
      this.session.messages.push(clean);
      // Persist intent before side effects; crash recovery marks unrecorded outcomes unknown.
      await this.save();
      const blocks: unknown[] = clean.content ? [{ type: 'text', text: clean.content }] : [];
      for (const call of calls) {
        let input: unknown;
        try { input = JSON.parse(call.function.arguments); } catch { input = { invalid_json: call.function.arguments }; }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      this.emit({ type: 'assistant', session_id: this.session.id, parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', content: blocks, model: this.environment.MIRIAD_AI_MODEL ?? 'Workers AI' } });
      if (!calls.length) {
        if (!clean.content) throw new Error('Workers AI returned an empty completion');
        this.emit({ type: 'result', subtype: 'success', is_error: false, session_id: this.session.id, result: clean.content, num_turns: round + 1, duration_ms: Date.now() - started, total_cost_usd: this.costUsd, usage: this.usage });
        return;
      }
      for (const call of calls) {
        signal.throwIfAborted();
        let result: ToolResult;
        try {
          const args = JSON.parse(call.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
          result = await this.executeTool(call.function.name, args, signal);
        } catch (error) {
          signal.throwIfAborted();
          result = { text: error instanceof Error ? error.message : String(error), error: true };
        }
        const text = this.redact(bounded(result.text));
        this.session.messages.push({ role: 'tool', tool_call_id: call.id, content: `${result.error ? 'Tool error: ' : ''}${text}` });
        await this.save();
        this.emit({ type: 'user', session_id: this.session.id, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: text, is_error: !!result.error }] } });
      }
    }
    throw new Error(`Workers AI stopped at the ${MAX_ROUNDS}-round tool limit before completing the task`);
  }

  private emitAssistant(text: string): void {
    this.emit({ type: 'assistant', session_id: this.session.id, parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], model: 'Workers AI' } });
  }

  private async executeTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const mcp = this.mcpTools.get(name);
    if (mcp) {
      const result = await mcp.client.callTool({ name: mcp.name, arguments: args }, undefined, { signal, timeout: 120_000 });
      // Keep structuredContent and non-text content in the serialized result rather than silently dropping them.
      return { text: JSON.stringify(result), error: result.isError === true };
    }
    if (name === 'Bash') {
      if (typeof args.command !== 'string') throw new Error('Bash requires a command string');
      return this.bash(args.command, typeof args.timeout_ms === 'number' ? args.timeout_ms : 60_000, signal);
    }
    if (!['Read', 'Write', 'Edit'].includes(name)) throw new Error(`Unknown tool: ${name}`);
    if (typeof args.path !== 'string' || !args.path) throw new Error(`${name} requires a path`);
    const path = resolve(this.config.workspacePath, args.path);
    if (name === 'Write') {
      if (typeof args.content !== 'string') throw new Error('Write requires string content');
      signal.throwIfAborted();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, args.content, { signal });
      return { text: `Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}` };
    }
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Read and Edit require a regular file');
    if (info.size > 2_000_000) throw new Error('File exceeds the 2 MB reading limit; use Bash for a targeted excerpt');
    const contents = await readFile(path, { encoding: 'utf8', signal });
    signal.throwIfAborted();
    if (name === 'Read') {
      const offset = typeof args.offset === 'number' ? Math.max(1, Math.floor(args.offset)) : 1;
      const limit = typeof args.limit === 'number' ? Math.min(500, Math.max(1, Math.floor(args.limit))) : 200;
      return { text: contents.split('\n').slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join('\n') };
    }
    if (typeof args.old_string !== 'string' || !args.old_string || typeof args.new_string !== 'string') throw new Error('Edit requires a nonempty old_string and string new_string');
    if (contents.indexOf(args.old_string) < 0 || contents.indexOf(args.old_string) !== contents.lastIndexOf(args.old_string)) throw new Error('Edit requires exactly one match');
    await writeFile(path, contents.replace(args.old_string, () => args.new_string as string), { signal });
    return { text: `Edited ${args.path}` };
  }

  private bash(command: string, requestedTimeout: number, signal: AbortSignal): Promise<ToolResult> {
    return new Promise((resolvePromise, reject) => {
      signal.throwIfAborted();
      const child = spawn('/bin/bash', ['-lc', command], { cwd: this.config.workspacePath, env: this.childEnvironment(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let timedOut = false;
      const append = (chunk: Buffer) => { output = bounded(output + chunk.toString('utf8')); };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const kill = () => {
        try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* process already exited */ }
      };
      const abort = () => kill();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => { timedOut = true; kill(); }, Math.min(120_000, Math.max(1, Number.isFinite(requestedTimeout) ? requestedTimeout : 60_000)));
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', (code) => {
        cleanup();
        if (signal.aborted) { reject(signal.reason); return; }
        resolvePromise({ text: `${output}${timedOut ? '\nCommand timed out; process group killed.' : `\nExit code: ${code}`}`, error: timedOut || code !== 0 });
      });
      if (signal.aborted) kill();
    });
  }

  async terminate(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this._state = 'terminated';
    this.queue = [];
    this.abort?.abort(new Error('Agent terminated'));
    await this.active;
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value: undefined!, done: true }); }
    for (const handler of this.exitHandlers) handler(0);
  }
  onExit(handler: (code: number | null) => void): void { this.exitHandlers.push(handler); }
}

export class WorkersAIEngine implements AgentEngine {
  readonly engineId = 'workers-ai';
  readonly displayName = 'Cloudflare Workers AI';
  async isAvailable(): Promise<boolean> { return !!process.env.MIRIAD_AI_URL && !!process.env.MIRIAD_AI_TOKEN; }
  async spawn(config: EngineConfig): Promise<EngineProcess> {
    const process = new WorkersAIProcess(config);
    await process.initialize();
    return process;
  }
}

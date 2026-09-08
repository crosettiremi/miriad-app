import { verifyCheckpoint, deleteCheckpoint } from './checkpoint.js';
import { inferenceInput, MAX_INFERENCE_BYTES, runWorkersAI, type InferenceInput } from './workers-ai.js';
import { getSandbox, type DirectoryBackup } from '@cloudflare/sandbox';
import {
  Agent,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from 'agents';
import { isSetFrame } from '@cast/core';
import { parseAgentId } from '@cast/runtime';
import {
  createRuntimeProtocolHandlers,
  type AgentFrameMessage,
  type RuntimeConnectionState,
  type RuntimeToBackendMessage,
} from '@cast/server/runtimes/runtime-protocol-handlers';
import type { Storage } from '@cast/storage';
import { openStorage } from './postgres.js';
import { authorizeChannel, type Principal } from './auth.js';

type SocketState = Principal & { channelId?: string; runtimeId?: string };
/** Private operational state only. No @callable methods: browser RPC is forbidden. */
export class SpaceAgent extends Agent<Env> {
  private activeModelRequests = 0;

  // Internal binding RPC only: intentionally not @callable on browser sockets.
  async inferModel(principal: Principal, raw: InferenceInput) {
    if (principal.role !== 'runtime' || principal.spaceId !== this.name ||
        principal.expiresAt <= Date.now())
      return { status: 403, body: { error: 'Runtime access denied' } };
    const input = inferenceInput.parse(raw);
    if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_INFERENCE_BYTES)
      return { status: 400, body: { error: 'Model input too large' } };
    if (this.activeModelRequests >= 4)
      return { status: 429, body: { error: 'Model concurrency limit reached' } };
    this.activeModelRequests++;
    try {
      const allowed = await this.ctx.storage.transaction(async (tx) => {
        const minute = Math.floor(Date.now() / 60000);
        const previous = await tx.get<{ minute: number; count: number }>('aiRate');
        const count = previous?.minute === minute ? previous.count : 0;
        if (count >= 60) return false;
        await tx.put('aiRate', { minute, count: count + 1 });
        return true;
      });
      if (!allowed) return { status: 429, body: { error: 'Model request rate limit reached' } };
      return { status: 200, body: await runWorkersAI(this.env, input) };
    } catch (error) {
      console.error('Workers AI inference failed', error instanceof Error ? error.name : 'Error');
      return { status: 502, body: { error: 'Workers AI inference failed; retry the turn' } };
    } finally { this.activeModelRequests--; }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const principal: Principal = JSON.parse(
        request.headers.get('x-miriad-principal') ?? 'null',
      );
      if (
        !principal ||
        principal.spaceId !== this.name ||
        !principal.userId ||
        !['browser', 'runtime'].includes(principal.role) ||
        !Number.isFinite(principal.expiresAt) ||
        principal.expiresAt <= Date.now()
      )
        return new Response('Unauthorized', { status: 403 });
    } catch {
      return new Response('Unauthorized', { status: 403 });
    }
    return super.fetch(request);
  }
  shouldSendProtocolMessages() {
    return false;
  }
  validateStateChange(_state: unknown, source: Connection | 'server') {
    if (source !== 'server')
      throw new Error('Client state updates are forbidden');
  }
  private async withStorage<T>(
    run: (storage: Storage) => Promise<T>,
  ): Promise<T> {
    const url = this.env.HYPERDRIVE?.connectionString ?? this.env.DATABASE_URL;
    if (!url) throw new Error('PostgreSQL is not configured');
    const db = openStorage(url);
    try {
      return await run(db.storage);
    } finally {
      await db.close();
    }
  }
  async onConnect(
    connection: Connection<SocketState>,
    context: ConnectionContext,
  ) {
    // Only the authenticated Worker can reach this binding. It replaces this header.
    const raw = context.request.headers.get('x-miriad-principal');
    if (!raw) {
      connection.close(1008, 'Unauthorized');
      return;
    }
    const principal: Principal = JSON.parse(raw);
    if (principal.spaceId !== this.name || principal.expiresAt <= Date.now()) {
      connection.close(1008, 'Unauthorized');
      return;
    }
    const channelId =
      new URL(context.request.url).searchParams.get('threadId') ?? undefined;
    connection.setState({ ...principal, channelId });
  }
  async broadcastChannel(channelId: string, frame: string) {
    await this.withStorage((storage) =>
      authorizeChannel(storage, this.name, channelId),
    );
    for (const connection of this.getConnections<SocketState>()) {
      if (
        connection.state?.role === 'browser' &&
        connection.state.channelId === channelId &&
        connection.state.expiresAt > Date.now()
      )
        connection.send(frame);
    }
  }
  async sendRuntime(connectionId: string, data: string): Promise<boolean> {
    const connection = this.getConnection<SocketState>(connectionId);
    if (
      !connection?.state ||
      connection.state.role !== 'runtime' ||
      connection.state.expiresAt <= Date.now()
    )
      return false;
    const message = JSON.parse(data);
    if (
      typeof message.agentId === 'string' &&
      parseAgentId(message.agentId).spaceId !== this.name
    )
      throw new Error('Cross-space runtime command');
    if (message.type === 'message' && message.agentId) {
      const active =
        (await this.ctx.storage.get<string[]>('activeAgents')) ?? [];
      await this.ctx.storage.put({
        activeAgents: [...new Set([...active, message.agentId])],
        lastActivity: Date.now(),
      });
    }
    connection.send(data);
    return true;
  }
  async onMessage(connection: Connection<SocketState>, message: WSMessage) {
    try {
      const state = connection.state;
      if (
        !state ||
        state.spaceId !== this.name ||
        state.expiresAt <= Date.now()
      ) {
        connection.close(1008, 'Session expired');
        return;
      }
      if (
        typeof message !== 'string' ||
        new TextEncoder().encode(message).byteLength > 1024 * 1024
      ) {
        connection.close(1009, 'Invalid frame');
        return;
      }
      const parsed = JSON.parse(message);
      await this.withStorage(async (storage) => {
        if (state.role === 'browser') {
          const space = await storage.getSpace(this.name);
          if (space?.ownerId !== state.userId)
            throw new Error('Access revoked');
          if (
            parsed.request !== 'sync' ||
            (parsed.channelId !== undefined &&
              typeof parsed.channelId !== 'string')
          )
            throw new Error('Only sync requests are accepted');
          const channelId = parsed.channelId ?? state.channelId;
          if (!channelId) throw new Error('Channel is required');
          await authorizeChannel(storage, this.name, channelId);
          const limit = Math.min(
            100,
            Math.max(1, Number.isInteger(parsed.limit) ? parsed.limit : 25),
          );
          const messages = await storage.getMessages(this.name, channelId, {
            since: parsed.since,
            before: parsed.before,
            limit,
            newestFirst: !parsed.since && !parsed.before,
            includeToolCalls: true,
          });
          connection.setState({ ...state, channelId });
          const frames = messages.map((m) => {
            const structured =
              m.type === 'tool_call' || m.type === 'tool_result';
            const value = structured
              ? typeof m.content === 'string'
                ? JSON.parse(m.content)
                : m.content
              : { content: m.content };
            return JSON.stringify({
              i: m.id,
              t: m.timestamp,
              c: channelId,
              v: {
                ...value,
                type: m.type,
                sender: m.sender,
                senderType: m.senderType,
                ...m.metadata,
              },
            });
          });
          frames.push(
            JSON.stringify({
              sync: new Date().toISOString(),
              hasMore: messages.length >= limit,
              oldestId: messages[0]?.id,
            }),
          );
          connection.send(frames.join('\n'));
          return;
        }
        const server = state.serverId
          ? await storage.getLocalAgentServer(state.serverId)
          : null;
        if (!server || server.spaceId !== this.name || server.revokedAt)
          throw new Error('Runtime access revoked');
        const protocol = createRuntimeProtocolHandlers({
          storage,
          broadcast: (channel, frame) => this.broadcastChannel(channel, frame),
          send: async (id, data) => {
            const target = this.getConnection(id);
            if (!target) return false;
            target.send(data);
            return true;
          },
          sendError: async (_id, code, error) => {
            connection.send(JSON.stringify({ error: code, message: error }));
          },
        });
        const context = {
          connectionId: connection.id,
          channelId: '',
          protocol: 'runtime' as const,
          runtimeId: state.runtimeId ?? null,
          spaceId: this.name,
          serverId: state.serverId,
        };
        const event = parsed as RuntimeToBackendMessage;
        if (event.type === 'runtime_ready') {
          if (event.spaceId !== this.name)
            throw new Error('Cross-space registration');
          const existing = await storage.getRuntime(event.runtimeId);
          if (existing && existing.spaceId !== this.name)
            throw new Error('Cross-space runtime');
          const result = await protocol.handleRuntimeReady(context, event);
          if (result.success)
            connection.setState({ ...state, runtimeId: result.runtimeId });
          return;
        }
        if (event.type === 'pong') return;
        if (!state.runtimeId || !('agentId' in event))
          throw new Error('Unregistered runtime');
        const agent = parseAgentId(event.agentId);
        if (agent.spaceId !== this.name) throw new Error('Cross-space frame');
        await authorizeChannel(storage, this.name, agent.channelId);
        const roster = await storage.getRosterByCallsign(
          agent.channelId,
          agent.callsign,
        );
        if (!roster || roster.runtimeId !== state.runtimeId)
          throw new Error('Agent is not assigned to this runtime');
        if (event.type === 'agent_checkin')
          await protocol.handleAgentCheckin(context, event);
        else if (event.type === 'agent_heartbeat')
          await protocol.handleAgentHeartbeat(context, event);
        else if (event.type === 'frame') {
          if ('c' in event.frame && event.frame.c !== agent.channelId)
            throw new Error('Cross-channel frame');
          if (isSetFrame(event.frame)) {
            const operationId = `${state.runtimeId}:${event.frame.i}`;
            const key = `pending:${operationId}`;
            await this.ctx.storage.put(key, { context, event });
            await this.commitFrame(context, event, operationId);
            await this.ctx.storage.delete(key);
            connection.send(JSON.stringify({ type: 'frame_ack', operationId }));
          } else await protocol.handleFrame(context, event);
          await this.ctx.storage.put('lastActivity', Date.now());
          if (
            'v' in event.frame &&
            event.frame.v &&
            typeof event.frame.v === 'object' &&
            ['idle', 'error'].includes(String(event.frame.v.type))
          ) {
            const active =
              (await this.ctx.storage.get<string[]>('activeAgents')) ?? [];
            await this.ctx.storage.put(
              'activeAgents',
              active.filter((id) => id !== event.agentId),
            );
          }
        } else throw new Error('Unsupported runtime message');
      });
    } catch {
      connection.send(
        JSON.stringify({
          error: 'invalid_message',
          message: 'Message rejected',
        }),
      );
    }
  }
  async onClose(connection: Connection<SocketState>) {
    const runtimeId = connection.state?.runtimeId;
    if (!runtimeId) return;
    await this.withStorage(async (storage) => {
      const runtime = await storage.getRuntime(runtimeId);
      if (
        runtime?.spaceId === this.name &&
        (runtime.config as { wsConnectionId?: string })?.wsConnectionId ===
          connection.id
      ) {
        await storage.updateRuntime(runtimeId, {
          status: 'offline',
          config: { wsConnectionId: null },
        });
      }
    });
  }
  private async commitFrame(
    context: RuntimeConnectionState,
    event: AgentFrameMessage,
    operationId: string,
  ) {
    const url = this.env.HYPERDRIVE?.connectionString ?? this.env.DATABASE_URL;
    if (!url) throw new Error('PostgreSQL is not configured');
    const db = openStorage(url);
    const channelId = parseAgentId(event.agentId).channelId;
    try {
      await db.transaction(async (storage, sql) => {
        const inserted =
          await sql`INSERT INTO runtime_frame_receipts(space_id,operation_id) VALUES (${this.name},${operationId}) ON CONFLICT DO NOTHING RETURNING operation_id`;
        if (!inserted.length) return;
        const handlers = createRuntimeProtocolHandlers({
          storage,
          strictPersistence: true,
          broadcast: async () => {},
          send: async () => true,
          sendError: async () => {
            throw new Error('Frame persistence rejected');
          },
        });
        await handlers.handleFrame(context, event);
      });
      await this.broadcastChannel(
        channelId,
        JSON.stringify({ ...event.frame, c: channelId }),
      );
    } finally {
      await db.close();
    }
  }
  async onStart() {
    const pending = await this.ctx.storage.list<{
      context: RuntimeConnectionState;
      event: AgentFrameMessage;
    }>({ prefix: 'pending:', limit: 100 });
    for (const [key, record] of pending) {
      await this.commitFrame(record.context, record.event, key.slice(8));
      await this.ctx.storage.delete(key);
    }
  }
  private lifecycleQueue: Promise<unknown> = Promise.resolve();
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = next.catch(() => {});
    return next;
  }
  async runtimeStatus() {
    const phase = (await this.ctx.storage.get<string>('phase')) ?? 'stopped';
    const runtime = await this.withStorage((storage) =>
      storage.getRuntimeByName(this.name, 'miriad-cloud'),
    );
    return {
      available: true,
      modelProvider: this.env.HOSTED_ENGINE === 'workers-ai' ? 'workers-ai' : 'anthropic',
      model: this.env.HOSTED_ENGINE === 'workers-ai' ? this.env.WORKERS_AI_MODEL : null,
      requiresApiKey: this.env.HOSTED_ENGINE !== 'workers-ai',
      runtime,
      container: { status: phase, provider: 'cloudflare' },
    };
  }
  async startHosted(userId: string) {
    return this.serialize(async () => {
      await this.withStorage(async (storage) => {
        if ((await storage.getSpace(this.name))?.ownerId !== userId)
          throw new Error('Space access denied');
        if (
          this.env.HOSTED_ENGINE !== 'workers-ai' &&
          !(await storage.getSpaceSecretValue(
            this.name,
            'anthropic_api_key',
          )) &&
          !this.env.ANTHROPIC_API_KEY
        )
          throw new Error('Configure a Claude API key');
      });
      const sandbox = getSandbox(this.env.SANDBOX, this.name, {
        sleepAfter: '20m',
      });
      const phase = await this.ctx.storage.get<string>('phase');
      // Recover interrupted starts by inspecting the stable process ID before restoring files.
      if (
        ['starting', 'failed', 'running', 'recovery_required'].includes(
          phase ?? '',
        )
      ) {
        const processes = await sandbox.listProcesses();
        if (
          processes.some(
            (p) => p.id === 'miriad-runtime' && p.status === 'running',
          )
        ) {
          await this.ctx.storage.put('phase', 'running');
          await sandbox.setKeepAlive(true);
          if (!this.getSchedules().some((s) => s.callback === 'maintainHosted'))
            await this.schedule(60, 'maintainHosted');
          return this.runtimeStatus();
        }
      }
      await this.ctx.storage.put('phase', 'starting');
      try {
        await sandbox.setKeepAlive(true);
        const backup =
          await this.ctx.storage.get<DirectoryBackup>('checkpoint');
        if (backup) await sandbox.restoreBackup(backup);
        else await sandbox.mkdir('/workspace', { recursive: true });
        const initialized = await sandbox.exec(
          'chown -R agent:agent /workspace',
        );
        if (!initialized.success)
          throw new Error('Workspace ownership initialization failed');
        await this.withStorage(async (storage) => {
          const space = await storage.getSpace(this.name);
          if (space?.ownerId !== userId) throw new Error('Space access denied');
          const anthropicKey =
            (await storage.getSpaceSecretValue(
              this.name,
              'anthropic_api_key',
            )) ?? this.env.ANTHROPIC_API_KEY;
          if (this.env.HOSTED_ENGINE !== 'workers-ai' && !anthropicKey)
            throw new Error('Configure the Claude API key in Settings');
          let serverId = await this.ctx.storage.get<string>('hostedServerId');
          let server = serverId
            ? await storage.getLocalAgentServer(serverId)
            : null;
          if (!server || server.revokedAt) {
            serverId = `srv_${crypto.randomUUID()}`;
            server = await storage.saveLocalAgentServer({
              serverId,
              spaceId: this.name,
              userId,
              secret: `sk_cast_${crypto.randomUUID()}${crypto.randomUUID()}`,
            });
            await this.ctx.storage.put('hostedServerId', serverId);
          }
          let runtime = await storage.getRuntimeByName(
            this.name,
            'miriad-cloud',
          );
          if (!runtime)
            runtime = await storage.createRuntime({
              spaceId: this.name,
              serverId: server.serverId,
              name: 'miriad-cloud',
              type: 'local',
              status: 'offline',
              config: { wsConnectionId: null },
            });
          const origin = this.env.RUNTIME_ORIGIN;
          if (!origin) throw new Error('RUNTIME_ORIGIN is required');
          const config = {
            spaceId: this.name,
            name: 'miriad-cloud',
            credentials: {
              runtimeId: runtime.id,
              serverId: server.serverId,
              secret: server.secret,
              apiUrl: origin,
              wsUrl: origin.replace(/^http/, 'ws'),
            },
            workspace: { basePath: '/workspace' },
          };
          await sandbox.startProcess(
            'runuser -u agent -- node /opt/miriad/dist/cli.js start',
            {
              processId: 'miriad-runtime',
              autoCleanup: false,
              env: {
                MIRIAD_RELIABLE_FRAMES: '1',
                MIRIAD_CONFIG: JSON.stringify(config),
                ...(this.env.HOSTED_ENGINE === 'workers-ai' ? {
                  MIRIAD_ENGINE: 'workers-ai',
                  MIRIAD_AI_URL: `${origin}/api/ai/chat/completions`,
                  MIRIAD_AI_TOKEN: server.secret,
                  MIRIAD_AI_MODEL: this.env.WORKERS_AI_MODEL,
                } : { ANTHROPIC_API_KEY: anthropicKey! }),
                CLAUDE_CONFIG_DIR: '/workspace/.claude',
                HOME: '/home/agent',
              },
            },
          );
        });
        await this.ctx.storage.put('phase', 'running');
        await this.ctx.storage.put({
          lastActivity: Date.now(),
          activeAgents: [],
          checkpointFailures: 0,
        });
        await this.schedule(60, 'maintainHosted');
        return this.runtimeStatus();
      } catch (error) {
        await this.ctx.storage.put('phase', 'failed');
        await sandbox.setKeepAlive(false);
        throw error;
      }
    });
  }
  private async checkpointWorkspace(resume = true) {
    const sandbox = getSandbox(this.env.SANDBOX, this.name);
    // Pause every process owned by the runtime user, including detached preview writers.
    const paused = await sandbox.exec('pkill -STOP -u agent');
    if (!paused.success) throw new Error('Cannot quiesce workspace writers');
    let committed = false;
    try {
      const backup = await sandbox.createBackup({
        dir: '/workspace',
        gitignore: false,
        ttl: 315360000,
      });
      // SDK verifies archive upload size before returning. Publish the pointer last.
      const previous =
        await this.ctx.storage.get<DirectoryBackup>('checkpoint');
      const obsolete =
        await this.ctx.storage.get<DirectoryBackup>('previousCheckpoint');
      const generation =
        ((await this.ctx.storage.get<number>('generation')) ?? 0) + 1;
      const manifest = await verifyCheckpoint(
        this.env.BACKUP_BUCKET,
        backup,
        generation,
      );
      await this.ctx.storage.put({
        checkpoint: backup,
        previousCheckpoint: previous ?? null,
        generation,
        checkpointAt: Date.now(),
        checkpointManifest: manifest,
      });
      if (obsolete) await deleteCheckpoint(this.env.BACKUP_BUCKET, obsolete);
      committed = true;
    } finally {
      const resumed =
        resume || !committed
          ? await sandbox.exec('pkill -CONT -u agent')
          : { success: true };
      if (!resumed.success) throw new Error('Cannot resume workspace writers');
    }
  }
  async stopHosted() {
    return this.serialize(async () => {
      if ((await this.ctx.storage.get<string>('phase')) === 'stopped')
        return this.runtimeStatus();
      const sandbox = getSandbox(this.env.SANDBOX, this.name);
      await this.ctx.storage.put('phase', 'stopping');
      let destroyed = false;
      try {
        await this.checkpointWorkspace(false);
        await sandbox.destroy();
        destroyed = true;
        await this.ctx.storage.put('phase', 'stopped');
        await this.withStorage(async (storage) => {
          const runtime = await storage.getRuntimeByName(
            this.name,
            'miriad-cloud',
          );
          if (runtime)
            await storage.updateRuntime(runtime.id, {
              status: 'offline',
              config: { wsConnectionId: null },
            });
        });
        await this.ctx.storage.put('phase', 'stopped');
        const grants = await this.ctx.storage.list({ prefix: 'preview:' });
        if (grants.size) await this.ctx.storage.delete([...grants.keys()]);
        return this.runtimeStatus();
      } catch (error) {
        // Database cleanup can fail after destruction; never label a destroyed runtime running.
        if (!destroyed) {
          const resumed = await sandbox
            .exec('pkill -CONT -u agent')
            .catch(() => ({ success: false }));
          await this.ctx.storage.put(
            'phase',
            resumed.success ? 'running' : 'recovery_required',
          );
          if (
            resumed.success &&
            !this.getSchedules().some((s) => s.callback === 'maintainHosted')
          )
            await this.schedule(60, 'maintainHosted');
        }
        throw error;
      }
    });
  }
  async maintainHosted() {
    if ((await this.ctx.storage.get<string>('phase')) !== 'running') return;
    try {
      await this.serialize(() => this.checkpointWorkspace());
      await this.ctx.storage.put('checkpointFailures', 0);
      const last =
        (await this.ctx.storage.get<number>('lastActivity')) ?? Date.now();
      const active =
        (await this.ctx.storage.get<string[]>('activeAgents')) ?? [];
      if (!active.length && Date.now() - last > 15 * 60_000) {
        await this.stopHosted();
        return;
      }
    } catch {
      const failures =
        ((await this.ctx.storage.get<number>('checkpointFailures')) ?? 0) + 1;
      await this.ctx.storage.put('checkpointFailures', failures);
      if (failures >= 3) {
        await this.ctx.storage.put('phase', 'recovery_required');
        await getSandbox(this.env.SANDBOX, this.name).setKeepAlive(false);
      }
    } finally {
      if ((await this.ctx.storage.get<string>('phase')) === 'running')
        await this.schedule(60, 'maintainHosted');
    }
  }
  async grantPreview(id: string, port: number, expiry: number) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000)
      throw new Error('Invalid preview port');
    if ((await this.ctx.storage.get<string>('phase')) !== 'running')
      throw new Error('Start the hosted runtime first');
    await this.ctx.storage.put(`preview:${id}`, { port, expiry });
  }
  async hasPreviewGrant(id: string, port: number) {
    const grant = await this.ctx.storage.get<{ port: number; expiry: number }>(
      `preview:${id}`,
    );
    return (
      !!grant &&
      grant.port === port &&
      grant.expiry * 1000 > Date.now() &&
      (await this.ctx.storage.get<string>('phase')) === 'running'
    );
  }
  async revokePreview(id: string) {
    await this.ctx.storage.delete(`preview:${id}`);
  }
  async proxyPreview(request: Request, port: number, id: string) {
    if (!(await this.hasPreviewGrant(id, port)))
      return new Response('Preview revoked', { status: 403 });
    const url = new URL(request.url);
    url.hostname = 'localhost';
    url.port = String(port);
    url.protocol = 'http:';
    return getSandbox(this.env.SANDBOX, this.name).containerFetch(
      new Request(url, request),
      port,
    );
  }
  async onRequest() {
    return new Response('Not found', { status: 404 });
  }
}

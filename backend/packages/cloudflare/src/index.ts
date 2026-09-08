import {
  verifyAccess,
  accessSessionRequest,
  externalAccessId,
  provisionAccessUser,
} from './access.js';
import { isPreviewHost, servePreview, createPreview } from './previews.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getAgentByName } from 'agents';
import { createApp } from '@cast/server/app-core';
import { authenticate } from './auth.js';
import { readInferenceInput } from './workers-ai.js';
import { openStorage } from './postgres.js';
import { createR2AssetStorage } from './r2-assets.js';
import { createBridge } from './bridge.js';
export { Sandbox } from '@cloudflare/sandbox';
export { SpaceAgent } from './space-agent.js';
const apiPath =
  /^\/(auth|api|channels|agents|assets|mcp|tymbal|focus-types|agent-types|kb|disclaimer|boards|thread|initialize-root-channel)(\/|$)/;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (isPreviewHost(url.hostname, env.PREVIEW_DOMAIN))
      return servePreview(request, env);
    const websocket =
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    if (url.pathname === '/health')
      return Response.json({
        status:
          env.HYPERDRIVE && env.JWT_SECRET
            ? 'configured'
            : 'configuration_required',
        service: 'miriad-cloudflare',
      });
    const runtimeHost =
      !!env.RUNTIME_ORIGIN && url.origin === env.RUNTIME_ORIGIN;
    if (!runtimeHost && url.origin !== env.APP_ORIGIN)
      return new Response('Unknown application origin', { status: 404 });
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
      return new Response('Cloudflare Access configuration required', {
        status: 503,
      });
    const identity = runtimeHost ? null : await verifyAccess(request, env);
    if (!runtimeHost && !identity)
      return new Response('Cloudflare Access authentication required', {
        status: 401,
      });
    if (runtimeHost) {
      // No browser sessions or public auth endpoints on the machine-only origin.
      const auth = request.headers.get('Authorization') ?? '';
      if (
        !/^(Server|Container) .+/.test(auth) ||
        url.pathname.startsWith('/auth/') ||
        url.pathname === '/api/runtimes/auth/bootstrap'
      )
        return new Response('Machine credentials required', { status: 401 });
      const headers = new Headers(request.headers);
      headers.delete('Cookie');
      request = new Request(request, { headers });
    }
    if (!websocket && !apiPath.test(url.pathname))
      return runtimeHost
        ? new Response('Not found', { status: 404 })
        : env.ASSETS.fetch(request);
    if (identity && url.pathname === '/auth/logout') {
      const logoutUrl = `${env.APP_ORIGIN}/cdn-cgi/access/logout`;
      const headers = {
        'Set-Cookie':
          'cast_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
        'Cache-Control': 'no-store',
      };
      return request.method === 'POST'
        ? Response.json({ ok: true, logoutUrl }, { headers })
        : new Response(null, {
            status: 302,
            headers: { ...headers, Location: logoutUrl },
          });
    }
    const databaseUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    if (!databaseUrl || !env.JWT_SECRET)
      return Response.json(
        { error: 'Staging database configuration required' },
        { status: 503 },
      );
    const origin = request.headers.get('Origin');
    if (origin && origin !== env.APP_ORIGIN)
      return new Response('Origin not allowed', { status: 403 });
    const bootstrap = url.pathname === '/api/runtimes/auth/bootstrap';
    if (
      !bootstrap &&
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      !request.headers.has('Authorization') &&
      origin !== env.APP_ORIGIN
    )
      return new Response('Origin required', { status: 403 });
    const db = openStorage(databaseUrl);
    try {
      if (identity) {
        let userId = '',
          spaceId = '';
        await db.transaction(async (storage, sql) => {
          const key = externalAccessId(identity);
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          const profile = await provisionAccessUser(storage, identity);
          userId = profile.user.id;
          spaceId = profile.space.id;
        });
        request = await accessSessionRequest(
          request,
          userId,
          spaceId,
          identity,
          env.JWT_SECRET,
        );
        if (url.pathname === '/auth/login')
          return new Response(null, {
            status: 302,
            headers: { Location: env.APP_ORIGIN!, 'Cache-Control': 'no-store' },
          });
      }
      const principal = await authenticate(
        request,
        db.storage,
        env.JWT_SECRET,
        'access',
      );
      if (runtimeHost && (!principal || principal.role === 'browser'))
        return new Response('Unauthorized', { status: 401 });
      if (url.pathname === '/api/ai/chat/completions') {
        if (!runtimeHost || principal?.role !== 'runtime')
          return new Response('Runtime credentials required', { status: 401 });
        if (request.method !== 'POST')
          return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        let input;
        try { input = await readInferenceInput(request); }
        catch { return Response.json({ error: 'Invalid or oversized model request' }, { status: 400 }); }
        const agent = await getAgentByName(env.SPACES, principal.spaceId);
        const result = await agent.inferModel(principal, input);
        return Response.json(result.body, {
          status: result.status,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      if (websocket) {
        if (!principal || principal.role === 'container')
          return new Response('Unauthorized', { status: 401 });
        const headers = new Headers(request.headers);
        headers.set('x-miriad-principal', JSON.stringify(principal));
        const agent = await getAgentByName(env.SPACES, principal.spaceId);
        return await agent.fetch(new Request(request, { headers }));
      }
      if (url.pathname === '/api/previews' && request.method === 'POST') {
        if (!principal || principal.role === 'container')
          return new Response('Unauthorized', { status: 401 });
        if (Number(request.headers.get('Content-Length') ?? 0) > 1024)
          return new Response('Request too large', { status: 413 });
        const reader = request.body?.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        if (reader)
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 1024) {
              await reader.cancel();
              return new Response('Request too large', { status: 413 });
            }
            parts.push(chunk.value);
          }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        const input = JSON.parse(new TextDecoder().decode(bytes)) as {
          port: number;
        };
        return Response.json(
          await createPreview(env, principal.spaceId, input.port),
        );
      }
      if (
        url.pathname.startsWith('/api/previews/') &&
        request.method === 'DELETE'
      ) {
        if (!principal || principal.role !== 'browser')
          return new Response('Unauthorized', { status: 401 });
        await (
          await getAgentByName(env.SPACES, principal.spaceId)
        ).revokePreview(url.pathname.split('/').pop()!);
        return new Response(null, { status: 204 });
      }
      const publicAuth = false; // Access verification precedes every browser API request.
      if (!principal && !publicAuth)
        return new Response('Unauthorized', { status: 401 });
      // Container routes perform their own signed token authorization in the shared API.
      const spaceId = principal?.spaceId ?? '';
      const hosted = new Hono();
      hosted.all('*', async (c) => {
        if (!principal || principal.role !== 'browser')
          return c.json({ error: 'Unauthorized' }, 401);
        const agent = await getAgentByName(env.SPACES, principal.spaceId);
        if (c.req.path.endsWith('/status'))
          return c.json(await agent.runtimeStatus());
        if (c.req.method === 'POST' && c.req.path.endsWith('/start'))
          return c.json(await agent.startHosted(principal.userId));
        if (c.req.method === 'POST' && c.req.path.endsWith('/stop'))
          return c.json(await agent.stopHosted());
        return c.json({ error: 'Not found' }, 404);
      });
      const app = createApp({
        platformMcpUrl: env.RUNTIME_ORIGIN,
        storage: db.storage,
        ...createBridge(env, db.storage, spaceId),
        assetStorage: createR2AssetStorage(env.ASSET_BUCKET, spaceId),
        hostedRuntimeRoutes: hosted,
      });
      const bounded = new Hono();
      bounded.use('*', bodyLimit({ maxSize: 12 * 1024 * 1024 }));
      bounded.all('*', (c) => app.fetch(c.req.raw));
      return await bounded.fetch(request);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'request_failed',
          path: url.pathname,
          error: error instanceof Error ? error.name : 'Error',
        }),
      );
      return Response.json({ error: 'Request failed' }, { status: 500 });
    } finally {
      await db.close();
    }
  },
} satisfies ExportedHandler<Env>;

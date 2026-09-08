import { sign, verify } from 'hono/jwt';
import { getAgentByName } from 'agents';
export function validPreviewPort(port: unknown): port is number {
  return (
    Number.isInteger(port) &&
    Number(port) >= 1024 &&
    Number(port) <= 65535 &&
    port !== 3000
  );
}
export function isPreviewHost(host: string, domain?: string) {
  return (
    !!domain &&
    host.endsWith('.' + domain) &&
    host.slice(0, -domain.length - 1).indexOf('.') === -1
  );
}
export async function createPreview(env: Env, spaceId: string, port: number) {
  if (!env.PREVIEW_DOMAIN || !env.PREVIEW_SECRET)
    throw new Error('Configure a separate wildcard preview domain and secret');
  if (!validPreviewPort(port)) throw new Error('Invalid preview port');
  const grantId = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await (
    await getAgentByName(env.SPACES, spaceId)
  ).grantPreview(grantId, port, exp);
  const ticket = await sign(
    { aud: 'miriad-preview', spaceId, port, grantId, exp },
    env.PREVIEW_SECRET,
    'HS256',
  );
  return {
    id: grantId,
    url: `https://${grantId}.${env.PREVIEW_DOMAIN}/?ticket=${encodeURIComponent(ticket)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}
export async function servePreview(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.PREVIEW_SECRET || !env.PREVIEW_DOMAIN)
    return new Response('Preview unavailable', { status: 503 });
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin)
    return new Response('Origin denied', { status: 403 });
  const ticket = url.searchParams.get('ticket');
  const token =
    ticket ??
    request.headers
      .get('Cookie')
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('__Host-miriad_preview='))
      ?.slice('__Host-miriad_preview='.length);
  if (!token)
    return new Response('Open this preview from Miriad again', { status: 401 });
  try {
    const p = await verify(token, env.PREVIEW_SECRET, 'HS256');
    if (
      p.aud !== 'miriad-preview' ||
      typeof p.spaceId !== 'string' ||
      typeof p.grantId !== 'string' ||
      !validPreviewPort(p.port) ||
      typeof p.exp !== 'number' ||
      p.exp * 1000 <= Date.now() ||
      url.hostname !== `${p.grantId}.${env.PREVIEW_DOMAIN}`
    )
      throw Error('Invalid preview token');
    const agent = await getAgentByName(env.SPACES, p.spaceId);
    if (!(await agent.hasPreviewGrant(p.grantId, p.port)))
      return new Response('Preview expired or revoked', { status: 403 });
    if (ticket) {
      url.searchParams.delete('ticket');
      return new Response(null, {
        status: 303,
        headers: {
          Location: url.toString(),
          'Set-Cookie': `__Host-miriad_preview=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, p.exp - Math.floor(Date.now() / 1000))}`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }
    const headers = new Headers(request.headers);
    headers.delete('Cookie');
    headers.delete('Authorization');
    headers.delete('x-miriad-principal');
    const upstream = await agent.proxyPreview(
      new Request(request, { headers }),
      p.port,
      p.grantId,
    );
    const outputHeaders = new Headers(upstream.headers);
    outputHeaders.delete('Set-Cookie');
    outputHeaders.set('Cache-Control', 'no-store');
    outputHeaders.set('Referrer-Policy', 'no-referrer');
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outputHeaders,
      ...(upstream.webSocket ? { webSocket: upstream.webSocket } : {}),
    });
  } catch {
    return new Response('Invalid preview authorization', { status: 403 });
  }
}

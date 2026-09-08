import { verifyContainerToken } from '@cast/server/auth/container-token';
import { verify } from 'hono/jwt';
import type { Storage } from '@cast/storage';
export interface Principal {
  spaceId: string;
  userId: string;
  role: 'browser' | 'runtime' | 'container';
  serverId?: string;
  expiresAt: number;
}
export async function authenticate(
  request: Request,
  storage: Storage,
  secret: string,
): Promise<Principal | null> {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Container ')) {
    const token = verifyContainerToken(authorization.slice(10));
    if (!token) return null;
    await authorizeChannel(storage, token.spaceId, token.channelId);
    const space = await storage.getSpace(token.spaceId);
    if (!space) return null;
    return {
      spaceId: token.spaceId,
      userId: space.ownerId,
      role: 'container',
      expiresAt: Date.now() + 3600_000,
    };
  }
  if (authorization?.startsWith('Server ')) {
    const server = await storage.getLocalAgentServerBySecret(
      authorization.slice(7),
    );
    if (!server) return null;
    return {
      spaceId: server.spaceId,
      userId: server.userId,
      role: 'runtime',
      serverId: server.serverId,
      expiresAt: Date.now() + 3600_000,
    };
  }
  const cookie = request.headers
    .get('Cookie')
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith('cast_session='))
    ?.slice(13);
  if (!cookie) return null;
  try {
    const p = await verify(cookie, secret, 'HS256');
    if (
      typeof p.userId !== 'string' ||
      typeof p.spaceId !== 'string' ||
      p.mode !== 'workos' ||
      typeof p.exp !== 'number' ||
      p.exp * 1000 <= Date.now()
    )
      return null;
    const space = await storage.getSpace(p.spaceId);
    if (!space || space.ownerId !== p.userId) return null;
    return {
      spaceId: p.spaceId,
      userId: p.userId,
      role: 'browser',
      expiresAt: p.exp * 1000,
    };
  } catch {
    return null;
  }
}
export async function authorizeChannel(
  storage: Storage,
  spaceId: string,
  channelId: string,
) {
  const channel = await storage.getChannelById(channelId);
  if (!channel || channel.spaceId !== spaceId)
    throw new Error('Channel access denied');
  return channel;
}

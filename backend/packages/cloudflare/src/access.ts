import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { sign } from 'hono/jwt';
import type { Storage } from '@cast/storage';
import { seedSpaceFromSanity } from '@cast/server/onboarding/seed';

export interface AccessIdentity {
  subject: string;
  email: string;
  issuer: string;
  expiresAt: number;
}
const keySets = new Map<string, JWTVerifyGetKey>();
export function accessIssuer(domain: string | undefined): string {
  if (!domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain))
    throw new Error(
      'ACCESS_TEAM_DOMAIN must be a Cloudflare Access team hostname',
    );
  return `https://${domain}`;
}
export async function verifyAccess(
  request: Request,
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD'>,
  keys?: JWTVerifyGetKey,
): Promise<AccessIdentity | null> {
  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
  if (!env.ACCESS_AUD) throw new Error('ACCESS_AUD is required');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  if (!keys) {
    keys = keySets.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      if (keySets.size >= 4) keySets.clear();
      keySets.set(issuer, keys);
    }
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'email', 'exp', 'iat'],
    });
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.email !== 'string' ||
      !payload.email.includes('@') ||
      typeof payload.exp !== 'number' ||
      payload.type !== 'app'
    )
      return null;
    return {
      subject: payload.sub,
      email: payload.email.toLowerCase(),
      issuer,
      expiresAt: payload.exp * 1000,
    };
  } catch {
    return null;
  }
}
export function externalAccessId(identity: AccessIdentity) {
  return `cloudflare-access:${identity.issuer}:${identity.subject}`;
}
/** Run under the caller's PostgreSQL transaction and per-identity advisory lock. Never link by email. */
export async function provisionAccessUser(
  storage: Storage,
  identity: AccessIdentity,
) {
  let user = await storage.getUserByExternalId(externalAccessId(identity));
  if (!user) {
    const callsign =
      identity.email
        .split('@')[0]
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .slice(0, 20) || 'owner';
    user = await storage.createUser({
      externalId: externalAccessId(identity),
      callsign,
      email: identity.email,
    });
  }
  let space = (await storage.getSpacesByOwner(user.id))[0];
  if (!space) {
    space = await storage.createSpace({
      ownerId: user.id,
      name: `${user.callsign}'s space`,
    });
    await seedSpaceFromSanity(storage, space.id);
  }
  return { user, space };
}
/** Internal-only session for existing Hono handlers, bounded by the Access token lifetime. */
export async function accessSessionRequest(
  request: Request,
  userId: string,
  spaceId: string,
  identity: AccessIdentity,
  secret: string,
) {
  const token = await sign(
    {
      userId,
      spaceId,
      mode: 'access',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(identity.expiresAt / 1000),
    },
    secret,
    'HS256',
  );
  const headers = new Headers(request.headers);
  const cookies = (headers.get('Cookie') ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith('cast_session='));
  headers.set('Cookie', [...cookies, `cast_session=${token}`].join('; '));
  // A browser-supplied machine authorization header must not change the verified identity.
  headers.delete('Authorization');
  return new Request(request, { headers });
}

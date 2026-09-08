import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { verify } from 'hono/jwt';
import {
  verifyAccess,
  accessSessionRequest,
  externalAccessId,
  accessIssuer,
} from './access.js';
const issuer = 'https://miriad-test.cloudflareaccess.com';
const env = {
  ACCESS_TEAM_DOMAIN: 'miriad-test.cloudflareaccess.com',
  ACCESS_AUD: 'miriad-audience',
};
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  pair = await generateKeyPair('RS256');
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'one', alg: 'RS256' }],
  });
});
async function token(
  overrides: Record<string, unknown> = {},
  signingKey = pair.privateKey,
) {
  return new SignJWT({
    sub: 'user-a',
    email: 'owner@example.com',
    type: 'app',
    iss: issuer,
    aud: env.ACCESS_AUD,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'one' })
    .sign(signingKey);
}
async function check(jwt: string) {
  return verifyAccess(
    new Request('https://os.example.com', {
      headers: { 'Cf-Access-Jwt-Assertion': jwt },
    }),
    env,
    keys,
  );
}
describe('Cloudflare Access identity', () => {
  it('verifies an application token', async () => {
    expect(await check(await token())).toMatchObject({
      subject: 'user-a',
      email: 'owner@example.com',
      issuer,
    });
  });
  it.each([
    { iss: 'https://foreign.cloudflareaccess.com' },
    { aud: 'another-app' },
    { exp: 1 },
    { email: undefined },
    { sub: undefined },
    { type: 'service' },
    { nbf: Math.floor(Date.now() / 1000) + 600 },
  ])('rejects invalid claims %j', async (claims) => {
    expect(await check(await token(claims))).toBeNull();
  });
  it('rejects forged signatures', async () => {
    const other = await generateKeyPair('RS256');
    expect(await check(await token({}, other.privateKey))).toBeNull();
  });
  it('does not trust identity headers or an app cookie without a signed assertion', async () => {
    expect(
      await verifyAccess(
        new Request('https://os.example.com', {
          headers: {
            'Cf-Access-Authenticated-User-Email': 'owner@example.com',
            Cookie: 'cast_session=forged',
          },
        }),
        env,
        keys,
      ),
    ).toBeNull();
  });
  it('rejects arbitrary certificate hosts', () => {
    expect(() => accessIssuer('attacker.example')).toThrow();
  });
  it('replaces supplied sessions and caps the internal session at Access expiry', async () => {
    const identity = (await check(await token()))!;
    const request = await accessSessionRequest(
      new Request('https://os.example.com', {
        headers: {
          Cookie: 'cast_session=attacker; other=ok',
          Authorization: 'Server attacker',
        },
      }),
      'user-a',
      'space-a',
      identity,
      'a-test-secret-at-least-32-characters',
    );
    expect(request.headers.has('Authorization')).toBe(false);
    expect(request.headers.get('Cookie')).not.toContain('attacker');
    const session = request.headers.get('Cookie')!.split('cast_session=')[1];
    expect(
      await verify(session, 'a-test-secret-at-least-32-characters', 'HS256'),
    ).toMatchObject({
      userId: 'user-a',
      spaceId: 'space-a',
      mode: 'access',
      exp: Math.floor(identity.expiresAt / 1000),
    });
    expect(externalAccessId(identity)).not.toContain(identity.email);
  });
});

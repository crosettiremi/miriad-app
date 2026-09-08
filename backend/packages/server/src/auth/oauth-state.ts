import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';

const lifetime = 15 * 60;
function cookieOptions(c: Context) {
  const secure = new URL(c.req.url).protocol === 'https:';
  return {
    name: secure ? '__Host-miriad_oauth_state' : 'miriad_oauth_state',
    options: { path: '/', httpOnly: true, secure, sameSite: 'Lax' as const },
  };
}
export function safeReturnPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\x00-\x20\x7f]/.test(value)
  )
    return '/';
  return value;
}
/** Signed state is bound to a host-only browser cookie and consumed on callback. */
export async function createOAuthState(
  c: Context,
  returnTo: unknown,
  secret: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const state = await sign(
    {
      type: 'oauth_state',
      nonce: crypto.randomUUID(),
      returnTo: safeReturnPath(returnTo),
      iat: now,
      exp: now + lifetime,
    },
    secret,
    'HS256',
  );
  const cookie = cookieOptions(c);
  setCookie(c, cookie.name, state, { ...cookie.options, maxAge: lifetime });
  return state;
}
export async function consumeOAuthState(
  c: Context,
  state: string | undefined,
  secret: string,
): Promise<string | null> {
  const cookie = cookieOptions(c);
  const expected = getCookie(c, cookie.name);
  deleteCookie(c, cookie.name, cookie.options);
  if (!state || !expected || state !== expected) return null;
  try {
    const payload = await verify(state, secret, 'HS256');
    if (
      payload.type !== 'oauth_state' ||
      typeof payload.nonce !== 'string' ||
      typeof payload.exp !== 'number'
    )
      return null;
    return safeReturnPath(payload.returnTo);
  } catch {
    return null;
  }
}

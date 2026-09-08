import { describe, it, expect, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import {
  createOAuthState,
  consumeOAuthState,
  safeReturnPath,
} from './oauth-state.js';
const secret = 'test-oauth-state-secret-with-at-least-32-characters';
const app = new Hono();
app.get('/login', async (c) =>
  c.json({ state: await createOAuthState(c, c.req.query('returnTo'), secret) }),
);
app.get('/callback', async (c) =>
  c.json({
    returnTo: await consumeOAuthState(c, c.req.query('state'), secret),
  }),
);
async function login() {
  const response = await app.request(
    'https://app.example/login?returnTo=%2Fchannels%2Fone',
  );
  return {
    state: (await response.json()).state as string,
    cookie: response.headers.get('set-cookie')!,
  };
}
describe('OAuth browser binding', () => {
  afterEach(() => vi.useRealTimers());
  it('accepts matching signed browser state and consumes its secure host-only cookie', async () => {
    const { state, cookie } = await login();
    expect(cookie).toContain('__Host-miriad_oauth_state=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
    const response = await app.request(
      `https://app.example/callback?state=${state}`,
      { headers: { Cookie: cookie.split(';')[0] } },
    );
    expect(await response.json()).toEqual({ returnTo: '/channels/one' });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('rejects another browser, missing state and mismatched state', async () => {
    const { state, cookie } = await login();
    for (const [query, headers] of [
      [state, {}],
      ['', { Cookie: cookie.split(';')[0] }],
      ['attacker', { Cookie: cookie.split(';')[0] }],
    ] as [string, Record<string, string>][]) {
      const response = await app.request(
        `https://app.example/callback?state=${query}`,
        { headers },
      );
      expect(await response.json()).toEqual({ returnTo: null });
    }
  });
  it('rejects a forged state even when the attacker supplies a matching cookie', async () => {
    const response = await app.request(
      'https://app.example/callback?state=forged',
      { headers: { Cookie: '__Host-miriad_oauth_state=forged' } },
    );
    expect(await response.json()).toEqual({ returnTo: null });
  });
  it('rejects expired state', async () => {
    vi.useFakeTimers();
    const { state, cookie } = await login();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const response = await app.request(
      `https://app.example/callback?state=${state}`,
      { headers: { Cookie: cookie.split(';')[0] } },
    );
    expect(await response.json()).toEqual({ returnTo: null });
  });
  it('allows local paths while rejecting external or ambiguous redirect targets', () => {
    for (const path of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\nevil.example',
      null,
    ])
      expect(safeReturnPath(path)).toBe('/');
    expect(safeReturnPath('/channels/one?view=chat')).toBe(
      '/channels/one?view=chat',
    );
  });
});

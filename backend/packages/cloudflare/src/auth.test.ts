import { describe, it, expect, vi } from 'vitest';
import { sign } from 'hono/jwt';
import { authenticate, authorizeChannel } from './auth.js';
import type { Storage } from '@cast/storage';
const secret = 'a-test-secret-at-least-thirty-two-characters';
function store(owner = 'alice') {
  return {
    getSpace: vi.fn(async () => ({ ownerId: owner })),
    getChannelById: vi.fn(async () => ({ spaceId: 'space-a' })),
    getLocalAgentServerBySecret: vi.fn(async () => null),
  } as unknown as Storage;
}
async function request(changes: Record<string, unknown> = {}) {
  const token = await sign(
    {
      userId: 'alice',
      spaceId: 'space-a',
      mode: 'workos',
      exp: Math.floor(Date.now() / 1000) + 60,
      ...changes,
    },
    secret,
    'HS256',
  );
  return new Request('https://miriad.example/', {
    headers: { Cookie: `cast_session=${token}` },
  });
}
describe('edge authentication', () => {
  it('accepts a signed session for the current owner', async () =>
    expect(await authenticate(await request(), store(), secret)).toMatchObject({
      spaceId: 'space-a',
      userId: 'alice',
      role: 'browser',
    }));
  it('rejects a removed owner', async () =>
    expect(
      await authenticate(await request(), store('bob'), secret),
    ).toBeNull());
  it('rejects development tokens in the hosted deployment', async () =>
    expect(
      await authenticate(await request({ mode: 'dev' }), store(), secret),
    ).toBeNull());
  it('requires expiration', async () =>
    expect(
      await authenticate(await request({ exp: undefined }), store(), secret),
    ).toBeNull());
  it('rejects expired sessions', async () =>
    expect(
      await authenticate(await request({ exp: 1 }), store(), secret),
    ).toBeNull());
  it('rejects forged signatures', async () =>
    expect(
      await authenticate(await request(), store(), 'wrong-secret'),
    ).toBeNull());
  it('rejects another space channel', async () => {
    await expect(
      authorizeChannel(store(), 'space-b', 'channel'),
    ).rejects.toThrow('denied');
  });
  it('rejects unknown runtime credentials', async () =>
    expect(
      await authenticate(
        new Request('https://miriad.example/', {
          headers: { Authorization: 'Server forged' },
        }),
        store(),
        secret,
      ),
    ).toBeNull());
});

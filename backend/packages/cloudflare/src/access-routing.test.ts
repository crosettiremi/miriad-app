import { describe, it, expect, vi, beforeEach } from 'vitest';
const fakes = vi.hoisted(() => ({ verify: vi.fn(), storage: vi.fn() }));
vi.mock('./access.js', () => ({
  verifyAccess: fakes.verify,
  accessSessionRequest: vi.fn(),
  externalAccessId: vi.fn(),
  provisionAccessUser: vi.fn(),
}));
vi.mock('./postgres.js', () => ({ openStorage: fakes.storage }));
vi.mock('agents', () => ({ getAgentByName: vi.fn() }));
vi.mock('./space-agent.js', () => ({ SpaceAgent: class {} }));
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
vi.mock('@cast/server/app-core', () => ({ createApp: vi.fn() }));
import worker from './index.js';
const assets = vi.fn(async () => new Response('private app'));
const env = {
  APP_ORIGIN: 'https://os.example.com',
  RUNTIME_ORIGIN: 'https://runtime.example.com',
  ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
  ACCESS_AUD: 'aud',
  ASSETS: { fetch: assets },
  JWT_SECRET: 'test-secret',
  DATABASE_URL: 'postgres://unused',
} as unknown as Env;
beforeEach(() => {
  vi.clearAllMocks();
  fakes.verify.mockResolvedValue(null);
});
describe('Access origin enforcement', () => {
  it('protects static assets as well as API and WebSocket requests', async () => {
    for (const path of ['/', '/static/index.js', '/static/index.css', '/auth/me', '/connect']) {
      const response = await worker.fetch(
        new Request(env.APP_ORIGIN + path, {
          headers: path === '/connect' ? { Upgrade: 'websocket' } : {},
        }),
        env,
      );
      expect(response.status).toBe(401);
    }
    expect(assets).not.toHaveBeenCalled();
    expect(fakes.storage).not.toHaveBeenCalled();
  });
  it('rejects alternate hostnames before identity or database access', async () => {
    expect(
      (
        await worker.fetch(
          new Request('https://alternate.workers.dev/auth/me'),
          env,
        )
      ).status,
    ).toBe(404);
    expect(fakes.verify).not.toHaveBeenCalled();
    expect(fakes.storage).not.toHaveBeenCalled();
  });
  it('does not accept a browser cookie or Access assertion on the machine origin', async () => {
    const response = await worker.fetch(
      new Request(env.RUNTIME_ORIGIN + '/auth/me', {
        headers: {
          Cookie: 'cast_session=stolen',
          'Cf-Access-Jwt-Assertion': 'stolen',
        },
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(fakes.storage).not.toHaveBeenCalled();
  });
  it('rejects invalid machine credentials after consulting storage', async () => {
    const close = vi.fn();
    fakes.storage.mockReturnValue({
      storage: { getLocalAgentServerBySecret: vi.fn(async () => null) },
      close,
    });
    const response = await worker.fetch(
      new Request(env.RUNTIME_ORIGIN + '/api/previews', {
        method: 'POST',
        headers: { Authorization: 'Server invalid' },
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(close).toHaveBeenCalled();
  });
  it('allows verified browser identity to fetch the app without provisioning a database record', async () => {
    fakes.verify.mockResolvedValue({ subject: 'owner' });
    expect(
      await (await worker.fetch(new Request(env.APP_ORIGIN + '/'), env)).text(),
    ).toBe('private app');
    expect(fakes.storage).not.toHaveBeenCalled();
  });
  it('serves frontend bundles through the static binding without opening PostgreSQL', async () => {
    fakes.verify.mockResolvedValue({ subject: 'owner' });
    for (const path of ['/static/index.js', '/static/index.css']) {
      const request = new Request(env.APP_ORIGIN + path);
      expect(await (await worker.fetch(request, env)).text()).toBe('private app');
      expect(assets).toHaveBeenCalledWith(request);
    }
    expect(fakes.storage).not.toHaveBeenCalled();
  });
  it('logs out through Access instead of WorkOS', async () => {
    fakes.verify.mockResolvedValue({ subject: 'owner' });
    const response = await worker.fetch(
      new Request(env.APP_ORIGIN + '/auth/logout', {
        method: 'POST',
        headers: { Origin: env.APP_ORIGIN! },
      }),
      env,
    );
    expect(await response.json()).toEqual({
      ok: true,
      logoutUrl: env.APP_ORIGIN + '/cdn-cgi/access/logout',
    });
  });
});

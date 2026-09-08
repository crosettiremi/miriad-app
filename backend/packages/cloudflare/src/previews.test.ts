import { it, expect, vi } from 'vitest';
const agent = vi.hoisted(() => ({
  grantPreview: vi.fn(async () => {}),
  hasPreviewGrant: vi.fn(async () => true),
  proxyPreview: vi.fn(
    async () =>
      new Response('preview', {
        headers: { 'Set-Cookie': 'stolen=value; Domain=example.com' },
      }),
  ),
}));
vi.mock('agents', () => ({ getAgentByName: async () => agent }));
import {
  createPreview,
  servePreview,
  validPreviewPort,
  isPreviewHost,
} from './previews.js';
const env = {
  PREVIEW_DOMAIN: 'previews.example.com',
  PREVIEW_SECRET: 'preview-test-secret-at-least-thirty-two-characters',
} as Env;
it('rejects the control plane and invalid ports', () => {
  for (const port of [3000, 80, 65536, 8080.1, '8080'])
    expect(validPreviewPort(port)).toBe(false);
  expect(validPreviewPort(8080)).toBe(true);
});
it('requires exactly one preview subdomain label', () => {
  expect(isPreviewHost('id.previews.example.com', env.PREVIEW_DOMAIN)).toBe(
    true,
  );
  expect(
    isPreviewHost('id.previews.example.com.attacker.net', env.PREVIEW_DOMAIN),
  ).toBe(false);
});
it('exchanges ticket for a host-only cookie and strips credentials from upstream', async () => {
  const grant = await createPreview(env, 'space-a', 8080);
  const landing = await servePreview(new Request(grant.url), env);
  expect(landing.status).toBe(303);
  const cookie = landing.headers.get('Set-Cookie')!;
  expect(cookie).toContain('Secure; HttpOnly');
  expect(cookie).not.toContain('Domain=');
  expect(landing.headers.get('Location')).not.toContain('ticket=');
  const response = await servePreview(
    new Request(landing.headers.get('Location')!, {
      headers: { Cookie: cookie.split(';')[0], Authorization: 'secret' },
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.has('Set-Cookie')).toBe(false);
  const upstream = agent.proxyPreview.mock.calls.at(-1)?.[0] as Request;
  expect(upstream.headers.has('Cookie')).toBe(false);
  expect(upstream.headers.has('Authorization')).toBe(false);
});
it('rejects revoked grants before contacting a container', async () => {
  const grant = await createPreview(env, 'space-a', 8080);
  agent.hasPreviewGrant.mockResolvedValueOnce(false);
  expect((await servePreview(new Request(grant.url), env)).status).toBe(403);
});

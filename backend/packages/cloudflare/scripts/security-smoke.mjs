import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const directory = await mkdtemp(join(tmpdir(), 'miriad-worker-test-'));
let mf;
try {
  const result = await build({
    stdin: {
      contents: `
   import {getAgentByName} from 'agents';
   export {SpaceAgent} from './src/space-agent.ts';
   export default {async fetch(request,env){
     const agent=await getAgentByName(env.SPACES,'space-a');
     const headers=new Headers(request.headers);
     const bad=new URL(request.url).searchParams.has('foreign');
     headers.set('x-miriad-principal',JSON.stringify({spaceId:bad?'space-b':'space-a',userId:'alice',role:'browser',expiresAt:Date.now()+60000}));
     return agent.fetch(new Request(request,{headers}));
   }};
 `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    alias: { crypto: 'node:crypto', path: 'node:path' },
    external: ['cloudflare:*', 'node:*'],
    write: false,
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: result.outputFiles[0].text,
      compatibilityDate: '2026-09-08',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { SPACES: { className: 'SpaceAgent', useSQLite: true } },
      durableObjectsPersist: directory,
    }),
  );
  const response = await mf.dispatchFetch('http://localhost/connect', {
    headers: { Upgrade: 'websocket' },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  const next = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('WebSocket response timeout')),
        5000,
      );
      socket.addEventListener(
        'message',
        (e) => {
          clearTimeout(timer);
          resolve(JSON.parse(e.data));
        },
        { once: true },
      );
    });
  let reply = next();
  socket.send(
    JSON.stringify({ type: 'cf_agent_state', state: { compromised: true } }),
  );
  assert.equal((await reply).type, 'cf_agent_state_error');
  reply = next();
  socket.send(
    JSON.stringify({
      type: 'rpc',
      id: 'attack',
      method: 'startHosted',
      args: ['alice'],
    }),
  );
  const rpc = await reply;
  assert.match(JSON.stringify(rpc), /not callable/);
  socket.close();
  const foreign = await mf.dispatchFetch('http://localhost/connect?foreign=1', {
    headers: { Upgrade: 'websocket' },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.webSocket, null);
  console.log(
    'PASS: real Agents SDK rejects state mutation, callable RPC, and foreign space identity',
  );
} finally {
  await mf?.dispose();
  await rm(directory, { recursive: true, force: true });
}

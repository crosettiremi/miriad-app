import { spawnSync } from 'node:child_process';
const secrets = JSON.parse(process.env.MIRIAD_WORKER_SECRETS ?? '{}');
for (const name of [
  'JWT_SECRET',
  'SECRET_KEY',
  'CAST_SERVER_SECRET',
  'CAST_CONTAINER_SECRET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'PREVIEW_SECRET',
]) {
  if (typeof secrets[name] !== 'string' || !secrets[name])
    throw Error(`Missing worker secret ${name}`);
}
for (const name of [
  'JWT_SECRET',
  'SECRET_KEY',
  'CAST_SERVER_SECRET',
  'CAST_CONTAINER_SECRET',
  'PREVIEW_SECRET',
])
  if (secrets[name].length < 32)
    throw Error(`${name} must contain at least 32 characters`);
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'secret',
    'bulk',
    '--config',
    'wrangler.staging.generated.json',
  ],
  {
    input: JSON.stringify(secrets),
    encoding: 'utf8',
    env: { ...process.env, MIRIAD_WORKER_SECRETS: '' },
  },
);
// Wrangler logs secret names, never echo the input object.
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.status !== 0) process.exit(result.status ?? 1);

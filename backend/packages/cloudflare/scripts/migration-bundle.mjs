import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Hash the exact executable sent to the homelab, including its dependencies.
export async function migrationBundle() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['scripts/migrate.ts'],
    alias: { '@cast/storage': fileURLToPath(new URL('../../storage/src/index.ts', import.meta.url)) },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    minifyWhitespace: true,
    banner: { js: `import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
process.env.DATABASE_URL = readFileSync('/etc/miriad/migrator.url', 'utf8').trim();` },
  });
  const code = result.outputFiles[0].contents;
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

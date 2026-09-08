import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationBundle } from './migration-bundle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('deployment gate rejects missing/stale attestations and accepts exact bundle', async () => {
  const { sha256 } = await migrationBundle();
  console.log(`Migration bundle SHA-256: ${sha256}`);
  for (const value of ['', '0'.repeat(64)]) {
    const result = spawnSync(process.execPath, ['scripts/check-schema.mjs'], {
      cwd: root, env: { ...process.env, MIRIAD_SCHEMA_SHA256: value }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /schema has not been recorded/);
  }
  const output = execFileSync(process.execPath, ['scripts/check-schema.mjs'], {
    cwd: root, env: { ...process.env, MIRIAD_SCHEMA_SHA256: sha256 }, encoding: 'utf8',
  });
  assert.match(output, /attestation matches/);
});

test('failed SSH or migration never records a successful GitHub attestation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'miriad-migration-test-'));
  try {
    writeFileSync(join(directory, 'ssh'), '#!/bin/sh\ncat >/dev/null\nexit 37\n', { mode: 0o700 });
    writeFileSync(join(directory, 'gh'), '#!/bin/sh\ntouch "$MIRIAD_TEST_MARKER"\n', { mode: 0o700 });
    const marker = join(directory, 'unexpected-attestation');
    const result = spawnSync(process.execPath, ['scripts/migrate-homelab.mjs', '--record'], {
      cwd: root, env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MIRIAD_TEST_MARKER: marker },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Command failed: ssh/);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

import { execFileSync } from 'node:child_process';
import { migrationBundle } from './migration-bundle.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--record')) throw new Error('Usage: migrate-homelab.mjs [--record]');
const { code, sha256 } = await migrationBundle();
// Credentials stay in CT 116. TLS verifies the dedicated origin certificate.
execFileSync('ssh', [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'homelab',
  'pct exec 116 -- env NODE_EXTRA_CA_CERTS=/etc/miriad/origin-ca.pem node --input-type=module',
], { input: code, stdio: ['pipe', 'inherit', 'inherit'], timeout: 120_000 });
console.log(`Applied homelab migration SHA-256: ${sha256}`);
if (args.includes('--record')) {
  // Only attest after successful execution. Never store a database URL in GitHub.
  execFileSync('gh', ['variable', 'set', 'MIRIAD_SCHEMA_SHA256', '--repo',
    'crosettiremi/miriad-app', '--env', 'cloudflare-staging', '--body', sha256],
    { stdio: 'inherit', timeout: 30_000 });
  console.log('Recorded migration for the cloudflare-staging deployment gate.');
}

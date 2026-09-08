import { migrationBundle } from './migration-bundle.mjs';
const { sha256 } = await migrationBundle();
if (process.env.MIRIAD_SCHEMA_SHA256 !== sha256) {
  throw new Error('Homelab schema has not been recorded for this build. Run pnpm migrate:homelab --record from a trusted machine with homelab SSH access.');
}
console.log(`Homelab migration attestation matches this build: ${sha256}`);

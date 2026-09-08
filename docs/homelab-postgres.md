# Miriad homelab PostgreSQL

Provisioned and verified on 2026-09-08. The database and Miriad Worker/Sandbox application are deployed. See [deployment status](cloudflare-deployment.md) for verified gates and remaining user setup.

## Inventory

| Resource | Configuration |
| --- | --- |
| Proxmox | `ssh homelab`, dedicated unprivileged CT **116**, `miriad-postgres` |
| Guest | Debian 13, PostgreSQL **17.11**, Node 20; nesting enabled for systemd namespace compatibility |
| Capacity | 2 cores, 4 GiB RAM, 512 MiB swap, **64 GiB** expandable ZFS volume on `Storage-3` |
| Network | VLAN 20, DHCP; database listens **only on 127.0.0.1:5432** |
| Database | `miriad_staging`, UTF-8, 13 application tables, `ltree` extension |
| Roles | `miriad_migrator` owns schema; `miriad_app` has DML/sequence privileges, no superuser/create-role/create-database privileges |
| Cloudflare account | Rémi Org, `f14987cb2f1db42ebfde241a23700328` |
| Dedicated Tunnel | `miriad-postgres`, `5d03f342-7278-45d7-a0fd-84cb9b228bbc` |
| VPC service | `01a08260-d2d1-7871-b6d9-0e2473644b1e`, TCP PostgreSQL to tunnel-local `127.0.0.1:5432` |
| Hyperdrive | `38aff821a40a43609b5ac37916076301`, query caching disabled, origin connection limit 20 |

The path is Worker → Hyperdrive → VPC service → dedicated cloudflared in CT 116 → localhost PostgreSQL. No inbound port forwarding or public database DNS record was added. The existing shared homelab Tunnel was not reconfigured. The connector was copied from its installed cloudflared 2026.8.2 binary; update the dedicated connector when upgrading the homelab connectors.

PostgreSQL requires TLS and SCRAM authentication. The VPC service uses `verify_ca`: it verifies the Cloudflare Origin CA chain but skips hostname matching because its target is loopback. It does **not** disable certificate verification. Local migrations use `verify-full`, the dedicated hostname in CT 116's hosts file, and the Origin CA root. The certificate covers only `postgres.os.prescottandremi.com` and expires **2027-09-08 18:49 UTC**. Renew before that date, replace `/etc/postgresql/17/main/server.crt` and its matching key (postgres-owned, mode 0600), reload PostgreSQL, and rerun a live Hyperdrive check.

Connection URLs live in root-readable `/etc/miriad/app.url` and `/etc/miriad/migrator.url` inside CT 116. The app password is also stored by Hyperdrive. The Tunnel token is `/etc/cloudflared/token`, readable by root and the dedicated cloudflared service group. Do not print these files or commit them. PostgreSQL's administrative Unix socket uses peer authentication.

## Apply future migrations

From the repository root, using Node/pnpm versions in the project:

```sh
pnpm --dir backend install --frozen-lockfile
pnpm --dir backend build
pnpm --dir backend/packages/cloudflare migrate:homelab --record
```

This bundles the current migration code and dependencies, sends it through SSH to CT 116, runs it with the container's migration credential, and records `MIRIAD_SCHEMA_SHA256` in the fork's `cloudflare-staging` GitHub environment **only after success**. It creates no test fixtures. Without `--record`, it applies the migration and prints its hash without updating GitHub. A failing SSH/migration command stops before attestation.

The staging workflow rebuilds the same bundle and rejects a missing or mismatched hash before modifying Worker secrets or deploying. This is an operator attestation, not a live database availability/schema query. Rerun the migration after restoring an older database. Do not manually copy an old hash onto a changed database. Dependencies are part of the bundle, so a dependency change may require replaying the additive migration.

The workflow no longer requires a `DATABASE_URL` GitHub secret. `MIRIAD_HYPERDRIVE_ID` is already set. Worker signing/encryption and bucket-scoped R2 checkpoint secrets are installed and backed up in `MIRIAD_WORKER_SECRETS`. GitHub workflow deployment still requires its scoped `CLOUDFLARE_API_TOKEN`; the initial deployment used local Wrangler OAuth.

## Backups and restore

- Nightly logical backup at **02:15 UTC**, with up to five minutes jitter; approximately 14 days retained. Host timer: `miriad-postgres-backup.timer`.
- Backup script: `/usr/local/sbin/miriad-postgres-backup` on Proxmox; source copy at `ops/homelab/miriad-postgres-backup`.
- Destination: `/Storage-2/Backups/miriad-postgres/<UTC timestamp>/`. Contains a custom-format database dump, role definitions, private configuration/credentials, container configuration and SHA-256 manifest. Directories/files are root-only.
- Weekly Proxmox snapshot backup, Sunday **03:30 in the Proxmox host timezone**, job `miriad-postgres-weekly`, storage `S2`, retains four full container backups.
- Initial full container backup completed successfully (451 MB compressed). Initial logical backup was checksum-verified and restored into a separate test database; all 13 tables restored. The temporary restore database was removed.

These backups are on a different storage pool but **the same physical homelab server**. They do not yet protect against loss of the whole server/site. Nightly dumps do not provide continuous point-in-time recovery; a failure may lose changes since the last successful backup.

Inspect backup status without reading credentials:

```sh
ssh homelab 'systemctl list-timers miriad-postgres-backup.timer; journalctl -u miriad-postgres-backup.service -n 30 --no-pager'
ssh homelab '/usr/local/sbin/miriad-postgres-backup'
ssh homelab 'pct exec 116 -- pg_isready; pct exec 116 -- systemctl is-active cloudflared'
```

For a restore rehearsal, verify `SHA256SUMS`, copy `database.dump` to CT 116 as postgres, create a **new isolated UTF-8 database from template0**, and run `pg_restore --exit-on-error` into it as postgres. Check tables/data before deleting only that rehearsal database. On a fresh server, restore role definitions first. For a full disaster restore, restore the Proxmox archive to an isolated container/network, validate PostgreSQL and credentials, and reconnect the dedicated Tunnel only after choosing the authoritative database. Never start a second connector pointing to a divergent writable restore.

## Evidence and remaining application work

A real Cloudflare remote Worker used the application's Postgres.js adapter and Hyperdrive binding to verify database/role/UTF-8 encoding, all 13 tables, an application-role insert/read, and transaction rollback. The temporary remote development session was stopped afterward. PostgreSQL stayed bound to localhost and the guest had no failed systemd units after reboot.

Worker/Sandbox deployment, browser Access login, and an isolated deployed Sandbox checkpoint/restore have passed. The Workers AI adapter now provides keyless model access; authenticated tool execution and session resume have passed. Database availability depends on the homelab's power, Internet connection, PostgreSQL and dedicated Tunnel.

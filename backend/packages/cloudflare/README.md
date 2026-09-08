# Miriad on Cloudflare

This package ports Miriad's existing API and runtime protocol to Workers, Agents SDK and Sandbox. PostgreSQL remains authoritative. Staging is deployed at https://os.prescottandremi.com. See [deployment status](../../../docs/cloudflare-deployment.md) for verified gates and remaining user setup.

The Worker serves the React build and existing Hono routes. One `SpaceAgent` per authenticated space owns socket routing, runtime operations, frame receipts and checkpoint pointers. A Sandbox runs the existing Claude SDK engine as the `agent` user. Binary assets and workspace checkpoints use separate R2 buckets. No Fly, Docker orchestration or filesystem asset implementation is included in the Worker bundle.

## Local checks

Use Node 22.23.2 (`.node-version`) and pnpm 9.15.9. From the repository root:

```sh
pnpm --dir backend install --frozen-lockfile
pnpm --dir frontend install --frozen-lockfile
pnpm --dir backend build
pnpm --dir frontend build
pnpm --dir backend test
pnpm --dir backend/packages/cloudflare test:security
pnpm --dir backend/packages/cloudflare exec wrangler deploy --dry-run --containers-rollout=none --outdir dist
```

`test:security` executes the real Agents SDK in workerd. It checks that client state updates and callable RPC are rejected and foreign identities cannot upgrade a socket. The test fixture is never deployed.

Run `pnpm test:postgres` from this package with `DATABASE_URL` set to an **isolated test database**. It creates fixtures and checks migration replay, idempotent bundled seeding, JSON/array transport, messages, artifacts, secret round-trip, tenant isolation and transactional rollback. It does not clean a shared database. CI provides a disposable PostgreSQL service.

The legacy PostgreSQL suite still uses the original PlanetScale HTTP endpoint; its skips do not validate the new transport. The new database smoke test uses a real PostgreSQL server. Postgres.js type discovery is enabled to preserve PostgreSQL arrays; pre-encoded JSON from the legacy storage layer has an explicit serializer to avoid double encoding.

## Staging setup

Target account: Rémi Org (`f14987cb2f1db42ebfde241a23700328`). Created buckets:

- `miriad-staging-assets`
- `miriad-staging-checkpoints`

The homelab PostgreSQL database and Hyperdrive connection are configured with **query caching disabled**; see [the homelab runbook](../../../docs/homelab-postgres.md). The `HYPERDRIVE` binding is generated once its real ID is available; no fake ID is checked in. `DATABASE_URL` is an optional direct local-development connection, not the production pooling configuration.

Create a self-hosted Cloudflare Access application for `os.prescottandremi.com` in Rémi Org. Allow only the approved owner email, with a six-hour session. Use the account's identity provider or email one-time PIN. Record the team hostname and application AUD. The Worker verifies the RS256 signature, issuer, AUD, expiry and user claims on every browser request, including static assets and WebSocket upgrades. It never trusts the email header alone or an old app cookie.

First authenticated API use atomically creates an Access-specific Miriad identity, space and bundled content. A PostgreSQL advisory lock prevents concurrent first requests from creating duplicate spaces. Existing WorkOS users are not linked by email. The Worker supplies an internal session to existing handlers, bounded by Access token expiry. Logout uses `/cdn-cgi/access/logout`. Access policy revocation is subject to token/session lifetime; existing WebSockets stop accepting messages/broadcasts at token expiry.

Use `runtime.os.prescottandremi.com` for hosted machine traffic. This origin has no browser Access application; the Worker rejects browser cookies and public auth endpoints there and requires verified Miriad Server/Container credentials. The app origin requires an Access identity even if a machine authorization header is supplied. Workers.dev and version preview URLs are disabled and unknown origins rejected. Existing CLI bootstrap through the protected app requires a browser Access session; unattended runtimes need pre-provisioned Miriad credentials and the runtime origin.

Use `previews.os.prescottandremi.com` as the separate wildcard preview hostname, with a Cloudflare route in the `prescottandremi.com` zone. Preview grants retain their own expiring tickets and host-only cookies. No broad Access bypass policy is created. The runtime and preview routes are deployed, with an active certificate covering the nested wildcard preview hostname.

In the GitHub environment `cloudflare-staging`, set:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `MIRIAD_ACCESS_TEAM_DOMAIN` | Team hostname, e.g. team.cloudflareaccess.com |
| Variable | `MIRIAD_ACCESS_AUD` | Exact Access application audience |
| Variable | `MIRIAD_RUNTIME_ORIGIN` | https://runtime.os.prescottandremi.com |
| Variable | `MIRIAD_HYPERDRIVE_ID` | Real Hyperdrive ID, query caching disabled |
| Variable | `MIRIAD_APP_ORIGIN` | HTTPS app origin |
| Variable | `MIRIAD_PREVIEW_DOMAIN` | Separate preview hostname, e.g. previews.example.com |
| Variable | `MIRIAD_PREVIEW_ZONE_ID` | Cloudflare zone ID for that hostname |
| Variable | `MIRIAD_SCHEMA_SHA256` | Successful homelab migration bundle hash; recorded by `migrate:homelab --record` |
| Secret | `CLOUDFLARE_API_TOKEN` | Deployment token scoped to Rémi Org |
| Secret | `MIRIAD_WORKER_SECRETS` | JSON object containing the Worker secrets below |

Worker secrets: `JWT_SECRET`, `SECRET_KEY`, `CAST_SERVER_SECRET`, `CAST_CONTAINER_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `PREVIEW_SECRET`. Use independent random values of at least 32 characters for signing/encryption secrets. R2 S3 credentials must be restricted to the checkpoint bucket. The account and bucket name are nonsecret configuration. Model keys can be entered through Miriad Settings; `ANTHROPIC_API_KEY` is an optional Worker fallback.

Run `pnpm --dir backend/packages/cloudflare migrate:homelab --record` from a trusted machine with `ssh homelab` access before deploying a changed migration bundle. Credentials remain in the database container. Then run the manual **Cloudflare staging** workflow after configuring the remaining inputs. It builds/tests, generates deployment config, checks the recorded migration hash, installs secrets and deploys the Worker/container image. GitHub hosted runners do not connect directly to the private database. Old AWS/Fly/Vercel/npm publishing workflows are archived under `docs/legacy-deployment`; they no longer trigger in this fork.

Docker is required for the image build. The image preserves the Sandbox control-service entrypoint; Miriad starts separately through `runuser`. The SDK and image are pinned to 0.12.9. CI builds the Linux image from the repository root. Start with a maximum of two standard-1 instances; this is staging capacity, not a production sizing recommendation.

## Workspace recovery

Workspace snapshots include `.git`, untracked files, modes, symlinks, Claude session state and the reliable final-frame outbox. Runtime credentials stay in process environment, outside the checkpoint. Miriad does not write provider credentials into snapshots; user-created files remain user workspace data.

Every minute while running, all `agent` processes are paused together and the SDK creates a consistent archive. The SDK verifies the upload; Miriad also checks its metadata/size, records the R2 ETag, and publishes the pointer last. The current and previous snapshots are retained. Older committed snapshots are deleted after pointer publication. Backup TTL is explicitly ten years, rather than the SDK's three-day default; renewal is required before that horizon. The object layout check is version-coupled to the pinned SDK and must be reviewed on upgrades.

Orderly stop snapshots while writers remain paused, then destroys the Sandbox. Startup restores before launching the runtime. A crash can lose changes since the last completed checkpoint, including in-flight execution; one minute is the scheduling target, not a guaranteed loss bound during slow or failed backups. After three failed periodic backups, status becomes `recovery_required` and forced keep-alive is disabled; automatic destructive cleanup is not used. The instance may remain billed until recovery or platform sleep. Inspect the error and retry before relying on the workspace. An isolated deployed Sandbox restart verified R2 restore of Git data, untracked files, modes, symlinks and session files, followed by writable access as `agent`. A real application agent turn/restart remains a separate release gate.

With `MIRIAD_RELIABLE_FRAMES=1` (set automatically for hosted Sandboxes), final runtime frames are written to the workspace outbox before sending. The coordinator keeps pending frames in private durable storage and commits a PostgreSQL receipt in the same transaction as message/cost updates. It broadcasts after commit and acknowledges the runtime; reconnect replays unacknowledged frames. Duplicate broadcasts can occur, while PostgreSQL side effects are deduplicated. Streaming deltas remain ephemeral.

`miriad-preview 8080` inside the hosted workspace creates an authenticated URL for a local service. Port 3000 is reserved for the Sandbox control plane. Revocation uses `DELETE /api/previews/<grant-id>`. Preview hot reload/WebSocket behavior still needs the configured staging domain for verification.

Binary uploads through the existing JSON API are limited to 8 MiB on Workers (12 MiB request cap). Downloads stream from R2. Larger uploads need a future multipart/direct-upload path.

## Release gate and rollback

Before production, record the Worker version and image digest, then demonstrate: Cloudflare Access login; two authenticated clients and reconnect; a real file-editing agent turn; authenticated preview and revocation; concurrent start/stop; cancellation; checkpoint failure; and a real Sandbox restart restoring Git state, untracked files, symlinks, modes and Claude session files. Repeat against the previous application build and expanded schema.

Database migrations are additive. They do not automatically delete duplicate cost records or run down-migrations. Existing incompatible data must be reconciled explicitly. To roll back a Worker, use `wrangler rollback <previous-version-id> --config wrangler.staging.generated.json`; restore the previous container image separately and retain PostgreSQL data and both valid checkpoints. Rehearse this in staging first.

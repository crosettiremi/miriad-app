# Cloudflare staging deployment

Deployed on 2026-09-08 to Rémi Org (`f14987cb2f1db42ebfde241a23700328`).

- App: https://os.prescottandremi.com — Cloudflare Access, owner `crosettiremi@gmail.com`.
- Worker: `miriad-staging`; deployed version `7036c65c-02da-43ff-97aa-26ca34d9a208`. Agents SDK coordinates spaces in Durable Objects.
- Runtime: https://runtime.os.prescottandremi.com — machine credentials required, browser sessions rejected.
- Sandbox: `miriad-staging-sandbox`, SDK/image 0.12.9, at most two standard-1 instances.
- Workspace checkpoints: `miriad-staging-checkpoints` R2 bucket. S3 credentials have object read/write permission only on this bucket.
- Uploaded assets: `miriad-staging-assets` R2 bucket, accessed through the Worker binding.
- Previews: `*.previews.os.prescottandremi.com`, proxied DNS and Worker route, expiring preview grants. The nested wildcard and runtime hostname have an active advanced TLS certificate with automatic renewal.
- Database: private PostgreSQL 17 in homelab CT 116, reached over Hyperdrive/VPC/Tunnel. See [database operations](homelab-postgres.md).

Frontend build files use `/static/` because `/assets/` is the backend upload API. All app-origin static files still pass Access verification in the Worker.

## Verification

Passed in the deployed environment:

- Google Access sign-in reached the first-run screen. Authenticated identity, channel, cost and roster API requests returned HTTP 200 against the homelab database.
- JavaScript/CSS load through the static asset binding after fixing the `/assets` route collision.
- Anonymous app access redirects to Access. Runtime browser-auth endpoints and ungranted preview URLs return 401. The workers.dev alternative returns 404.
- Runtime executable works as the non-root `agent` user in the deployed Sandbox image.
- An isolated Sandbox created an R2 checkpoint, was destroyed, and restored on cold start. Git history, untracked files, executable mode, symlink, session file and post-restore writes as `agent` were verified. Probe containers and checkpoint objects were removed.
- Local frontend build, 621 backend tests (56 legacy skips), nine Access routing tests and real workerd Agents SDK security checks passed. Prior branch CI passed backend tests/builds, workerd security checks, PostgreSQL integration checks, migration tooling tests and Linux image checks.

The Workers AI adapter removes the model-key requirement. A real authenticated inference/tool turn and session resume passed. In-app hosted startup, Write/Read and Miriad MCP calls also passed using the `verify` agent in `first-channel`. After checkpointing and restarting on the updated image, a read-only tool call returned the original `CF_ADAPTER_VERIFIED` file contents. One post-deployment runtime disappearance required another Start and message retry; interrupted requests are not automatically replayed. Authenticated preview WebSocket verification remains separate from these runtime checks. See [Workers AI runtime](workers-ai-runtime.md).

## Secrets and future deployments

Independent Worker signing/encryption secrets and checkpoint S3 credentials are installed. A recovery copy is stored in the fork's `cloudflare-staging` environment secret `MIRIAD_WORKER_SECRETS`. Preserve `SECRET_KEY` when redeploying: changing it prevents decryption of existing application secrets. Never commit or print secret values.

The initial deployment used authenticated local Wrangler. The GitHub environment has the deployment variables and migration attestation; its manual staging workflow still needs a scoped `CLOUDFLARE_API_TOKEN`. Do not substitute a short-lived Wrangler OAuth token for that secret.

Use Node 22 and pnpm 9.15.9. Build backend and frontend before deploying. Apply and record migrations when their bundle changes:

```sh
pnpm --dir backend build
pnpm --dir frontend build
pnpm --dir backend/packages/cloudflare migrate:homelab --record
```

The local image build used `DOCKER_HOST=ssh://openhands` and the existing Docker daemon on that VM. A generated, ignored `wrangler.staging.generated.json` contains the deployed bindings/routes. From `backend/packages/cloudflare`, after generating/reviewing the correct config and checking the migration attestation:

```sh
DOCKER_HOST=ssh://openhands wrangler deploy --config wrangler.staging.generated.json
```

Stop hosted runtimes through the app before an image rollout so their workspaces are checkpointed. Wait for the container rollout to settle before restarting them: Wrangler success can precede termination of old containers.

Keep secrets and bindings consistent during rollback. Database migrations are additive and are not rolled back by a Worker rollback. PostgreSQL availability depends on homelab power and networking; current database backups remain on the same physical server, on another storage pool.

## Workers AI binding — 2026-09-08

The Worker now has a typed `env.AI` binding in the tracked Wrangler configuration and the deployed staging configuration. Type checking passed. A temporary remote Worker in Rémi Org successfully called `@cf/qwen/qwen3-30b-a3b-fp8` through this binding and received `READY`; no model API key was supplied. The temporary verification session was stopped afterward. The Sandbox image was preserved with `--containers-rollout=none`.

The hosted runtime now selects the Workers AI adapter, with Qwen 3.8 27B and no Anthropic key. The legacy Claude SDK path remains for other runtime configurations. The initial keyless inference-only setup has been superseded by the [runtime adapter](workers-ai-runtime.md).

Reference: [Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/).

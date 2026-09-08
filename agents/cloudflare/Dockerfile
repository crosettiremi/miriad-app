FROM node:22-bookworm AS builder
WORKDIR /build
RUN npm install -g pnpm@9.15.9
COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml ./
COPY backend/packages ./packages
RUN pnpm install --frozen-lockfile --filter @miriad-systems/backend
RUN pnpm --filter @miriad-systems/backend build
RUN pnpm --filter @miriad-systems/backend deploy --prod /runtime

# Must match the exact @cloudflare/sandbox SDK version.
FROM docker.io/cloudflare/sandbox:0.12.9
COPY --from=builder /runtime /opt/miriad
RUN useradd -m -s /bin/bash agent && mkdir -p /workspace && chown agent:agent /workspace
# Keep the Sandbox control service's entrypoint. Start Miriad separately as agent.
COPY agents/cloudflare/miriad-preview.mjs /usr/local/bin/miriad-preview
RUN chmod +x /usr/local/bin/miriad-preview

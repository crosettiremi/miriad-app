import { readFileSync, writeFileSync } from 'node:fs';
const team = process.env.MIRIAD_ACCESS_TEAM_DOMAIN;
const audience = process.env.MIRIAD_ACCESS_AUD;
const runtime = process.env.MIRIAD_RUNTIME_ORIGIN;
if (
  !team ||
  !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) ||
  !audience ||
  !/^[a-f0-9]{64}$/.test(audience)
)
  throw new Error('Real Access team hostname and application AUD are required');
if (!runtime) throw new Error('MIRIAD_RUNTIME_ORIGIN is required');
const runtimeUrl = new URL(runtime);
const id = process.env.MIRIAD_HYPERDRIVE_ID;
const app = process.env.MIRIAD_APP_ORIGIN;
const preview = process.env.MIRIAD_PREVIEW_DOMAIN;
const zone = process.env.MIRIAD_PREVIEW_ZONE_ID;
if (!id || !/^[0-9a-f]{32}$/.test(id))
  throw new Error(
    'MIRIAD_HYPERDRIVE_ID is required; disable Hyperdrive query caching',
  );
if (!app || !preview || !zone || !/^[0-9a-f]{32}$/.test(zone))
  throw new Error(
    'App origin, preview domain and preview zone ID are required',
  );
const url = new URL(app);
if (
  url.protocol !== 'https:' ||
  url.origin !== app ||
  url.username ||
  url.password
)
  throw new Error('App must be an HTTPS origin without a path');
if (
  !/^[a-z0-9.-]+$/.test(preview) ||
  preview.startsWith('.') ||
  !preview.includes('.') ||
  url.hostname === preview ||
  url.hostname.endsWith('.' + preview)
)
  throw new Error('Use a separate preview hostname');
if (
  runtimeUrl.protocol !== 'https:' ||
  runtimeUrl.origin !== runtime ||
  runtime === app ||
  runtimeUrl.hostname === preview ||
  runtimeUrl.hostname.endsWith('.' + preview)
)
  throw new Error('Use a separate HTTPS runtime origin');
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
config.hyperdrive = [{ binding: 'HYPERDRIVE', id }];
config.vars = {
  ...config.vars,
  APP_ORIGIN: app,
  APP_URL: app,
  FRONTEND_URL: app,
  CAST_API_URL: app,
  ACCESS_TEAM_DOMAIN: team,
  ACCESS_AUD: audience,
  RUNTIME_ORIGIN: runtime,
  PREVIEW_DOMAIN: preview,
};
config.routes = [
  { pattern: runtimeUrl.hostname, custom_domain: true },
  { pattern: `*.${preview}/*`, zone_id: zone },
  ...(!url.hostname.endsWith('.workers.dev')
    ? [{ pattern: url.hostname, custom_domain: true }]
    : []),
];
writeFileSync(
  'wrangler.staging.generated.json',
  JSON.stringify(config, null, 2) + '\n',
);
console.log(
  'Validated staging bindings and generated deployment configuration',
);

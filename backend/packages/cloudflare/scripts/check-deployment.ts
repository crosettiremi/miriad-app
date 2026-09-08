import { readFileSync, writeFileSync } from 'node:fs';
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
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
config.hyperdrive = [{ binding: 'HYPERDRIVE', id }];
config.vars = {
  ...config.vars,
  APP_ORIGIN: app,
  APP_URL: app,
  FRONTEND_URL: app,
  CAST_API_URL: app,
  WORKOS_REDIRECT_URI: app + '/auth/callback',
  PREVIEW_DOMAIN: preview,
};
config.routes = [
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

// Secrets are provisioned with Wrangler, never checked into deployment configuration.
interface Env extends Cloudflare.Env {
  PREVIEW_DOMAIN?: string;
  PREVIEW_SECRET?: string;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  APP_ORIGIN?: string;
  JWT_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  RUNTIME_ORIGIN?: string;
  CAST_SERVER_SECRET?: string;
  CAST_CONTAINER_SECRET?: string;
  SECRET_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

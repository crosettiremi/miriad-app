/**
 * Runtime Server Auth Handlers
 *
 * REST API routes for LocalRuntime server authentication.
 *
 * Endpoints:
 * - POST /api/runtimes/bootstrap-token    - Generate bootstrap token (UI)
 * - POST /api/runtimes/bootstrap          - Exchange bootstrap for server credentials (CLI)
 * - POST /api/runtimes/agent-token        - Issue agent token (server requests)
 *
 * Flow:
 * 1. User clicks "Connect Local Runtime" in CAST UI
 * 2. UI calls /bootstrap-token → gets connection string
 * 3. User runs `npx @miriad-systems/backend auth "cast://..."` command
 * 4. CLI calls /bootstrap → exchanges token for server credentials
 * 5. Runtime uses credentials to request agent tokens via /agent-token
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createHmac, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Storage } from '@cast/storage';
import { generateContainerToken, parseSession } from '../auth/index.js';

// =============================================================================
// Configuration
// =============================================================================

// Stable dev secret - used when no environment variable is set
const DEV_SECRET = 'cast-dev-server-secret-do-not-use-in-production';

function getServerSecret(): string {
  const secret = process.env.CAST_SERVER_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') throw new Error('CAST_SERVER_SECRET is required in production');
  return secret ?? DEV_SECRET;
}

// Bootstrap token expiry (10 minutes)
const BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

export interface RuntimeAuthOptions {
  /** Storage backend */
  storage: Storage;
  /** API host for connection string (e.g., api.cast.dev) */
  apiHost: string;
  /** WebSocket host for connection string (e.g., ws.cast.dev) */
  wsHost: string;
}

// =============================================================================
// Zod Schemas
// =============================================================================

const BootstrapTokenRequestSchema = z.object({
  // No required fields - uses session for spaceId
});

const BootstrapExchangeSchema = z.object({
  bootstrapToken: z.string().min(1),
});

const AgentTokenRequestSchema = z.object({
  channelId: z.string().min(1),
  callsign: z.string().min(1),
});

// =============================================================================
// Helper Functions
// =============================================================================

function generateBootstrapToken(): string {
  return `bst_${randomBytes(24).toString('base64url')}`;
}

function generateServerId(): string {
  return `srv_${ulid()}`;
}

function generateServerSecret(serverId: string, spaceId: string): string {
  // HMAC-signed server secret
  const data = `${serverId}:${spaceId}`;
  const hmac = createHmac('sha256', getServerSecret()).update(data).digest('base64url');
  return `sk_cast_${hmac}`;
}

function formatZodError(error: z.ZodError): { error: string; details: Array<{ path: string; message: string }> } {
  return {
    error: 'validation_error',
    details: error.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    })),
  };
}

// =============================================================================
// Route Factory
// =============================================================================

export function createRuntimeAuthRoutes(options: RuntimeAuthOptions): Hono {
  const { storage, apiHost, wsHost } = options;
  const app = new Hono();

  // ---------------------------------------------------------------------------
  // POST /bootstrap-token - Generate bootstrap token (UI calls this)
  // ---------------------------------------------------------------------------
  app.post('/bootstrap-token', async (c) => {
    // Get user session (parse directly since middleware types aren't available here)
    const session = await parseSession(c);

    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const { userId, spaceId } = session;

    // Generate bootstrap token
    const token = generateBootstrapToken();
    const expiresAt = new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS);

    // Store token in database
    await storage.saveBootstrapToken({
      token,
      spaceId,
      userId,
      expiresAt,
    });

    // Build connection string and command
    const connectionString = `cast://${token}@${apiHost}/${spaceId}`;
    const command = `npx @miriad-systems/backend auth "${connectionString}"`;

    return c.json({
      bootstrapToken: token,
      expiresAt: expiresAt.toISOString(),
      connectionString,
      command,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /bootstrap - Exchange bootstrap token for server credentials (CLI)
  // ---------------------------------------------------------------------------
  app.post('/bootstrap', async (c) => {
    // Parse request body
    const body = await c.req.json().catch(() => ({}));
    const parsed = BootstrapExchangeSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { bootstrapToken } = parsed.data;

    // Look up bootstrap token from database
    // getBootstrapToken already checks consumed=false and expires_at > now
    const tokenData = await storage.getBootstrapToken(bootstrapToken);

    if (!tokenData) {
      return c.json({ error: 'Invalid or expired bootstrap token' }, 401);
    }

    // Atomically consume the token
    // This prevents race conditions where two requests try to consume the same token
    const consumed = await storage.consumeBootstrapToken(bootstrapToken);

    if (!consumed) {
      // Token was consumed by another request between our lookup and consume
      return c.json({ error: 'Bootstrap token already consumed' }, 409);
    }

    // Generate server credentials
    const serverId = generateServerId();
    const secret = generateServerSecret(serverId, tokenData.spaceId);

    // Store server credentials in database
    await storage.saveLocalAgentServer({
      serverId,
      spaceId: tokenData.spaceId,
      userId: tokenData.userId,
      secret,
    });

    console.log(`[RuntimeAuth] Issued server credentials ${serverId} for space ${tokenData.spaceId}`);

    return c.json({
      serverId,
      secret,
      spaceId: tokenData.spaceId,
      host: apiHost,
      wsHost,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /agent-token - Issue agent token (server requests this)
  // ---------------------------------------------------------------------------
  app.post('/agent-token', async (c) => {
    // Parse Authorization header
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Server ')) {
      return c.json({ error: 'Authorization header required (Server <secret>)' }, 401);
    }

    const secret = authHeader.slice(7); // Remove 'Server ' prefix

    // Look up server credentials from database
    const serverCreds = await storage.getLocalAgentServerBySecret(secret);

    if (!serverCreds) {
      return c.json({ error: 'Invalid server credentials' }, 401);
    }

    // Parse request body
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentTokenRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { channelId, callsign } = parsed.data;

    // Verify channel exists and belongs to server's space
    const channel = await storage.getChannelById(channelId);

    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    if (channel.spaceId !== serverCreds.spaceId) {
      return c.json({ error: 'Channel not accessible from this space' }, 403);
    }

    // Generate agent token (same format as containers)
    const token = generateContainerToken({
      spaceId: serverCreds.spaceId,
      channelId,
      callsign,
    });

    console.log(`[RuntimeAuth] Issued agent token for ${callsign} in channel ${channelId}`);

    return c.json({ token });
  });

  // ---------------------------------------------------------------------------
  // GET /servers - List active servers for current user (UI calls this)
  // ---------------------------------------------------------------------------
  app.get('/servers', async (c) => {
    // Get user session
    const session = await parseSession(c);

    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const servers = await storage.getLocalAgentServersByUser(session.userId);

    // Format response for frontend
    const formattedServers = servers.map((s) => ({
      serverId: s.serverId,
      spaceId: s.spaceId,
      connectedAt: s.createdAt,
      // Note: agentCount would require tracking active connections per server
      // For now, return 0 — can be enhanced later
      agentCount: 0,
      status: 'active',
    }));

    return c.json({ servers: formattedServers });
  });

  // ---------------------------------------------------------------------------
  // DELETE /servers/:id - Revoke a server (UI calls this)
  // ---------------------------------------------------------------------------
  app.delete('/servers/:id', async (c) => {
    // Get user session
    const session = await parseSession(c);

    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const serverId = c.req.param('id');

    // Verify server belongs to user before revoking
    const servers = await storage.getLocalAgentServersByUser(session.userId);
    const server = servers.find((s) => s.serverId === serverId);

    if (!server) {
      return c.json({ error: 'Server not found' }, 404);
    }

    const revoked = await storage.revokeLocalAgentServer(serverId);

    if (!revoked) {
      return c.json({ error: 'Failed to revoke server' }, 500);
    }

    console.log(`[RuntimeAuth] Revoked server credentials ${serverId}`);

    return c.json({ success: true });
  });

  return app;
}

// =============================================================================
// Server Auth Middleware (for WebSocket)
// =============================================================================

export interface ServerAuthResult {
  serverId: string;
  spaceId: string;
  userId: string;
}

/**
 * Create a function to verify server credentials from Authorization header.
 * For use in WebSocket upgrade handler.
 *
 * @param storage - Storage backend for looking up credentials
 * @returns Function that verifies server auth from Authorization header
 */
export function createServerAuthVerifier(storage: Storage) {
  return async function verifyServerAuth(authHeader: string | undefined): Promise<ServerAuthResult | null> {
    if (!authHeader?.startsWith('Server ')) {
      return null;
    }

    const secret = authHeader.slice(7);
    const serverCreds = await storage.getLocalAgentServerBySecret(secret);

    if (!serverCreds) {
      return null;
    }

    return {
      serverId: serverCreds.serverId,
      spaceId: serverCreds.spaceId,
      userId: serverCreds.userId,
    };
  };
}

/**
 * @deprecated Use createServerAuthVerifier(storage) instead.
 * This synchronous version is kept for backward compatibility but will always return null.
 */
export function verifyServerAuth(authHeader: string | undefined): ServerAuthResult | null {
  console.warn('[RuntimeAuth] verifyServerAuth is deprecated - use createServerAuthVerifier(storage) for async DB lookup');
  // Return null - caller should migrate to async version
  return null;
}

/**
 * @deprecated Use storage.getLocalAgentServersByUser() directly.
 * This function is kept for backward compatibility but will always return empty array.
 */
export function getServerCredentialsByUser(userId: string): Array<{
  serverId: string;
  spaceId: string;
  createdAt: Date;
}> {
  console.warn('[RuntimeAuth] getServerCredentialsByUser is deprecated - use storage.getLocalAgentServersByUser() directly');
  return [];
}

/**
 * @deprecated Use storage.revokeLocalAgentServer() directly.
 * This function is kept for backward compatibility but will always return false.
 */
export function revokeServerCredentials(serverId: string): boolean {
  console.warn('[RuntimeAuth] revokeServerCredentials is deprecated - use storage.revokeLocalAgentServer() directly');
  return false;
}

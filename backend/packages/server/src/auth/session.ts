/**
 * Session Management
 *
 * JWT-based session handling for user authentication.
 * Sessions are stored in httpOnly cookies for security.
 */

import { sign, verify } from 'hono/jwt';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

// =============================================================================
// Types
// =============================================================================

export type AuthMode = 'dev' | 'workos';

export interface SessionPayload {
  /** User ID */
  userId: string;
  /** Space ID */
  spaceId: string;
  /** Authentication mode */
  mode: AuthMode;
  /** WorkOS session ID (for logout) - only present when mode is 'workos' */
  workosSessionId?: string;
  /** Issued at timestamp */
  iat: number;
  /** Expiration timestamp */
  exp: number;
}

export interface SessionData {
  userId: string;
  spaceId: string;
  mode: AuthMode;
  /** WorkOS session ID (for logout) - only present when mode is 'workos' */
  workosSessionId?: string;
}

// =============================================================================
// Configuration
// =============================================================================

const COOKIE_NAME = 'cast_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Get the JWT secret from environment or use a default for dev.
 * In production, JWT_SECRET must be set.
 */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is required in production');
    }
    // Default secret for local development only
    return 'cast-dev-secret-do-not-use-in-production';
  }
  return secret;
}

// =============================================================================
// Session Functions
// =============================================================================

/**
 * Create a new session JWT token.
 * @param workosSessionId - WorkOS session ID for logout (required when mode is 'workos')
 */
export async function createSession(
  userId: string,
  spaceId: string,
  mode: AuthMode,
  workosSessionId?: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.floor(SESSION_DURATION_MS / 1000);

  const payload: Record<string, unknown> = {
    userId,
    spaceId,
    mode,
    iat: now,
    exp,
  };

  // Include WorkOS session ID for logout support
  if (workosSessionId) {
    payload.workosSessionId = workosSessionId;
  }

  return await sign(payload, getJwtSecret());
}

/**
 * Parse and verify a session from the request cookie.
 * Returns null if no valid session exists.
 */
export async function parseSession(c: Context): Promise<SessionData | null> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) {
    return null;
  }

  try {
    const payload = await verify(token, getJwtSecret()) as unknown as SessionPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }

    // Validate required fields exist
    if (!payload.userId || !payload.spaceId || !payload.mode) {
      return null;
    }

    return {
      userId: payload.userId,
      spaceId: payload.spaceId,
      mode: payload.mode,
      workosSessionId: payload.workosSessionId,
    };
  } catch {
    // Invalid or expired token
    return null;
  }
}

/**
 * Get the cookie domain based on FRONTEND_URL or STAGE.
 * Returns undefined for localhost (no domain scoping needed).
 */
function getCookieDomain(): string | undefined {
  // Host-only by default; never infer a registrable domain from hostname labels.
  return process.env.SESSION_COOKIE_DOMAIN || undefined;
}

/**
 * Set the session cookie on the response.
 *
 * Cookie domain is derived from FRONTEND_URL to support multiple deployments:
 * - miriad.tech (production)
 * - caststack.ai (legacy)
 * - localhost (development)
 */
export function setSessionCookie(c: Context, token: string): void {
  const isProduction = process.env.NODE_ENV === 'production' ||
    process.env.STAGE === 'stag' ||
    process.env.STAGE === 'prod';

  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'Lax',
    path: '/',
    domain: getCookieDomain(),
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
  });
}

/**
 * Clear the session cookie.
 */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, {
    path: '/',
    domain: getCookieDomain(),
  });
}

/**
 * Verify a session token directly (without Hono context).
 * Useful for WebSocket upgrade handlers that only have raw cookies.
 */
export async function verifySessionToken(token: string): Promise<SessionData | null> {
  if (!token) {
    return null;
  }

  try {
    const payload = (await verify(token, getJwtSecret())) as unknown as SessionPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }

    // Validate required fields exist
    if (!payload.userId || !payload.spaceId || !payload.mode) {
      return null;
    }

    return {
      userId: payload.userId,
      spaceId: payload.spaceId,
      mode: payload.mode,
      workosSessionId: payload.workosSessionId,
    };
  } catch {
    // Invalid or expired token
    return null;
  }
}

/**
 * Parse session cookie from a raw cookie header string.
 * Returns the session token if found.
 */
export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }

  // Parse cookie header: "name1=value1; name2=value2"
  const cookies = cookieHeader.split(';').reduce(
    (acc, cookie) => {
      const [name, ...rest] = cookie.trim().split('=');
      if (name) {
        acc[name] = rest.join('=');
      }
      return acc;
    },
    {} as Record<string, string>
  );

  return cookies[COOKIE_NAME] || null;
}

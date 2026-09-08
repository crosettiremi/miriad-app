/**
 * WorkOS Auth Routes
 *
 * Production authentication flow using WorkOS AuthKit.
 * - GET /auth/login → redirect to WorkOS
 * - GET /auth/callback → handle OAuth callback
 * - POST /auth/complete-onboarding → complete new user setup
 */

import { Hono } from 'hono';
import { WorkOS } from '@workos-inc/node';
import { sign, verify } from 'hono/jwt';
import { createOAuthState, consumeOAuthState } from './oauth-state.js';
import type { Storage } from '@cast/storage';
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  parseSession,
} from './session.js';
import { seedSpaceFromSanity } from '../onboarding/index.js';

// =============================================================================
// Types
// =============================================================================

export interface WorkOSAuthOptions {
  storage: Storage;
}

interface OnboardingTokenPayload {
  /** WorkOS user ID */
  workosUserId: string;
  /** User's email from WorkOS */
  email: string;
  /** User's display name from WorkOS (optional) */
  displayName?: string;
  /** Suggested callsign derived from name/email */
  suggestedCallsign: string;
  /** WorkOS session ID for logout support */
  workosSessionId?: string;
  /** Token type marker */
  type: 'onboarding';
  /** Issued at timestamp */
  iat: number;
  /** Expiration timestamp (short-lived) */
  exp: number;
}

interface CompleteOnboardingBody {
  callsign: string;
  spaceName?: string;
  onboardingToken: string;
}

// =============================================================================
// Configuration
// =============================================================================

const ONBOARDING_TOKEN_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Get frontend URL for redirects.
 * Required for cross-origin deployments where API and frontend are on different domains.
 */
function getFrontendUrl(): string {
  return process.env.FRONTEND_URL || 'http://localhost:5173';
}

/**
 * Get WorkOS configuration from environment.
 * All values are required in production.
 */
function getWorkOSConfig(): { apiKey: string; clientId: string; redirectUri: string } {
  const apiKey = process.env.WORKOS_API_KEY;
  const clientId = process.env.WORKOS_CLIENT_ID;
  const redirectUri = process.env.WORKOS_REDIRECT_URI;

  if (!apiKey || !clientId || !redirectUri) {
    throw new Error(
      'WorkOS configuration missing. Required: WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI'
    );
  }

  return { apiKey, clientId, redirectUri };
}

/**
 * Get JWT secret for onboarding tokens.
 */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is required in production');
    }
    return 'cast-dev-secret-do-not-use-in-production';
  }
  return secret;
}

/**
 * Create a short-lived onboarding token for new users.
 */
async function createOnboardingToken(
  workosUserId: string,
  email: string,
  displayName: string | undefined,
  suggestedCallsign: string,
  workosSessionId?: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.floor(ONBOARDING_TOKEN_DURATION_MS / 1000);

  const payload: Record<string, unknown> = {
    workosUserId,
    email,
    displayName,
    suggestedCallsign,
    type: 'onboarding' as const,
    iat: now,
    exp,
  };

  // Include WorkOS session ID for logout support after onboarding
  if (workosSessionId) {
    payload.workosSessionId = workosSessionId;
  }

  return await sign(payload, getJwtSecret());
}

/**
 * Verify and decode an onboarding token.
 */
async function verifyOnboardingToken(token: string): Promise<OnboardingTokenPayload | null> {
  try {
    const payload = await verify(token, getJwtSecret()) as unknown as OnboardingTokenPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }

    // Validate token type
    if (payload.type !== 'onboarding') {
      return null;
    }

    // Validate required fields
    if (!payload.workosUserId || !payload.email || !payload.suggestedCallsign) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Decode a JWT without verification to extract claims.
 * Used to get session ID from WorkOS access token.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Derive a suggested callsign from user info.
 * Uses first name if available, otherwise email prefix.
 */
function deriveCallsign(email: string, displayName?: string): string {
  if (displayName) {
    // Use first name, lowercase, no spaces
    const firstName = displayName.split(/\s+/)[0];
    return firstName.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Fall back to email prefix
  const emailPrefix = email.split('@')[0];
  return emailPrefix.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// =============================================================================
// Routes
// =============================================================================

export function createWorkOSAuthRoutes(options: WorkOSAuthOptions): Hono {
  const { storage } = options;
  const app = new Hono();

  /**
   * GET /auth/login
   *
   * Redirect user to WorkOS AuthKit for authentication.
   * Query params:
   * - returnTo (optional): URL to redirect to after auth
   */
  app.get('/login', async (c) => {
    try {
      const config = getWorkOSConfig();
      const workos = new WorkOS(config.apiKey);

      // Store returnTo in state for post-auth redirect
      const state = await createOAuthState(c, c.req.query('returnTo'), getJwtSecret());

      const authorizationUrl = workos.userManagement.getAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        provider: 'authkit',
        state,
      });

      return c.redirect(authorizationUrl);
    } catch (error) {
      console.error('[WorkOS] Error generating auth URL:', error);
      return c.json({ error: 'Failed to initiate authentication' }, 500);
    }
  });

  /**
   * GET /auth/callback
   *
   * Handle OAuth callback from WorkOS.
   * - Exchange code for user info
   * - If existing user → create session, redirect to app
   * - If new user → redirect to onboarding with temp token
   */
  app.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    const errorDescription = c.req.query('error_description');

    const frontendUrl = getFrontendUrl();
    const returnTo = await consumeOAuthState(c, state, getJwtSecret());
    if (returnTo === null) {
      return c.redirect(`${frontendUrl}/auth-error?error=invalid_state`);
    }

    // Handle OAuth errors
    if (error) {
      console.error(`[WorkOS] OAuth error: ${error} - ${errorDescription}`);
      return c.redirect(`${frontendUrl}/auth-error?error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return c.redirect(`${frontendUrl}/auth-error?error=missing_code`);
    }

    try {
      const config = getWorkOSConfig();
      const workos = new WorkOS(config.apiKey);

      // Exchange code for user and access token
      const authResult = await workos.userManagement.authenticateWithCode({
        clientId: config.clientId,
        code,
      });
      const workosUser = authResult.user;

      // Extract session ID from access token for logout support
      const accessTokenPayload = decodeJwtPayload(authResult.accessToken);
      const workosSessionId = accessTokenPayload?.sid as string | undefined;


      // Check if user already exists
      const existingUser = await storage.getUserByExternalId(`workos:${workosUser.id}`);

      if (existingUser) {
        // Existing user - get their space and create session
        const spaces = await storage.getSpacesByOwner(existingUser.id);
        if (spaces.length === 0) {
          // User exists but has no space - this shouldn't happen, but handle it
          console.error(`[WorkOS] User ${existingUser.id} has no spaces`);
          return c.redirect(`${frontendUrl}/auth-error?error=no_space`);
        }

        // Use first space (multi-space support can come later)
        const space = spaces[0];

        // Create session with WorkOS session ID for logout support
        const token = await createSession(existingUser.id, space.id, 'workos', workosSessionId);
        setSessionCookie(c, token);

        return c.redirect(`${frontendUrl}${returnTo}`);
      }

      // New user - redirect to onboarding
      const suggestedCallsign = deriveCallsign(
        workosUser.email,
        workosUser.firstName ? `${workosUser.firstName} ${workosUser.lastName || ''}`.trim() : undefined
      );

      const onboardingToken = await createOnboardingToken(
        workosUser.id,
        workosUser.email,
        workosUser.firstName ? `${workosUser.firstName} ${workosUser.lastName || ''}`.trim() : undefined,
        suggestedCallsign,
        workosSessionId
      );

      // Redirect to onboarding page with token
      // Frontend reads token from query params on root route (/?token=xxx)
      const onboardingUrl = `${frontendUrl}/?token=${encodeURIComponent(onboardingToken)}&returnTo=${encodeURIComponent(returnTo)}`;
      return c.redirect(onboardingUrl);
    } catch (error) {
      console.error('[WorkOS] Callback error:', error);
      return c.redirect(`${frontendUrl}/auth-error?error=callback_failed`);
    }
  });

  /**
   * POST /auth/complete-onboarding
   *
   * Complete new user setup after onboarding page.
   * Creates user, space, seeds space, and creates session.
   */
  app.post('/complete-onboarding', async (c) => {
    let body: CompleteOnboardingBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { callsign, spaceName, onboardingToken } = body;

    // Validate required fields
    if (!callsign || !onboardingToken) {
      return c.json({ error: 'callsign and onboardingToken are required' }, 400);
    }

    // Validate callsign format
    const trimmedCallsign = callsign.trim().toLowerCase();
    if (trimmedCallsign.length < 2 || trimmedCallsign.length > 20) {
      return c.json({ error: 'Callsign must be 2-20 characters' }, 400);
    }
    if (!/^[a-z0-9-]+$/.test(trimmedCallsign)) {
      return c.json({ error: 'Callsign must contain only lowercase letters, numbers, and hyphens' }, 400);
    }

    // Verify onboarding token
    const tokenPayload = await verifyOnboardingToken(onboardingToken);
    if (!tokenPayload) {
      return c.json({ error: 'Invalid or expired onboarding token' }, 401);
    }

    try {
      // Check if user was already created (race condition / double submit)
      const existingUser = await storage.getUserByExternalId(`workos:${tokenPayload.workosUserId}`);
      if (existingUser) {
        // User already exists - just log them in
        const spaces = await storage.getSpacesByOwner(existingUser.id);
        if (spaces.length === 0) {
          return c.json({ error: 'User exists but has no space' }, 500);
        }

        const token = await createSession(existingUser.id, spaces[0].id, 'workos', tokenPayload.workosSessionId);
        setSessionCookie(c, token);

        return c.json({
          userId: existingUser.id,
          spaceId: spaces[0].id,
          user: {
            id: existingUser.id,
            callsign: existingUser.callsign,
            email: existingUser.email,
            avatarUrl: existingUser.avatarUrl,
            disclaimerAcceptedVersion: existingUser.disclaimerAcceptedVersion,
          },
          space: {
            id: spaces[0].id,
            name: spaces[0].name,
            ownerId: spaces[0].ownerId,
          },
        });
      }

      // Create new user
      const user = await storage.createUser({
        externalId: `workos:${tokenPayload.workosUserId}`,
        callsign: trimmedCallsign,
        email: tokenPayload.email,
      });

      // Create space
      const finalSpaceName = spaceName?.trim() || `${trimmedCallsign}'s space`;
      const space = await storage.createSpace({
        ownerId: user.id,
        name: finalSpaceName,
      });

      // Seed space with content from Sanity
      await seedSpaceFromSanity(storage, space.id);

      // Create session with WorkOS session ID for logout support
      const token = await createSession(user.id, space.id, 'workos', tokenPayload.workosSessionId);
      setSessionCookie(c, token);

      return c.json({
        userId: user.id,
        spaceId: space.id,
        user: {
          id: user.id,
          callsign: user.callsign,
          email: user.email,
          avatarUrl: user.avatarUrl,
          disclaimerAcceptedVersion: user.disclaimerAcceptedVersion,
        },
        space: {
          id: space.id,
          name: space.name,
          ownerId: space.ownerId,
        },
      }, 201);
    } catch (error) {
      console.error('[WorkOS] Error completing onboarding:', error);
      return c.json({ error: 'Failed to complete onboarding' }, 500);
    }
  });

  /**
   * GET /auth/onboarding-info
   *
   * Get info from onboarding token for the onboarding page.
   * Returns suggested callsign, email, display name.
   */
  app.get('/onboarding-info', async (c) => {
    const token = c.req.query('token');
    if (!token) {
      return c.json({ error: 'Token is required' }, 400);
    }

    const payload = await verifyOnboardingToken(token);
    if (!payload) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    return c.json({
      email: payload.email,
      displayName: payload.displayName,
      suggestedCallsign: payload.suggestedCallsign,
    });
  });

  /**
   * GET /auth/logout
   *
   * Log out the user by:
   * 1. Clearing the local session cookie
   * 2. Redirecting to WorkOS logout URL to end the WorkOS session
   *
   * Query params:
   * - returnTo (optional): URL to redirect to after logout (must be configured in WorkOS dashboard)
   */
  app.get('/logout', async (c) => {
    const frontendUrl = getFrontendUrl();

    // Parse session to get WorkOS session ID
    const session = await parseSession(c);

    // Always clear local cookie first
    clearSessionCookie(c);

    // If no session or no WorkOS session ID, just redirect to frontend
    if (!session?.workosSessionId) {
      console.log('[WorkOS] Logout: No WorkOS session ID, redirecting to frontend');
      return c.redirect(frontendUrl);
    }

    try {
      const config = getWorkOSConfig();
      const workos = new WorkOS(config.apiKey);

      // Get logout URL from WorkOS
      const returnTo = c.req.query('returnTo') || frontendUrl;
      const logoutUrl = workos.userManagement.getLogoutUrl({
        sessionId: session.workosSessionId,
        returnTo,
      });

      console.log(`[WorkOS] Logout: Redirecting to WorkOS logout URL`);
      return c.redirect(logoutUrl);
    } catch (error) {
      console.error('[WorkOS] Error getting logout URL:', error);
      // Fall back to just redirecting to frontend (cookie already cleared)
      return c.redirect(frontendUrl);
    }
  });

  /**
   * POST /auth/logout
   *
   * API-style logout for frontend compatibility.
   * Returns the WorkOS logout URL for the frontend to redirect to.
   * Clears the local session cookie.
   */
  app.post('/logout', async (c) => {
    const frontendUrl = getFrontendUrl();

    // Parse session to get WorkOS session ID
    const session = await parseSession(c);

    // Always clear local cookie first
    clearSessionCookie(c);

    // If no session or no WorkOS session ID, return success without redirect URL
    if (!session?.workosSessionId) {
      console.log('[WorkOS] Logout: No WorkOS session ID');
      return c.json({ ok: true });
    }

    try {
      const config = getWorkOSConfig();
      const workos = new WorkOS(config.apiKey);

      // Get logout URL from WorkOS for frontend to redirect
      const logoutUrl = workos.userManagement.getLogoutUrl({
        sessionId: session.workosSessionId,
        returnTo: frontendUrl,
      });

      console.log(`[WorkOS] Logout: Returning logout URL for frontend redirect`);
      return c.json({ ok: true, logoutUrl });
    } catch (error) {
      console.error('[WorkOS] Error getting logout URL:', error);
      // Return success anyway - cookie is cleared
      return c.json({ ok: true });
    }
  });

  return app;
}

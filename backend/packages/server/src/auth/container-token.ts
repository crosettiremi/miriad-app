/**
 * Container Token Authentication
 *
 * Generates and verifies tokens for Docker container authentication.
 * Token format: base64url(spaceId:channelId:callsign).hmac
 *
 * The HMAC ensures containers can only access their assigned space/channel.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// =============================================================================
// Configuration
// =============================================================================

// Stable dev secret - used when no environment variable is set
const DEV_SECRET = 'cast-dev-container-secret-do-not-use-in-production';

function getContainerSecret(): string {
  const secret = process.env.CAST_CONTAINER_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') throw new Error('CAST_CONTAINER_SECRET is required in production');
  return secret ?? DEV_SECRET;
}

// =============================================================================
// Types
// =============================================================================

export interface ContainerTokenPayload {
  spaceId: string;
  channelId: string;
  callsign: string;
}

// =============================================================================
// Token Functions
// =============================================================================

/**
 * Generate a container auth token.
 *
 * @param payload - Space, channel, and callsign identifiers
 * @returns Token string to inject as CONTAINER_TOKEN env var
 */
export function generateContainerToken(payload: ContainerTokenPayload): string {
  const data = `${payload.spaceId}:${payload.channelId}:${payload.callsign}`;
  const encodedData = Buffer.from(data).toString('base64url');
  const hmac = createHmac('sha256', getContainerSecret()).update(data).digest('base64url');
  return `${encodedData}.${hmac}`;
}

/**
 * Verify and decode a container auth token.
 *
 * @param token - Token string from container
 * @returns Decoded payload if valid, null if invalid
 */
export function verifyContainerToken(token: string): ContainerTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [encodedData, providedHmac] = parts;

  // Decode payload
  let data: string;
  try {
    data = Buffer.from(encodedData, 'base64url').toString('utf-8');
  } catch {
    return null;
  }

  // Verify HMAC with timing-safe comparison
  const expectedHmac = createHmac('sha256', getContainerSecret()).update(data).digest('base64url');
  const providedBuffer = Buffer.from(providedHmac);
  const expectedBuffer = Buffer.from(expectedHmac);

  // Reject if lengths differ or content doesn't match (timing-safe)
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  // Parse payload
  const dataParts = data.split(':');
  if (dataParts.length !== 3) {
    return null;
  }

  return {
    spaceId: dataParts[0],
    channelId: dataParts[1],
    callsign: dataParts[2],
  };
}

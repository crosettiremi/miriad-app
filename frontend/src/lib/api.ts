/**
 * API Client for CAST
 *
 * Simplified client - assumes always authenticated for local development.
 * Auth will be added later via WorkOS.
 */

import type { Message } from '../types'

// API host - use env var or default to local dev server (port 3234 to avoid conflicts)
// This is the single source of truth for backend URL - all HTTP and WebSocket calls should use this
export const API_HOST = import.meta.env.VITE_BACKEND_URL || (import.meta.env.PROD ? window.location.origin : 'http://localhost:3234')

// =============================================================================
// Auth Types
// =============================================================================

export interface StoredUser {
  id: string
  externalId: string
  callsign: string
  email?: string
  avatarUrl?: string
  createdAt: string
  updatedAt: string
  disclaimerAcceptedVersion?: string
}

export interface StoredSpace {
  id: string
  name: string
  ownerId: string
  createdAt: string
  updatedAt: string
}

export interface AuthSession {
  userId: string
  spaceId: string
  user: StoredUser
  space: StoredSpace
  /** WebSocket auth token for AWS API Gateway connections */
  wsToken?: string
}

export interface SpaceWithOwner {
  space: StoredSpace
  owner: StoredUser
}

// =============================================================================
// Auth Functions
// =============================================================================

/**
 * Check if user is authenticated.
 * Calls /auth/me endpoint and returns session info if authenticated.
 */
export async function checkAuth(): Promise<AuthSession | null> {
  try {
    const response = await fetch(`${API_HOST}/auth/me`, {
      credentials: 'include',
    })
    if (response.status === 401) {
      return null
    }
    if (!response.ok) {
      console.error('Auth check failed:', response.status)
      return null
    }
    return response.json()
  } catch (error) {
    console.error('Auth check error:', error)
    return null
  }
}

/**
 * Fetch available spaces for dev mode login.
 */
export async function fetchDevSpaces(): Promise<SpaceWithOwner[]> {
  const response = await fetch(`${API_HOST}/auth/dev/spaces`, {
    credentials: 'include',
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch spaces: ${response.status}`)
  }
  const data = await response.json()
  return data.spaces || []
}

/**
 * Dev mode login - either login to existing space or create new user+space.
 */
export async function devLogin(params: {
  spaceId?: string
  callsign?: string
  spaceName?: string
}): Promise<{ userId: string; spaceId: string }> {
  const response = await fetch(`${API_HOST}/auth/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `Login failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Log out - clears session cookie and ends WorkOS session if applicable.
 * For WorkOS auth, redirects to WorkOS logout URL to properly end the session.
 */
export async function logout(): Promise<void> {
  try {
    const response = await fetch(`${API_HOST}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = await response.json()

    // If server returned a logout URL (WorkOS), redirect to it
    // This ensures the WorkOS session is properly terminated
    if (data.logoutUrl) {
      window.location.href = data.logoutUrl
      return
    }
  } catch (error) {
    console.error('Logout error:', error)
  }
  // For dev mode or if no redirect URL, just reload the page
  window.location.reload()
}

/**
 * Complete onboarding for new WorkOS users.
 * Called after OAuth when user needs to pick callsign and space name.
 */
export async function completeOnboarding(params: {
  callsign: string
  spaceName: string
  onboardingToken: string
}): Promise<{ userId: string; spaceId: string }> {
  const response = await fetch(`${API_HOST}/auth/complete-onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `Onboarding failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Fetch wrapper for API calls.
 * Includes credentials for session cookie authentication.
 */
export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  // Prepend API_HOST if path is relative
  const url = input.startsWith('/') ? `${API_HOST}${input}` : input

  const response = await fetch(url, {
    ...init,
    credentials: 'include',
  })

  return response
}

/**
 * Custom error class for auth failures.
 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Helper for JSON API calls.
 */
export async function apiJson<T>(
  input: string,
  init?: RequestInit
): Promise<T> {
  const response = await apiFetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || `API error: ${response.status}`)
  }

  return response.json()
}

/**
 * POST JSON helper.
 */
export async function apiPost<T>(
  input: string,
  body: unknown
): Promise<T> {
  return apiJson<T>(input, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * PUT JSON helper.
 */
export async function apiPut<T>(
  input: string,
  body: unknown
): Promise<T> {
  return apiJson<T>(input, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/**
 * DELETE helper.
 */
export async function apiDelete(input: string): Promise<void> {
  const response = await apiFetch(input, {
    method: 'DELETE',
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error || `API error: ${response.status}`)
  }
}

// =============================================================================
// Disclaimer Types & Functions
// =============================================================================

export interface DisclaimerResponse {
  title: string
  content: string
  version: string
}

/**
 * Fetch the current legal disclaimer.
 */
export async function fetchDisclaimer(): Promise<DisclaimerResponse> {
  return apiJson<DisclaimerResponse>('/disclaimer')
}

/**
 * Accept the legal disclaimer.
 */
export async function acceptDisclaimer(params: {
  confirmation: string
  version: string
}): Promise<{ success: boolean; disclaimerAcceptedVersion: string }> {
  return apiPost('/disclaimer/accept', params)
}

// =============================================================================
// Backend/Engine Types
// =============================================================================

export interface BackendCapabilities {
  supportsMcp: boolean
  supportsTools: boolean
  supportsVision: boolean
}

export interface BackendInfo {
  name: string
  isBuiltIn: boolean
  capabilities: BackendCapabilities
}

/**
 * Fetch available backends/engines from the API.
 */
export async function fetchBackends(): Promise<BackendInfo[]> {
  const response = await apiFetch('/api/backends')
  if (!response.ok) {
    throw new Error('Failed to fetch backends')
  }
  return response.json()
}

// =============================================================================
// Structured Ask Functions
// =============================================================================

export interface StructuredAskResponseResult {
  ok: boolean
  messageId: string
  followUpMessageId: string
  formState: 'submitted'
}

/**
 * Submit a response to a structured ask form.
 */
export async function submitStructuredAskResponse(
  channelId: string,
  messageId: string,
  response: Record<string, unknown>,
  respondedBy: string
): Promise<StructuredAskResponseResult> {
  return apiPost<StructuredAskResponseResult>(
    `/channels/${channelId}/messages/${messageId}/respond`,
    { response, respondedBy }
  )
}

interface StructuredAskDismissResult {
  ok: boolean
  messageId: string
  followUpMessageId: string
  formState: 'dismissed'
}

/**
 * Dismiss/cancel a structured ask form.
 */
export async function dismissStructuredAsk(
  channelId: string,
  messageId: string,
  dismissedBy: string
): Promise<StructuredAskDismissResult> {
  return apiPost<StructuredAskDismissResult>(
    `/channels/${channelId}/messages/${messageId}/dismiss`,
    { dismissedBy }
  )
}

/**
 * Get all pending structured asks for a channel.
 * This fetches from the database, not just loaded messages.
 */
export async function getPendingAsks(
  channelId: string
): Promise<{ messages: Message[] }> {
  return apiJson<{ messages: Message[] }>(
    `/channels/${channelId}/pending-asks`
  )
}

// =============================================================================
// Event Messages
// =============================================================================

/**
 * Send an event message to a channel.
 * Event messages (type: 'event') are hidden from the chat UI but trigger agents.
 * Used for system-initiated nudges like first-agent greetings.
 */
export async function sendEventMessage(
  channelId: string,
  content: string
): Promise<{ id: string }> {
  return apiPost<{ id: string }>(
    `/channels/${channelId}/messages`,
    { content, sender: '__event__', senderType: 'user', type: 'event' }
  )
}

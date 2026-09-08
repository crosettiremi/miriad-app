/**
 * PostgreSQL Storage Implementation
 *
 * Uses @neondatabase/serverless for PlanetScale Postgres.
 * HTTP-based queries optimized for serverless environments.
 *
 * @see https://planetscale.com/docs/postgres/connecting/neon-serverless-driver
 */

import { neon, neonConfig, NeonQueryFunction } from '@neondatabase/serverless';
import crypto from 'crypto';
import { ulid } from 'ulid';
import type {
  StoredMessage,
  CreateMessageInput,
  GetMessagesParams,
  StoredChannel,
  CreateChannelInput,
  UpdateChannelInput,
  ListChannelsParams,
  RosterEntry,
  AddToRosterInput,
  UpdateRosterInput,
  RosterStatus,
  RosterCurrent,
  // User/Space types (Spaces & Auth)
  StoredUser,
  CreateUserInput,
  StoredSpace,
  CreateSpaceInput,
  // Artifact types (Phase A)
  StoredArtifact,
  CreateArtifactInput,
  ArtifactCASChange,
  ArtifactCASResult,
  ArtifactEditInput,
  ListArtifactsParams,
  ArtifactSummary,
  ArtifactTreeNode,
  ArtifactVersion,
  CreateArtifactVersionInput,
  ArtifactType,
  ArtifactStatus,
  RecursiveArchiveResult,
  ArchivedItem,
  // Secrets types (App Integrations)
  SecretMetadata,
  StoredSecret,
  // Local Agent Server types (Stage 3)
  StoredLocalAgentServer,
  CreateLocalAgentServerInput,
  // Bootstrap Token types (Stage 3)
  StoredBootstrapToken,
  CreateBootstrapTokenInput,
  // Cost tracking types
  StoredCostRecord,
  CreateCostRecordInput,
  CostTally,
  TokenUsage,
  ModelUsage,
  // WebSocket connection types
  StoredConnection,
  ConnectionProtocol,
  // Runtime types
  StoredRuntime,
  CreateRuntimeInput,
  UpdateRuntimeInput,
  RuntimeType,
  RuntimeStatus,
  LocalRuntimeConfig,
} from '@cast/core';
// Import functions separately (not as types)
import {
  extractRefs,
  getDefaultArtifactStatus,
  slugToPathSegment,
} from '@cast/core';
import type { Storage, SetSecretInput } from './interface.js';

// =============================================================================
// Types
// =============================================================================

export interface PostgresStorageOptions {
  /** PostgreSQL connection string */
  connectionString?: string;
  /** Inject a transport, e.g. Postgres.js via Hyperdrive. */
  sql?: TypedSql;
}

/**
 * Configure Neon driver for PlanetScale Postgres.
 * Must be set before creating any connections.
 *
 * @see https://planetscale.com/docs/postgres/connecting/neon-serverless-driver
 */
neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;

/**
 * Tagged template function type that allows generic result typing.
 * Wraps Neon's query function to provide type safety.
 */
export interface TypedSql {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  /** Parameterized query with placeholders ($1, $2, etc.) */
  query<T = Record<string, unknown>>(queryString: string, params: unknown[]): Promise<T[]>;
}

/**
 * Create a postgres client using Neon's HTTP driver.
 * Optimized for serverless environments - each query is a stateless HTTP request.
 */
export function createPostgresClient(connectionString: string): TypedSql {
  const client = neon(connectionString);
  // Wrap the client to provide type-safe query interface
  const typedSql = (<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    return client(strings, ...values) as Promise<T[]>;
  }) as TypedSql;
  // Add query method for parameterized queries
  typedSql.query = <T = Record<string, unknown>>(
    queryString: string,
    params: unknown[]
  ): Promise<T[]> => {
    return client.query(queryString, params) as Promise<T[]>;
  };
  return typedSql;
}

/** Type of the postgres client returned by createPostgresClient */
export type PostgresClient = TypedSql;

/**
 * Valid SQL identifier pattern: letters, numbers, underscores, starting with letter or underscore.
 */
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * TEMPORARY: Defensive parsing for JSONB columns that may have been double-stringified.
 * Only logs when a string looks like a JSON object/array (starts with { or [).
 * Plain strings are valid JSONB values and don't trigger warnings.
 * TODO: Remove once we confirm the Neon migration is stable.
 */
function parseJsonbField<T>(value: unknown, context: string): T | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Only warn and parse if it looks like a stringified object/array
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      console.warn(`[Storage] JSONB double-stringified - ${context}:`, value.slice(0, 100));
      try {
        return JSON.parse(value) as T;
      } catch {
        return null;
      }
    }
    // Plain string - valid JSONB value, no warning
    return null;
  }
  return value as T | null;
}

/**
 * Helper to build dynamic UPDATE SET clauses for Neon driver.
 * Returns [setClauses, values, nextParamIndex] for building parameterized queries.
 *
 * @example
 * const obj = { name: 'foo', count: 42 };
 * const [setClauses, values, nextIdx] = buildSetClause(obj);
 * // setClauses = "name = $1, count = $2"
 * // values = ['foo', 42]
 * // nextIdx = 3
 */
function buildSetClause(
  obj: Record<string, unknown>,
  startIndex: number = 1
): [string, unknown[], number] {
  const entries = Object.entries(obj);
  // Validate column names to prevent SQL injection
  for (const [key] of entries) {
    if (!VALID_IDENTIFIER.test(key)) {
      throw new Error(`Invalid column name: ${key}`);
    }
  }
  const setClauses = entries
    .map(([key], i) => `${key} = $${startIndex + i}`)
    .join(', ');
  const values = entries.map(([, value]) => value);
  return [setClauses, values, startIndex + entries.length];
}

// Row type from database
interface MessageRow {
  id: string;
  space_id: string;
  channel_id: string;
  sender: string;
  sender_type: string;
  type: string;
  content: unknown;
  timestamp: Date;
  is_complete: boolean;
  addressed_agents: string[] | null;
  turn_id: string | null;
  metadata: Record<string, unknown> | null;
  state: string | null;
}

interface ChannelRow {
  id: string;
  space_id: string;
  name: string;
  tagline: string | null;
  mission: string | null;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
  last_active_at: Date;
}

interface RosterRow {
  id: string;
  channel_id: string;
  callsign: string;
  agent_type: string;
  status: string;
  created_at: Date;
  callback_url: string | null;
  readmark: string | null;
  tunnel_hash: string | null;
  last_heartbeat: Date | null;
  route_hints: Record<string, string> | null;
  current: Record<string, unknown> | null;
  last_message_routed_at: Date | null;
  runtime_id: string | null;
  runtime_name?: string | null;
  runtime_status?: string | null;
  props: Record<string, unknown> | null;
}

interface UserRow {
  id: string;
  external_id: string;
  callsign: string;
  email: string | null;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
  disclaimer_accepted_version: string | null;
}

interface SpaceRow {
  id: string;
  owner_id: string;
  name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ArtifactRow {
  id: string;
  channel_id: string;
  slug: string;
  type: string;
  title: string | null;
  tldr: string | null;
  content: string;
  parent_slug: string | null;
  path: string;
  order_key: string;
  status: string;
  assignees: string[];
  labels: string[];
  refs: string[];
  props: Record<string, unknown> | null;
  secrets: Record<string, StoredSecret> | null;
  content_type: string | null;
  file_size: number | null;
  attached_to_message_id: string | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date | null;
}

interface ArtifactVersionRow {
  slug: string;
  channel_id: string;
  version_name: string;
  version_message: string | null;
  version_created_at: Date;
  version_created_by: string;
  tldr: string;
  content: string;
}

interface LocalAgentServerRow {
  server_id: string;
  space_id: string;
  user_id: string;
  secret: string;
  created_at: Date;
  revoked_at: Date | null;
}

interface BootstrapTokenRow {
  token: string;
  space_id: string;
  user_id: string;
  expires_at: Date;
  consumed: boolean;
  created_at: Date;
}

interface RuntimeRow {
  id: string;
  space_id: string;
  server_id: string | null;
  name: string;
  type: string;
  status: string;
  config: Record<string, unknown> | null;
  created_at: Date;
  last_seen_at: Date | null;
}

// =============================================================================
// PostgreSQL Storage Implementation
// =============================================================================

export function createPostgresStorage(options: PostgresStorageOptions): Storage {
  if (!options.sql && !options.connectionString) throw new Error('PostgreSQL transport is required');
  const sql = options.sql ?? createPostgresClient(options.connectionString!);

  // ---------------------------------------------------------------------------
  // Message Operations
  // ---------------------------------------------------------------------------

  async function saveMessage(input: CreateMessageInput): Promise<StoredMessage> {
    const id = input.id ?? ulid();
    const timestamp = new Date();
    const isComplete = input.isComplete ?? true;

    const result = await sql<MessageRow>`
      INSERT INTO messages (
        id, space_id, channel_id, sender, sender_type, type, content,
        timestamp, is_complete, addressed_agents, turn_id, metadata, state
      )
      VALUES (
        ${id},
        ${input.spaceId},
        ${input.channelId},
        ${input.sender},
        ${input.senderType},
        ${input.type},
        ${JSON.stringify(input.content)},
        ${timestamp},
        ${isComplete},
        ${input.addressedAgents ?? null},
        ${input.turnId ?? null},
        ${input.metadata ? JSON.stringify(input.metadata) : null},
        ${input.state ?? null}
      )
      RETURNING *
    `;

    return rowToMessage(result[0]);
  }

  async function getMessage(
    spaceId: string,
    messageId: string
  ): Promise<StoredMessage | null> {
    const result = await sql<MessageRow>`
      SELECT * FROM messages
      WHERE space_id = ${spaceId} AND id = ${messageId}
    `;

    if (result.length === 0) return null;
    return rowToMessage(result[0]);
  }

  async function getMessages(
    spaceId: string,
    channelId: string,
    params?: GetMessagesParams
  ): Promise<StoredMessage[]> {
    const limit = params?.limit ?? 50;
    const { since, before, newestFirst, search, sender, includeToolCalls, type, state } = params ?? {};

    // Build search pattern for ILIKE (null if no search)
    const searchPattern = search ? `%${search}%` : null;
    // Ensure sender is null not undefined for postgres.js type safety
    const senderFilter = sender ?? null;
    // Type and state filters (null if not specified)
    const typeFilter = type ?? null;
    const stateFilter = state ?? null;
    // By default, only return conversation messages (user, agent, assistant, system, error)
    // Tool calls, tool results, status updates, idle markers, etc. are filtered out
    // But if type filter is specified, include that type regardless
    const conversationOnly = !includeToolCalls && !typeFilter;

    let result: MessageRow[];

    if (since && before) {
      // Range query between two cursors
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND id > ${since}
          AND id < ${before}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${typeFilter}::text IS NULL OR type = ${typeFilter})
          AND (${stateFilter}::text IS NULL OR state = ${stateFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else if (since) {
      // Forward pagination (newer messages)
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND id > ${since}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${typeFilter}::text IS NULL OR type = ${typeFilter})
          AND (${stateFilter}::text IS NULL OR state = ${stateFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else if (before) {
      // Backward pagination (older messages) - fetch DESC then reverse
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND id < ${before}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${typeFilter}::text IS NULL OR type = ${typeFilter})
          AND (${stateFilter}::text IS NULL OR state = ${stateFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id DESC
        LIMIT ${limit}
      `;
      result = result.reverse(); // Return in chronological order
    } else if (newestFirst) {
      // Initial load - fetch newest, then reverse for chronological order
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${typeFilter}::text IS NULL OR type = ${typeFilter})
          AND (${stateFilter}::text IS NULL OR state = ${stateFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id DESC
        LIMIT ${limit}
      `;
      result = result.reverse(); // Return in chronological order
    } else {
      // Default: oldest first
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE space_id = ${spaceId}
          AND channel_id = ${channelId}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${typeFilter}::text IS NULL OR type = ${typeFilter})
          AND (${stateFilter}::text IS NULL OR state = ${stateFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    }

    return result.map(rowToMessage);
  }

  /**
   * Get messages by channel ID only - more efficient when spaceId isn't available.
   * Uses idx_messages_channel_only index for fast lookups.
   */
  async function getMessagesByChannelId(
    channelId: string,
    params?: GetMessagesParams
  ): Promise<StoredMessage[]> {
    const limit = params?.limit ?? 50;
    const { since, before, newestFirst, search, sender, includeToolCalls } = params ?? {};
    const t0 = performance.now();

    // Build search pattern for ILIKE (null if no search)
    const searchPattern = search ? `%${search}%` : null;
    // Ensure sender is null not undefined for postgres.js type safety
    const senderFilter = sender ?? null;
    // By default, only return conversation messages (user, agent, assistant, system, error)
    // Tool calls, tool results, status updates, idle markers, etc. are filtered out
    const conversationOnly = !includeToolCalls;

    let result: MessageRow[];

    if (since && before) {
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE channel_id = ${channelId}
          AND id > ${since}
          AND id < ${before}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else if (since) {
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE channel_id = ${channelId}
          AND id > ${since}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    } else if (before) {
      // Get newest N messages before the cursor, then reverse for chronological order
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE channel_id = ${channelId}
          AND id < ${before}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id DESC
        LIMIT ${limit}
      `;
      result = result.reverse(); // Return in chronological order
    } else if (newestFirst) {
      // Get newest messages first (for initial sync), then reverse for chronological order
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE channel_id = ${channelId}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id DESC
        LIMIT ${limit}
      `;
      result = result.reverse(); // Return in chronological order
    } else {
      result = await sql<MessageRow>`
        SELECT * FROM messages
        WHERE channel_id = ${channelId}
          AND (${searchPattern}::text IS NULL OR (content::text ILIKE ${searchPattern} OR sender ILIKE ${searchPattern}))
          AND (${senderFilter}::text IS NULL OR sender = ${senderFilter})
          AND (${conversationOnly} = false OR type IN ('user', 'agent', 'assistant', 'system', 'error'))
        ORDER BY id ASC
        LIMIT ${limit}
      `;
    }
    const t1 = performance.now();
    const mapped = result.map(rowToMessage);
    const t2 = performance.now();

    console.log(`[Storage] getMessagesByChannelId: sql=${(t1-t0).toFixed(1)}ms, map=${(t2-t1).toFixed(1)}ms, rows=${result.length}`);

    return mapped;
  }

  async function updateMessage(
    spaceId: string,
    messageId: string,
    update: Partial<StoredMessage>
  ): Promise<void> {
    // Build update object for postgres.js
    const updateObj: Record<string, unknown> = {};

    if (update.content !== undefined) {
      updateObj.content = JSON.stringify(update.content);
    }
    if (update.isComplete !== undefined) {
      updateObj.is_complete = update.isComplete;
    }
    if (update.addressedAgents !== undefined) {
      updateObj.addressed_agents = update.addressedAgents;
    }
    if (update.metadata !== undefined) {
      updateObj.metadata = JSON.stringify(update.metadata);
    }
    if (update.state !== undefined) {
      updateObj.state = update.state;
    }

    if (Object.keys(updateObj).length === 0) return;

    // Build dynamic SET clause for Neon driver
    const [setClauses, values, nextIdx] = buildSetClause(updateObj);
    await sql.query(
      `UPDATE messages SET ${setClauses} WHERE space_id = $${nextIdx} AND id = $${nextIdx + 1}`,
      [...values, spaceId, messageId]
    );
  }

  async function deleteMessage(spaceId: string, messageId: string): Promise<void> {
    await sql`
      DELETE FROM messages
      WHERE space_id = ${spaceId} AND id = ${messageId}
    `;
  }

  // ---------------------------------------------------------------------------
  // Channel Operations (Phase 2)
  // ---------------------------------------------------------------------------

  async function createChannel(input: CreateChannelInput): Promise<StoredChannel> {
    const id = input.id ?? ulid();
    const now = new Date();

    const result = await sql<ChannelRow>`
      INSERT INTO channels (
        id, space_id, name, tagline, mission, archived, created_at, updated_at, last_active_at
      )
      VALUES (
        ${id},
        ${input.spaceId},
        ${input.name},
        ${input.tagline ?? null},
        ${input.mission ?? null},
        false,
        ${now},
        ${now},
        ${now}
      )
      RETURNING *
    `;

    return rowToChannel(result[0]);
  }

  async function getChannel(
    spaceId: string,
    channelId: string
  ): Promise<StoredChannel | null> {
    const result = await sql<ChannelRow>`
      SELECT * FROM channels
      WHERE space_id = ${spaceId} AND id = ${channelId}
    `;

    if (result.length === 0) return null;
    return rowToChannel(result[0]);
  }

  async function getChannelById(channelId: string): Promise<StoredChannel | null> {
    const result = await sql<ChannelRow>`
      SELECT * FROM channels
      WHERE id = ${channelId}
    `;

    if (result.length === 0) return null;
    return rowToChannel(result[0]);
  }

  async function getChannelByName(
    spaceId: string,
    name: string
  ): Promise<StoredChannel | null> {
    const result = await sql<ChannelRow>`
      SELECT * FROM channels
      WHERE space_id = ${spaceId} AND name = ${name}
    `;

    if (result.length === 0) return null;
    return rowToChannel(result[0]);
  }

  async function resolveChannel(
    spaceId: string,
    idOrName: string
  ): Promise<StoredChannel | null> {
    // Single query that matches either ID or name
    // ID match takes priority (checked first via CASE in ORDER BY)
    const result = await sql<ChannelRow>`
      SELECT * FROM channels
      WHERE space_id = ${spaceId}
        AND (id = ${idOrName} OR name = ${idOrName})
      ORDER BY CASE WHEN id = ${idOrName} THEN 0 ELSE 1 END
      LIMIT 1
    `;

    if (result.length === 0) return null;
    return rowToChannel(result[0]);
  }

  async function getChannelWithRoster(
    spaceId: string,
    channelId: string
  ): Promise<{ channel: StoredChannel; roster: RosterEntry[] } | null> {
    // Use a single query with LEFT JOIN to get channel and roster together
    const result = await sql<ChannelRow & {
      roster_id: string | null;
      roster_callsign: string | null;
      roster_agent_type: string | null;
      roster_status: string | null;
      roster_created_at: Date | null;
      roster_callback_url: string | null;
      roster_readmark: string | null;
      roster_tunnel_hash: string | null;
    }>`
      SELECT
        c.id, c.space_id, c.name, c.tagline, c.mission, c.archived, c.created_at, c.updated_at, c.last_active_at,
        r.id as roster_id, r.callsign as roster_callsign, r.agent_type as roster_agent_type,
        r.status as roster_status, r.created_at as roster_created_at,
        r.callback_url as roster_callback_url, r.readmark as roster_readmark,
        r.tunnel_hash as roster_tunnel_hash
      FROM channels c
      LEFT JOIN roster r ON r.channel_id = c.id AND r.status != 'archived'
      WHERE c.space_id = ${spaceId} AND c.id = ${channelId}
      ORDER BY r.created_at ASC
    `;

    if (result.length === 0) return null;

    // First row has the channel data
    const channel = rowToChannel(result[0]);

    // Extract roster entries (filter out null rows from LEFT JOIN)
    const roster: RosterEntry[] = result
      .filter(row => row.roster_id !== null)
      .map(row => ({
        id: row.roster_id!,
        channelId: channelId,
        callsign: row.roster_callsign!,
        agentType: row.roster_agent_type!,
        status: row.roster_status as RosterStatus,
        createdAt: row.roster_created_at!.toISOString(),
        callbackUrl: row.roster_callback_url ?? undefined,
        readmark: row.roster_readmark ?? undefined,
        tunnelHash: row.roster_tunnel_hash ?? undefined,
      }));

    return { channel, roster };
  }

  async function resolveChannelWithRoster(
    spaceId: string,
    idOrName: string
  ): Promise<{ channel: StoredChannel; roster: RosterEntry[] } | null> {
    // Combined resolution + roster fetch in one query
    const result = await sql<ChannelRow & {
      roster_id: string | null;
      roster_callsign: string | null;
      roster_agent_type: string | null;
      roster_status: string | null;
      roster_created_at: Date | null;
      roster_callback_url: string | null;
      roster_readmark: string | null;
      roster_tunnel_hash: string | null;
    }>`
      SELECT
        c.id, c.space_id, c.name, c.tagline, c.mission, c.archived, c.created_at, c.updated_at, c.last_active_at,
        r.id as roster_id, r.callsign as roster_callsign, r.agent_type as roster_agent_type,
        r.status as roster_status, r.created_at as roster_created_at,
        r.callback_url as roster_callback_url, r.readmark as roster_readmark,
        r.tunnel_hash as roster_tunnel_hash
      FROM channels c
      LEFT JOIN roster r ON r.channel_id = c.id AND r.status != 'archived'
      WHERE c.space_id = ${spaceId}
        AND (c.id = ${idOrName} OR c.name = ${idOrName})
      ORDER BY CASE WHEN c.id = ${idOrName} THEN 0 ELSE 1 END, r.created_at ASC
    `;

    if (result.length === 0) return null;

    // First row has the channel data
    const channel = rowToChannel(result[0]);

    // Extract roster entries (filter out null rows from LEFT JOIN)
    const roster: RosterEntry[] = result
      .filter(row => row.roster_id !== null)
      .map(row => ({
        id: row.roster_id!,
        channelId: channel.id,
        callsign: row.roster_callsign!,
        agentType: row.roster_agent_type!,
        status: row.roster_status as RosterStatus,
        createdAt: row.roster_created_at!.toISOString(),
        callbackUrl: row.roster_callback_url ?? undefined,
        readmark: row.roster_readmark ?? undefined,
        tunnelHash: row.roster_tunnel_hash ?? undefined,
      }));

    return { channel, roster };
  }

  async function listChannels(
    spaceId: string,
    params?: ListChannelsParams
  ): Promise<StoredChannel[]> {
    const limit = params?.limit ?? 100;
    const includeArchived = params?.includeArchived ?? false;

    let result: ChannelRow[];

    if (includeArchived) {
      result = await sql<ChannelRow>`
        SELECT * FROM channels
        WHERE space_id = ${spaceId}
        ORDER BY last_active_at DESC
        LIMIT ${limit}
      `;
    } else {
      result = await sql<ChannelRow>`
        SELECT * FROM channels
        WHERE space_id = ${spaceId} AND archived = false
        ORDER BY last_active_at DESC
        LIMIT ${limit}
      `;
    }

    return result.map(rowToChannel);
  }

  async function updateChannel(
    spaceId: string,
    channelId: string,
    update: UpdateChannelInput
  ): Promise<void> {
    const updateObj: Record<string, unknown> = {
      updated_at: new Date(),
    };

    if (update.name !== undefined) {
      updateObj.name = update.name;
    }
    if (update.tagline !== undefined) {
      updateObj.tagline = update.tagline;
    }
    if (update.mission !== undefined) {
      updateObj.mission = update.mission;
    }
    if (update.archived !== undefined) {
      updateObj.archived = update.archived;
    }
    if (update.lastActiveAt !== undefined) {
      updateObj.last_active_at = new Date(update.lastActiveAt);
    }

    // Build dynamic SET clause for Neon driver
    const [setClauses, values, nextIdx] = buildSetClause(updateObj);
    await sql.query(
      `UPDATE channels SET ${setClauses} WHERE space_id = $${nextIdx} AND id = $${nextIdx + 1}`,
      [...values, spaceId, channelId]
    );
  }

  async function archiveChannel(spaceId: string, channelId: string): Promise<void> {
    await sql`
      UPDATE channels
      SET archived = true, updated_at = ${new Date()}
      WHERE space_id = ${spaceId} AND id = ${channelId}
    `;
  }

  // ---------------------------------------------------------------------------
  // Roster Operations (Phase 2)
  // ---------------------------------------------------------------------------

  async function addToRoster(input: AddToRosterInput): Promise<RosterEntry> {
    const id = input.id ?? ulid();
    const now = new Date();
    const status = input.status ?? 'active';
    const runtimeId = input.runtimeId ?? null;
    // Generate tunnel hash: 32 char hex string (16 bytes)
    // Used as subdomain for HTTP tunnel access: {tunnelHash}.containers.domain.com
    const tunnelHash = crypto.randomBytes(16).toString('hex');

    const result = await sql<RosterRow>`
      INSERT INTO roster (
        id, channel_id, callsign, agent_type, status, created_at, tunnel_hash, runtime_id
      )
      VALUES (
        ${id},
        ${input.channelId},
        ${input.callsign},
        ${input.agentType},
        ${status},
        ${now},
        ${tunnelHash},
        ${runtimeId}
      )
      RETURNING *
    `;

    return rowToRosterEntry(result[0]);
  }

  async function getRosterEntry(
    channelId: string,
    entryId: string
  ): Promise<RosterEntry | null> {
    const result = await sql<RosterRow>`
      SELECT * FROM roster
      WHERE channel_id = ${channelId} AND id = ${entryId}
    `;

    if (result.length === 0) return null;
    return rowToRosterEntry(result[0]);
  }

  async function getRosterByCallsign(
    channelId: string,
    callsign: string
  ): Promise<RosterEntry | null> {
    const result = await sql<RosterRow & { runtime_name: string | null; runtime_status: string | null }>`
      SELECT r.*, rt.name as runtime_name, rt.status as runtime_status
      FROM roster r
      LEFT JOIN runtimes rt ON r.runtime_id = rt.id
      WHERE r.channel_id = ${channelId} AND r.callsign = ${callsign}
    `;

    if (result.length === 0) return null;
    return rowToRosterEntry(result[0]);
  }

  async function listRoster(channelId: string): Promise<RosterEntry[]> {
    const result = await sql<RosterRow & { runtime_name: string | null; runtime_status: string | null }>`
      SELECT r.*, rt.name as runtime_name, rt.status as runtime_status
      FROM roster r
      LEFT JOIN runtimes rt ON r.runtime_id = rt.id
      WHERE r.channel_id = ${channelId}
        AND r.status != 'archived'
      ORDER BY r.created_at ASC
    `;

    return result.map(rowToRosterEntry);
  }

  async function listArchivedRoster(channelId: string): Promise<RosterEntry[]> {
    const result = await sql<RosterRow & { runtime_name: string | null; runtime_status: string | null }>`
      SELECT r.*, rt.name as runtime_name, rt.status as runtime_status
      FROM roster r
      LEFT JOIN runtimes rt ON r.runtime_id = rt.id
      WHERE r.channel_id = ${channelId}
        AND r.status = 'archived'
      ORDER BY r.created_at ASC
    `;

    return result.map(rowToRosterEntry);
  }

  async function getAgentsByRuntime(
    runtimeId: string
  ): Promise<Array<RosterEntry & { channelName: string }>> {
    const result = await sql<RosterRow & { channel_name: string }>`
      SELECT r.*, rt.name as runtime_name, rt.status as runtime_status, c.name as channel_name
      FROM roster r
      LEFT JOIN runtimes rt ON r.runtime_id = rt.id
      JOIN channels c ON r.channel_id = c.id
      WHERE r.runtime_id = ${runtimeId}
        AND r.status != 'archived'
      ORDER BY c.name ASC, r.callsign ASC
    `;

    return result.map((row) => ({
      ...rowToRosterEntry(row),
      channelName: row.channel_name,
    }));
  }

  async function updateRosterEntry(
    channelId: string,
    entryId: string,
    update: UpdateRosterInput
  ): Promise<void> {
    // Build update object for postgres.js dynamic columns
    const updateObj: Record<string, unknown> = {};

    if (update.status !== undefined) {
      updateObj.status = update.status;
    }
    if (update.callbackUrl !== undefined) {
      updateObj.callback_url = update.callbackUrl;
    }
    if (update.readmark !== undefined) {
      updateObj.readmark = update.readmark;
    }
    if (update.tunnelHash !== undefined) {
      updateObj.tunnel_hash = update.tunnelHash;
    }
    if (update.lastHeartbeat !== undefined) {
      updateObj.last_heartbeat = new Date(update.lastHeartbeat);
    }
    if (update.routeHints !== undefined) {
      // routeHints can be null (to clear) or an object
      updateObj.route_hints = update.routeHints ? JSON.stringify(update.routeHints) : null;
    }
    if (update.current !== undefined) {
      // Merge current object - use JSONB merge to preserve other keys
      // For now, we replace the entire object. Can add merge logic later if needed.
      updateObj.current = JSON.stringify(update.current);
    }
    if (update.lastMessageRoutedAt !== undefined) {
      updateObj.last_message_routed_at = new Date(update.lastMessageRoutedAt);
    }
    if (update.runtimeId !== undefined) {
      updateObj.runtime_id = update.runtimeId;
    }
    if (update.props !== undefined) {
      updateObj.props = JSON.stringify(update.props);
    }

    if (Object.keys(updateObj).length === 0) return;

    // Build dynamic SET clause for Neon driver
    const [setClauses, values, nextIdx] = buildSetClause(updateObj);
    await sql.query(
      `UPDATE roster SET ${setClauses} WHERE channel_id = $${nextIdx} AND id = $${nextIdx + 1}`,
      [...values, channelId, entryId]
    );
  }

  async function removeFromRoster(channelId: string, entryId: string): Promise<void> {
    await sql`
      DELETE FROM roster
      WHERE channel_id = ${channelId} AND id = ${entryId}
    `;
  }

  // ---------------------------------------------------------------------------
  // User Operations (Spaces & Auth)
  // ---------------------------------------------------------------------------

  function rowToUser(row: UserRow): StoredUser {
    return {
      id: row.id,
      externalId: row.external_id,
      callsign: row.callsign,
      email: row.email ?? undefined,
      avatarUrl: row.avatar_url ?? undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      disclaimerAcceptedVersion: row.disclaimer_accepted_version ?? undefined,
    };
  }

  function rowToSpace(row: SpaceRow): StoredSpace {
    return {
      id: row.id,
      ownerId: row.owner_id,
      name: row.name ?? undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async function createUser(input: CreateUserInput): Promise<StoredUser> {
    const id = input.id ?? ulid();
    const now = new Date();

    const result = await sql<UserRow>`
      INSERT INTO users (
        id, external_id, callsign, email, avatar_url, created_at, updated_at
      )
      VALUES (
        ${id},
        ${input.externalId},
        ${input.callsign},
        ${input.email ?? null},
        ${input.avatarUrl ?? null},
        ${now},
        ${now}
      )
      RETURNING *
    `;

    return rowToUser(result[0]);
  }

  async function getUser(userId: string): Promise<StoredUser | null> {
    const result = await sql<UserRow>`
      SELECT * FROM users WHERE id = ${userId}
    `;

    if (result.length === 0) return null;
    return rowToUser(result[0]);
  }

  async function getUserByExternalId(externalId: string): Promise<StoredUser | null> {
    const result = await sql<UserRow>`
      SELECT * FROM users WHERE external_id = ${externalId}
    `;

    if (result.length === 0) return null;
    return rowToUser(result[0]);
  }

  async function acceptDisclaimer(
    userId: string,
    version: string
  ): Promise<StoredUser | null> {
    const result = await sql<UserRow>`
      UPDATE users
      SET disclaimer_accepted_version = ${version}, updated_at = NOW()
      WHERE id = ${userId}
      RETURNING *
    `;

    if (result.length === 0) return null;
    return rowToUser(result[0]);
  }

  // ---------------------------------------------------------------------------
  // Space Operations (Spaces & Auth)
  // ---------------------------------------------------------------------------

  async function createSpace(input: CreateSpaceInput): Promise<StoredSpace> {
    const id = input.id ?? ulid();
    const now = new Date();

    const result = await sql<SpaceRow>`
      INSERT INTO spaces (
        id, owner_id, name, created_at, updated_at
      )
      VALUES (
        ${id},
        ${input.ownerId},
        ${input.name ?? null},
        ${now},
        ${now}
      )
      RETURNING *
    `;

    return rowToSpace(result[0]);
  }

  async function getSpace(spaceId: string): Promise<StoredSpace | null> {
    const result = await sql<SpaceRow>`
      SELECT * FROM spaces WHERE id = ${spaceId}
    `;

    if (result.length === 0) return null;
    return rowToSpace(result[0]);
  }

  async function getSpacesByOwner(ownerId: string): Promise<StoredSpace[]> {
    const result = await sql<SpaceRow>`
      SELECT * FROM spaces
      WHERE owner_id = ${ownerId}
      ORDER BY created_at DESC
    `;

    return result.map(rowToSpace);
  }

  async function listSpacesWithOwners(): Promise<Array<{ space: StoredSpace; owner: StoredUser }>> {
    const result = await sql<SpaceRow & { user_id: string; user_external_id: string; user_callsign: string; user_email: string | null; user_avatar_url: string | null; user_created_at: Date; user_updated_at: Date }>`
      SELECT
        s.id, s.owner_id, s.name, s.created_at, s.updated_at,
        u.id as user_id, u.external_id as user_external_id, u.callsign as user_callsign,
        u.email as user_email, u.avatar_url as user_avatar_url,
        u.created_at as user_created_at, u.updated_at as user_updated_at
      FROM spaces s
      JOIN users u ON s.owner_id = u.id
      ORDER BY s.created_at DESC
    `;

    return result.map(row => ({
      space: {
        id: row.id,
        ownerId: row.owner_id,
        name: row.name ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      },
      owner: {
        id: row.user_id,
        externalId: row.user_external_id,
        callsign: row.user_callsign,
        email: row.user_email ?? undefined,
        avatarUrl: row.user_avatar_url ?? undefined,
        createdAt: row.user_created_at.toISOString(),
        updatedAt: row.user_updated_at.toISOString(),
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Artifact Operations (Phase A)
  // ---------------------------------------------------------------------------

  /**
   * Compute the ltree path for an artifact based on its parent hierarchy.
   */
  async function computeArtifactPath(
    channelId: string,
    slug: string,
    parentSlug?: string
  ): Promise<string> {
    const segment = slugToPathSegment(slug);
    if (!parentSlug) {
      return segment;
    }

    // Get parent's path
    const parent = await sql<{ path: string }>`
      SELECT path FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${parentSlug}
    `;

    if (parent.length === 0) {
      throw new Error(`Parent artifact not found: ${parentSlug}`);
    }

    return `${parent[0].path}.${segment}`;
  }

  /**
   * Generate a lexicographic order key for sibling ordering.
   * Uses fractional indexing: between "a" and "b", insert "an".
   */
  async function generateOrderKey(
    channelId: string,
    parentSlug?: string
  ): Promise<string> {
    // Get existing siblings' order keys
    let siblings: { order_key: string }[];
    if (parentSlug) {
      siblings = await sql<{ order_key: string }>`
        SELECT order_key FROM artifacts
        WHERE channel_id = ${channelId} AND parent_slug = ${parentSlug}
        ORDER BY order_key DESC
        LIMIT 1
      `;
    } else {
      siblings = await sql<{ order_key: string }>`
        SELECT order_key FROM artifacts
        WHERE channel_id = ${channelId} AND parent_slug IS NULL
        ORDER BY order_key DESC
        LIMIT 1
      `;
    }

    if (siblings.length === 0) {
      return 'a'; // First child
    }

    // Append to last key to come after it
    const lastKey = siblings[0].order_key;
    return lastKey + 'a';
  }

  function rowToArtifact(row: ArtifactRow): StoredArtifact {
    // Convert stored secrets to metadata (strip encrypted values)
    let secretsMetadata: Record<string, SecretMetadata> | undefined;
    if (row.secrets) {
      secretsMetadata = {};
      for (const [key, storedSecret] of Object.entries(row.secrets)) {
        secretsMetadata[key] = {
          setAt: storedSecret.setAt,
          expiresAt: storedSecret.expiresAt,
        };
      }
    }

    const props = parseJsonbField<Record<string, unknown>>(row.props, `artifact props slug=${row.slug}`);

    return {
      id: row.id,
      channelId: row.channel_id,
      slug: row.slug,
      type: row.type as ArtifactType,
      title: row.title ?? undefined,
      tldr: row.tldr ?? undefined,
      content: row.content,
      parentSlug: row.parent_slug ?? undefined,
      path: row.path,
      orderKey: row.order_key,
      status: row.status as ArtifactStatus,
      assignees: row.assignees ?? [],
      labels: row.labels ?? [],
      refs: row.refs ?? [],
      props: props ?? undefined,
      secrets: secretsMetadata,
      contentType: row.content_type ?? undefined,
      fileSize: row.file_size ?? undefined,
      attachedToMessageId: row.attached_to_message_id ?? undefined,
      version: row.version,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      updatedBy: row.updated_by ?? undefined,
      updatedAt: row.updated_at?.toISOString(),
    };
  }

  function rowToArtifactSummary(row: ArtifactRow): ArtifactSummary {
    const props = parseJsonbField<Record<string, unknown>>(row.props, `artifact props slug=${row.slug}`);

    return {
      slug: row.slug,
      type: row.type as ArtifactType,
      title: row.title ?? undefined,
      tldr: row.tldr ?? undefined,
      status: row.status as ArtifactStatus,
      path: row.path,
      orderKey: row.order_key,
      assignees: row.assignees ?? [],
      parentSlug: row.parent_slug ?? undefined,
      channelId: row.channel_id,
      props: props ?? undefined,
    };
  }

  async function createArtifact(
    channelId: string,
    input: CreateArtifactInput
  ): Promise<StoredArtifact> {
    const id = ulid();
    const now = new Date();
    const path = await computeArtifactPath(channelId, input.slug, input.parentSlug);
    const orderKey = await generateOrderKey(channelId, input.parentSlug);
    const refs = extractRefs(input.content);
    const status = input.status ?? getDefaultArtifactStatus(input.type, input.createdBy);

    try {
      const result = await sql<ArtifactRow>`
        INSERT INTO artifacts (
          id, channel_id, slug, type, title, tldr, content, parent_slug, path,
          order_key, status, assignees, labels, refs, props,
          content_type, file_size, attached_to_message_id,
          version, created_by, created_at
        )
        VALUES (
          ${id},
          ${channelId},
          ${input.slug},
          ${input.type},
          ${input.title ?? null},
          ${input.tldr ?? null},
          ${input.content},
          ${input.parentSlug ?? null},
          ${path},
          ${orderKey},
          ${status},
          ${(input.assignees ?? [])},
          ${(input.labels ?? [])},
          ${(refs)},
          ${input.props ? JSON.stringify(input.props) : null},
          ${input.contentType ?? null},
          ${input.fileSize ?? null},
          ${input.attachedToMessageId ?? null},
          1,
          ${input.createdBy},
          ${now}
        )
        RETURNING *
      `;

      return rowToArtifact(result[0]);
    } catch (err: unknown) {
      const message = (err as Error).message ?? '';
      if (message.includes('unique') || message.includes('duplicate')) {
        throw new Error(`Artifact already exists: ${input.slug}`);
      }
      throw err;
    }
  }

  async function getArtifact(
    channelId: string,
    slug: string
  ): Promise<StoredArtifact | null> {
    const result = await sql<ArtifactRow>`
      SELECT * FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    if (result.length === 0) return null;
    return rowToArtifact(result[0]);
  }

  async function updateArtifactWithCAS(
    channelId: string,
    slug: string,
    changes: ArtifactCASChange[],
    updatedBy: string
  ): Promise<ArtifactCASResult> {
    // Get current artifact state
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Normalize values for comparison (treat null and undefined as equivalent)
    const normalize = (val: unknown): unknown =>
      val === undefined || val === null ? null : val;

    // Verify all CAS conditions
    for (const change of changes) {
      const currentValue = normalize(artifact[change.field as keyof StoredArtifact]);
      const expectedValue = normalize(change.oldValue);
      const currentStr = JSON.stringify(currentValue);
      const expectedStr = JSON.stringify(expectedValue);

      if (currentStr !== expectedStr) {
        return {
          success: false,
          conflict: {
            field: change.field,
            expected: change.oldValue,
            actual: artifact[change.field as keyof StoredArtifact],
          },
        };
      }
    }

    // Build update object
    const now = new Date();
    const updateObj: Record<string, unknown> = {
      updated_by: updatedBy,
      updated_at: now,
    };

    for (const change of changes) {
      switch (change.field) {
        case 'title':
          updateObj.title = change.newValue ?? null;
          break;
        case 'tldr':
          updateObj.tldr = change.newValue ?? null;
          break;
        case 'status':
          updateObj.status = change.newValue;
          break;
        case 'parentSlug': {
          const newParentSlug = change.newValue as string | null | undefined;
          updateObj.parent_slug = newParentSlug ?? null;
          // Recompute path when parent changes
          const newPath = await computeArtifactPath(channelId, slug, newParentSlug ?? undefined);
          updateObj.path = newPath;
          break;
        }
        case 'assignees':
          updateObj.assignees = change.newValue ?? [];
          break;
        case 'labels':
          updateObj.labels = change.newValue ?? [];
          break;
        case 'props':
          updateObj.props = change.newValue ?? null;
          break;
        case 'orderKey':
          updateObj.order_key = change.newValue ?? null;
          break;
      }
    }

    // Apply the updates
    const title = 'title' in updateObj ? (updateObj.title as string | null) : (artifact.title ?? null);
    const tldr = 'tldr' in updateObj ? (updateObj.tldr as string | null) : (artifact.tldr ?? null);
    const status = 'status' in updateObj ? (updateObj.status as string) : artifact.status;
    const parentSlug = 'parent_slug' in updateObj ? (updateObj.parent_slug as string | null) : (artifact.parentSlug ?? null);
    const path = 'path' in updateObj ? (updateObj.path as string) : artifact.path;
    const assignees = 'assignees' in updateObj ? (updateObj.assignees as string[]) : artifact.assignees;
    const labels = 'labels' in updateObj ? (updateObj.labels as string[]) : artifact.labels;
    const propsValue = 'props' in updateObj ? (updateObj.props as Record<string, unknown> | null) : (artifact.props ?? null);
    const orderKey = 'order_key' in updateObj ? (updateObj.order_key as string | null) : (artifact.orderKey ?? null);

    // Increment version
    await sql`
      UPDATE artifacts
      SET
        title = ${title},
        tldr = ${tldr},
        status = ${status},
        parent_slug = ${parentSlug},
        path = ${path},
        assignees = ${(assignees)},
        labels = ${(labels)},
        props = ${propsValue ? JSON.stringify(propsValue) : null},
        order_key = ${orderKey},
        version = version + 1,
        updated_by = ${updatedBy},
        updated_at = ${now}
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    const updated = await getArtifact(channelId, slug);
    return { success: true, artifact: updated! };
  }

  async function editArtifact(
    channelId: string,
    slug: string,
    edit: ArtifactEditInput
  ): Promise<StoredArtifact> {
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Check that oldString matches exactly once
    const matches = artifact.content.split(edit.oldString).length - 1;
    if (matches === 0) {
      throw new Error(`String not found in artifact content`);
    }
    if (matches > 1) {
      throw new Error(`String matches ${matches} times, must be unique`);
    }

    // Perform the replacement
    const newContent = artifact.content.replace(edit.oldString, edit.newString);
    const newRefs = extractRefs(newContent);
    const now = new Date();

    await sql`
      UPDATE artifacts
      SET
        content = ${newContent},
        refs = ${(newRefs)},
        version = version + 1,
        updated_by = ${edit.updatedBy},
        updated_at = ${now}
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    const updated = await getArtifact(channelId, slug);
    return updated!;
  }

  async function setArtifactAttachment(
    channelId: string,
    slug: string,
    messageId: string,
    updatedBy: string
  ): Promise<void> {
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date();

    await sql`
      UPDATE artifacts
      SET
        attached_to_message_id = ${messageId},
        version = version + 1,
        updated_by = ${updatedBy},
        updated_at = ${now}
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;
  }

  async function archiveArtifact(
    channelId: string,
    slug: string,
    updatedBy: string
  ): Promise<StoredArtifact> {
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date();

    await sql`
      UPDATE artifacts
      SET
        status = 'archived',
        version = version + 1,
        updated_by = ${updatedBy},
        updated_at = ${now}
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    const updated = await getArtifact(channelId, slug);
    return updated!;
  }

  async function archiveArtifactRecursive(
    channelId: string,
    slug: string,
    updatedBy: string
  ): Promise<RecursiveArchiveResult> {
    // First, get the artifact to find its path
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date();

    // Find all artifacts that are descendants (path starts with this artifact's path)
    // Using ltree path for efficient hierarchical query
    // Also include the artifact itself
    const toArchive = await sql<{ slug: string; status: string }>`
      SELECT slug, status
      FROM artifacts
      WHERE channel_id = ${channelId}
        AND status != 'archived'
        AND (slug = ${slug} OR path <@ ${artifact.path}::ltree)
      ORDER BY path
    `;

    if (toArchive.length === 0) {
      return { archived: [], count: 0 };
    }

    // Store previous statuses for undo
    const archivedItems: ArchivedItem[] = toArchive.map(row => ({
      slug: row.slug,
      previousStatus: row.status as ArtifactStatus,
    }));

    // Archive all in one UPDATE using the same path query
    await sql`
      UPDATE artifacts
      SET
        status = 'archived',
        version = version + 1,
        updated_by = ${updatedBy},
        updated_at = ${now}
      WHERE channel_id = ${channelId}
        AND status != 'archived'
        AND (slug = ${slug} OR path <@ ${artifact.path}::ltree)
    `;

    return {
      archived: archivedItems,
      count: archivedItems.length,
    };
  }

  async function deleteAllArtifactsInChannel(channelId: string): Promise<number> {
    // First delete all artifact versions (references artifacts by channel_id + slug)
    await sql`
      DELETE FROM artifact_versions
      WHERE channel_id = ${channelId}
    `;

    // Then delete all artifacts in the channel
    const result = await sql<MessageRow>`
      DELETE FROM artifacts
      WHERE channel_id = ${channelId}
      RETURNING id
    `;

    return result.length;
  }

  async function listArtifacts(
    channelId: string,
    params?: ListArtifactsParams
  ): Promise<ArtifactSummary[]> {
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    // Build dynamic query based on filters
    // Note: Using raw SQL building here since postgres.js doesn't easily support
    // complex conditional WHERE clauses
    // Filter out message attachments (artifacts with attachedToMessageId set)
    const conditions: string[] = ['channel_id = $1', 'attached_to_message_id IS NULL'];
    const values: unknown[] = [channelId];
    let paramIndex = 2;

    if (params?.type) {
      conditions.push(`type = $${paramIndex++}`);
      values.push(params.type);
    }

    if (params?.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(params.status);
    } else {
      conditions.push(`status != 'archived'`);
    }

    if (params?.assignee) {
      conditions.push(`$${paramIndex++} = ANY(assignees)`);
      values.push(params.assignee);
    }

    if (params?.parentSlug === 'root') {
      conditions.push(`parent_slug IS NULL`);
    } else if (params?.parentSlug) {
      conditions.push(`parent_slug = $${paramIndex++}`);
      values.push(params.parentSlug);
    }

    if (params?.search) {
      // FTS search using tsvector
      conditions.push(`search_vector @@ plainto_tsquery('english', $${paramIndex++})`);
      values.push(params.search);
    }

    if (params?.regex) {
      conditions.push(`(slug ~* $${paramIndex} OR title ~* $${paramIndex} OR tldr ~* $${paramIndex} OR content ~* $${paramIndex++})`);
      values.push(params.regex);
    }

    values.push(limit, offset);

    const query = `
      SELECT slug, type, title, tldr, status, path, order_key, assignees, parent_slug, channel_id, props
      FROM artifacts
      WHERE ${conditions.join(' AND ')}
      ORDER BY path ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `;

    const result = await sql.query<ArtifactRow>(query, values);
    return result.map(rowToArtifactSummary);
  }

  async function listPublishedKnowledgeBases(
    spaceId: string
  ): Promise<Array<{ name: string; title?: string; tldr?: string }>> {
    // Single JOIN query - no N+1 channel loop
    // Support both 'active' (new) and 'published' (legacy) statuses
    const result = await sql<{ name: string; title: string | null; tldr: string | null }>`
      SELECT c.name, a.title, a.tldr
      FROM artifacts a
      JOIN channels c ON a.channel_id = c.id
      WHERE c.space_id = ${spaceId}
        AND a.type = 'knowledgebase'
        AND a.slug = 'knowledgebase'
        AND a.status IN ('active', 'published')
        AND c.archived = false
      ORDER BY c.name ASC
    `;

    return result.map((row) => ({
      name: row.name,
      title: row.title ?? undefined,
      tldr: row.tldr ?? undefined,
    }));
  }

  async function globArtifacts(
    channelId: string,
    pattern: string
  ): Promise<ArtifactTreeNode[]> {
    // Convert glob pattern to ltree query
    let ltreeQuery: string;
    let isRootOnly = false;

    if (pattern === '/**') {
      // All artifacts
      ltreeQuery = '*';
    } else if (pattern === '/*') {
      // Root level only
      isRootOnly = true;
      ltreeQuery = '*';
    } else if (pattern.endsWith('/**')) {
      // Subtree under a path
      const base = pattern.slice(1, -3); // Remove leading / and trailing /**
      const ltreePath = base.split('/').map(slugToPathSegment).join('.');
      ltreeQuery = `${ltreePath}.*`;
    } else {
      // Specific pattern
      const cleanPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern;
      ltreeQuery = cleanPattern.split('/').map(s => s.replace(/\*/g, '%')).join('.');
    }

    let result: (ArtifactRow & { parent_slug: string | null })[];

    if (isRootOnly) {
      result = await sql<ArtifactRow & { parent_slug: string | null }>`
        SELECT slug, path, type, title, status, assignees, parent_slug, order_key
        FROM artifacts
        WHERE channel_id = ${channelId}
          AND parent_slug IS NULL
          AND status != 'archived'
          AND attached_to_message_id IS NULL
        ORDER BY order_key ASC
      `;
    } else if (ltreeQuery === '*') {
      result = await sql<ArtifactRow & { parent_slug: string | null }>`
        SELECT slug, path, type, title, status, assignees, parent_slug, order_key
        FROM artifacts
        WHERE channel_id = ${channelId}
          AND status != 'archived'
          AND attached_to_message_id IS NULL
        ORDER BY path ASC, order_key ASC
      `;
    } else {
      result = await sql<ArtifactRow & { parent_slug: string | null }>`
        SELECT slug, path, type, title, status, assignees, parent_slug, order_key
        FROM artifacts
        WHERE channel_id = ${channelId}
          AND path ~ ${ltreeQuery}::lquery
          AND status != 'archived'
          AND attached_to_message_id IS NULL
        ORDER BY path ASC, order_key ASC
      `;
    }

    // Build tree structure
    const nodeMap = new Map<string, ArtifactTreeNode>();
    const rootNodes: ArtifactTreeNode[] = [];

    for (const row of result) {
      const node: ArtifactTreeNode = {
        slug: row.slug,
        type: row.type as ArtifactType,
        title: row.title ?? undefined,
        status: row.status as ArtifactStatus,
        path: row.path,
        orderKey: row.order_key,
        assignees: row.assignees ?? [],
        children: [],
      };
      nodeMap.set(row.slug, node);
    }

    for (const row of result) {
      const node = nodeMap.get(row.slug)!;
      if (row.parent_slug && nodeMap.has(row.parent_slug)) {
        nodeMap.get(row.parent_slug)!.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    // Sort all children arrays by orderKey
    // Use simple string comparison (not localeCompare) because fractional-indexing
    // generates keys designed for ASCII/Unicode code point ordering
    const sortByOrderKey = (nodes: ArtifactTreeNode[]) => {
      nodes.sort((a, b) => {
        const aKey = a.orderKey || '';
        const bKey = b.orderKey || '';
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      });
      for (const node of nodes) {
        if (node.children.length > 0) {
          sortByOrderKey(node.children);
        }
      }
    };

    sortByOrderKey(rootNodes);

    return rootNodes;
  }

  async function checkpointArtifact(
    channelId: string,
    slug: string,
    input: CreateArtifactVersionInput
  ): Promise<ArtifactVersion> {
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date();

    await sql`
      INSERT INTO artifact_versions (
        channel_id, slug, version_name, version_message,
        version_created_at, version_created_by, tldr, content
      )
      VALUES (
        ${channelId},
        ${slug},
        ${input.versionName},
        ${input.versionMessage ?? null},
        ${now},
        ${input.createdBy},
        ${artifact.tldr ?? ''},
        ${artifact.content}
      )
    `;

    return {
      slug,
      channelId,
      versionName: input.versionName,
      versionMessage: input.versionMessage,
      tldr: artifact.tldr ?? '',
      content: artifact.content,
      versionCreatedBy: input.createdBy,
      versionCreatedAt: now.toISOString(),
    };
  }

  async function getArtifactVersion(
    channelId: string,
    slug: string,
    versionName: string
  ): Promise<ArtifactVersion | null> {
    const result = await sql<ArtifactVersionRow>`
      SELECT slug, channel_id, version_name, version_message,
             version_created_at, version_created_by, tldr, content
      FROM artifact_versions
      WHERE channel_id = ${channelId}
        AND slug = ${slug}
        AND version_name = ${versionName}
    `;

    if (result.length === 0) return null;

    const row = result[0];
    return {
      slug: row.slug,
      channelId: row.channel_id,
      versionName: row.version_name,
      versionMessage: row.version_message ?? undefined,
      tldr: row.tldr,
      content: row.content,
      versionCreatedBy: row.version_created_by,
      versionCreatedAt: row.version_created_at.toISOString(),
    };
  }

  async function listArtifactVersions(
    channelId: string,
    slug: string
  ): Promise<ArtifactVersion[]> {
    const result = await sql<ArtifactVersionRow>`
      SELECT slug, channel_id, version_name, version_message,
             version_created_at, version_created_by, tldr, content
      FROM artifact_versions
      WHERE channel_id = ${channelId} AND slug = ${slug}
      ORDER BY version_created_at DESC
    `;

    return result.map(row => ({
      slug: row.slug,
      channelId: row.channel_id,
      versionName: row.version_name,
      versionMessage: row.version_message ?? undefined,
      tldr: row.tldr,
      content: row.content,
      versionCreatedBy: row.version_created_by,
      versionCreatedAt: row.version_created_at.toISOString(),
    }));
  }

  /**
   * Generate a unified diff between two strings.
   * Simple line-by-line implementation without external dependencies.
   */
  function generateUnifiedDiff(
    oldContent: string,
    newContent: string,
    oldLabel: string,
    newLabel: string
  ): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Simple LCS-based diff algorithm
    const lcs = computeLCS(oldLines, newLines);

    const diff: string[] = [];
    diff.push(`--- ${oldLabel}`);
    diff.push(`+++ ${newLabel}`);

    let oldIdx = 0;
    let newIdx = 0;
    let hunkOldStart = 0;
    let hunkNewStart = 0;
    let hunkLines: string[] = [];

    function flushHunk() {
      if (hunkLines.length > 0) {
        const hunkOldCount = hunkLines.filter(l => l.startsWith('-') || l.startsWith(' ')).length;
        const hunkNewCount = hunkLines.filter(l => l.startsWith('+') || l.startsWith(' ')).length;
        diff.push(`@@ -${hunkOldStart + 1},${hunkOldCount} +${hunkNewStart + 1},${hunkNewCount} @@`);
        diff.push(...hunkLines);
        hunkLines = [];
      }
    }

    for (const match of lcs) {
      // Output removed lines
      while (oldIdx < match.oldIdx) {
        if (hunkLines.length === 0) {
          hunkOldStart = oldIdx;
          hunkNewStart = newIdx;
        }
        hunkLines.push(`-${oldLines[oldIdx]}`);
        oldIdx++;
      }
      // Output added lines
      while (newIdx < match.newIdx) {
        if (hunkLines.length === 0) {
          hunkOldStart = oldIdx;
          hunkNewStart = newIdx;
        }
        hunkLines.push(`+${newLines[newIdx]}`);
        newIdx++;
      }
      // Output context (matching line)
      if (hunkLines.length > 0) {
        hunkLines.push(` ${oldLines[oldIdx]}`);
      }
      oldIdx++;
      newIdx++;

      // Flush hunk if we have enough trailing context
      const lastFewAreContext = hunkLines.slice(-3).every(l => l.startsWith(' '));
      if (lastFewAreContext && hunkLines.length > 6) {
        // Remove trailing context, flush, reset
        const trailing = hunkLines.splice(-3);
        flushHunk();
        hunkOldStart = oldIdx - 3;
        hunkNewStart = newIdx - 3;
        hunkLines = trailing;
      }
    }

    // Handle remaining lines after last match
    while (oldIdx < oldLines.length) {
      if (hunkLines.length === 0) {
        hunkOldStart = oldIdx;
        hunkNewStart = newIdx;
      }
      hunkLines.push(`-${oldLines[oldIdx]}`);
      oldIdx++;
    }
    while (newIdx < newLines.length) {
      if (hunkLines.length === 0) {
        hunkOldStart = oldIdx;
        hunkNewStart = newIdx;
      }
      hunkLines.push(`+${newLines[newIdx]}`);
      newIdx++;
    }

    flushHunk();

    return diff.join('\n');
  }

  /**
   * Compute Longest Common Subsequence for diff algorithm.
   * Returns array of matching indices.
   */
  function computeLCS(
    oldLines: string[],
    newLines: string[]
  ): Array<{ oldIdx: number; newIdx: number }> {
    const m = oldLines.length;
    const n = newLines.length;

    // Build LCS table
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to find matches
    const matches: Array<{ oldIdx: number; newIdx: number }> = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        matches.unshift({ oldIdx: i - 1, newIdx: j - 1 });
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return matches;
  }

  async function diffArtifactVersions(
    channelId: string,
    slug: string,
    fromVersion: string,
    toVersion?: string
  ): Promise<string> {
    // Get the "from" version
    const fromVer = await getArtifactVersion(channelId, slug, fromVersion);
    if (!fromVer) {
      throw new Error(`Version '${fromVersion}' not found for artifact '${slug}'`);
    }

    let toContent: string;
    let toLabel: string;

    if (toVersion) {
      // Get the "to" version
      const toVer = await getArtifactVersion(channelId, slug, toVersion);
      if (!toVer) {
        throw new Error(`Version '${toVersion}' not found for artifact '${slug}'`);
      }
      toContent = toVer.content;
      toLabel = `${slug}@${toVersion}`;
    } else {
      // Compare against current content
      const artifact = await getArtifact(channelId, slug);
      if (!artifact) {
        throw new Error(`Artifact not found: ${slug}`);
      }
      toContent = artifact.content;
      toLabel = `${slug} (current)`;
    }

    const fromLabel = `${slug}@${fromVersion}`;

    return generateUnifiedDiff(fromVer.content, toContent, fromLabel, toLabel);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async function initialize(): Promise<void> {
    // Create messages table if not exists
    await sql`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(26) PRIMARY KEY,
        space_id VARCHAR(26) NOT NULL,
        channel_id VARCHAR(26) NOT NULL,
        sender VARCHAR(255) NOT NULL,
        sender_type VARCHAR(50) NOT NULL,
        type VARCHAR(50) NOT NULL,
        content JSONB NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_complete BOOLEAN NOT NULL DEFAULT true,
        addressed_agents TEXT[],
        turn_id VARCHAR(26),
        metadata JSONB
      )
    `;

    // Create messages indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_channel
      ON messages(space_id, channel_id, id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_turn
      ON messages(space_id, channel_id, turn_id)
    `;

    // Index for channel-only queries (sync operations don't need spaceId)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_channel_only
      ON messages(channel_id, id)
    `;

    // ---------------------------------------------------------------------------
    // Users Table (Spaces & Auth)
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(26) PRIMARY KEY,
        external_id VARCHAR(255) NOT NULL,
        callsign VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        avatar_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_id
      ON users(external_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_users_callsign
      ON users(callsign)
    `;

    // ---------------------------------------------------------------------------
    // Spaces Table (Spaces & Auth)
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS spaces (
        id VARCHAR(26) PRIMARY KEY,
        owner_id VARCHAR(26) NOT NULL REFERENCES users(id),
        name VARCHAR(255),
        secrets JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Add secrets column if it doesn't exist (migration for existing DBs)
    await sql`
      ALTER TABLE spaces ADD COLUMN IF NOT EXISTS secrets JSONB
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_spaces_owner
      ON spaces(owner_id)
    `;

    // Composite index for getSpacesByOwner ORDER BY created_at
    await sql`
      CREATE INDEX IF NOT EXISTS idx_spaces_owner_created
      ON spaces(owner_id, created_at DESC)
    `;

    // Create channels table (Phase 2)
    await sql`
      CREATE TABLE IF NOT EXISTS channels (
        id VARCHAR(26) PRIMARY KEY,
        space_id VARCHAR(26) NOT NULL,
        name VARCHAR(255) NOT NULL,
        tagline TEXT,
        mission TEXT,
        archived BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Add last_active_at column if it doesn't exist (migration for existing DBs)
    await sql`
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW()
    `;

    // Backfill any NULL last_active_at values with created_at
    await sql`
      UPDATE channels SET last_active_at = created_at WHERE last_active_at IS NULL
    `;

    // Create channels indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_channels_space
      ON channels(space_id)
    `;

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_space_name
      ON channels(space_id, name)
    `;

    // Composite index for listChannels ORDER BY created_at
    await sql`
      CREATE INDEX IF NOT EXISTS idx_channels_space_created
      ON channels(space_id, archived, created_at DESC)
    `;

    // Composite index for listChannels ORDER BY last_active_at
    await sql`
      CREATE INDEX IF NOT EXISTS idx_channels_space_active
      ON channels(space_id, archived, last_active_at DESC)
    `;

    // Create roster table (Phase 2)
    await sql`
      CREATE TABLE IF NOT EXISTS roster (
        id VARCHAR(26) PRIMARY KEY,
        channel_id VARCHAR(26) NOT NULL,
        callsign VARCHAR(255) NOT NULL,
        agent_type VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Create roster indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_roster_channel
      ON roster(channel_id)
    `;

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_channel_callsign
      ON roster(channel_id, callsign)
    `;

    // Composite index for listRoster ORDER BY created_at
    await sql`
      CREATE INDEX IF NOT EXISTS idx_roster_channel_created
      ON roster(channel_id, created_at ASC)
    `;

    // Add callback_url, readmark, tunnel_hash, last_heartbeat, current, last_message_routed_at, route_hints, and runtime_id columns to roster if they don't exist
    // (These may be added in migrations for existing databases)
    await sql`
      DO $$ BEGIN
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS callback_url TEXT;
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS readmark VARCHAR(26);
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS tunnel_hash VARCHAR(64);
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ;
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS current JSONB;
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS last_message_routed_at TIMESTAMPTZ;
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS route_hints JSONB;
        ALTER TABLE roster ADD COLUMN IF NOT EXISTS runtime_id VARCHAR(26);
      EXCEPTION
        WHEN duplicate_column THEN NULL;
      END $$;
    `;

    // ---------------------------------------------------------------------------
    // Artifacts Tables (Phase A)
    // ---------------------------------------------------------------------------

    // Enable ltree extension for hierarchical paths
    await sql`CREATE EXTENSION IF NOT EXISTS ltree`;

    // Create artifacts table
    await sql`
      CREATE TABLE IF NOT EXISTS artifacts (
        id VARCHAR(26) PRIMARY KEY,
        channel_id VARCHAR(26) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        title TEXT,
        tldr TEXT,
        content TEXT NOT NULL,
        parent_slug VARCHAR(255),
        path LTREE NOT NULL,
        order_key VARCHAR(255) NOT NULL DEFAULT 'a',
        status VARCHAR(50) NOT NULL DEFAULT 'draft',
        assignees TEXT[] NOT NULL DEFAULT '{}',
        labels TEXT[] NOT NULL DEFAULT '{}',
        refs TEXT[] NOT NULL DEFAULT '{}',
        props JSONB,
        secrets JSONB,
        version INTEGER NOT NULL DEFAULT 1,
        created_by VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by VARCHAR(255),
        updated_at TIMESTAMPTZ,
        -- Generated tsvector column for FTS
        search_vector TSVECTOR GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(slug, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(tldr, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(content, '')), 'C')
        ) STORED,
        CONSTRAINT artifacts_channel_slug_unique UNIQUE(channel_id, slug)
      )
    `;

    // Create artifacts indexes
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_channel
      ON artifacts(channel_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_type
      ON artifacts(channel_id, type)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_status
      ON artifacts(channel_id, status)
    `;

    // GiST index for ltree path queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_path
      ON artifacts USING GIST(path)
    `;

    // GIN index for array membership queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_assignees
      ON artifacts USING GIN(assignees)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_labels
      ON artifacts USING GIN(labels)
    `;

    // GIN index for full-text search
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_search
      ON artifacts USING GIN(search_vector)
    `;

    // Partial index for non-archived artifacts (most common query pattern)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_active
      ON artifacts(channel_id, path) WHERE status != 'archived'
    `;

    // Index for parent_slug lookups (used in generateOrderKey and tree queries)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifacts_parent
      ON artifacts(channel_id, parent_slug, order_key)
    `;

    // Create artifact_versions table for checkpoints
    await sql`
      CREATE TABLE IF NOT EXISTS artifact_versions (
        id SERIAL PRIMARY KEY,
        channel_id VARCHAR(26) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        version_name VARCHAR(255) NOT NULL,
        version_message TEXT,
        version_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        version_created_by VARCHAR(255) NOT NULL,
        tldr TEXT NOT NULL,
        content TEXT NOT NULL,
        CONSTRAINT artifact_versions_unique UNIQUE(channel_id, slug, version_name)
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact
      ON artifact_versions(channel_id, slug)
    `;

    // Add content_type, file_size columns if they don't exist (migration for existing databases)
    await sql`
      DO $$ BEGIN
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_type VARCHAR(255);
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS file_size BIGINT;
      EXCEPTION
        WHEN duplicate_column THEN NULL;
      END $$;
    `;

    // Add secrets column if it doesn't exist (migration for App Integrations)
    await sql`
      DO $$ BEGIN
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS secrets JSONB;
      EXCEPTION
        WHEN duplicate_column THEN NULL;
      END $$;
    `;

    // Add attached_to_message_id column if it doesn't exist (migration for message attachments)
    await sql`
      DO $$ BEGIN
        ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS attached_to_message_id VARCHAR(26);
      EXCEPTION
        WHEN duplicate_column THEN NULL;
      END $$;
    `;

    // ---------------------------------------------------------------------------
    // Local Agent Servers Table (Stage 3)
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS local_agent_servers (
        server_id VARCHAR(255) PRIMARY KEY,
        space_id VARCHAR(26) NOT NULL,
        user_id VARCHAR(26) NOT NULL,
        secret VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      )
    `;

    // Index for looking up servers by secret (auth flow)
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_agent_servers_secret
      ON local_agent_servers(secret) WHERE revoked_at IS NULL
    `;

    // Index for looking up servers by user (UI listing)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_local_agent_servers_user
      ON local_agent_servers(user_id) WHERE revoked_at IS NULL
    `;

    // Index for space-scoped queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_local_agent_servers_space
      ON local_agent_servers(space_id)
    `;

    // ---------------------------------------------------------------------------
    // Bootstrap Tokens Table (Stage 3)
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS bootstrap_tokens (
        token VARCHAR(255) PRIMARY KEY,
        space_id VARCHAR(26) NOT NULL,
        user_id VARCHAR(26) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Index for cleanup of expired tokens
    await sql`
      CREATE INDEX IF NOT EXISTS idx_bootstrap_tokens_expires
      ON bootstrap_tokens(expires_at) WHERE consumed = FALSE
    `;

    // ---------------------------------------------------------------------------
    // Runtimes Table (LocalRuntime support)
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS runtimes (
        id VARCHAR(26) PRIMARY KEY,
        space_id VARCHAR(26) NOT NULL,
        server_id VARCHAR(255) REFERENCES local_agent_servers(server_id),
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'offline',
        config JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ,
        CONSTRAINT runtimes_space_name_unique UNIQUE(space_id, name)
      )
    `;

    // Index for space-scoped queries
    await sql`
      CREATE INDEX IF NOT EXISTS idx_runtimes_space
      ON runtimes(space_id)
    `;

    // Index for server credential lookup (revocation cascade)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_runtimes_server
      ON runtimes(server_id) WHERE server_id IS NOT NULL
    `;

    // Add FK constraint to roster.runtime_id (after runtimes table exists)
    // Note: We can't add FK in the DO block above because runtimes table may not exist yet
    // This is safe to run multiple times - PostgreSQL will ignore if constraint exists
    await sql`
      DO $$ BEGIN
        ALTER TABLE roster
        ADD CONSTRAINT fk_roster_runtime
        FOREIGN KEY (runtime_id) REFERENCES runtimes(id);
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `;

    // ---------------------------------------------------------------------------
    // Cost Records Table (Cost Tracking)
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS cost_records (
        id VARCHAR(26) PRIMARY KEY,
        space_id VARCHAR(26) NOT NULL,
        channel_id VARCHAR(26) NOT NULL,
        callsign VARCHAR(100) NOT NULL,
        cost_usd DOUBLE PRECISION NOT NULL,
        duration_ms INTEGER NOT NULL,
        num_turns INTEGER NOT NULL,
        usage JSONB NOT NULL,
        model_usage JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Index for channel cost tally aggregation
    await sql`
      CREATE INDEX IF NOT EXISTS idx_cost_records_channel
      ON cost_records(channel_id, callsign)
    `;

    // Index for space-level reporting
    await sql`
      CREATE INDEX IF NOT EXISTS idx_cost_records_space
      ON cost_records(space_id, created_at DESC)
    `;

    // ---------------------------------------------------------------------------
    // WebSocket Connections Table
    // ---------------------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS ws_connections (
        connection_id VARCHAR(255) PRIMARY KEY,
        channel_id VARCHAR(255) NOT NULL DEFAULT '__pending__',
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        agent_callsign VARCHAR(255),
        container_id VARCHAR(255),
        protocol VARCHAR(20) NOT NULL DEFAULT 'browser',
        runtime_id VARCHAR(255)
      )
    `;

    // Migration: Add protocol and runtime_id columns for existing tables
    await sql`
      DO $$ BEGIN
        ALTER TABLE ws_connections ADD COLUMN IF NOT EXISTS protocol VARCHAR(20) NOT NULL DEFAULT 'browser';
        ALTER TABLE ws_connections ADD COLUMN IF NOT EXISTS runtime_id VARCHAR(255);
      EXCEPTION
        WHEN duplicate_column THEN NULL;
      END $$
    `;

    // Index on channel_id for efficient broadcasts
    await sql`
      CREATE INDEX IF NOT EXISTS idx_ws_connections_channel_id
      ON ws_connections(channel_id)
    `;

    // Index on protocol for filtering runtime vs browser connections
    await sql`
      CREATE INDEX IF NOT EXISTS idx_ws_connections_protocol
      ON ws_connections(protocol)
    `;
  }

  async function close(): Promise<void> {
    // HTTP mode - no persistent connection to close
  }

  // ---------------------------------------------------------------------------
  // Secrets Operations (App Integrations)
  // ---------------------------------------------------------------------------

  /**
   * Get the SECRET_KEY from environment.
   * Required for encryption/decryption operations.
   * In production, SECRET_KEY must be explicitly set.
   * In development, falls back to a default (DO NOT use in production).
   */
  function getSecretKey(): string {
    const key = process.env.SECRET_KEY;
    if (!key) {
      // Fail hard in production — no fallback allowed
      if (process.env.NODE_ENV === 'production') {
        throw new Error('SECRET_KEY environment variable is required in production');
      }
      // Dev fallback — never use in production
      console.warn('[Storage] WARNING: Using default SECRET_KEY — DO NOT use in production');
      return 'cast-dev-secret-key-min-32-characters!!';
    }
    if (key.length < 32) {
      throw new Error('SECRET_KEY must be at least 32 characters');
    }
    return key;
  }

  /**
   * Derive an encryption key from spaceId and server secret.
   * Each space has a unique derived key for isolation.
   */
  function deriveKey(spaceId: string): Buffer {
    const serverKey = getSecretKey();
    return crypto.createHash('sha256')
      .update(`${spaceId}:${serverKey}`)
      .digest();
  }

  /**
   * Encrypt a plaintext value using AES-256-GCM.
   */
  function encrypt(plaintext: string, spaceId: string): { encrypted: string; iv: string; tag: string } {
    const key = deriveKey(spaceId);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  /**
   * Decrypt an encrypted value using AES-256-GCM.
   */
  function decrypt(encryptedData: { encrypted: string; iv: string; tag: string }, spaceId: string): string {
    const key = deriveKey(spaceId);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(encryptedData.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(encryptedData.tag, 'base64'));
    return decipher.update(Buffer.from(encryptedData.encrypted, 'base64')) + decipher.final('utf8');
  }

  async function setSecret(
    spaceId: string,
    channelId: string,
    slug: string,
    key: string,
    input: SetSecretInput
  ): Promise<void> {
    // Get current artifact to merge secrets
    const artifact = await getArtifact(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Encrypt the value
    const encrypted = encrypt(input.value, spaceId);
    const now = new Date().toISOString();

    // Build the stored secret
    const storedSecret: StoredSecret = {
      setAt: now,
      expiresAt: input.expiresAt,
      encrypted: encrypted.encrypted,
      iv: encrypted.iv,
      tag: encrypted.tag,
    };

    // Get current secrets (need to fetch raw from DB to preserve encrypted values)
    const currentSecrets = await sql<{ secrets: Record<string, StoredSecret> | null }>`
      SELECT secrets FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    const secrets = currentSecrets[0]?.secrets ?? {};
    secrets[key] = storedSecret;

    // Update the artifact with new secrets
    await sql`
      UPDATE artifacts
      SET secrets = ${JSON.stringify(secrets)},
          version = version + 1,
          updated_at = NOW()
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;
  }

  async function deleteSecret(
    channelId: string,
    slug: string,
    key: string
  ): Promise<void> {
    // Get current secrets
    const currentSecrets = await sql<{ secrets: Record<string, StoredSecret> | null }>`
      SELECT secrets FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    if (currentSecrets.length === 0) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const secrets = currentSecrets[0]?.secrets ?? {};
    if (!(key in secrets)) {
      return; // Secret doesn't exist, nothing to delete
    }

    delete secrets[key];

    // Update with null if no secrets remain, otherwise update with remaining secrets
    const secretsValue = Object.keys(secrets).length > 0 ? secrets : null;

    await sql`
      UPDATE artifacts
      SET secrets = ${secretsValue ? JSON.stringify(secretsValue) : null},
          version = version + 1,
          updated_at = NOW()
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;
  }

  async function getSecretValue(
    spaceId: string,
    channelId: string,
    slug: string,
    key: string
  ): Promise<string | null> {
    // Get the raw secrets from DB
    const result = await sql<{ secrets: Record<string, StoredSecret> | null }>`
      SELECT secrets FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    if (result.length === 0) {
      return null;
    }

    const secrets = result[0]?.secrets;
    if (!secrets || !(key in secrets)) {
      return null;
    }

    const storedSecret = secrets[key];

    // Decrypt and return
    return decrypt(
      {
        encrypted: storedSecret.encrypted,
        iv: storedSecret.iv,
        tag: storedSecret.tag,
      },
      spaceId
    );
  }

  async function getSecretMetadata(
    channelId: string,
    slug: string,
    key: string
  ): Promise<SecretMetadata | null> {
    const result = await sql<{ secrets: Record<string, StoredSecret> | null }>`
      SELECT secrets FROM artifacts
      WHERE channel_id = ${channelId} AND slug = ${slug}
    `;

    if (result.length === 0) {
      return null;
    }

    const secrets = result[0]?.secrets;
    if (!secrets || !(key in secrets)) {
      return null;
    }

    const storedSecret = secrets[key];
    return {
      setAt: storedSecret.setAt,
      expiresAt: storedSecret.expiresAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Space Secrets
  // ---------------------------------------------------------------------------

  async function setSpaceSecret(
    spaceId: string,
    key: string,
    input: SetSecretInput
  ): Promise<void> {
    // Encrypt the value
    const encrypted = encrypt(input.value, spaceId);
    const now = new Date().toISOString();

    // Build the stored secret
    const storedSecret: StoredSecret = {
      setAt: now,
      expiresAt: input.expiresAt,
      encrypted: encrypted.encrypted,
      iv: encrypted.iv,
      tag: encrypted.tag,
    };

    // Get current secrets
    const currentSecrets = await sql<{ secrets: Record<string, StoredSecret> | null }>`
      SELECT secrets FROM spaces WHERE id = ${spaceId}
    `;

    if (currentSecrets.length === 0) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    const secrets = currentSecrets[0]?.secrets ?? {};
    secrets[key] = storedSecret;

    // Update the space with new secrets
    await sql`
      UPDATE spaces
      SET secrets = ${JSON.stringify(secrets)},
          updated_at = NOW()
      WHERE id = ${spaceId}
    `;
  }

  async function deleteSpaceSecret(
    spaceId: string,
    key: string
  ): Promise<void> {
    // Get current secrets
    const currentSecrets = await sql<{ secrets: Record<string, StoredSecret> | null }>`
      SELECT secrets FROM spaces WHERE id = ${spaceId}
    `;

    if (currentSecrets.length === 0) {
      throw new Error(`Space not found: ${spaceId}`);
    }

    const secrets = currentSecrets[0]?.secrets ?? {};
    if (!(key in secrets)) {
      return; // Secret doesn't exist, nothing to delete
    }

    delete secrets[key];

    // Update with null if no secrets remain, otherwise update with remaining secrets
    const secretsValue = Object.keys(secrets).length > 0 ? secrets : null;

    await sql`
      UPDATE spaces
      SET secrets = ${secretsValue ? JSON.stringify(secretsValue) : null},
          updated_at = NOW()
      WHERE id = ${spaceId}
    `;
  }

  async function getSpaceSecretValue(
    spaceId: string,
    key: string
  ): Promise<string | null> {
    const result = await sql<{ secrets: Record<string, StoredSecret> | null }>`
      SELECT secrets FROM spaces WHERE id = ${spaceId}
    `;

    if (result.length === 0) {
      return null;
    }

    const secrets = result[0]?.secrets;
    if (!secrets || !(key in secrets)) {
      return null;
    }

    const storedSecret = secrets[key];

    // Decrypt and return
    return decrypt(
      {
        encrypted: storedSecret.encrypted,
        iv: storedSecret.iv,
        tag: storedSecret.tag,
      },
      spaceId
    );
  }

  async function getSpaceSecretMetadata(
    spaceId: string,
    key: string
  ): Promise<SecretMetadata | null> {
    const result = await sql<{ secrets: Record<string, StoredSecret> | null }>`
      SELECT secrets FROM spaces WHERE id = ${spaceId}
    `;

    if (result.length === 0) {
      return null;
    }

    const secrets = result[0]?.secrets;
    if (!secrets || !(key in secrets)) {
      return null;
    }

    const storedSecret = secrets[key];
    return {
      setAt: storedSecret.setAt,
      expiresAt: storedSecret.expiresAt,
    };
  }

  async function listSpaceSecrets(
    spaceId: string
  ): Promise<Record<string, SecretMetadata>> {
    const result = await sql<{ secrets: Record<string, StoredSecret> | null }>`
      SELECT secrets FROM spaces WHERE id = ${spaceId}
    `;

    if (result.length === 0 || !result[0]?.secrets) {
      return {};
    }

    const secrets = result[0].secrets;
    const metadata: Record<string, SecretMetadata> = {};

    for (const [key, storedSecret] of Object.entries(secrets)) {
      metadata[key] = {
        setAt: storedSecret.setAt,
        expiresAt: storedSecret.expiresAt,
      };
    }

    return metadata;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function rowToMessage(row: MessageRow): StoredMessage {
    const content = parseJsonbField<unknown>(row.content, `message content id=${row.id}`) ?? row.content;
    const metadata = parseJsonbField<Record<string, unknown>>(row.metadata, `message metadata id=${row.id}`);

    return {
      id: row.id,
      spaceId: row.space_id,
      channelId: row.channel_id,
      sender: row.sender,
      senderType: row.sender_type as StoredMessage['senderType'],
      type: row.type as StoredMessage['type'],
      content,
      timestamp: row.timestamp.toISOString(),
      isComplete: row.is_complete,
      addressedAgents: row.addressed_agents ?? undefined,
      turnId: row.turn_id ?? undefined,
      metadata: metadata ?? undefined,
      state: row.state ?? undefined,
    };
  }

  function rowToChannel(row: ChannelRow): StoredChannel {
    return {
      id: row.id,
      spaceId: row.space_id,
      name: row.name,
      tagline: row.tagline ?? undefined,
      mission: row.mission ?? undefined,
      archived: row.archived,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      lastActiveAt: row.last_active_at.toISOString(),
    };
  }

  function rowToRosterEntry(row: RosterRow): RosterEntry {
    return {
      id: row.id,
      channelId: row.channel_id,
      callsign: row.callsign,
      agentType: row.agent_type,
      status: row.status as RosterStatus,
      createdAt: row.created_at.toISOString(),
      callbackUrl: row.callback_url ?? undefined,
      readmark: row.readmark ?? undefined,
      tunnelHash: row.tunnel_hash ?? undefined,
      lastHeartbeat: row.last_heartbeat?.toISOString() ?? undefined,
      routeHints: row.route_hints ?? undefined,
      current: (row.current as RosterCurrent) ?? undefined,
      lastMessageRoutedAt: row.last_message_routed_at?.toISOString() ?? undefined,
      runtimeId: row.runtime_id ?? undefined,
      runtimeName: row.runtime_name ?? undefined,
      runtimeStatus: (row.runtime_status as RuntimeStatus) ?? undefined,
      props: (row.props as Record<string, unknown>) ?? undefined,
    };
  }

  function rowToLocalAgentServer(row: LocalAgentServerRow): StoredLocalAgentServer {
    return {
      serverId: row.server_id,
      spaceId: row.space_id,
      userId: row.user_id,
      secret: row.secret,
      createdAt: row.created_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Local Agent Server Operations (Stage 3)
  // ---------------------------------------------------------------------------

  async function saveLocalAgentServer(
    input: CreateLocalAgentServerInput
  ): Promise<StoredLocalAgentServer> {
    const now = new Date();

    const result = await sql<LocalAgentServerRow>`
      INSERT INTO local_agent_servers (
        server_id, space_id, user_id, secret, created_at
      )
      VALUES (
        ${input.serverId},
        ${input.spaceId},
        ${input.userId},
        ${input.secret},
        ${now}
      )
      RETURNING *
    `;

    return rowToLocalAgentServer(result[0]);
  }

  async function getLocalAgentServer(
    serverId: string
  ): Promise<StoredLocalAgentServer | null> {
    const result = await sql<LocalAgentServerRow>`
      SELECT * FROM local_agent_servers
      WHERE server_id = ${serverId}
    `;

    if (result.length === 0) return null;
    return rowToLocalAgentServer(result[0]);
  }

  async function getLocalAgentServerBySecret(
    secret: string
  ): Promise<StoredLocalAgentServer | null> {
    const result = await sql<LocalAgentServerRow>`
      SELECT * FROM local_agent_servers
      WHERE secret = ${secret} AND revoked_at IS NULL
    `;

    if (result.length === 0) return null;
    return rowToLocalAgentServer(result[0]);
  }

  async function getLocalAgentServersByUser(
    userId: string
  ): Promise<StoredLocalAgentServer[]> {
    const result = await sql<LocalAgentServerRow>`
      SELECT * FROM local_agent_servers
      WHERE user_id = ${userId} AND revoked_at IS NULL
      ORDER BY created_at DESC
    `;

    return result.map(rowToLocalAgentServer);
  }

  async function revokeLocalAgentServer(serverId: string): Promise<boolean> {
    const now = new Date();

    const result = await sql<MessageRow>`
      UPDATE local_agent_servers
      SET revoked_at = ${now}
      WHERE server_id = ${serverId} AND revoked_at IS NULL
      RETURNING server_id
    `;

    return result.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap Token Operations (Stage 3)
  // ---------------------------------------------------------------------------

  function rowToBootstrapToken(row: BootstrapTokenRow): StoredBootstrapToken {
    return {
      token: row.token,
      spaceId: row.space_id,
      userId: row.user_id,
      expiresAt: row.expires_at.toISOString(),
      consumed: row.consumed,
      createdAt: row.created_at.toISOString(),
    };
  }

  async function saveBootstrapToken(
    input: CreateBootstrapTokenInput
  ): Promise<StoredBootstrapToken> {
    const now = new Date();

    const result = await sql<BootstrapTokenRow>`
      INSERT INTO bootstrap_tokens (
        token, space_id, user_id, expires_at, consumed, created_at
      )
      VALUES (
        ${input.token},
        ${input.spaceId},
        ${input.userId},
        ${input.expiresAt},
        FALSE,
        ${now}
      )
      RETURNING *
    `;

    return rowToBootstrapToken(result[0]);
  }

  async function getBootstrapToken(
    token: string
  ): Promise<StoredBootstrapToken | null> {
    const now = new Date();

    // Only return if not consumed and not expired
    const result = await sql<BootstrapTokenRow>`
      SELECT * FROM bootstrap_tokens
      WHERE token = ${token}
        AND consumed = FALSE
        AND expires_at > ${now}
    `;

    if (result.length === 0) return null;
    return rowToBootstrapToken(result[0]);
  }

  async function consumeBootstrapToken(token: string): Promise<boolean> {
    const now = new Date();

    // Only consume if not already consumed and not expired
    const result = await sql<MessageRow>`
      UPDATE bootstrap_tokens
      SET consumed = TRUE
      WHERE token = ${token}
        AND consumed = FALSE
        AND expires_at > ${now}
      RETURNING token
    `;

    return result.length > 0;
  }

  async function cleanupExpiredBootstrapTokens(): Promise<number> {
    const now = new Date();

    const result = await sql<MessageRow>`
      DELETE FROM bootstrap_tokens
      WHERE expires_at < ${now} OR consumed = TRUE
      RETURNING token
    `;

    return result.length;
  }

  // ---------------------------------------------------------------------------
  // Cost Tracking Operations
  // ---------------------------------------------------------------------------

  interface CostRecordRow {
    id: string;
    space_id: string;
    channel_id: string;
    callsign: string;
    cost_usd: number;
    duration_ms: number;
    num_turns: number;
    usage: TokenUsage;
    model_usage: Record<string, ModelUsage> | null;
    created_at: Date;
  }

  function rowToCostRecord(row: CostRecordRow): StoredCostRecord {
    return {
      id: row.id,
      spaceId: row.space_id,
      channelId: row.channel_id,
      callsign: row.callsign,
      costUsd: row.cost_usd,
      durationMs: row.duration_ms,
      numTurns: row.num_turns,
      usage: row.usage,
      modelUsage: row.model_usage ?? undefined,
      createdAt: row.created_at.toISOString(),
    };
  }

  async function saveCostRecord(
    input: CreateCostRecordInput
  ): Promise<StoredCostRecord> {
    const id = ulid();
    const now = new Date();

    // Upsert: the SDK reports cumulative totals, so we update to the absolute values
    // rather than accumulating. Uses (channel_id, callsign) as the unique key.
    const result = await sql<CostRecordRow>`
      INSERT INTO cost_records (
        id, space_id, channel_id, callsign, cost_usd, duration_ms, num_turns, usage, model_usage, created_at
      )
      VALUES (
        ${id},
        ${input.spaceId},
        ${input.channelId},
        ${input.callsign},
        ${input.costUsd},
        ${input.durationMs},
        ${input.numTurns},
        ${JSON.stringify(input.usage)},
        ${input.modelUsage ? JSON.stringify(input.modelUsage) : null},
        ${now}
      )
      ON CONFLICT (channel_id, callsign) DO UPDATE SET
        cost_usd = EXCLUDED.cost_usd,
        duration_ms = EXCLUDED.duration_ms,
        num_turns = EXCLUDED.num_turns,
        usage = EXCLUDED.usage,
        model_usage = EXCLUDED.model_usage,
        created_at = EXCLUDED.created_at
      RETURNING *
    `;

    return rowToCostRecord(result[0]);
  }

  interface CostTallyRow {
    callsign: string;
    total_cost_usd: number;
    total_turns: number;
    total_duration_ms: number;
  }

  async function getChannelCostTally(channelId: string): Promise<CostTally[]> {
    // Each row is now the cumulative total per agent (upserted), so no SUM needed
    const result = await sql<CostTallyRow>`
      SELECT
        callsign,
        cost_usd as total_cost_usd,
        num_turns as total_turns,
        duration_ms as total_duration_ms
      FROM cost_records
      WHERE channel_id = ${channelId}
      ORDER BY cost_usd DESC
    `;

    return result.map((row) => ({
      callsign: row.callsign,
      totalCostUsd: row.total_cost_usd,
      totalTurns: row.total_turns,
      totalDurationMs: row.total_duration_ms,
    }));
  }

  // ---------------------------------------------------------------------------
  // WebSocket Connection Operations
  // ---------------------------------------------------------------------------

  interface ConnectionRow {
    connection_id: string;
    channel_id: string;
    connected_at: Date;
    agent_callsign: string | null;
    container_id: string | null;
    protocol: string;
    runtime_id: string | null;
  }

  function rowToConnection(row: ConnectionRow): StoredConnection {
    return {
      connectionId: row.connection_id,
      channelId: row.channel_id,
      connectedAt: row.connected_at.toISOString(),
      agentCallsign: row.agent_callsign ?? undefined,
      containerId: row.container_id ?? undefined,
      protocol: row.protocol as ConnectionProtocol,
      runtimeId: row.runtime_id ?? undefined,
    };
  }

  async function saveConnection(
    connectionId: string,
    channelId: string,
    options?: {
      agentCallsign?: string;
      containerId?: string;
      protocol?: ConnectionProtocol;
      runtimeId?: string;
    }
  ): Promise<void> {
    const now = new Date();
    const protocol = options?.protocol ?? 'browser';

    await sql`
      INSERT INTO ws_connections (
        connection_id,
        channel_id,
        connected_at,
        agent_callsign,
        container_id,
        protocol,
        runtime_id
      ) VALUES (
        ${connectionId},
        ${channelId},
        ${now},
        ${options?.agentCallsign ?? null},
        ${options?.containerId ?? null},
        ${protocol},
        ${options?.runtimeId ?? null}
      )
      ON CONFLICT (connection_id) DO UPDATE SET
        channel_id = EXCLUDED.channel_id,
        connected_at = EXCLUDED.connected_at,
        agent_callsign = EXCLUDED.agent_callsign,
        container_id = EXCLUDED.container_id,
        protocol = EXCLUDED.protocol,
        runtime_id = EXCLUDED.runtime_id
    `;
  }

  async function getConnection(connectionId: string): Promise<StoredConnection | null> {
    const result = await sql<ConnectionRow>`
      SELECT * FROM ws_connections
      WHERE connection_id = ${connectionId}
    `;

    if (result.length === 0) return null;
    return rowToConnection(result[0]);
  }

  async function updateConnectionChannel(
    connectionId: string,
    channelId: string
  ): Promise<void> {
    await sql`
      UPDATE ws_connections
      SET channel_id = ${channelId}
      WHERE connection_id = ${connectionId}
    `;
  }

  async function updateConnectionRuntime(
    connectionId: string,
    runtimeId: string
  ): Promise<void> {
    await sql`
      UPDATE ws_connections
      SET runtime_id = ${runtimeId}
      WHERE connection_id = ${connectionId}
    `;
  }

  async function deleteConnection(connectionId: string): Promise<void> {
    await sql`
      DELETE FROM ws_connections
      WHERE connection_id = ${connectionId}
    `;
  }

  async function getConnectionsByChannel(channelId: string): Promise<StoredConnection[]> {
    const result = await sql<ConnectionRow>`
      SELECT * FROM ws_connections
      WHERE channel_id = ${channelId}
    `;

    return result.map(rowToConnection);
  }

  // ---------------------------------------------------------------------------
  // Runtime Operations
  // ---------------------------------------------------------------------------

  function rowToRuntime(row: RuntimeRow): StoredRuntime {
    return {
      id: row.id,
      spaceId: row.space_id,
      serverId: row.server_id,
      name: row.name,
      type: row.type as RuntimeType,
      status: row.status as RuntimeStatus,
      config: row.config as LocalRuntimeConfig | null,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    };
  }

  async function createRuntime(input: CreateRuntimeInput): Promise<StoredRuntime> {
    const id = input.id ?? ulid();
    const status = input.status ?? 'offline';
    const config = input.config ?? null;
    const serverId = input.serverId ?? null;

    const [row] = await sql<RuntimeRow>`
      INSERT INTO runtimes (id, space_id, server_id, name, type, status, config)
      VALUES (${id}, ${input.spaceId}, ${serverId}, ${input.name}, ${input.type}, ${status}, ${config ? JSON.stringify(config) : null})
      RETURNING *
    `;

    return rowToRuntime(row);
  }

  async function getRuntime(runtimeId: string): Promise<StoredRuntime | null> {
    const [row] = await sql<RuntimeRow>`
      SELECT * FROM runtimes WHERE id = ${runtimeId}
    `;
    return row ? rowToRuntime(row) : null;
  }

  async function getRuntimeByName(spaceId: string, name: string): Promise<StoredRuntime | null> {
    const [row] = await sql<RuntimeRow>`
      SELECT * FROM runtimes WHERE space_id = ${spaceId} AND name = ${name}
    `;
    return row ? rowToRuntime(row) : null;
  }

  async function getRuntimesBySpace(spaceId: string): Promise<StoredRuntime[]> {
    const rows = await sql<RuntimeRow>`
      SELECT * FROM runtimes
      WHERE space_id = ${spaceId}
      ORDER BY
        CASE WHEN status = 'online' THEN 0 ELSE 1 END,
        name ASC
    `;
    return rows.map(rowToRuntime);
  }

  async function updateRuntime(runtimeId: string, update: UpdateRuntimeInput): Promise<void> {
    // Build update object for postgres.js dynamic columns (same pattern as updateChannel, updateRosterEntry)
    const updateObj: Record<string, unknown> = {};

    if (update.name !== undefined) {
      updateObj.name = update.name;
    }
    if (update.status !== undefined) {
      updateObj.status = update.status;
    }
    if (update.config !== undefined) {
      updateObj.config = update.config ? JSON.stringify(update.config) : null;
    }
    if (update.lastSeenAt !== undefined) {
      updateObj.last_seen_at = update.lastSeenAt ? new Date(update.lastSeenAt) : null;
    }

    if (Object.keys(updateObj).length === 0) return;

    // Build dynamic SET clause for Neon driver
    const [setClauses, values, nextIdx] = buildSetClause(updateObj);
    await sql.query(
      `UPDATE runtimes SET ${setClauses} WHERE id = $${nextIdx}`,
      [...values, runtimeId]
    );
  }

  async function deleteRuntime(runtimeId: string): Promise<void> {
    // Clear runtime_id from any roster entries first
    await sql`
      UPDATE roster SET runtime_id = NULL WHERE runtime_id = ${runtimeId}
    `;

    await sql`
      DELETE FROM runtimes WHERE id = ${runtimeId}
    `;
  }

  return {
    // Message operations
    saveMessage,
    getMessage,
    getMessages,
    getMessagesByChannelId,
    updateMessage,
    deleteMessage,
    // User operations (Spaces & Auth)
    createUser,
    getUser,
    getUserByExternalId,
    acceptDisclaimer,
    // Space operations (Spaces & Auth)
    createSpace,
    getSpace,
    getSpacesByOwner,
    listSpacesWithOwners,
    // Channel operations
    createChannel,
    getChannel,
    getChannelById,
    getChannelByName,
    resolveChannel,
    getChannelWithRoster,
    resolveChannelWithRoster,
    listChannels,
    updateChannel,
    archiveChannel,
    // Roster operations
    addToRoster,
    getRosterEntry,
    getRosterByCallsign,
    listRoster,
    listArchivedRoster,
    getAgentsByRuntime,
    updateRosterEntry,
    removeFromRoster,
    // Artifact operations (Phase A)
    createArtifact,
    getArtifact,
    updateArtifactWithCAS,
    editArtifact,
    setArtifactAttachment,
    archiveArtifact,
    archiveArtifactRecursive,
    deleteAllArtifactsInChannel,
    listArtifacts,
    listPublishedKnowledgeBases,
    globArtifacts,
    checkpointArtifact,
    getArtifactVersion,
    listArtifactVersions,
    diffArtifactVersions,
    // Secrets operations (App Integrations)
    setSecret,
    deleteSecret,
    getSecretValue,
    getSecretMetadata,
    // Space Secrets operations
    setSpaceSecret,
    deleteSpaceSecret,
    getSpaceSecretValue,
    getSpaceSecretMetadata,
    listSpaceSecrets,
    // Local Agent Server operations (Stage 3)
    saveLocalAgentServer,
    getLocalAgentServer,
    getLocalAgentServerBySecret,
    getLocalAgentServersByUser,
    revokeLocalAgentServer,
    // Bootstrap Token operations (Stage 3)
    saveBootstrapToken,
    getBootstrapToken,
    consumeBootstrapToken,
    cleanupExpiredBootstrapTokens,
    // Cost tracking operations
    saveCostRecord,
    getChannelCostTally,
    // WebSocket connection operations
    saveConnection,
    getConnection,
    updateConnectionChannel,
    updateConnectionRuntime,
    deleteConnection,
    getConnectionsByChannel,
    // Runtime operations
    createRuntime,
    getRuntime,
    getRuntimeByName,
    getRuntimesBySpace,
    updateRuntime,
    deleteRuntime,
    // Lifecycle
    initialize,
    close,
  };
}

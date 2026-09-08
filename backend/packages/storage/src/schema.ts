import type { TypedSql } from './postgres.js';

export async function migrateSchema(sql: TypedSql): Promise<void> {
  // ---------------------------------------------------------------------------
  // Messages Table
  // ---------------------------------------------------------------------------
  console.log('Creating messages table...');
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

  await sql`
    CREATE INDEX IF NOT EXISTS idx_messages_channel
    ON messages(space_id, channel_id, id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_messages_turn
    ON messages(space_id, channel_id, turn_id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_only
    ON messages(channel_id, id)
  `;

  // Add state column for structured asks (pending, completed, dismissed)
  await sql`
    DO $$ BEGIN
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS state VARCHAR(50);
    EXCEPTION
      WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Index for efficiently querying pending asks by channel
  await sql`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_type_state
    ON messages(channel_id, type, state)
    WHERE state IS NOT NULL
  `;

  // ---------------------------------------------------------------------------
  // Users Table
  // ---------------------------------------------------------------------------
  console.log('Creating users table...');
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

  await sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disclaimer_accepted_version VARCHAR(50)
  `;

  // ---------------------------------------------------------------------------
  // Spaces Table
  // ---------------------------------------------------------------------------
  console.log('Creating spaces table...');
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

  await sql`
    ALTER TABLE spaces ADD COLUMN IF NOT EXISTS secrets JSONB
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_spaces_owner
    ON spaces(owner_id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_spaces_owner_created
    ON spaces(owner_id, created_at DESC)
  `;

  // ---------------------------------------------------------------------------
  // Channels Table
  // ---------------------------------------------------------------------------
  console.log('Creating channels table...');
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

  await sql`
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ DEFAULT NOW()
  `;

  await sql`
    UPDATE channels SET last_active_at = created_at WHERE last_active_at IS NULL
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_channels_space
    ON channels(space_id)
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_space_name
    ON channels(space_id, name)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_channels_space_created
    ON channels(space_id, archived, created_at DESC)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_channels_space_active
    ON channels(space_id, archived, last_active_at DESC)
  `;

  // ---------------------------------------------------------------------------
  // Roster Table
  // ---------------------------------------------------------------------------
  console.log('Creating roster table...');
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

  await sql`
    CREATE INDEX IF NOT EXISTS idx_roster_channel
    ON roster(channel_id)
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_channel_callsign
    ON roster(channel_id, callsign)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_roster_channel_created
    ON roster(channel_id, created_at ASC)
  `;

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
      ALTER TABLE roster ADD COLUMN IF NOT EXISTS props JSONB;
    EXCEPTION
      WHEN duplicate_column THEN NULL;
    END $$;
  `;

  // ---------------------------------------------------------------------------
  // Artifacts Tables
  // ---------------------------------------------------------------------------
  console.log('Creating artifacts tables...');

  await sql`CREATE EXTENSION IF NOT EXISTS ltree`;

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
      search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(slug, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(tldr, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(content, '')), 'C')
      ) STORED,
      CONSTRAINT artifacts_channel_slug_unique UNIQUE(channel_id, slug)
    )
  `;

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

  await sql`
    CREATE INDEX IF NOT EXISTS idx_artifacts_path
    ON artifacts USING GIST(path)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_artifacts_assignees
    ON artifacts USING GIN(assignees)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_artifacts_labels
    ON artifacts USING GIN(labels)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_artifacts_search
    ON artifacts USING GIN(search_vector)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_artifacts_active
    ON artifacts(channel_id, path) WHERE status != 'archived'
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_artifacts_parent
    ON artifacts(channel_id, parent_slug, order_key)
  `;

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

  await sql`
    DO $$ BEGIN
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS content_type VARCHAR(255);
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS file_size BIGINT;
    EXCEPTION
      WHEN duplicate_column THEN NULL;
    END $$;
  `;

  await sql`
    DO $$ BEGIN
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS secrets JSONB;
    EXCEPTION
      WHEN duplicate_column THEN NULL;
    END $$;
  `;

  await sql`
    DO $$ BEGIN
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS attached_to_message_id VARCHAR(26);
    EXCEPTION
      WHEN duplicate_column THEN NULL;
    END $$;
  `;

  // ---------------------------------------------------------------------------
  // Local Agent Servers Table
  // ---------------------------------------------------------------------------
  console.log('Creating local_agent_servers table...');
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

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_local_agent_servers_secret
    ON local_agent_servers(secret) WHERE revoked_at IS NULL
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_local_agent_servers_user
    ON local_agent_servers(user_id) WHERE revoked_at IS NULL
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_local_agent_servers_space
    ON local_agent_servers(space_id)
  `;

  // ---------------------------------------------------------------------------
  // Bootstrap Tokens Table
  // ---------------------------------------------------------------------------
  console.log('Creating bootstrap_tokens table...');
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

  await sql`
    CREATE INDEX IF NOT EXISTS idx_bootstrap_tokens_expires
    ON bootstrap_tokens(expires_at) WHERE consumed = FALSE
  `;

  // ---------------------------------------------------------------------------
  // Runtimes Table
  // ---------------------------------------------------------------------------
  console.log('Creating runtimes table...');
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

  await sql`
    CREATE INDEX IF NOT EXISTS idx_runtimes_space
    ON runtimes(space_id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_runtimes_server
    ON runtimes(server_id) WHERE server_id IS NOT NULL
  `;

  // Add FK constraint to roster.runtime_id
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
  // Cost Records Table
  // ---------------------------------------------------------------------------
  console.log('Creating cost_records table...');
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

  // Existing duplicates must be reconciled explicitly; never delete business data here.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_records_channel_callsign
    ON cost_records(channel_id, callsign)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_cost_records_space
    ON cost_records(space_id, created_at DESC)
  `;

  // ---------------------------------------------------------------------------
  // WebSocket Connections Table
  // ---------------------------------------------------------------------------
  console.log('Creating ws_connections table...');
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

  await sql`
    DO $$ BEGIN
      ALTER TABLE ws_connections ADD COLUMN IF NOT EXISTS protocol VARCHAR(20) NOT NULL DEFAULT 'browser';
      ALTER TABLE ws_connections ADD COLUMN IF NOT EXISTS runtime_id VARCHAR(255);
    EXCEPTION
      WHEN duplicate_column THEN NULL;
    END $$
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ws_connections_channel_id
    ON ws_connections(channel_id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ws_connections_protocol
    ON ws_connections(protocol)
  `;
}

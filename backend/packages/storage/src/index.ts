/**
 * @cast/storage - Storage interface and implementations
 *
 * PostgreSQL storage using @neondatabase/serverless for PlanetScale.
 */

// Interface
export type { Storage, SetSecretInput } from './interface.js';

// Re-export types from @cast/core used by storage consumers
export type { StoredConnection } from '@cast/core';

// Implementations
export { createPostgresStorage } from './postgres.js';
export type { PostgresStorageOptions, TypedSql } from './postgres.js';

export { migrateSchema } from './schema.js';

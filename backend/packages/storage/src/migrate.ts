#!/usr/bin/env node
/**
 * Database Migration Script
 *
 * Runs schema migrations for PlanetScale Postgres.
 * All operations are idempotent (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS).
 *
 * Usage:
 *   pnpm migrate              (from backend/, loads .env automatically)
 *   PLANETSCALE_URL=... pnpm migrate  (explicit connection string)
 *
 * In CI/CD:
 *   pnpm --filter @cast/storage migrate
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from backend root (two levels up from packages/storage/src)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../../.env');
config({ path: envPath });

import { migrateSchema } from './schema.js';
import { createPostgresClient } from './postgres.js';

const connectionString = process.env.PLANETSCALE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Error: PLANETSCALE_URL or DATABASE_URL environment variable is required');
  process.exit(1);
}

console.log('Starting database migration...');

const sql = createPostgresClient(connectionString);

// Run migration with retry
async function runWithRetry(maxRetries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await migrateSchema(sql);
      console.log('Migration completed successfully!');
      process.exit(0);
    } catch (error) {
      console.error(`Migration attempt ${attempt}/${maxRetries} failed:`, error);
      if (attempt < maxRetries) {
        console.log(`Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 2; // Exponential backoff
      } else {
        console.error('All migration attempts failed');
        process.exit(1);
      }
    }
  }
}

runWithRetry();

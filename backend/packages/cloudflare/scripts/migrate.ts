import { migrateSchema } from '@cast/storage';
import { openStorage } from '../src/postgres.js';
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL must point to the isolated staging database');
const db = openStorage(process.env.DATABASE_URL);
try {
  await migrateSchema(db.sql);
  await db.sql`CREATE TABLE IF NOT EXISTS runtime_frame_receipts (
    space_id text NOT NULL, operation_id text NOT NULL, committed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (space_id, operation_id)
  )`;
  console.log('Schema and runtime receipt migration complete');
} finally {
  await db.close();
}

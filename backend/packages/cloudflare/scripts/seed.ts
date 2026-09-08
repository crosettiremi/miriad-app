import { seedSpaceFromSanity } from '@cast/server/onboarding/seed';
import { openStorage } from '../src/postgres.js';
const spaceId = process.argv[2];
if (!process.env.DATABASE_URL || !spaceId)
  throw new Error(
    'Usage: DATABASE_URL=... pnpm seed:cloudflare <existing-space-id>',
  );
process.env.CONTENT_SOURCE = 'bundled';
const db = openStorage(process.env.DATABASE_URL);
try {
  if (!(await db.storage.getSpace(spaceId)))
    throw new Error('Space does not exist');
  await seedSpaceFromSanity(db.storage, spaceId);
  console.log('Bundled seed complete');
} finally {
  await db.close();
}

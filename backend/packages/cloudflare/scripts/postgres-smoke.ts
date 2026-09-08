import assert from 'node:assert/strict';
import { migrateSchema } from '@cast/storage';
import { seedSpaceFromSanity } from '@cast/server/onboarding/seed';
import { openStorage } from '../src/postgres.js';
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL must target an isolated test database');
const db = openStorage(process.env.DATABASE_URL);
process.env.CONTENT_SOURCE = 'bundled';
try {
  await migrateSchema(db.sql);
  await migrateSchema(db.sql); // Repeated expansion must preserve records.
  const user = await db.storage.createUser({
    externalId: `test-${crypto.randomUUID()}`,
    callsign: 'cloudflare-test',
  });
  const space = await db.storage.createSpace({
    name: 'Cloudflare integration',
    ownerId: user.id,
  });
  await seedSpaceFromSanity(db.storage, space.id);
  await seedSpaceFromSanity(db.storage, space.id);
  const channels = await db.storage.listChannels(space.id);
  assert.equal(channels.length, 2);
  const root = await db.storage.getChannelByName(space.id, 'root');
  assert.ok(root);
  const builder = await db.storage.getArtifact(root.id, 'builder');
  assert.equal(builder?.props?.engine, 'claude-sdk');
  const channel = channels.find((c) => c.name === 'first-channel')!;
  const message = await db.storage.saveMessage({
    spaceId: space.id,
    channelId: channel.id,
    sender: 'human',
    senderType: 'user',
    type: 'user',
    content: 'hello',
    isComplete: true,
  });
  assert.equal(
    (await db.storage.getMessage(space.id, message.id))?.content,
    'hello',
  );
  assert.equal(await db.storage.getMessage('another-space', message.id), null);
  await db.storage.updateMessage(space.id, message.id, {
    content: { text: 'structured' },
    addressedAgents: ['builder'],
  });
  assert.deepEqual(
    (await db.storage.getMessage(space.id, message.id))?.content,
    { text: 'structured' },
  );
  process.env.SECRET_KEY =
    'isolated-test-encryption-key-at-least-32-characters';
  await db.storage.setSpaceSecret(space.id, 'test_key', {
    value: 'secret-value',
  });
  assert.equal(
    await db.storage.getSpaceSecretValue(space.id, 'test_key'),
    'secret-value',
  );
  const artifact = await db.storage.createArtifact(channel.id, {
    channelId: channel.id,
    slug: 'smoke',
    type: 'doc',
    tldr: 'smoke',
    content: 'body',
    createdBy: 'test',
  });
  assert.equal(
    (await db.storage.getArtifact(channel.id, 'smoke'))?.id,
    artifact.id,
  );
  await db.sql`CREATE TABLE IF NOT EXISTS runtime_frame_receipts(space_id text, operation_id text, PRIMARY KEY(space_id,operation_id))`;
  await assert.rejects(
    db.transaction(async (storage, sql) => {
      await sql`INSERT INTO runtime_frame_receipts VALUES (${space.id},'rollback')`;
      await storage.saveMessage({
        spaceId: space.id,
        channelId: channel.id,
        sender: 'agent',
        senderType: 'agent',
        type: 'agent',
        content: 'must rollback',
      });
      throw Error('abort');
    }),
  );
  assert.equal(
    (
      await db.sql`SELECT * FROM runtime_frame_receipts WHERE operation_id='rollback'`
    ).length,
    0,
  );
  assert.equal((await db.storage.getMessages(space.id, channel.id)).length, 1);
  console.log(
    'PASS: PostgreSQL schema replay, bundled seed replay, messages, tenant isolation, artifacts, transaction rollback',
  );
} finally {
  await db.close();
}

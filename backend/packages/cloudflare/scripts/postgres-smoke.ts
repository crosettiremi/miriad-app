import { provisionAccessUser, externalAccessId } from '../src/access.js';
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
  const accessIdentity = {
    subject: crypto.randomUUID(),
    email: 'owner@example.com',
    issuer: 'https://test.cloudflareaccess.com',
    expiresAt: Date.now() + 60000,
  };
  const second = openStorage(process.env.DATABASE_URL!);
  const profiles: string[] = [];
  try {
    await Promise.all(
      [db, second].map((client) =>
        client.transaction(async (storage, sql) => {
          const key = externalAccessId(accessIdentity);
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          const profile = await provisionAccessUser(storage, accessIdentity);
          profiles.push(profile.user.id + ':' + profile.space.id);
        }),
      ),
    );
    assert.equal(profiles.length, 2);
    assert.equal(
      profiles[0],
      profiles[1],
      'Concurrent first login must create exactly one user/space',
    );
    const original = await db.storage.getUserByExternalId(
      externalAccessId(accessIdentity),
    );
    assert.ok(original);
    assert.equal((await db.storage.getSpacesByOwner(original.id)).length, 1);
    await db.transaction(async (storage) => {
      const unrelated = await provisionAccessUser(storage, {
        ...accessIdentity,
        subject: crypto.randomUUID(),
      });
      assert.notEqual(
        unrelated.user.id,
        original.id,
        'Email alone must never link an identity',
      );
    });
  } finally {
    await second.close();
  }
  console.log(
    'PASS: PostgreSQL schema replay, bundled seed replay, messages, tenant isolation, artifacts, transaction rollback, concurrent Access provisioning',
  );
} finally {
  await db.close();
}

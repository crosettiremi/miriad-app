import { it, expect, vi } from 'vitest';
import { verifyCheckpoint, deleteCheckpoint } from './checkpoint.js';
const backup = { id: 'backup-123', dir: '/workspace' };
it('refuses partial uploads before a checkpoint can be published', async () => {
  const b = {
    head: async () => ({ size: 9 }),
    get: async () => ({ json: async () => ({ sizeBytes: 10 }) }),
  } as unknown as R2Bucket;
  await expect(verifyCheckpoint(b, backup, 1)).rejects.toThrow('mismatch');
});
it('records verified archive integrity metadata', async () => {
  const b = {
    head: async () => ({ size: 10, etag: 'etag' }),
    get: async () => ({ json: async () => ({ sizeBytes: 10 }) }),
  } as unknown as R2Bucket;
  expect(await verifyCheckpoint(b, backup, 2)).toMatchObject({
    generation: 2,
    archiveSize: 10,
    etag: 'etag',
    backup,
  });
});
it('refuses foreign keys when pruning checkpoint objects', async () => {
  const b = { delete: vi.fn() } as unknown as R2Bucket;
  await expect(
    deleteCheckpoint(b, { id: '../../assets', dir: '/workspace' }),
  ).rejects.toThrow('identifier');
  expect(b.delete).not.toHaveBeenCalled();
});

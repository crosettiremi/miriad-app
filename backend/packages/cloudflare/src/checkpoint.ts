import type { DirectoryBackup } from '@cloudflare/sandbox';
export interface Checkpoint {
  backup: DirectoryBackup;
  generation: number;
  archiveSize: number;
  etag: string;
  createdAt: number;
  runtimeVersion: string;
}
/** Keys are the pinned Sandbox 0.12.9 backup format; validate before publishing pointers. */
export async function verifyCheckpoint(
  bucket: R2Bucket,
  backup: DirectoryBackup,
  generation: number,
): Promise<Checkpoint> {
  if (!/^[a-zA-Z0-9_-]+$/.test(backup.id))
    throw new Error('Unexpected backup identifier');
  const archive = await bucket.head(`backups/${backup.id}/data.sqsh`);
  const metadata = await bucket.get(`backups/${backup.id}/meta.json`);
  if (!archive || !metadata || archive.size === 0)
    throw new Error('Incomplete checkpoint upload');
  const info = await metadata.json<{ sizeBytes: number }>();
  if (archive.size !== info.sizeBytes)
    throw new Error('Checkpoint size mismatch');
  return {
    backup,
    generation,
    archiveSize: archive.size,
    etag: archive.etag,
    createdAt: Date.now(),
    runtimeVersion: '0.1.0',
  };
}
export async function deleteCheckpoint(
  bucket: R2Bucket,
  backup: DirectoryBackup,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(backup.id))
    throw new Error('Unexpected backup identifier');
  await bucket.delete([
    `backups/${backup.id}/data.sqsh`,
    `backups/${backup.id}/meta.json`,
  ]);
}

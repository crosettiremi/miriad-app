import { describe, it, expect, vi } from 'vitest';
import { createR2AssetStorage, MAX_WORKER_ASSET_SIZE } from './r2-assets.js';
function bucket() {
  const objects = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    put: vi.fn(
      async (
        key: string,
        data: Uint8Array,
        options: { httpMetadata: { contentType: string } },
      ) => {
        objects.set(key, {
          data,
          contentType: options.httpMetadata.contentType,
        });
      },
    ),
    get: vi.fn(async (key: string) => {
      const o = objects.get(key);
      return o
        ? {
            arrayBuffer: async () =>
              o.data.buffer.slice(
                o.data.byteOffset,
                o.data.byteOffset + o.data.byteLength,
              ),
            body: new Blob([o.data]).stream(),
            size: o.data.length,
            httpMetadata: { contentType: o.contentType },
          }
        : null;
    }),
    head: vi.fn(async (key: string) => (objects.has(key) ? {} : null)),
    delete: vi.fn(async (key: string) => objects.delete(key)),
  } as unknown as R2Bucket;
}
describe('R2 assets', () => {
  it('round trips binary content and streams with metadata', async () => {
    const b = bucket();
    const a = createR2AssetStorage(b, 'a');
    await a.saveAsset({
      channelId: 'c',
      slug: 'x.png',
      source: { type: 'base64', data: 'AAEC/w==' },
    });
    expect([...(await a.readAsset('c', 'x.png'))]).toEqual([0, 1, 2, 255]);
    const stream = await a.readAssetStream!('c', 'x.png');
    expect(stream.contentType).toBe('image/png');
    expect(stream.contentLength).toBe(4);
  });
  it('isolates spaces even with identical channel and asset names', async () => {
    const b = bucket();
    await createR2AssetStorage(b, 'a').saveAsset({
      channelId: 'c',
      slug: 'x',
      source: { type: 'base64', data: 'eA==' },
    });
    await expect(
      createR2AssetStorage(b, 'b').readAsset('c', 'x'),
    ).rejects.toThrow('not found');
  });
  it('does not allow path components to escape the namespace', () => {
    const a = createR2AssetStorage(bucket(), 'a');
    expect(a.getAssetPath('../other', '../../x')).toBe(
      'spaces/a/..%2Fother/..%2F..%2Fx',
    );
  });
  it('rejects filesystem input', async () => {
    await expect(
      createR2AssetStorage(bucket(), 'a').saveAsset({
        channelId: 'c',
        slug: 'x',
        source: { type: 'path', path: '/etc/passwd' },
      }),
    ).rejects.toThrow('filesystem');
  });
  it('rejects oversized uploads before storing', async () => {
    const b = bucket();
    await expect(
      createR2AssetStorage(b, 'a').saveAsset({
        channelId: 'c',
        slug: 'x',
        source: {
          type: 'base64',
          data: 'A'.repeat(Math.ceil(MAX_WORKER_ASSET_SIZE / 3) * 4 + 1),
        },
      }),
    ).rejects.toThrow('size');
    expect(b.put).not.toHaveBeenCalled();
  });
  it('deletes idempotently', async () => {
    const a = createR2AssetStorage(bucket(), 'a');
    await a.deleteAsset('c', 'missing');
    expect(await a.assetExists('c', 'missing')).toBe(false);
  });
});

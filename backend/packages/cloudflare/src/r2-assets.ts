import { Buffer } from 'node:buffer';
import { getMimeType } from '@cast/core';
import type { AssetStorage } from '@cast/server/assets/index';

export const MAX_WORKER_ASSET_SIZE = 8 * 1024 * 1024;

/** A space-scoped adapter. Callers must authorize the channel before accessing it. */
export function createR2AssetStorage(
  bucket: R2Bucket,
  spaceId: string,
): AssetStorage {
  const component = (value: string) => {
    if (!value || value.includes('\0'))
      throw new Error('Invalid asset identifier');
    return encodeURIComponent(value);
  };
  const key = (channel: string, slug: string) =>
    `spaces/${component(spaceId)}/${component(channel)}/${component(slug)}`;
  const get = async (channel: string, slug: string) => {
    const object = await bucket.get(key(channel, slug));
    if (!object) throw new Error(`Asset not found: ${slug}`);
    return object;
  };
  return {
    async saveAsset({ channelId, slug, source }) {
      if (source.type !== 'base64')
        throw new Error(
          'Worker assets require uploaded content, not a filesystem path',
        );
      if (source.data.length > Math.ceil(MAX_WORKER_ASSET_SIZE / 3) * 4)
        throw new Error('Asset exceeds size limit');
      const data = Buffer.from(source.data, 'base64');
      if (data.length > MAX_WORKER_ASSET_SIZE)
        throw new Error('Asset exceeds size limit');
      const contentType = getMimeType(slug);
      const filePath = key(channelId, slug);
      await bucket.put(filePath, data, { httpMetadata: { contentType } });
      return { filePath, contentType, fileSize: data.length };
    },
    async readAsset(channel, slug) {
      return Buffer.from(await (await get(channel, slug)).arrayBuffer());
    },
    async readAssetStream(channel, slug) {
      const object = await get(channel, slug);
      return {
        stream: object.body,
        contentLength: object.size,
        contentType: object.httpMetadata?.contentType,
      };
    },
    async assetExists(channel, slug) {
      return (await bucket.head(key(channel, slug))) !== null;
    },
    async deleteAsset(channel, slug) {
      await bucket.delete(key(channel, slug));
    },
    getAssetPath: key,
  };
}

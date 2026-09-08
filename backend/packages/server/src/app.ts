/** Node deployment defaults. Workers import app-core directly. */
import { createApp as createCoreApp, type AppOptions as CoreOptions } from './app-core.js';
import { createAssetStorage } from './assets/index.js';
import { createMiriadCloudRoutes } from './handlers/miriad-cloud.js';
export { getAgentManager } from './app-core.js';
export type AppOptions = Omit<CoreOptions, 'assetStorage' | 'hostedRuntimeRoutes'> & Partial<Pick<CoreOptions, 'assetStorage' | 'hostedRuntimeRoutes'>>;
export function createApp(options: AppOptions) {
  return createCoreApp({
    ...options,
    assetStorage: options.assetStorage ?? createAssetStorage(),
    hostedRuntimeRoutes: options.hostedRuntimeRoutes ?? createMiriadCloudRoutes({storage: options.storage}),
  });
}

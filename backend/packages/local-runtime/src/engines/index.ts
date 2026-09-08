/**
 * Agent Engines
 *
 * Pluggable engine system for running different agent implementations.
 */

export * from './types.js';
export { EngineManager } from './engine-manager.js';
export { ClaudeSDKEngine, startClaudeSDKProcess } from './claude-sdk-engine.js';
export { NuumEngine } from './nuum-engine.js';

import { EngineManager } from './engine-manager.js';
import { ClaudeSDKEngine } from './claude-sdk-engine.js';
import { NuumEngine } from './nuum-engine.js';
import { WorkersAIEngine } from './workers-ai-engine.js';
export { WorkersAIEngine } from './workers-ai-engine.js';

/**
 * Create and configure the default engine manager with all available engines.
 */
export function createEngineManager(): EngineManager {
  const manager = new EngineManager();

  // Register default engines
  manager.register(new ClaudeSDKEngine());
  manager.register(new NuumEngine());
  manager.register(new WorkersAIEngine());

  return manager;
}

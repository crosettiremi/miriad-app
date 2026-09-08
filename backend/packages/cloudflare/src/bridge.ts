import { getAgentByName } from 'agents';
import { parseAgentId, type AgentRuntime } from '@cast/runtime';
import type { Storage } from '@cast/storage';
import type { AppOptions } from '@cast/server/app-core';
export function createBridge(env: Env, storage: Storage, spaceId: string) {
  const space = () => getAgentByName(env.SPACES, spaceId);
  const unsupported = (): never => {
    throw new Error('Socket lifecycle is owned by SpaceAgent');
  };
  const connectionManager: AppOptions['connectionManager'] = {
    addConnection: unsupported,
    removeConnection: unsupported,
    switchChannel: unsupported,
    getChannelConnections: unsupported,
    getConnection: unsupported,
    getConnectionCount: unsupported,
    getChannelConnectionCount: unsupported,
    closeAll: unsupported,
    broadcast: async (channel, frame) => {
      await (await space()).broadcastChannel(channel, frame);
    },
    send: async (id, frame) => {
      if (!(await (await space()).sendRuntime(id, frame)))
        throw new Error('Runtime is offline');
    },
  };
  const send = async (agentId: string, command: object) => {
    const agent = parseAgentId(agentId);
    if (agent.spaceId !== spaceId) throw new Error('Cross-space command');
    const roster = await storage.getRosterByCallsign(
      agent.channelId,
      agent.callsign,
    );
    const runtime = roster?.runtimeId
      ? await storage.getRuntime(roster.runtimeId)
      : null;
    const id = (runtime?.config as { wsConnectionId?: string })?.wsConnectionId;
    if (
      runtime?.spaceId !== spaceId ||
      !id ||
      !(await (await space()).sendRuntime(id, JSON.stringify(command)))
    )
      throw new Error('Select and start a runtime before invoking an agent');
  };
  const runtime: AgentRuntime = {
    async activate(options) {
      await send(options.agentId, {
        type: 'activate',
        agentId: options.agentId,
        systemPrompt: options.systemPrompt,
        mcpServers: options.mcpServers,
        workspacePath: `/workspace/${parseAgentId(options.agentId).channelId}`,
      });
      return {
        agentId: options.agentId,
        container: null,
        port: null,
        status: 'activating',
        endpoint: null,
        routeHints: null,
        activatedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };
    },
    async sendMessage(agentId, message) {
      await send(agentId, { type: 'message', agentId, ...message });
    },
    async suspend(agentId, reason) {
      await send(agentId, { type: 'suspend', agentId, reason });
    },
    // The legacy synchronous cache is intentionally absent; durable status lives in PostgreSQL.
    getState: () => null,
    isOnline: () => false,
    getAllOnline: () => [],
    shutdown: async () => {},
  };
  return {
    connectionManager,
    runtime,
    runtimeSend: async (id: string, data: string) =>
      (await space()).sendRuntime(id, data),
  };
}

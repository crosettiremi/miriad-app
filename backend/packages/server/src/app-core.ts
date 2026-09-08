/**
 * App Factory
 *
 * Creates a fully configured Hono app with all dependencies wired up.
 * This is the main entry point for both local dev and Lambda deployment.
 */

import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import type { Storage } from "@cast/storage";
import type { AgentRuntime } from "@cast/runtime";
import type {
  ChannelRoster,
  StoredMessage,
  RosterEntry,
  StoredMessageType,
  SetFrame,
} from "@cast/core";
import {
  parseFrame,
  isSetFrame,
  isResetFrame,
  tymbal,
  generateMessageId,
  getMimeType,
} from "@cast/core";
import { createTymbalRoutes } from "./handlers/tymbal.js";
import {
  createMessageRoutes,
  type MessageStorage,
  type RosterProvider,
  type Message,
} from "./handlers/messages.js";
import {
  createCheckinRoutes,
  broadcastAgentState,
} from "./handlers/checkin.js";
import { createMcpRoutes } from "./handlers/mcp-http.js";
import { createArtifactRoutes } from "./handlers/artifacts.js";
import { createAssetsApiRoutes } from "./handlers/assets-api.js";
import type { AssetStorage } from "./assets/index.js";
import type { ConnectionManager } from "./websocket/index.js";
import { AgentManager, createAgentInvokerAdapter } from "./agents/index.js";
import {
  createDevAuthRoutes,
  createWorkOSAuthRoutes,
  requireAuth,
  getSpaceId,
  generateContainerToken,
} from "./auth/index.js";
import { createAppRoutes } from "./handlers/apps.js";
import { createRuntimeAuthRoutes } from "./handlers/runtime-auth.js";
import { createRuntimeRoutes } from "./handlers/runtimes.js";
import { createKBRoutes } from "./handlers/kb.js";
import { createDisclaimerRoutes } from "./handlers/disclaimer.js";
import { createOAuthRoutes } from "./oauth/routes.js";
import {
  getOAuthTokens,
  saveOAuthTokens,
  getValidAccessToken,
  resolveOAuthEndpoints,
  OAUTH_SECRET_KEYS,
} from "./oauth/index.js";
import { resetRootChannel } from "./onboarding/index.js";

// =============================================================================
// Types
// =============================================================================

export interface AppOptions {
  /** Machine origin for built-in MCP; browser OAuth keeps the public API origin. */
  platformMcpUrl?: string;
  /** Storage backend for messages, channels, roster */
  storage: Storage;
  /** Platform-provided binary asset adapter. */
  assetStorage: AssetStorage;
  /** Platform-provided hosted runtime routes. */
  hostedRuntimeRoutes: Hono;
  /** Agent runtime (Docker for local, Fly.io for prod) */
  runtime: AgentRuntime;
  /** WebSocket connection manager for browser clients */
  connectionManager: ConnectionManager;
  /** Send function for runtime WebSocket connections (LocalRuntime) */
  runtimeSend?: (connectionId: string, data: string) => Promise<boolean>;
}

// =============================================================================
// Storage Adapters
// =============================================================================

/**
 * Adapt @cast/storage to MessageStorage interface expected by message handlers.
 * Note: spaceId is passed per-call since it comes from session context.
 */
function createMessageStorageAdapter(storage: Storage): {
  forSpace: (spaceId: string) => MessageStorage;
} {
  return {
    forSpace: (spaceId: string): MessageStorage => ({
      async saveMessage(channelId: string, message: Message): Promise<void> {
        await storage.saveMessage({
          id: message.id,
          spaceId,
          channelId,
          sender: message.sender,
          senderType: message.senderType,
          type: message.type as "user" | "agent",
          content: message.content,
          isComplete: message.isComplete,
          addressedAgents: message.addressedAgents,
          metadata: message.metadata,
        });
      },

      async getMessages(
        channelId: string,
        options?: {
          since?: string;
          before?: string;
          limit?: number;
          forAgent?: string;
        },
      ): Promise<Message[]> {
        const stored = await storage.getMessages(spaceId, channelId, {
          since: options?.since,
          before: options?.before,
          limit: options?.limit,
          includeToolCalls: true,
        });

        return stored.map((msg: StoredMessage) => ({
          id: msg.id,
          channelId: msg.channelId,
          sender: msg.sender,
          senderType: msg.senderType,
          type: msg.type,
          // Pass content directly - strings for text, objects for structured (e.g., status)
          content: msg.content as string | Record<string, unknown>,
          timestamp: msg.timestamp,
          isComplete: msg.isComplete,
          addressedAgents: msg.addressedAgents,
          metadata: msg.metadata,
        }));
      },

      async deleteMessage(channelId: string, messageId: string): Promise<void> {
        await storage.deleteMessage(spaceId, messageId);
      },
    }),
  };
}

/**
 * Adapt @cast/storage to RosterProvider interface expected by message handlers.
 * Note: spaceId is passed per-call since it comes from session context.
 */
function createRosterProviderAdapter(storage: Storage): {
  forSpace: (spaceId: string) => RosterProvider;
} {
  return {
    forSpace: (spaceId: string): RosterProvider => ({
      async getRoster(channelId: string): Promise<ChannelRoster | null> {
        // Single query: channel + roster via JOIN
        const result = await storage.getChannelWithRoster(spaceId, channelId);
        if (!result) return null;

        const rosterEntries = result.roster;

        // Find leader (first agent with 'lead' in type)
        const leaderEntry = rosterEntries.find((e: RosterEntry) =>
          e.agentType.toLowerCase().includes("lead"),
        );

        // Get space owner's callsign (human user) for valid @mentions
        const space = await storage.getSpace(spaceId);
        const owner = space ? await storage.getUser(space.ownerId) : null;

        // ChannelRoster expects { agents: string[], leader: string, users?: string[] }
        const roster: ChannelRoster = {
          agents: rosterEntries.map((e: RosterEntry) => e.callsign),
          leader: leaderEntry?.callsign ?? rosterEntries[0]?.callsign ?? "",
          users: owner?.callsign ? [owner.callsign] : [],
        };

        return roster;
      },

      async getLeader(channelId: string): Promise<string | null> {
        const rosterEntries = await storage.listRoster(channelId);
        // Convention: first agent with 'lead' in type is the leader
        const leader = rosterEntries.find((e: RosterEntry) =>
          e.agentType.toLowerCase().includes("lead"),
        );
        return leader?.callsign ?? null;
      },
    }),
  };
}

// =============================================================================
// Channel & Roster Routes
// =============================================================================

function createChannelRoutes(storage: Storage): Hono {
  const app = new Hono();

  // GET /channels - List all channels
  app.get("/", async (c) => {
    const spaceId = getSpaceId(c);
    try {
      const channels = await storage.listChannels(spaceId);
      return c.json({ channels });
    } catch (error) {
      console.error("[Channels] Error listing channels:", error);
      return c.json({ error: "Failed to list channels" }, 500);
    }
  });

  // POST /channels - Create a channel
  app.post("/", async (c) => {
    const spaceId = getSpaceId(c);
    let body: { name?: string; tagline?: string; mission?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.name) {
      return c.json({ error: "Channel name is required" }, 400);
    }

    try {
      const channel = await storage.createChannel({
        spaceId,
        name: body.name,
        tagline: body.tagline,
        mission: body.mission,
      });
      return c.json({ channel }, 201);
    } catch (error) {
      console.error("[Channels] Error creating channel:", error);
      return c.json({ error: "Failed to create channel" }, 500);
    }
  });

  // GET /channels/:id - Get a channel (with roster per spec)
  app.get("/:channelId", async (c) => {
    const spaceId = getSpaceId(c);
    const channelId = c.req.param("channelId");

    try {
      // Single query: channel + roster via JOIN
      const result = await storage.getChannelWithRoster(spaceId, channelId);
      if (!result) {
        return c.json({ error: "Channel not found" }, 404);
      }

      return c.json({ channel: result.channel, roster: result.roster });
    } catch (error) {
      console.error("[Channels] Error getting channel:", error);
      return c.json({ error: "Failed to get channel" }, 500);
    }
  });

  // PUT /channels/:id - Update a channel
  app.put("/:channelId", async (c) => {
    const spaceId = getSpaceId(c);
    const channelId = c.req.param("channelId");

    let body: {
      name?: string;
      tagline?: string;
      mission?: string;
      archived?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      await storage.updateChannel(spaceId, channelId, body);
      const channel = await storage.getChannel(spaceId, channelId);
      return c.json({ channel });
    } catch (error) {
      console.error("[Channels] Error updating channel:", error);
      return c.json({ error: "Failed to update channel" }, 500);
    }
  });

  return app;
}

function createRosterRoutes(storage: Storage): Hono {
  const app = new Hono();

  // GET /channels/:id/roster - List roster
  app.get("/:channelId/roster", async (c) => {
    const channelId = c.req.param("channelId");

    try {
      const roster = await storage.listRoster(channelId);
      return c.json({ roster });
    } catch (error) {
      console.error("[Roster] Error listing roster:", error);
      return c.json({ error: "Failed to list roster" }, 500);
    }
  });

  // POST /channels/:id/roster - Add to roster
  app.post("/:channelId/roster", async (c) => {
    const spaceId = getSpaceId(c);
    const channelId = c.req.param("channelId");

    let body: {
      callsign?: string;
      agentType?: string;
      status?: string;
      runtimeId?: string | null;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.callsign || !body.agentType) {
      return c.json({ error: "callsign and agentType are required" }, 400);
    }

    try {
      // Validate runtimeId if provided
      if (body.runtimeId) {
        const runtime = await storage.getRuntime(body.runtimeId);
        if (!runtime) {
          return c.json({ error: "Runtime not found" }, 404);
        }
        if (runtime.spaceId !== spaceId) {
          return c.json(
            { error: "Runtime does not belong to this space" },
            403,
          );
        }
      }

      const entry = await storage.addToRoster({
        channelId,
        callsign: body.callsign,
        agentType: body.agentType,
        status:
          (body.status as "active" | "idle" | "busy" | "offline") ?? "active",
        runtimeId: body.runtimeId ?? null,
      });
      return c.json({ entry }, 201);
    } catch (error) {
      console.error("[Roster] Error adding to roster:", error);
      return c.json({ error: "Failed to add to roster" }, 500);
    }
  });

  // DELETE /channels/:id/roster/:entryId - Remove from roster
  app.delete("/:channelId/roster/:entryId", async (c) => {
    const channelId = c.req.param("channelId");
    const entryId = c.req.param("entryId");

    try {
      await storage.removeFromRoster(channelId, entryId);
      return c.json({ ok: true });
    } catch (error) {
      console.error("[Roster] Error removing from roster:", error);
      return c.json({ error: "Failed to remove from roster" }, 500);
    }
  });

  return app;
}

// =============================================================================
// Agent Routes (POST /channels/:id/agents - Add agent to channel)
// =============================================================================

interface AgentRoutesOptions {
  storage: Storage;
  connectionManager: ConnectionManager;
  agentManager: AgentManager;
}

function createAgentRoutes(options: AgentRoutesOptions): Hono {
  const { storage, connectionManager, agentManager } = options;
  const app = new Hono();

  /**
   * POST /channels/:id/agents - Add an agent to a channel
   *
   * Flow:
   * 1. Add to roster via storage.addToRoster()
   * 2. Create "Summoning {callsign}..." status message (save + broadcast)
   * 3. Set that message ID as initial readmark
   * 4. Spawn container via agentManager
   * 5. Return agent info
   */
  app.post("/:channelId/agents", async (c) => {
    const spaceId = getSpaceId(c);
    const channelId = c.req.param("channelId");

    let body: {
      callsign?: string;
      agentType?: string;
      runtimeId?: string | null;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { callsign, agentType, runtimeId } = body;

    if (!callsign || !agentType) {
      return c.json({ error: "callsign and agentType are required" }, 400);
    }

    try {
      // Verify channel exists
      const channel = await storage.getChannel(spaceId, channelId);
      if (!channel) {
        return c.json({ error: "Channel not found" }, 404);
      }

      // Validate runtimeId if provided
      if (runtimeId) {
        const runtime = await storage.getRuntime(runtimeId);
        if (!runtime) {
          return c.json({ error: "Runtime not found" }, 404);
        }
        if (runtime.spaceId !== spaceId) {
          return c.json(
            { error: "Runtime does not belong to this space" },
            403,
          );
        }
      }

      // Check if agent already exists in roster
      const existingEntry = await storage.getRosterByCallsign(
        channelId,
        callsign,
      );
      if (existingEntry) {
        return c.json({ error: "Agent already in roster" }, 409);
      }

      console.log(
        `[Agents] Adding ${callsign} (${agentType}) to channel ${channelId}${runtimeId ? ` on runtime ${runtimeId}` : ""}`,
      );

      // Step 1: Add to roster
      const rosterEntry = await storage.addToRoster({
        channelId,
        callsign,
        agentType,
        status: "active",
        runtimeId: runtimeId ?? null,
      });
      console.log(
        `[Agents] Added ${callsign} to roster, entry ID: ${rosterEntry.id}`,
      );

      // Step 2: Create summoning message (save + broadcast)
      const messageId = generateMessageId();
      const now = new Date().toISOString();
      const summoningContent = { action: "summon", callsign };

      // Save message to storage (content as object - stored as JSONB)
      await storage.saveMessage({
        id: messageId,
        spaceId,
        channelId,
        sender: "system",
        senderType: "system",
        type: "status",
        content: summoningContent,
        isComplete: true,
      });
      console.log(`[Agents] Created summoning message: ${messageId}`);

      // Broadcast to WebSocket clients
      const frame = tymbal.set(messageId, {
        type: "status",
        sender: "system",
        senderType: "system",
        content: summoningContent,
        timestamp: now,
      });
      await connectionManager.broadcast(channelId, frame);
      console.log(`[Agents] Broadcast summoning message to channel`);

      // Broadcast roster event so clients add the new agent to their roster
      // Need to fetch the full entry with runtime info
      const fullEntry = await storage.getRosterByCallsign(channelId, callsign);
      if (fullEntry) {
        const rosterFrame = {
          i: generateMessageId(),
          t: now,
          v: {
            type: "roster",
            action: "agent_joined",
            agent: {
              callsign: fullEntry.callsign,
              agentType: fullEntry.agentType,
              status: fullEntry.status,
              runtimeId: fullEntry.runtimeId,
              runtimeName: fullEntry.runtimeName,
              runtimeStatus: fullEntry.runtimeStatus,
            },
          },
          c: channelId,
        };
        await connectionManager.broadcast(
          channelId,
          JSON.stringify(rosterFrame),
        );
        console.log(`[Agents] Broadcast roster join event for ${callsign}`);
      }

      // Broadcast 'connecting' agent state - user knows to wait
      await broadcastAgentState(
        connectionManager,
        channelId,
        callsign,
        "connecting",
      );

      // Step 3: Set summoning message ID as initial readmark
      await storage.updateRosterEntry(channelId, rosterEntry.id, {
        readmark: messageId,
      });
      console.log(`[Agents] Set initial readmark to ${messageId}`);

      // Step 4: Spawn container
      // Note: For agents with runtimeId, the first message will trigger activation
      // via the invoker-adapter's DB-based WebSocket routing
      try {
        if (!runtimeId) {
          // No runtime binding - spawn via Docker/Fly runtime
          await agentManager.activate(spaceId, channelId, callsign);
          console.log(`[Agents] Container spawned for ${callsign}`);
        } else {
          // Agent bound to LocalRuntime - will activate on first message
          console.log(
            `[Agents] Agent ${callsign} bound to runtime ${runtimeId}, will activate on first message`,
          );
        }
      } catch (spawnError) {
        console.error(
          `[Agents] Failed to spawn container for ${callsign}:`,
          spawnError,
        );
        // Don't fail the request - agent is in roster, container spawn can retry
      }

      // Step 5: Return agent info
      return c.json(
        {
          success: true,
          agent: {
            id: rosterEntry.id,
            callsign: rosterEntry.callsign,
            agentType: rosterEntry.agentType,
            status: rosterEntry.status,
          },
        },
        201,
      );
    } catch (error) {
      console.error("[Agents] Error adding agent:", error);
      return c.json({ error: "Failed to add agent" }, 500);
    }
  });

  /**
   * GET /channels/:id/agents/available - List available agent definitions
   *
   * Fetches system.agent artifacts from both the channel's board and root channel,
   * merges by slug (local shadows root), and returns unified list.
   */
  app.get("/:channelId/agents/available", async (c) => {
    const spaceId = getSpaceId(c);
    const channelId = c.req.param("channelId");

    try {
      // Verify channel exists
      const channel = await storage.getChannel(spaceId, channelId);
      if (!channel) {
        return c.json({ error: "Channel not found" }, 404);
      }

      // Fetch system.agent artifacts from root channel
      const rootChannel = await storage.getChannelByName(spaceId, "root");
      const rootAgents = rootChannel
        ? await storage.listArtifacts(rootChannel.id, { type: "system.agent" })
        : [];

      // Fetch system.agent artifacts from current channel (only if not root)
      const isRootChannel = rootChannel && channelId === rootChannel.id;
      const localAgents = isRootChannel
        ? [] // Don't double-load root agents
        : await storage.listArtifacts(channelId, { type: "system.agent" });

      // Merge by slug: local shadows root
      const agentMap = new Map<
        string,
        {
          slug: string;
          title?: string;
          tldr?: string;
          nameTheme?: string;
          suggestedName?: string;
          featuredChannelStarter?: boolean;
          source: "local" | "root";
        }
      >();

      // Add root agents first
      for (const agent of rootAgents) {
        const props = agent.props as Record<string, unknown> | undefined;
        agentMap.set(agent.slug, {
          slug: agent.slug,
          title: agent.title,
          tldr: agent.tldr,
          nameTheme: props?.nameTheme as string | undefined,
          suggestedName: props?.suggestedName as string | undefined,
          featuredChannelStarter: props?.featuredChannelStarter as
            | boolean
            | undefined,
          source: "root",
        });
      }

      // Add local agents (shadows root by slug)
      for (const agent of localAgents) {
        const props = agent.props as Record<string, unknown> | undefined;
        agentMap.set(agent.slug, {
          slug: agent.slug,
          title: agent.title,
          tldr: agent.tldr,
          nameTheme: props?.nameTheme as string | undefined,
          suggestedName: props?.suggestedName as string | undefined,
          featuredChannelStarter: props?.featuredChannelStarter as
            | boolean
            | undefined,
          source: "local",
        });
      }

      // Convert to array and sort alphabetically by title (fallback to slug)
      const agents = Array.from(agentMap.values()).sort((a, b) => {
        const aName = a.title || a.slug;
        const bName = b.title || b.slug;
        return aName.localeCompare(bName);
      });

      return c.json({ agents });
    } catch (error) {
      console.error("[Agents] Error listing available agents:", error);
      return c.json({ error: "Failed to list available agents" }, 500);
    }
  });

  /**
   * GET /channels/:id/agents/generateName - Generate a unique agent callsign
   *
   * Uses Claude Haiku to generate a name fitting the context that's unique
   * to the channel roster.
   *
   * Query params:
   *   - theme: Name theme (e.g., "wild birds of Canada")
   *   - role: Agent role (e.g., "builder", "researcher")
   *   - channelName: Channel name for context (e.g., "cast-dev")
   */
  app.get("/:channelId/agents/generateName", async (c) => {
    const spaceId = getSpaceId(c);
    const channelId = c.req.param("channelId");
    const theme = c.req.query("theme")?.trim();
    const role = c.req.query("role")?.trim();
    const channelName = c.req.query("channelName")?.trim();

    try {
      // Get current roster to know which names to avoid
      const roster = await storage.listRoster(channelId);
      const takenNames = roster.map((r) => r.callsign);

      // Get Anthropic API key from space secrets
      const apiKey = await storage.getSpaceSecretValue(
        spaceId,
        "anthropic_api_key",
      );
      if (!apiKey) {
        return c.json({ error: "Anthropic API key not configured" }, 400);
      }

      // Build contextual prompt
      const contextParts: string[] = [];
      if (role) contextParts.push(`Role: ${role}`);
      if (theme) contextParts.push(`Theme: ${theme}`);

      const channelVibe = channelName
        ? `\nChannel: #${channelName} — let the channel name inspire the vibe of the callsign.`
        : "";

      const contextBlock = contextParts.length > 0
        ? contextParts.join("\n")
        : "Style: humble and righteous robots from science fiction";

      const takenBlock = takenNames.length > 0
        ? `\nAlready taken: ${takenNames.join(", ")}`
        : "";

      const prompt = `Generate a memorable one-word callsign (lowercase) for an AI agent.

${contextBlock}${channelVibe}

Avoid: generic names, numbers, "agent-" prefixes, overly grandiose names.
Prefer: evocative, memorable, names that match the channel's tone.${takenBlock}

Return ONLY the callsign, nothing else.`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 50,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("[GenerateName] Anthropic API error:", error);
        return c.json({ error: "Failed to generate name" }, 500);
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      const textBlock = data.content.find((b) => b.type === "text");
      const generatedName =
        textBlock?.text
          ?.trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "") || "";

      if (!generatedName) {
        return c.json({ error: "Failed to generate name" }, 500);
      }

      return c.json({ name: generatedName });
    } catch (error) {
      console.error("[GenerateName] Error:", error);
      return c.json({ error: "Failed to generate name" }, 500);
    }
  });

  /**
   * POST /channels/:id/agents/:callsign/pause - Pause an agent
   *
   * Stops the container and sets status to 'paused'.
   * Agent remains in roster but won't receive messages.
   */
  app.post("/:channelId/agents/:callsign/pause", async (c) => {
    const channelId = c.req.param("channelId");
    const callsign = c.req.param("callsign");

    try {
      // Find agent in roster
      const rosterEntry = await storage.getRosterByCallsign(
        channelId,
        callsign,
      );
      if (!rosterEntry) {
        return c.json({ error: "Agent not found in roster" }, 404);
      }

      // Check if already paused
      if (rosterEntry.status === "paused") {
        return c.json({ error: "Agent is already paused" }, 400);
      }

      // Check if archived
      if (rosterEntry.status === "archived") {
        return c.json({ error: "Cannot pause archived agent" }, 400);
      }

      console.log(`[Agents] Pausing ${callsign} in channel ${channelId}`);

      // Stop container if running
      const spaceId = getSpaceId(c);
      try {
        await agentManager.suspend(spaceId, channelId, callsign);
      } catch (stopError) {
        console.warn(
          `[Agents] Error stopping container for ${callsign}:`,
          stopError,
        );
        // Continue anyway - container may already be stopped
      }

      // Update roster status to paused and clear callbackUrl
      await storage.updateRosterEntry(channelId, rosterEntry.id, {
        status: "paused",
        callbackUrl: undefined,
      });

      // Broadcast paused state
      await broadcastAgentState(
        connectionManager,
        channelId,
        callsign,
        "paused",
      );

      console.log(`[Agents] ${callsign} paused successfully`);
      return c.json({ success: true, callsign, status: "paused" });
    } catch (error) {
      console.error("[Agents] Error pausing agent:", error);
      return c.json({ error: "Failed to pause agent" }, 500);
    }
  });

  /**
   * POST /channels/:id/agents/:callsign/resume - Resume a paused agent
   *
   * Spawns a new container and sets status back to 'active'.
   */
  app.post("/:channelId/agents/:callsign/resume", async (c) => {
    const channelId = c.req.param("channelId");
    const callsign = c.req.param("callsign");

    try {
      // Find agent in roster
      const rosterEntry = await storage.getRosterByCallsign(
        channelId,
        callsign,
      );
      if (!rosterEntry) {
        return c.json({ error: "Agent not found in roster" }, 404);
      }

      // Check if actually paused
      if (rosterEntry.status !== "paused") {
        return c.json({ error: "Agent is not paused" }, 400);
      }

      console.log(`[Agents] Resuming ${callsign} in channel ${channelId}`);

      // Update roster status to active
      await storage.updateRosterEntry(channelId, rosterEntry.id, {
        status: "active",
      });

      // Broadcast resumed state - agent is no longer muted
      await broadcastAgentState(
        connectionManager,
        channelId,
        callsign,
        "resumed",
      );

      console.log(`[Agents] ${callsign} resumed successfully`);
      return c.json({ success: true, callsign, status: "active" });
    } catch (error) {
      console.error("[Agents] Error resuming agent:", error);
      return c.json({ error: "Failed to resume agent" }, 500);
    }
  });

  /**
   * POST /channels/:id/agents/:callsign/activate - Activate a suspended or paused agent
   *
   * Spawns a new container for an agent that is offline.
   * Also clears paused status if set (activate overrides mute).
   */
  app.post("/:channelId/agents/:callsign/activate", async (c) => {
    const channelId = c.req.param("channelId");
    const callsign = c.req.param("callsign");

    try {
      // Find agent in roster
      const rosterEntry = await storage.getRosterByCallsign(
        channelId,
        callsign,
      );
      if (!rosterEntry) {
        return c.json({ error: "Agent not found in roster" }, 404);
      }

      // Check if archived
      if (rosterEntry.status === "archived") {
        return c.json({ error: "Cannot activate archived agent" }, 400);
      }

      console.log(`[Agents] Activating ${callsign} in channel ${channelId}`);

      // Clear stale callbackUrl if present (container may have died without cleanup)
      if (rosterEntry.callbackUrl) {
        console.log(`[Agents] Clearing stale callbackUrl for ${callsign}`);
        await storage.updateRosterEntry(channelId, rosterEntry.id, {
          callbackUrl: undefined,
        });
      }

      const spaceId = getSpaceId(c);

      // If paused, clear the paused status (activate overrides mute)
      if (rosterEntry.status === "paused") {
        await storage.updateRosterEntry(channelId, rosterEntry.id, {
          status: "active",
        });
        console.log(`[Agents] Cleared paused status for ${callsign}`);
      }

      // Broadcast connecting state
      await broadcastAgentState(
        connectionManager,
        channelId,
        callsign,
        "connecting",
      );

      // Spawn new container
      try {
        await agentManager.activate(spaceId, channelId, callsign);
        console.log(`[Agents] Container spawned for ${callsign}`);
      } catch (spawnError) {
        console.error(
          `[Agents] Failed to spawn container for ${callsign}:`,
          spawnError,
        );
        // Broadcast offline state since spawn failed
        await broadcastAgentState(
          connectionManager,
          channelId,
          callsign,
          "offline",
        );
        return c.json({ error: "Failed to spawn container" }, 500);
      }

      console.log(`[Agents] ${callsign} activated successfully`);
      return c.json({ success: true, callsign, status: "active" });
    } catch (error) {
      console.error("[Agents] Error activating agent:", error);
      return c.json({ error: "Failed to activate agent" }, 500);
    }
  });

  /**
   * DELETE /channels/:id/agents/:callsign - Dismiss an agent
   *
   * Archives the agent (hidden from roster but data preserved).
   * Stops container, clears callbackUrl, broadcasts dismissed state.
   */
  app.delete("/:channelId/agents/:callsign", async (c) => {
    const channelId = c.req.param("channelId");
    const callsign = c.req.param("callsign");

    try {
      // Find agent in roster
      const rosterEntry = await storage.getRosterByCallsign(
        channelId,
        callsign,
      );
      if (!rosterEntry) {
        return c.json({ error: "Agent not found in roster" }, 404);
      }

      // Check if already archived
      if (rosterEntry.status === "archived") {
        return c.json({ error: "Agent is already dismissed" }, 400);
      }

      console.log(`[Agents] Dismissing ${callsign} in channel ${channelId}`);

      // Stop container if running
      const spaceId = getSpaceId(c);
      try {
        await agentManager.suspend(spaceId, channelId, callsign);
      } catch (stopError) {
        console.warn(
          `[Agents] Error stopping container for ${callsign}:`,
          stopError,
        );
        // Continue anyway - container may already be stopped
      }

      // Update roster status to archived and clear callbackUrl
      await storage.updateRosterEntry(channelId, rosterEntry.id, {
        status: "archived",
        callbackUrl: undefined,
      });

      // Broadcast dismissed state
      await broadcastAgentState(
        connectionManager,
        channelId,
        callsign,
        "dismissed",
      );

      // Create and broadcast status message for dismiss action
      const messageId = generateMessageId();
      const now = new Date().toISOString();
      const dismissContent = { action: "dismiss", callsign };
      // Save message to storage (content as object - stored as JSONB)
      await storage.saveMessage({
        id: messageId,
        spaceId,
        channelId,
        sender: "system",
        senderType: "system",
        type: "status",
        content: dismissContent,
        isComplete: true,
      });

      // Broadcast status message to channel
      const frame = tymbal.set(messageId, {
        type: "status",
        sender: "system",
        senderType: "system",
        content: dismissContent,
        timestamp: now,
      });
      await connectionManager.broadcast(channelId, frame);

      console.log(`[Agents] ${callsign} dismissed successfully`);
      return c.json({ success: true, callsign });
    } catch (error) {
      console.error("[Agents] Error dismissing agent:", error);
      return c.json({ error: "Failed to dismiss agent" }, 500);
    }
  });

  /**
   * GET /channels/:id/agents/archived - List archived agents
   *
   * Returns a flat list of archived (dismissed) agents.
   * Used by frontend to detect @mentions of dismissed agents
   * and offer to reactivate them.
   */
  app.get("/:channelId/agents/archived", async (c) => {
    const channelId = c.req.param("channelId");

    try {
      const archived = await storage.listArchivedRoster(channelId);
      return c.json({ agents: archived });
    } catch (error) {
      console.error("[Agents] Error listing archived agents:", error);
      return c.json({ error: "Failed to list archived agents" }, 500);
    }
  });

  /**
   * POST /channels/:id/agents/:callsign/unarchive - Restore a dismissed agent
   *
   * Sets status back to 'active' and spawns a new container.
   * Used when user wants to re-summon a previously dismissed agent.
   */
  app.post("/:channelId/agents/:callsign/unarchive", async (c) => {
    const channelId = c.req.param("channelId");
    const callsign = c.req.param("callsign");

    try {
      // Find agent in roster (archived agents are still in DB)
      const rosterEntry = await storage.getRosterByCallsign(
        channelId,
        callsign,
      );
      if (!rosterEntry) {
        return c.json({ error: "Agent not found in roster" }, 404);
      }

      // Check if actually archived
      if (rosterEntry.status !== "archived") {
        return c.json({ error: "Agent is not dismissed" }, 400);
      }

      console.log(`[Agents] Unarchiving ${callsign} in channel ${channelId}`);

      // Update roster status back to active
      await storage.updateRosterEntry(channelId, rosterEntry.id, {
        status: "active",
      });

      // Broadcast connecting state
      await broadcastAgentState(
        connectionManager,
        channelId,
        callsign,
        "connecting",
      );

      // Spawn new container
      const spaceId = getSpaceId(c);
      try {
        await agentManager.activate(spaceId, channelId, callsign);
        console.log(`[Agents] ${callsign} unarchived and container spawned`);
      } catch (spawnError) {
        console.warn(
          `[Agents] Error spawning container for ${callsign}:`,
          spawnError,
        );
        // Agent is restored to active state even if spawn fails
        // They'll get a container on next message
      }

      return c.json({ success: true, callsign, status: "active" });
    } catch (error) {
      console.error("[Agents] Error unarchiving agent:", error);
      return c.json({ error: "Failed to unarchive agent" }, 500);
    }
  });

  return app;
}

// =============================================================================
// App Factory
// =============================================================================

/**
 * Create a fully configured Cast backend Hono app.
 */
export function createApp(options: AppOptions): Hono {
  const { storage, runtime, connectionManager, runtimeSend } = options;

  const app = new Hono();

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: (origin) => {
        // Allow any localhost origin for local development
        if (origin && origin.match(/^http:\/\/localhost(:\d+)?$/)) {
          return origin;
        }
        // Allow staging and production frontend domains
        if (
          origin === "https://app.staging.caststack.ai" ||
          origin === "https://app.caststack.ai"
        ) {
          return origin;
        }
        // Allow FRONTEND_URL if set (for flexible deployment configurations)
        const frontendUrl = process.env.FRONTEND_URL;
        if (frontendUrl && origin === frontendUrl) {
          return origin;
        }
        return null;
      },
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // ---------------------------------------------------------------------------
  // Health & Info Endpoints
  // ---------------------------------------------------------------------------

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      version: "0.0.1",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/", (c) => {
    return c.json({
      name: "Cast Backend",
      version: "0.0.1",
      docs: "/health",
    });
  });

  // ---------------------------------------------------------------------------
  // Auth Routes
  // ---------------------------------------------------------------------------

  // Dev auth routes (local development only)
  // SECURITY: Only mount when AUTH_MODE=dev to prevent auth bypass in production
  const devAuthRoutes = createDevAuthRoutes({ storage });
  if (process.env.AUTH_MODE === "dev") {
    app.route("/auth/dev", devAuthRoutes);
  }

  // WorkOS auth routes (production)
  // These are always mounted - they'll return errors if WorkOS env vars aren't set
  const workosAuthRoutes = createWorkOSAuthRoutes({ storage });
  if (process.env.AUTH_MODE === "workos") app.route("/auth", workosAuthRoutes);

  // GET /auth/me is shared between dev and workos modes
  // (dev routes have /me handler, workos routes can add their own later)
  app.get("/auth/me", async (c) => {
    // Forward to dev routes - they use the shared session parsing
    const response = await devAuthRoutes.request(
      new Request(new URL("/me", c.req.url), { headers: c.req.raw.headers }),
      {},
    );
    // Copy response headers (including cookies)
    const headers = new Headers(response.headers);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  });

  // POST /auth/logout - route to appropriate handler based on session mode
  // WorkOS sessions need to redirect to WorkOS logout URL
  // Dev sessions just need cookie cleared
  app.post("/auth/logout", async (c) => {
    // Check session mode to decide which handler to use
    const { parseSession } = await import("./auth/session.js");
    const session = await parseSession(c);

    if (session?.mode === "workos") {
      // Forward to WorkOS routes for proper session termination
      const response = await workosAuthRoutes.request(
        new Request(new URL("/logout", c.req.url), {
          method: "POST",
          headers: c.req.raw.headers,
        }),
        {},
      );
      const headers = new Headers(response.headers);
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    // Dev mode - use dev routes
    const response = await devAuthRoutes.request(
      new Request(new URL("/logout", c.req.url), {
        method: "POST",
        headers: c.req.raw.headers,
      }),
      {},
    );
    const headers = new Headers(response.headers);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  });

  // ---------------------------------------------------------------------------
  // App OAuth Routes (External Service Integrations)
  // ---------------------------------------------------------------------------
  const apiUrl = process.env.CAST_API_URL || "http://localhost:8080";
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const jwtSecret =
    process.env.SECRET_KEY || "dev-secret-key-min-32-characters!!";

  const appRoutes = createAppRoutes({
    storage,
    apiUrl,
    appUrl,
    jwtSecret,
  });
  app.route("/auth/apps", appRoutes);

  // ---------------------------------------------------------------------------
  // MCP OAuth Routes (OAuth for HTTP MCP servers)
  // ---------------------------------------------------------------------------
  const oauthRoutes = createOAuthRoutes({
    storage,
    apiUrl,
  });
  app.route("/api/oauth", oauthRoutes);

  // ---------------------------------------------------------------------------
  // Runtime Auth Routes (bootstrap token, server credentials)
  // ---------------------------------------------------------------------------
  const runtimeAuthRoutes = createRuntimeAuthRoutes({
    storage,
    apiHost: new URL(apiUrl).host,
    wsHost: new URL(apiUrl).host.replace("api.", "ws."),
  });
  app.route("/api/runtimes/auth", runtimeAuthRoutes);

  // ---------------------------------------------------------------------------
  // Runtime Management Routes
  // ---------------------------------------------------------------------------
  const runtimeRoutes = createRuntimeRoutes({ storage });
  app.route("/api/spaces", runtimeRoutes);

  // ---------------------------------------------------------------------------
  // Miriad Cloud Routes (container provisioning)
  // ---------------------------------------------------------------------------
  const miriadCloudRoutes = options.hostedRuntimeRoutes;
  app.route("/api/runtimes/miriad-cloud", miriadCloudRoutes);

  // ---------------------------------------------------------------------------
  // Knowledge Base Routes
  // ---------------------------------------------------------------------------
  const kbRoutes = createKBRoutes({ storage });
  app.route("/kb", kbRoutes);

  // ---------------------------------------------------------------------------
  // Disclaimer Routes
  // ---------------------------------------------------------------------------
  const disclaimerRoutes = createDisclaimerRoutes(storage);
  app.route("/disclaimer", disclaimerRoutes);

  // ---------------------------------------------------------------------------
  // Focus Types & Agent Types (stubs for frontend)
  // ---------------------------------------------------------------------------

  app.get("/focus-types", (c) => {
    return c.json({
      focusTypes: [
        {
          slug: "general",
          name: "General",
          description: "Open workspace for any task",
        },
      ],
    });
  });

  app.get("/agents", (c) => {
    return c.json({
      agentTypes: [
        {
          slug: "engineer",
          name: "Engineer",
          description: "Software engineering agent",
        },
        {
          slug: "lead",
          name: "Lead",
          description: "Team lead agent",
        },
      ],
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/backends - List available AI backends/engines with capabilities
  // Static response for now - engine registry integration can come later
  // ---------------------------------------------------------------------------
  app.get("/api/backends", (c) => {
    return c.json([
      {
        name: "claude",
        isBuiltIn: true,
        capabilities: {
          supportsMcp: true,
          supportsTools: true,
          supportsVision: true,
        },
      },
      {
        name: "openai",
        isBuiltIn: true,
        capabilities: {
          supportsMcp: true,
          supportsTools: true,
          supportsVision: true,
        },
      },
      {
        name: "codex",
        isBuiltIn: true,
        capabilities: {
          supportsMcp: true,
          supportsTools: true,
          supportsVision: false,
        },
      },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Create Agent Manager
  // ---------------------------------------------------------------------------

  const agentManager = new AgentManager({
    runtime,
    broadcast: (channelId, frame) =>
      connectionManager.broadcast(channelId, frame),
    getChannel: async (sid, cid) => {
      const channel = await storage.getChannel(sid, cid);
      if (!channel) return null;
      return {
        id: channel.id,
        name: channel.name,
        tagline: channel.tagline,
        mission: channel.mission,
      };
    },
    getRoster: async (sid, cid) => {
      const entries = await storage.listRoster(cid);
      return entries.map((e: RosterEntry) => ({
        id: e.id,
        callsign: e.callsign,
        agentType: e.agentType,
        status: e.status === "active" ? "active" : "inactive",
        tunnelHash: e.tunnelHash,
      }));
    },
    getRosterByCallsign: async (cid, callsign) => {
      const entry = await storage.getRosterByCallsign(cid, callsign);
      if (!entry) return null;
      return {
        id: entry.id,
        callsign: entry.callsign,
        agentType: entry.agentType,
        status: entry.status === "active" ? "active" : "inactive",
        tunnelHash: entry.tunnelHash,
      };
    },
    tunnelServerUrl: process.env.TUNNEL_SERVER_URL,
    // App integrations: get system.app artifacts for MCP derivation
    getApps: async (sid, cid) => {
      // Get apps from this channel and from #root (space-wide apps)
      const channelApps = await storage.listArtifacts(cid, {
        type: "system.app",
      });

      // Get root channel for space-wide apps
      const rootChannel = await storage.getChannelByName(sid, "root");
      const rootApps = rootChannel
        ? await storage.listArtifacts(rootChannel.id, { type: "system.app" })
        : [];

      return [...channelApps, ...rootApps];
    },
    // App secrets accessor for token retrieval
    appSecrets: {
      getAccessToken: async (sid, cid, slug) => {
        return storage.getSecretValue(sid, cid, slug, "accessToken");
      },
      getRefreshToken: async (sid, cid, slug) => {
        return storage.getSecretValue(sid, cid, slug, "refreshToken");
      },
      getMetadata: async (cid, slug, key) => {
        return storage.getSecretMetadata(cid, slug, key);
      },
    },
    // Get agent definition by slug from #root channel
    getAgentDefinition: async (sid, agentSlug) => {
      const rootChannel = await storage.getChannelByName(sid, "root");
      if (!rootChannel) return null;

      const artifact = await storage.getArtifact(rootChannel.id, agentSlug);
      if (!artifact || artifact.type !== "system.agent") return null;

      return {
        slug: artifact.slug,
        title: artifact.title,
        tldr: artifact.tldr,
        content: artifact.content,
        props: artifact.props as
          | { engine?: string; nameTheme?: string; mcp?: Array<{ slug: string }> }
          | undefined,
      };
    },
    // Get focus type by slug from #root channel
    getFocusType: async (sid, focusSlug) => {
      const rootChannel = await storage.getChannelByName(sid, "root");
      if (!rootChannel) return null;

      const artifact = await storage.getArtifact(rootChannel.id, focusSlug);
      if (!artifact || artifact.type !== "system.focus") return null;

      return {
        slug: artifact.slug,
        title: artifact.title,
        tldr: artifact.tldr,
        content: artifact.content,
        props: artifact.props as
          | {
              defaultAgents?: Array<{ slug: string; role?: string }>;
              initialPrompt?: string;
            }
          | undefined,
      };
    },
    // Platform MCP URL for built-in powpow tools
    platformMcpUrl: options.platformMcpUrl ?? apiUrl,
    // Environment resolution: get system.environment artifacts for a channel
    getEnvironmentArtifacts: async (sid, cid) => {
      // First list to get slugs, then fetch full artifacts to get secrets
      const summaries = await storage.listArtifacts(cid, {
        type: "system.environment",
      });
      const results = [];
      for (const summary of summaries) {
        const artifact = await storage.getArtifact(cid, summary.slug);
        if (artifact) {
          results.push({
            slug: artifact.slug,
            channelId: artifact.channelId,
            props: {
              variables:
                ((artifact.props as Record<string, unknown> | undefined)
                  ?.variables as Record<string, string>) ?? {},
            },
            secretKeys: artifact.secrets ? Object.keys(artifact.secrets) : [],
          });
        }
      }
      return results;
    },
    // Get root channel ID for a space
    getRootChannelId: async (sid) => {
      const rootChannel = await storage.getChannelByName(sid, "root");
      return rootChannel?.id ?? null;
    },
    // Get decrypted secret value
    getSecretValue: async (sid, cid, slug, key) => {
      return storage.getSecretValue(sid, cid, slug, key);
    },
    // Get space owner's callsign (human user)
    getSpaceOwnerCallsign: async (sid) => {
      const space = await storage.getSpace(sid);
      if (!space) return null;
      const user = await storage.getUser(space.ownerId);
      return user?.callsign ?? null;
    },
    // Get a single system.mcp artifact by slug from a specific channel
    getSystemMcp: async (cid, slug) => {
      const artifact = await storage.getArtifact(cid, slug);
      if (!artifact || artifact.type !== "system.mcp") {
        return null;
      }
      // Return as ArtifactSummary
      return {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
        path: artifact.path,
        orderKey: artifact.orderKey,
        assignees: artifact.assignees,
        parentSlug: artifact.parentSlug,
        channelId: artifact.channelId,
        props: artifact.props,
      };
    },
    // Get agent definition with channel-then-root resolution
    getAgentDefinitionWithChannel: async (sid, cid, agentSlug) => {
      // First try the channel
      let artifact = await storage.getArtifact(cid, agentSlug);
      let foundChannelId = cid;

      // If not in channel, try root
      if (!artifact || artifact.type !== "system.agent") {
        const rootChannel = await storage.getChannelByName(sid, "root");
        if (rootChannel) {
          artifact = await storage.getArtifact(rootChannel.id, agentSlug);
          foundChannelId = rootChannel.id;
        }
      }

      if (!artifact || artifact.type !== "system.agent") {
        return null;
      }

      return {
        definition: {
          slug: artifact.slug,
          title: artifact.title,
          tldr: artifact.tldr,
          content: artifact.content,
          props: artifact.props as
            | { engine?: string; nameTheme?: string; mcp?: Array<{ slug: string }> }
            | undefined,
        },
        channelId: foundChannelId,
      };
    },
    // Get a valid OAuth access token, auto-refreshing if expired
    getValidOAuthToken: async (sid, cid, mcpSlug) => {
      try {
        // Get stored tokens
        const tokens = await getOAuthTokens(storage, sid, cid, mcpSlug);
        if (!tokens) {
          return null;
        }

        // Get the MCP artifact to find token endpoint for refresh
        const artifact = await storage.getArtifact(cid, mcpSlug);
        if (!artifact) {
          return null;
        }

        const props = artifact.props as {
          url?: string;
          oauth?: {
            type: "oauth";
            tokenEndpoint?: string;
          };
        } | undefined;

        // If no OAuth config, just return the token as-is
        if (!props?.oauth) {
          return tokens.accessToken;
        }

        // Resolve token endpoint from OAuth config or via discovery
        let tokenEndpoint = props.oauth.tokenEndpoint;
        if (!tokenEndpoint && props.url) {
          try {
            const endpoints = await resolveOAuthEndpoints(props.url);
            tokenEndpoint = endpoints.tokenEndpoint;
          } catch {
            // Discovery failed, can't refresh
            console.warn(
              `[OAuth] Failed to discover token endpoint for ${mcpSlug}`,
            );
          }
        }

        // Use getValidAccessToken which handles expiry check and refresh
        const validToken = await getValidAccessToken(
          {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            tokenType: "Bearer",
          },
          tokenEndpoint ?? "",
          tokens.clientId ?? "",
          undefined, // No client secret for public clients
          async (newTokens) => {
            // Save refreshed tokens back to storage
            await saveOAuthTokens(storage, sid, cid, mcpSlug, {
              accessToken: newTokens.accessToken,
              refreshToken: newTokens.refreshToken,
              expiresAt: newTokens.expiresAt,
              clientId: tokens.clientId,
            });
            console.log(`[OAuth] Refreshed tokens for ${mcpSlug}`);
          },
        );

        return validToken;
      } catch (error) {
        console.error(`[OAuth] Failed to get valid token for ${mcpSlug}:`, error);
        return null;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Storage Adapters (factory-based for dynamic spaceId)
  // ---------------------------------------------------------------------------

  const messageStorageFactory = createMessageStorageAdapter(storage);
  const rosterProviderFactory = createRosterProviderAdapter(storage);

  // ---------------------------------------------------------------------------
  // Mount Routes
  // ---------------------------------------------------------------------------

  // Tymbal routes (container → server communication)
  // Note: spaceId is extracted from the container token or threadId, not from user session
  const tymbalRoutes = createTymbalRoutes({
    connectionManager,
    onSetFrame: async (channelId, frame, spaceIdFromContainer) => {
      // Persist SetFrames as messages
      // spaceIdFromContainer is passed from the container auth context
      if (frame.v && typeof frame.v === "object") {
        const value = frame.v as Record<string, unknown>;

        // Handle cost frames separately - persist to costs table, not messages
        if (value.type === "cost") {
          console.log(
            `[Tymbal] Cost frame from ${value.sender}: $${value.totalCostUsd} (${value.numTurns} turns, ${value.durationMs}ms)`,
          );
          if (value.modelUsage) {
            console.log(
              `[Tymbal] Model usage:`,
              JSON.stringify(value.modelUsage),
            );
          }
          // Persist to costs table
          try {
            await storage.saveCostRecord({
              spaceId: spaceIdFromContainer,
              channelId,
              callsign: value.sender as string,
              costUsd: value.totalCostUsd as number,
              durationMs: value.durationMs as number,
              numTurns: value.numTurns as number,
              usage: value.usage as {
                inputTokens: number;
                outputTokens: number;
                cacheReadInputTokens: number;
                cacheCreationInputTokens: number;
              },
              modelUsage: value.modelUsage as
                | Record<
                    string,
                    {
                      inputTokens: number;
                      outputTokens: number;
                      cacheReadInputTokens: number;
                      cacheCreationInputTokens: number;
                      costUsd: number;
                    }
                  >
                | undefined,
            });
            console.log(`[Tymbal] Cost record saved for ${value.sender}`);
          } catch (err) {
            console.error(`[Tymbal] Failed to save cost record:`, err);
          }
          return; // Don't save cost frames as messages
        }

        // For tool_call and tool_result, store the full value object
        // so we can reconstruct all fields (toolCallId, name, args, isError, etc.)
        // when reading back. Storage layer handles JSON serialization.
        const messageType = (value.type as string) ?? "agent";
        let messageContent: string | Record<string, unknown>;
        if (messageType === "tool_call" || messageType === "tool_result") {
          messageContent = value as Record<string, unknown>;
        } else {
          // For other types, use content field or fall back to whole value
          messageContent =
            (value.content as string | Record<string, unknown>) ?? value;
        }

        // Detect method field - defaults to 'agent_output' for frames without explicit method
        // This enables the loop-breaker: send_message routes to agents, agent_output does not
        const method = (value.method as string) ?? "agent_output";

        await storage.saveMessage({
          id: frame.i,
          spaceId: spaceIdFromContainer,
          channelId,
          sender: (value.sender as string) ?? "system",
          senderType: (value.senderType as "user" | "agent") ?? "agent",
          type: messageType as StoredMessageType,
          content: messageContent,
          isComplete: true,
          addressedAgents: value.mentions as string[] | undefined,
          metadata: { fromTymbal: true, method },
        });
      }
    },
    onResetFrame: async (channelId, messageId, spaceIdFromContainer) => {
      await storage.deleteMessage(spaceIdFromContainer, messageId);
    },
  });
  app.route("/tymbal", tymbalRoutes);

  // Legacy /thread/:threadId/tymbal endpoint for compatibility with existing containers
  // threadId format: spaceId:channelId:callsign
  // This endpoint doesn't require container auth (legacy containers don't send it)
  app.post("/thread/:threadId/tymbal", async (c) => {
    const threadId = c.req.param("threadId");
    const parts = threadId.split(":");
    if (parts.length < 2) {
      return c.json(
        {
          error: "invalid_thread_id",
          message: "Thread ID must be spaceId:channelId[:callsign]",
        },
        400,
      );
    }
    const spaceIdFromThread = parts[0];
    const channelId = parts[1];

    const body = await c.req.text();
    if (!body.trim()) {
      return c.json(
        { error: "empty_body", message: "Request body is empty" },
        400,
      );
    }

    const frame = parseFrame(body);
    if (!frame) {
      return c.json(
        { error: "invalid_frame", message: "Could not parse Tymbal frame" },
        400,
      );
    }

    try {
      if (isSetFrame(frame)) {
        const normalizedValue =
          frame.v &&
          typeof frame.v === "object" &&
          (frame.v as Record<string, unknown>).type === "tool_call" &&
          "input" in (frame.v as Record<string, unknown>) &&
          !("args" in (frame.v as Record<string, unknown>))
            ? {
                ...(frame.v as Record<string, unknown>),
                args: (frame.v as Record<string, unknown>).input,
              }
            : frame.v;
        const normalizedFrame =
          normalizedValue !== frame.v
            ? { ...frame, v: normalizedValue }
            : frame;
        const serialized = JSON.stringify(normalizedFrame);
        await connectionManager.broadcast(channelId, serialized);

        // Persist SetFrames as messages (skip cost frames)
        if (normalizedFrame.v && typeof normalizedFrame.v === "object") {
          const value = normalizedFrame.v as Record<string, unknown>;

          // Handle cost frames separately - persist to costs table, not messages
          if (value.type === "cost") {
            console.log(
              `[Tymbal/Legacy] Cost frame from ${value.sender}: $${value.totalCostUsd} (${value.numTurns} turns, ${value.durationMs}ms)`,
            );
            if (value.modelUsage) {
              console.log(
                `[Tymbal/Legacy] Model usage:`,
                JSON.stringify(value.modelUsage),
              );
            }
            // Persist to costs table
            try {
              await storage.saveCostRecord({
                spaceId: spaceIdFromThread,
                channelId,
                callsign: value.sender as string,
                costUsd: value.totalCostUsd as number,
                durationMs: value.durationMs as number,
                numTurns: value.numTurns as number,
                usage: value.usage as {
                  inputTokens: number;
                  outputTokens: number;
                  cacheReadInputTokens: number;
                  cacheCreationInputTokens: number;
                },
                modelUsage: value.modelUsage as
                  | Record<
                      string,
                      {
                        inputTokens: number;
                        outputTokens: number;
                        cacheReadInputTokens: number;
                        cacheCreationInputTokens: number;
                        costUsd: number;
                      }
                    >
                  | undefined,
              });
              console.log(
                `[Tymbal/Legacy] Cost record saved for ${value.sender}`,
              );
            } catch (err) {
              console.error(`[Tymbal/Legacy] Failed to save cost record:`, err);
            }
            return c.json({ ok: true }); // Don't save cost frames as messages
          }

          // For tool_call and tool_result, store the full value object
          // so we can reconstruct all fields (toolCallId, name, args, isError, etc.)
          // when reading back. Storage layer handles JSON serialization.
          const messageType = (value.type as string) ?? "agent";
          let messageContent: string | Record<string, unknown>;
          if (messageType === "tool_call" || messageType === "tool_result") {
            messageContent = value as Record<string, unknown>;
          } else {
            // For other types, use content field or fall back to whole value
            messageContent =
              (value.content as string | Record<string, unknown>) ?? value;
          }

          // Detect method field - defaults to 'agent_output' for frames without explicit method
          const method = (value.method as string) ?? "agent_output";

          await storage.saveMessage({
            id: normalizedFrame.i,
            spaceId: spaceIdFromThread,
            channelId,
            sender: (value.sender as string) ?? "system",
            senderType: (value.senderType as "user" | "agent") ?? "agent",
            type: messageType as StoredMessageType,
            content: messageContent,
            isComplete: true,
            addressedAgents: value.mentions as string[] | undefined,
            metadata: { fromTymbal: true, method },
          });
        }
      } else if (isResetFrame(frame)) {
        await connectionManager.broadcast(channelId, body);
        await storage.deleteMessage(spaceIdFromThread, frame.i);
      } else {
        await connectionManager.broadcast(channelId, body);
      }

      return c.json({ ok: true });
    } catch (error) {
      console.error("[Tymbal/Legacy] Error processing frame:", error);
      return c.json(
        { error: "processing_error", message: "Failed to process frame" },
        500,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Protected Routes (require user authentication)
  // ---------------------------------------------------------------------------

  // Apply auth middleware to all /channels/* routes
  app.use("/channels/*", requireAuth);

  // Channel CRUD routes (gets spaceId from session context)
  const channelRoutes = createChannelRoutes(storage);
  app.route("/channels", channelRoutes);

  // ---------------------------------------------------------------------------
  // Root Channel Reset (for debugging onboarding/curation)
  // ---------------------------------------------------------------------------
  app.use("/initialize-root-channel", requireAuth);
  app.post("/initialize-root-channel", async (c) => {
    const spaceId = getSpaceId(c);
    try {
      const result = await resetRootChannel(storage, spaceId);
      return c.json({
        success: true,
        message: `Reset root channel: deleted ${result.deletedCount} artifacts, created ${result.createdCount} new artifacts`,
        ...result,
      });
    } catch (error) {
      console.error("[ResetRootChannel] Error:", error);
      return c.json(
        {
          error: "Failed to reset root channel",
          message: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  });

  // Roster routes (mounted under /channels/:id/roster)
  const rosterRoutes = createRosterRoutes(storage);
  app.route("/channels", rosterRoutes);

  // Agent routes (POST /channels/:id/agents - Add agent to channel)
  const agentRoutes = createAgentRoutes({
    storage,
    connectionManager,
    agentManager,
  });
  app.route("/channels", agentRoutes);

  // Message routes (user → server → agents)
  // Note: These need dynamic spaceId from session
  app.get("/channels/:channelId/messages", async (c) => {
    const spaceId = getSpaceId(c);
    const channelId = c.req.param("channelId");
    const since = c.req.query("since");
    const before = c.req.query("before");
    const limit = c.req.query("limit");
    const forAgent = c.req.query("forAgent");

    try {
      const messageStorage = messageStorageFactory.forSpace(spaceId);
      const messages = await messageStorage.getMessages(channelId, {
        since,
        before,
        limit: limit ? parseInt(limit, 10) : undefined,
        forAgent,
      });
      return c.json({ messages });
    } catch (error) {
      console.error("[Messages] Error getting messages:", error);
      return c.json({ error: "Failed to get messages" }, 500);
    }
  });

  // Get pending structured asks for a channel
  // Uses the partial index on (channel_id, type, state) for efficient queries
  app.get("/channels/:channelId/pending-asks", async (c) => {
    const spaceId = getSpaceId(c);
    const channelId = c.req.param("channelId");

    try {
      const messages = await storage.getMessages(spaceId, channelId, {
        type: "structured_ask",
        state: "pending",
        limit: 100, // Reasonable limit for pending asks
      });
      return c.json({ messages });
    } catch (error) {
      console.error("[PendingAsks] Error getting pending asks:", error);
      return c.json({ error: "Failed to get pending asks" }, 500);
    }
  });

  app.post("/channels/:channelId/messages", async (c) => {
    const spaceId = getSpaceId(c);
    const channelId = c.req.param("channelId");

    let body: { sender?: string; content?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.sender || !body.content) {
      return c.json({ error: "sender and content are required" }, 400);
    }

    try {
      const messageStorage = messageStorageFactory.forSpace(spaceId);
      const rosterProvider = rosterProviderFactory.forSpace(spaceId);

      // Create message routes handler inline with session-scoped adapters
      const messageRoutes = createMessageRoutes({
        messageStorage,
        rosterProvider,
        connectionManager,
        agentInvoker: {
          invokeAgents: async (
            cid: string,
            targets: string[],
            message: Message,
          ) => {
            // Create invoker on-the-fly with session's spaceId
            const invoker = createAgentInvokerAdapter({
              agentManager,
              storage,
              spaceId,
              connectionManager,
              runtimeSend,
            });
            return invoker.invokeAgents(cid, targets, message);
          },
        },
        onUserMessage: async (cid: string) => {
          // Update channel lastActiveAt when user sends a message
          await storage.updateChannel(spaceId, cid, {
            lastActiveAt: new Date().toISOString(),
          });
        },
        artifactStorage: {
          getArtifact: (channelId: string, slug: string) =>
            storage.getArtifact(channelId, slug),
          setArtifactAttachment: (
            channelId: string,
            slug: string,
            messageId: string,
            updatedBy: string,
          ) =>
            storage.setArtifactAttachment(
              channelId,
              slug,
              messageId,
              updatedBy,
            ),
        },
      });

      // Forward to message routes
      const response = await messageRoutes.request(
        new Request(new URL(`/${channelId}/messages`, c.req.url), {
          method: "POST",
          headers: c.req.raw.headers,
          body: JSON.stringify(body),
        }),
        {},
      );
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      console.error("[Messages] Error sending message:", error);
      return c.json({ error: "Failed to send message" }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // Structured Ask Response Endpoint
  // ---------------------------------------------------------------------------

  /**
   * POST /channels/:channelId/messages/:messageId/respond
   *
   * Submit a response to a structured ask form.
   * - Updates the original message content with response data
   * - Posts a follow-up message with human-readable response
   * - Triggers actions (e.g., summon agents for summon_request fields)
   */
  app.post("/channels/:channelId/messages/:messageId/respond", async (c) => {
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const spaceId = getSpaceId(c);

    let body: {
      response: Record<string, unknown>;
      respondedBy: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { response, respondedBy } = body;

    if (!response || typeof response !== "object") {
      return c.json({ error: "response is required and must be an object" }, 400);
    }

    if (!respondedBy || typeof respondedBy !== "string") {
      return c.json({ error: "respondedBy is required and must be a string" }, 400);
    }

    try {
      // Get the original message
      const originalMessage = await storage.getMessage(spaceId, messageId);
      if (!originalMessage) {
        return c.json({ error: "Message not found" }, 404);
      }

      if (originalMessage.type !== "structured_ask") {
        return c.json({ error: "Message is not a structured_ask" }, 400);
      }

      // Parse the original content
      const originalContent = originalMessage.content as Record<string, unknown>;
      if (originalContent.formState === "submitted") {
        return c.json({ error: "Form has already been submitted" }, 400);
      }

      const now = new Date().toISOString();

      // Build human-readable response message
      const fields = originalContent.fields as Array<{
        name: string;
        label: string;
        type: string;
        agents?: Array<{ callsign: string; definitionSlug: string; purpose: string }>;
        // For secret fields
        targetChannel?: string;
        targetSlug?: string;
        targetKey?: string;
      }>;

      // Process secret fields first - store them and replace values with placeholder
      const secretsSet: Array<{ targetChannel: string; targetSlug: string; targetKey: string }> = [];
      const sanitizedResponse = { ...response };

      for (const field of fields) {
        if (field.type === "secret" && field.targetChannel && field.targetSlug && field.targetKey) {
          const secretValue = response[field.name];
          if (typeof secretValue === "string" && secretValue) {
            // Resolve the target channel
            const targetChannel = await storage.resolveChannel(spaceId, field.targetChannel);
            if (!targetChannel) {
              console.error(`[StructuredAsk] Secret target channel not found: ${field.targetChannel}`);
              continue;
            }

            // Store the secret
            try {
              await storage.setSecret(spaceId, targetChannel.id, field.targetSlug, field.targetKey, {
                value: secretValue,
              });
              secretsSet.push({
                targetChannel: field.targetChannel,
                targetSlug: field.targetSlug,
                targetKey: field.targetKey,
              });
              console.log(`[StructuredAsk] Secret set: ${field.targetKey} on ${field.targetSlug} in ${field.targetChannel}`);
            } catch (secretError) {
              console.error(`[StructuredAsk] Failed to set secret ${field.targetKey}:`, secretError);
            }
          }
          // Replace the secret value with placeholder in the stored response
          sanitizedResponse[field.name] = "<secret encrypted>";
        }
      }

      // Update the stored response to use sanitized values (secrets replaced with placeholder)
      const updatedContentWithSanitizedResponse = {
        ...originalContent,
        formState: "submitted",
        response: sanitizedResponse,
        respondedBy,
        respondedAt: now,
      };

      await storage.updateMessage(spaceId, messageId, {
        content: updatedContentWithSanitizedResponse,
        state: "completed",
      });

      // Broadcast the update via Tymbal (with sanitized response)
      if (connectionManager) {
        const frame = tymbal.set(messageId, {
          type: "structured_ask",
          sender: originalMessage.sender,
          senderType: originalMessage.senderType,
          content: updatedContentWithSanitizedResponse,
          timestamp: originalMessage.timestamp,
          state: "completed",
        });
        await connectionManager.broadcast(channelId, frame);
      }

      const responseLines: string[] = [];
      for (const field of fields) {
        const value = response[field.name];
        if (field.type === "secret") {
          // For secrets, show that it was set with target info
          if (typeof value === "string" && value) {
            responseLines.push(
              `- **${field.label}:** ${field.targetKey} was set on ${field.targetSlug} in #${field.targetChannel}`
            );
          } else {
            responseLines.push(`- **${field.label}:** *(not provided)*`);
          }
        } else if (field.type === "summon_request") {
          // For summon_request, list approved agents
          // Value is array of {callsign, runtimeId} objects or plain strings (backwards compat)
          const approvedCallsigns = new Set<string>();
          if (Array.isArray(value)) {
            for (const item of value) {
              if (typeof item === "object" && item !== null && "callsign" in item) {
                approvedCallsigns.add((item as { callsign: string }).callsign);
              } else if (typeof item === "string") {
                approvedCallsigns.add(item);
              }
            }
          }
          const approvedAgents = field.agents?.filter((a) =>
            approvedCallsigns.has(a.callsign)
          ) || [];
          if (approvedAgents.length > 0) {
            responseLines.push(
              `- **${field.label}:** ${approvedAgents.map((a) => `@${a.callsign}`).join(", ")}`
            );
          } else {
            responseLines.push(`- **${field.label}:** *(none selected)*`);
          }
        } else if (Array.isArray(value)) {
          responseLines.push(`- **${field.label}:** ${value.join(", ") || "*(none)*"}`);
        } else if (typeof value === "string" && value) {
          responseLines.push(`- **${field.label}:** ${value}`);
        } else {
          responseLines.push(`- **${field.label}:** *(empty)*`);
        }
      }

      // Post follow-up message from user to the agent who created the ask
      const followUpMessageId = generateMessageId();
      const agentSender = originalMessage.sender;

      const responseMessageContent = responseLines.length > 0
        ? `@${agentSender}: @${respondedBy} submitted their response:\n\n${responseLines.join("\n")}`
        : `@${agentSender}: @${respondedBy} submitted an empty response.`;

      await storage.saveMessage({
        id: followUpMessageId,
        spaceId,
        channelId,
        sender: respondedBy,
        senderType: "user",
        type: "user",
        content: responseMessageContent,
        isComplete: true,
        addressedAgents: [agentSender],
      });

      // Broadcast the follow-up message
      if (connectionManager) {
        const followUpFrame = tymbal.set(followUpMessageId, {
          type: "user",
          sender: respondedBy,
          senderType: "user",
          content: responseMessageContent,
          timestamp: now,
          mentions: [agentSender],
        });
        await connectionManager.broadcast(channelId, followUpFrame);
      }

      // Invoke the agent who created the ask so they see the response
      const invoker = createAgentInvokerAdapter({
        agentManager,
        storage,
        spaceId,
        connectionManager,
        runtimeSend,
      });
      const followUpMessage: Message = {
        id: followUpMessageId,
        channelId,
        sender: respondedBy,
        senderType: "user",
        type: "user",
        content: `@${agentSender} ${responseMessageContent}`,
        timestamp: now,
        isComplete: true,
        addressedAgents: [agentSender],
      };
      await invoker.invokeAgents(channelId, [agentSender], followUpMessage);

      // Handle summon_request actions - add approved agents to roster
      // Response format: {callsign: string, runtimeId: string | null}[]
      // Agents will activate on first @mention
      const summonedAgents: string[] = [];
      console.log(`[StructuredAsk] Processing ${fields.length} fields for summon actions`);
      for (const field of fields) {
        console.log(`[StructuredAsk] Field: ${field.name}, type: ${field.type}, has agents: ${!!field.agents}`);
        if (field.type === "summon_request" && field.agents) {
          const approvedAgents = response[field.name];
          console.log(`[StructuredAsk] Approved agents for ${field.name}:`, JSON.stringify(approvedAgents));
          if (!Array.isArray(approvedAgents)) continue;

          // Build a map of callsign -> runtimeId from the response
          const runtimeMap = new Map<string, string | null>();
          for (const item of approvedAgents) {
            if (typeof item === "object" && item !== null && "callsign" in item) {
              runtimeMap.set(
                item.callsign as string,
                (item as { callsign: string; runtimeId?: string | null }).runtimeId ?? null
              );
            } else if (typeof item === "string") {
              // Backwards compat: plain string array
              runtimeMap.set(item, null);
            }
          }

          for (const agent of field.agents) {
            if (!runtimeMap.has(agent.callsign)) continue;
            const selectedRuntimeId = runtimeMap.get(agent.callsign) ?? null;

            try {
              // Check if agent already exists in roster
              const existingEntry = await storage.getRosterByCallsign(
                channelId,
                agent.callsign
              );
              if (existingEntry) {
                console.log(
                  `[StructuredAsk] Agent ${agent.callsign} already in roster, skipping`
                );
                continue;
              }

              console.log(
                `[StructuredAsk] Adding ${agent.callsign} (${agent.definitionSlug}) to roster on runtime ${selectedRuntimeId || "default"}`
              );

              // Add to roster - agent will activate on first @mention
              await storage.addToRoster({
                channelId,
                callsign: agent.callsign,
                agentType: agent.definitionSlug,
                status: "active",
                runtimeId: selectedRuntimeId,
              });

              // Broadcast roster event so UI updates
              const fullEntry = await storage.getRosterByCallsign(
                channelId,
                agent.callsign
              );
              if (fullEntry && connectionManager) {
                const rosterFrame = {
                  i: generateMessageId(),
                  t: now,
                  v: {
                    type: "roster",
                    action: "agent_joined",
                    agent: {
                      callsign: fullEntry.callsign,
                      agentType: fullEntry.agentType,
                      status: fullEntry.status,
                      runtimeId: fullEntry.runtimeId,
                      runtimeName: fullEntry.runtimeName,
                      runtimeStatus: fullEntry.runtimeStatus,
                    },
                  },
                  c: channelId,
                };
                await connectionManager.broadcast(
                  channelId,
                  JSON.stringify(rosterFrame)
                );
              }

              summonedAgents.push(agent.callsign);
            } catch (summonError) {
              console.error(
                `[StructuredAsk] Failed to add ${agent.callsign} to roster:`,
                summonError
              );
            }
          }
        }
      }

      return c.json({
        ok: true,
        messageId,
        followUpMessageId,
        formState: "submitted",
        summonedAgents,
        secretsSet,
      });
    } catch (error) {
      console.error("[StructuredAsk] Error submitting response:", error);
      return c.json({ error: "Failed to submit response" }, 500);
    }
  });

  /**
   * POST /channels/:channelId/messages/:messageId/dismiss
   *
   * Dismiss/cancel a structured ask form.
   * - Updates the message state to 'dismissed'
   * - Posts a follow-up message notifying the agent
   */
  app.post("/channels/:channelId/messages/:messageId/dismiss", async (c) => {
    const channelId = c.req.param("channelId");
    const messageId = c.req.param("messageId");
    const spaceId = getSpaceId(c);

    let body: { dismissedBy: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { dismissedBy } = body;

    if (!dismissedBy || typeof dismissedBy !== "string") {
      return c.json({ error: "dismissedBy is required and must be a string" }, 400);
    }

    try {
      // Get the original message
      const originalMessage = await storage.getMessage(spaceId, messageId);
      if (!originalMessage) {
        return c.json({ error: "Message not found" }, 404);
      }

      if (originalMessage.type !== "structured_ask") {
        return c.json({ error: "Message is not a structured_ask" }, 400);
      }

      // Parse the original content
      const originalContent = originalMessage.content as Record<string, unknown>;
      if (originalContent.formState === "submitted") {
        return c.json({ error: "Form has already been submitted" }, 400);
      }
      if (originalContent.formState === "dismissed") {
        return c.json({ error: "Form has already been dismissed" }, 400);
      }

      const now = new Date().toISOString();

      // Update the message content
      const updatedContent = {
        ...originalContent,
        formState: "dismissed",
        dismissedBy,
        dismissedAt: now,
      };

      await storage.updateMessage(spaceId, messageId, {
        content: updatedContent,
        state: "dismissed",
      });

      // Broadcast the update via Tymbal
      if (connectionManager) {
        const frame = tymbal.set(messageId, {
          type: "structured_ask",
          sender: originalMessage.sender,
          senderType: originalMessage.senderType,
          content: updatedContent,
          timestamp: originalMessage.timestamp,
          state: "dismissed",
        });
        await connectionManager.broadcast(channelId, frame);
      }

      // Get the cancel label and prompt from the form
      const cancelLabel = (originalContent.cancelLabel as string) || "Cancel";
      const prompt = (originalContent.prompt as string) || "your form";

      // Post follow-up message to notify the agent
      const agentSender = originalMessage.sender;
      const followUpMessageId = generateMessageId();
      const followUpContent = `@${agentSender}: @${dismissedBy} clicked "${cancelLabel}" on your form "${prompt}".`;

      await storage.saveMessage({
        id: followUpMessageId,
        spaceId,
        channelId,
        sender: dismissedBy,
        senderType: "user",
        type: "user",
        content: followUpContent,
      });

      // Broadcast the follow-up message
      if (connectionManager) {
        const msgFrame = tymbal.set(followUpMessageId, {
          type: "user",
          sender: dismissedBy,
          senderType: "user",
          content: followUpContent,
          timestamp: now,
        });
        await connectionManager.broadcast(channelId, msgFrame);
      }

      // Invoke the agent so they see the dismissal
      const invoker = createAgentInvokerAdapter({
        agentManager,
        storage,
        spaceId,
        connectionManager,
        runtimeSend,
      });
      const followUpMessage: Message = {
        id: followUpMessageId,
        channelId,
        sender: dismissedBy,
        senderType: "user",
        type: "user",
        content: `@${agentSender}: @${dismissedBy} clicked "${cancelLabel}" on your form.`,
        timestamp: now,
        isComplete: true,
        addressedAgents: [agentSender],
      };
      await invoker.invokeAgents(channelId, [agentSender], followUpMessage);

      return c.json({
        ok: true,
        messageId,
        followUpMessageId,
        formState: "dismissed",
      });
    } catch (error) {
      console.error("[StructuredAsk] Error dismissing form:", error);
      return c.json({ error: "Failed to dismiss form" }, 500);
    }
  });

  // Cost tally endpoint - get aggregated costs per agent for a channel
  app.get("/channels/:channelId/costs", async (c) => {
    const channelId = c.req.param("channelId");

    try {
      const tally = await storage.getChannelCostTally(channelId);
      return c.json({ tally });
    } catch (error) {
      console.error("[Costs] Error getting cost tally:", error);
      return c.json({ error: "Failed to get cost tally" }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // Container Routes (authenticated via container token, not user session)
  // ---------------------------------------------------------------------------

  // Agent checkin routes (container → server registration)
  // spaceId comes from body or is extracted from threadId
  const checkinRoutes = createCheckinRoutes({
    storage,
    // No default spaceId - extracted from body
    spaceId: "", // Placeholder - checkin extracts from body.spaceId
    runtime,
    connectionManager,
    // Pass the centralized prompt builder from AgentManager
    buildSystemPrompt: (sid, cid, callsign) =>
      agentManager.buildPromptForAgent(sid, cid, callsign),
  });
  app.route("/agents", checkinRoutes);

  // Asset storage for binary files (uses factory to select backend based on env)
  const assetStorage = options.assetStorage;

  // ---------------------------------------------------------------------------
  // /boards/:channel/:slug - PowPow-compatible artifact content serving
  // Serves artifact content with appropriate Content-Type headers.
  // For file-encoded artifacts (binary assets), serves via assetStorage.
  // For text artifacts, serves content directly.
  // Note: This endpoint requires auth - spaceId from session
  // ---------------------------------------------------------------------------
  app.get("/boards/:channel/:slug", requireAuth, async (c) => {
    const spaceId = getSpaceId(c);
    const channelParam = c.req.param("channel");
    const slug = c.req.param("slug");

    try {
      // Resolve channel by name or ID (single query)
      const channel = await storage.resolveChannel(spaceId, channelParam);

      if (!channel) {
        return c.json({ error: "Channel not found" }, 404);
      }

      // Get artifact by slug
      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      // For asset artifacts, serve binary file via assetStorage
      if (artifact.type === "asset") {
        const data = await assetStorage.readAsset(channel.id, slug);
        const mimeType = artifact.contentType || getMimeType(slug);

        return new Response(data, {
          status: 200,
          headers: {
            "Content-Type": mimeType,
            "Content-Length": data.length.toString(),
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }

      // For text artifacts, serve content directly with appropriate Content-Type
      const content = artifact.content || "";
      const mimeType = getMimeType(slug);

      c.header("Content-Type", mimeType);
      c.header("Content-Length", Buffer.byteLength(content).toString());
      c.header("Cache-Control", "public, max-age=3600");
      return c.body(content);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return c.json({ error: error.message }, 404);
      }
      console.error("[Boards] Error serving artifact content:", error);
      return c.json({ error: "Failed to serve artifact content" }, 500);
    }
  });

  // MCP HTTP routes (container → server board operations)
  // spaceId extracted from container auth
  const mcpRoutes = createMcpRoutes({
    storage,
    connectionManager,
    // AgentInvoker for send_message tool - creates invoker with spaceId from container auth context
    agentInvoker: {
      invokeAgents: async (
        channelId: string,
        targets: string[],
        message: Message,
      ) => {
        // Get spaceId from the channel (message.channelId is guaranteed to match)
        // Note: For MCP calls, spaceId is in the ToolContext, but agentInvoker is called
        // from within the handler which has access to ctx.spaceId
        // We need to look up the channel to get spaceId
        const channel = await storage.getChannelById(channelId);
        if (!channel) {
          console.warn(
            `[MCP] Channel ${channelId} not found for agent invocation`,
          );
          return;
        }
        const invoker = createAgentInvokerAdapter({
          agentManager,
          storage,
          spaceId: channel.spaceId,
          connectionManager,
          runtimeSend,
        });
        return invoker.invokeAgents(channelId, targets, message);
      },
    },
  });
  app.route("/mcp", mcpRoutes);

  // Assets API routes (container auth for agents)
  // Used by @miriad-systems/assets-mcp for agent file upload/download
  const assetsApiRoutes = createAssetsApiRoutes({
    storage,
    assetStorage,
    connectionManager,
  });
  app.route("/api/assets", assetsApiRoutes);

  // Artifact routes (REST API for frontend)
  // spaceId extracted from session context (auth middleware already applied to /channels/*)
  const artifactRoutes = createArtifactRoutes({
    storage,
    connectionManager,
    assetStorage,
  });
  app.route("/channels", artifactRoutes);

  return app;
}

/**
 * Get the AgentManager for shutdown handling.
 * Call this before server shutdown to stop all containers.
 */
export function getAgentManager(app: Hono): AgentManager | undefined {
  // Note: We'd need to store this in app context for retrieval
  // For now, the factory caller should retain their own reference
  return undefined;
}

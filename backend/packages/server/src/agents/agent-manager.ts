/**
 * Agent Manager
 *
 * Manages agent lifecycle, @mention routing, and container spawning.
 * Coordinates between storage, container orchestrator, and WebSocket broadcast.
 */

import type {
  AgentRuntime,
  ActivateOptions,
  AgentRuntimeState,
  McpServerConfig,
} from "@cast/runtime";
import type { ArtifactSummary } from "@cast/core";
import { generateContainerToken } from "../auth/index.js";
import { getAppDefinition, type TokenSet } from "../apps/index.js";

// =============================================================================
// Types
// =============================================================================

export type AgentState = "starting" | "idle" | "thinking" | "stopped" | "error";

export interface ManagedAgent {
  /** Agent callsign */
  callsign: string;
  /** Channel ID */
  channelId: string;
  /** Space ID */
  spaceId: string;
  /** Current lifecycle state */
  state: AgentState;
  /** Runtime state (if running) */
  runtimeState?: AgentRuntimeState;
}

export interface ChannelContext {
  id: string;
  name: string;
  tagline?: string;
  mission?: string;
  /** Focus type slug for loading system.focus artifact */
  focusSlug?: string;
}

export interface RosterEntry {
  id: string;
  callsign: string;
  agentType: string;
  status: "active" | "inactive";
  tunnelHash?: string;
}

export interface AppSecrets {
  /** Get decrypted access token */
  getAccessToken: (
    spaceId: string,
    channelId: string,
    slug: string,
  ) => Promise<string | null>;
  /** Get decrypted refresh token */
  getRefreshToken: (
    spaceId: string,
    channelId: string,
    slug: string,
  ) => Promise<string | null>;
  /** Get secret metadata */
  getMetadata: (
    channelId: string,
    slug: string,
    key: string,
  ) => Promise<{ expiresAt?: string } | null>;
}

/**
 * Environment artifact data for resolveEnvironment().
 */
export interface EnvironmentArtifact {
  slug: string;
  channelId: string;
  props: {
    variables: Record<string, string>;
  };
  /** Secret keys (values retrieved separately via getSecretValue) */
  secretKeys: string[];
}

/**
 * MCP reference in agent definition props.
 */
export interface McpReference {
  slug: string;
}

/**
 * Agent definition artifact (system.agent from #root or channel)
 */
export interface AgentDefinition {
  slug: string;
  title?: string;
  tldr?: string;
  content: string;
  props?: {
    engine?: string;
    nameTheme?: string;
    mcp?: McpReference[];
  };
}

/**
 * Focus type artifact (system.focus from #root)
 */
export interface FocusType {
  slug: string;
  title?: string;
  tldr?: string;
  content: string;
  props?: {
    defaultAgents?: Array<{ slug: string; role?: string }>;
    initialPrompt?: string;
  };
}

export interface AgentManagerConfig {
  /** Agent runtime (Docker for local, Fly.io for prod) */
  runtime: AgentRuntime;
  /** Broadcast function for WebSocket frames */
  broadcast: (channelId: string, frame: string) => Promise<void>;
  /** Get channel context for system prompt */
  getChannel: (
    spaceId: string,
    channelId: string,
  ) => Promise<ChannelContext | null>;
  /** Get roster for channel */
  getRoster: (spaceId: string, channelId: string) => Promise<RosterEntry[]>;
  /** Get a specific roster entry by callsign */
  getRosterByCallsign?: (
    channelId: string,
    callsign: string,
  ) => Promise<RosterEntry | null>;
  /** Get system.app artifacts for a channel (includes root) */
  getApps?: (spaceId: string, channelId: string) => Promise<ArtifactSummary[]>;
  /** App secrets accessor */
  appSecrets?: AppSecrets;
  /** Tunnel server URL for HTTP tunnel access (e.g., "https://tunnel.clanker.is") */
  tunnelServerUrl?: string;
  /** Get agent definition by slug from #root */
  getAgentDefinition?: (
    spaceId: string,
    agentSlug: string,
  ) => Promise<AgentDefinition | null>;
  /** Get focus type by slug from #root */
  getFocusType?: (
    spaceId: string,
    focusSlug: string,
  ) => Promise<FocusType | null>;
  /** Platform MCP URL for built-in powpow tools (e.g., "http://localhost:8080" or "https://api.cast.dev") */
  platformMcpUrl?: string;
  /** Get system.environment artifacts for a channel */
  getEnvironmentArtifacts?: (
    spaceId: string,
    channelId: string,
  ) => Promise<EnvironmentArtifact[]>;
  /** Get root channel ID for a space */
  getRootChannelId?: (spaceId: string) => Promise<string | null>;
  /** Get decrypted secret value */
  getSecretValue?: (
    spaceId: string,
    channelId: string,
    slug: string,
    key: string,
  ) => Promise<string | null>;
  /** Get space owner's callsign */
  getSpaceOwnerCallsign?: (spaceId: string) => Promise<string | null>;
  /**
   * Get a system.mcp artifact by slug from a specific channel.
   * Does NOT fall through to root - caller handles resolution order.
   */
  getSystemMcp?: (
    channelId: string,
    slug: string,
  ) => Promise<ArtifactSummary | null>;
  /**
   * Get a valid OAuth access token for an MCP artifact, auto-refreshing if needed.
   * Returns null if no tokens are stored or refresh fails.
   */
  getValidOAuthToken?: (
    spaceId: string,
    channelId: string,
    mcpSlug: string,
  ) => Promise<string | null>;
  /**
   * Get agent definition with channel-then-root resolution.
   * Returns the definition and the channelId it was found in.
   */
  getAgentDefinitionWithChannel?: (
    spaceId: string,
    channelId: string,
    agentSlug: string,
  ) => Promise<{ definition: AgentDefinition; channelId: string } | null>;
}

// =============================================================================
// System Prompt Builder
// =============================================================================

/**
 * Full context for building a system prompt.
 */
export interface PromptContext {
  channel: ChannelContext;
  roster: RosterEntry[];
  callsign: string;
  agentDefinition?: AgentDefinition;
  focusType?: FocusType;
  /** Human user's callsign (space owner) */
  userCallsign?: string;
}

/**
 * Build a system prompt for an agent with full channel and role context.
 *
 * Assembly order (per spec):
 * 1. Channel Context (name, tagline, mission)
 * 2. Focus Type Instructions (if channel has focus)
 * 3. Your Role (agent definition content)
 * 4. Team Roster
 * 5. Channel Participation Instructions
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const { channel, roster, callsign, agentDefinition, focusType } = ctx;
  const sections: string[] = [];

  // 1. Channel Context
  sections.push(`## Channel Context

**Channel:** #${channel.name}
**Tagline:** ${channel.tagline ?? "Open workspace"}
**Mission:** ${channel.mission ?? "A flexible space for freeform collaboration and exploration."}`);

  // 2. Focus Type Instructions (if channel has focus)
  if (focusType) {
    sections.push(`---

### Special Instructions
${focusType.content}`);
  }

  // 3. Your Role (from agent definition)
  if (agentDefinition) {
    sections.push(`## Your Role: ${agentDefinition.title ?? agentDefinition.slug}

${agentDefinition.content}`);
  } else {
    // Fallback if no agent definition found
    sections.push(`## Your Role

You are "${callsign}", an AI agent participating in #${channel.name}.`);
  }

  // 4. Team Roster (with titles from agent definitions if available)
  // Include the human user first, then agents
  const { userCallsign } = ctx;
  const rosterLines: string[] = [];

  // Add human user first
  if (userCallsign) {
    rosterLines.push(`- @${userCallsign} (user)`);
  }

  // Add agents
  for (const r of roster) {
    rosterLines.push(`- @${r.callsign} (${r.agentType})`);
  }

  if (rosterLines.length > 0) {
    sections.push(`---

## Team Roster

Your teammates in this channel:
${rosterLines.join("\n")}`);
  }

  // 5. Channel Participation Instructions (CAST-adapted per @ax feedback)
  sections.push(`---

## Channel Participation

You are "${callsign}", an AI agent in #${channel.name}.

## Communicating with Teammates

CRITICAL: To talk to other agents, you MUST use the \`send_message\` tool.
Plain text responses are NOT delivered to agents—human might see them in some modes

Example:
✗ Writing "@fox can you help?" in your response → fox will NOT see this
✓ Calling send_message with content "@fox can you help?" → fox receives it and will respond

• @callsign in send_message → notifies that agent
• @channel in send_message → broadcasts to all agents (use sparingly, leads to a lot of chatter)

Use \`set_status\` frequently to show what you're working on.

Keep comms effective and brief. A little personality is welcome—we're collaborating, not filing reports—but remember that verbose messages break focus and consume context windows.

## Collaboration Board

The channel has a shared **Board** for persistent work products—things that outlive chat messages. Use artifact tools to create specs, track tasks, log decisions, and share code.

### Artifact Types
- **doc** — Specs, plans, notes, documentation (default)
- **task** — Work items with status tracking (pending → in_progress → done/blocked)
- **code** — Code snippets, file references (syntax highlighted)
- **asset** – Images, documents, data files. read_instructions on \`binary-assets\`

### Structure
Artifacts form a **tree** like a file system. Each has a slug and optional \`parentSlug\`, creating paths like \`/auth-system/api-spec\`. **Use the tree structure to organize work—don't dump everything into content.**

Example task breakdown (as shown by \`artifact_glob\`):
\`\`\`
/planning
/phase-1 :task (done)
  /setup-repo :task (done) @fox
  /setup-ci :task (done) @bear
/phase-2 :task (in_progress)
  /implement-api :task (done) @fox
  /implement-auth :task (in_progress) @bear
/phase-3 :task (pending)
  /write-tests :task (pending)
  /write-docs :task (pending)
\`\`\`

Each task is a separate artifact with its own status. The \`tldr\` field is the task description—keep \`content\` for details, notes, or empty. Use \`artifact_glob\` to see the tree, \`artifact_list\` to query with filters.

### Task Coordination
For tasks, use the \`artifact_update\` tool with compare-and-swap to **claim work atomically**:

\`\`\`
artifact_update({
  slug: "implement-login",
  changes: [
    { field: "status", old_value: "pending", new_value: "in_progress" },
    { field: "assignees", old_value: [], new_value: ["${callsign}"] }
  ]
})
\`\`\`

This prevents race conditions—if another agent claimed it first, your update fails and you can pick a different task. Always check the current state before claiming.

### Playbooks

The board may contain **playbook** artifacts (type: \`system.playbook\`) with workflows and guidelines relevant to your work. When you join a channel:
1. Use \`artifact_list\` with \`type: "system.playbook"\` to find playbooks—this returns summaries (slug, tldr) without full content
2. Review the \`tldr\` field to understand what each playbook covers
3. Use \`artifact_read\` to read the full content when a playbook becomes relevant to your current task

Playbooks contain valuable context and procedures—consult them before diving into work.

### Quick Reference
- \`artifact_create\` - Create new artifact (fails if exists, use \`replace: true\` to overwrite)
- \`artifact_read\` - Get full content and version history
- \`artifact_edit\` - Surgical find-replace on content
- \`artifact_update\` - Atomic field updates (status, assignees, labels)
- \`artifact_checkpoint\` - Snapshot a named version for review
- \`artifact_list\` / \`artifact_glob\` - Browse and search

### Extended Capabilities

Use \`read_instructions\` to learn about additional platform features:

- **Sharing files** — Share images, diagrams, or documents with teammates via the board → \`binary-assets\`
- **Attachments** - Attached files appear as <attachments>[[slug]]</attachments> in messages. Access using download_asset. Attach files using upload with upload_asset (set attachToLatestMessage: true)  → \`attachments\`
- **Interactive mini-apps** — Build visualizations, prototypes, or tools as runnable \`.app.js\` artifacts → \`interactive-artifacts\`
- **Knowledge bases** — Create or query shared repositories of documentation → \`knowledge-bases\`
- **MCP servers** — Configure external integrations when setting up agent definitions → \`system-mcp\`
- **Structured questions** — Use \`structured_ask\` for critical questions, project surveys, and secret collection. Forms persist until answered and surface in a "pending asks" indicator. Great for gathering requirements and highlighting critical asks → \`structured-asks\`
- **Team assembly** — Use \`structured_ask\` with \`summon_request\` to propose agents to add. You suggest the team composition, the user can modify before confirming → \`structured-asks\`

### Code Execution Environment

You may be running on a user's local machine (be careful!) or in a shared container with other agents. If you have the \`miriad-tunnel\` tool, you're in a containerized environment—read \`coding-in-the-shared-container\` for workspace isolation rules, port etiquette, and tunneling.

# Wow the user!

This is a new kind of system. Don't over-do it, but you can inspire discovery by:

- Suggesting to work in teams if the user keeps working 1:1 like traditional AI agents.
- Using interactive artifacts to illustrate, explain or demonstrate designs or principles. Visual, interactive explainers are super nice for peoople.
- Pointing out the existence of knowledge bases. Super useful way to research a topic once then share across all you agents.
- Reminding that the root channel is where all agent definitions, mcp configurations and playbook templates are, and that the user can go there and iterate in collaboration with agents.
- Attaching images to messages and actively using the board for collaboration, also with the user.
`);

  return sections.join("\n\n");
}

// =============================================================================
// Agent Manager
// =============================================================================

export class AgentManager {
  private config: AgentManagerConfig;
  // NOTE: In-memory Map removed - Lambda doesn't preserve state between invocations.
  // Roster table (callbackUrl) is now the source of truth for running containers.
  // See invoker-adapter.ts for the routing logic.

  constructor(config: AgentManagerConfig) {
    this.config = config;
    console.log("[AgentManager] Initialized");
  }

  /**
   * Build an agent ID from space, channel, and callsign.
   */
  private buildAgentId(
    spaceId: string,
    channelId: string,
    callsign: string,
  ): string {
    return `${spaceId}:${channelId}:${callsign}`;
  }

  /**
   * Build a full system prompt for an agent.
   * This is the centralized method for building prompts with full context.
   * Used by both spawn() and exposed for local agent routing.
   */
  async buildPromptForAgent(
    spaceId: string,
    channelId: string,
    callsign: string,
  ): Promise<string> {
    // Get channel context and roster
    const channel = await this.config.getChannel(spaceId, channelId);
    if (!channel) {
      console.warn(`[AgentManager] Channel not found for prompt: ${channelId}`);
      return `You are "${callsign}", an AI agent.`;
    }

    const roster = await this.config.getRoster(spaceId, channelId);

    // Find this agent's roster entry to get agentType (definition slug)
    const rosterEntry = roster.find((r) => r.callsign === callsign);
    const agentType = rosterEntry?.agentType;

    // Fetch agent definition from #root (if config method provided)
    let agentDefinition: AgentDefinition | undefined;
    if (agentType && this.config.getAgentDefinition) {
      try {
        agentDefinition =
          (await this.config.getAgentDefinition(spaceId, agentType)) ??
          undefined;
        if (agentDefinition) {
          console.log(`[AgentManager] Loaded agent definition: ${agentType}`);
        }
      } catch (err) {
        console.error(`[AgentManager] Error loading agent definition:`, err);
      }
    }

    // Fetch focus type from #root (if channel has focusSlug and config method provided)
    let focusType: FocusType | undefined;
    if (channel.focusSlug && this.config.getFocusType) {
      try {
        focusType =
          (await this.config.getFocusType(spaceId, channel.focusSlug)) ??
          undefined;
        if (focusType) {
          console.log(`[AgentManager] Loaded focus type: ${channel.focusSlug}`);
        }
      } catch (err) {
        console.error(`[AgentManager] Error loading focus type:`, err);
      }
    }

    // Fetch space owner's callsign (human user)
    let userCallsign: string | undefined;
    if (this.config.getSpaceOwnerCallsign) {
      try {
        userCallsign =
          (await this.config.getSpaceOwnerCallsign(spaceId)) ?? undefined;
      } catch (err) {
        console.error(`[AgentManager] Error loading space owner:`, err);
      }
    }

    // Build and return the full system prompt
    return buildSystemPrompt({
      channel,
      roster,
      callsign,
      agentDefinition,
      focusType,
      userCallsign,
    });
  }

  /**
   * Derive MCP configs from connected system.app artifacts.
   * For each connected app, generates MCP config using the app registry.
   */
  private async deriveMcpConfigsFromApps(
    spaceId: string,
    channelId: string,
  ): Promise<McpServerConfig[]> {
    const { getApps, appSecrets } = this.config;

    // Skip if app derivation not configured
    if (!getApps || !appSecrets) {
      return [];
    }

    const mcpConfigs: McpServerConfig[] = [];

    try {
      // Get all system.app artifacts for this channel (includes root)
      const apps = await getApps(spaceId, channelId);

      for (const app of apps) {
        // Get provider from props
        const provider = (app.props as Record<string, unknown> | undefined)
          ?.provider as string | undefined;
        if (!provider) {
          console.log(
            `[AgentManager] Skipping app ${app.slug}: no provider in props`,
          );
          continue;
        }

        // Get app definition from registry
        const appDef = getAppDefinition(provider);
        if (!appDef) {
          console.log(
            `[AgentManager] Skipping app ${app.slug}: unknown provider ${provider}`,
          );
          continue;
        }

        // Check if connected (has accessToken secret)
        const accessTokenMeta = await appSecrets.getMetadata(
          app.channelId,
          app.slug,
          "accessToken",
        );
        if (!accessTokenMeta) {
          console.log(`[AgentManager] Skipping app ${app.slug}: not connected`);
          continue;
        }

        // Check if token expired (with 1 minute buffer)
        const bufferMs = 60 * 1000;
        const isExpired =
          accessTokenMeta.expiresAt &&
          new Date(accessTokenMeta.expiresAt).getTime() < Date.now() + bufferMs;

        if (isExpired) {
          console.log(`[AgentManager] Skipping app ${app.slug}: token expired`);
          // Note: In a more robust implementation, we would try to refresh here
          // For now, the user needs to reconnect or call /refresh manually
          continue;
        }

        // Get the access token
        const accessToken = await appSecrets.getAccessToken(
          spaceId,
          app.channelId,
          app.slug,
        );
        if (!accessToken) {
          console.log(
            `[AgentManager] Skipping app ${app.slug}: failed to get access token`,
          );
          continue;
        }

        // Get refresh token (optional)
        const refreshToken = await appSecrets.getRefreshToken(
          spaceId,
          app.channelId,
          app.slug,
        );

        // Build token set
        const tokens: TokenSet = {
          accessToken,
          refreshToken: refreshToken ?? undefined,
          expiresAt: accessTokenMeta.expiresAt
            ? new Date(accessTokenMeta.expiresAt).getTime()
            : undefined,
        };

        // Get app settings from props
        const settings = (app.props as Record<string, unknown> | undefined)
          ?.settings as Record<string, unknown> | undefined;

        // Derive MCP config
        const derivedConfig = appDef.deriveMcp(tokens, settings);

        // Convert to McpServerConfig format
        const mcpConfig: McpServerConfig = {
          name: app.slug, // Use artifact slug as MCP name
          slug: app.slug,
          transport: derivedConfig.transport,
          command: derivedConfig.command,
          args: derivedConfig.args,
          env: derivedConfig.env,
          url: derivedConfig.url,
          headers: derivedConfig.headers,
        };

        mcpConfigs.push(mcpConfig);
        console.log(
          `[AgentManager] Derived MCP config for ${app.slug} (${provider})`,
        );
      }
    } catch (error) {
      console.error(
        "[AgentManager] Error deriving MCP configs from apps:",
        error,
      );
      // Don't fail spawn if app derivation fails — just skip app MCPs
    }

    return mcpConfigs;
  }

  /**
   * Derive MCP configs from system.mcp artifacts based on agent definition.
   *
   * Resolution order:
   * 1. Get agent's roster entry to find agentType (definition slug)
   * 2. Find agent definition (channel first, then root via getAgentDefinitionWithChannel)
   * 3. Get MCP slugs from definition's props.mcp
   * 4. Resolve each MCP from the same channel as the definition was found
   *
   * For HTTP transport MCPs with OAuth configured, injects Bearer token into headers.
   * Auto-refreshes expired tokens when possible.
   */
  private async deriveMcpConfigsFromSystemMcps(
    spaceId: string,
    channelId: string,
    callsign: string,
  ): Promise<McpServerConfig[]> {
    const {
      getSystemMcp,
      getValidOAuthToken,
      getAgentDefinitionWithChannel,
      getRoster,
    } = this.config;

    // Skip if system.mcp derivation not configured
    if (!getSystemMcp || !getAgentDefinitionWithChannel || !getRoster) {
      return [];
    }

    const mcpConfigs: McpServerConfig[] = [];

    try {
      // Get agent's roster entry to find agentType
      const roster = await getRoster(spaceId, channelId);
      const rosterEntry = roster.find((r) => r.callsign === callsign);
      if (!rosterEntry?.agentType) {
        console.log(
          `[AgentManager] No agentType for ${callsign}, skipping system.mcp derivation`,
        );
        return [];
      }

      // Get agent definition with channel resolution
      const result = await getAgentDefinitionWithChannel(
        spaceId,
        channelId,
        rosterEntry.agentType,
      );
      if (!result) {
        console.log(
          `[AgentManager] No agent definition found for ${rosterEntry.agentType}`,
        );
        return [];
      }

      const { definition, channelId: definitionChannelId } = result;
      const mcpRefs = definition.props?.mcp;

      if (!mcpRefs || mcpRefs.length === 0) {
        console.log(
          `[AgentManager] Agent ${rosterEntry.agentType} has no MCPs configured`,
        );
        return [];
      }

      console.log(
        `[AgentManager] Agent ${rosterEntry.agentType} (from channel ${definitionChannelId}) has ${mcpRefs.length} MCPs: ${mcpRefs.map((r) => r.slug).join(", ")}`,
      );

      // Resolve each MCP from the definition's channel
      for (const mcpRef of mcpRefs) {
        const mcp = await getSystemMcp(definitionChannelId, mcpRef.slug);
        if (!mcp) {
          console.warn(
            `[AgentManager] MCP ${mcpRef.slug} not found in channel ${definitionChannelId}`,
          );
          continue;
        }

        const props = mcp.props as
          | {
              transport?: "stdio" | "http";
              url?: string;
              command?: string;
              args?: string[];
              variables?: Record<string, string>;
              cwd?: string;
              oauth?: { type: "oauth" };
            }
          | undefined;

        if (!props?.transport) {
          console.log(
            `[AgentManager] Skipping system.mcp ${mcp.slug}: no transport in props`,
          );
          continue;
        }

        // Build base config from props
        const mcpConfig: McpServerConfig = {
          name: mcp.slug,
          slug: mcp.slug,
          transport: props.transport,
          command: props.command,
          args: props.args,
          env: props.variables,
          cwd: props.cwd,
          url: props.url,
        };

        // For HTTP transport with OAuth, get valid token (auto-refreshes if needed)
        if (props.transport === "http" && props.oauth && getValidOAuthToken) {
          const accessToken = await getValidOAuthToken(
            spaceId,
            definitionChannelId, // Use definition's channel for OAuth tokens
            mcp.slug,
          );

          if (accessToken) {
            // Inject Authorization header with Bearer token
            mcpConfig.headers = {
              ...mcpConfig.headers,
              Authorization: `Bearer ${accessToken}`,
            };
            console.log(
              `[AgentManager] Injected OAuth token for system.mcp ${mcp.slug}`,
            );
          } else {
            console.log(
              `[AgentManager] Skipping system.mcp ${mcp.slug}: OAuth configured but no valid token`,
            );
            // MCP has OAuth configured but no tokens or refresh failed
            continue;
          }
        }

        mcpConfigs.push(mcpConfig);
        console.log(
          `[AgentManager] Added system.mcp config: ${mcp.slug} (${props.transport})`,
        );
      }
    } catch (error) {
      console.error(
        "[AgentManager] Error deriving MCP configs from system.mcp:",
        error,
      );
      // Don't fail spawn if derivation fails — just skip these MCPs
    }

    return mcpConfigs;
  }

  /**
   * Expand ${VAR} references in an MCP server config.
   *
   * Resolution order (specificity first - MCP's own wins):
   * 1. MCP's own env values
   * 2. Shared environment (from system.environment artifacts)
   *
   * Expands in: env values, args, url, headers
   */
  private expandMcpConfig(
    config: McpServerConfig,
    sharedEnv: Record<string, string>,
  ): McpServerConfig {
    // Expand ${VAR} references - MCP's own env takes precedence over shared
    const expand = (str: string): string =>
      str.replace(
        /\$\{(\w+)\}/g,
        (_, name) => config.env?.[name] ?? sharedEnv[name] ?? "",
      );

    return {
      ...config,
      env: config.env
        ? Object.fromEntries(
            Object.entries(config.env).map(([k, v]) => [k, expand(v)]),
          )
        : undefined,
      args: config.args?.map(expand),
      url: config.url ? expand(config.url) : undefined,
      headers: config.headers
        ? Object.fromEntries(
            Object.entries(config.headers).map(([k, v]) => [k, expand(v)]),
          )
        : undefined,
    };
  }

  /**
   * Get MCP server configurations for an agent.
   * Returns built-in platform MCPs, app MCPs, and agent-specific system.mcp configs.
   *
   * System MCPs are resolved based on agent definition:
   * 1. Find agent definition (channel first, then root)
   * 2. Only include MCPs listed in definition's props.mcp
   * 3. Resolve MCP artifacts from the same channel as the definition
   *
   * @param spaceId - Space ID
   * @param channelId - Channel ID where agent is spawned
   * @param callsign - Agent callsign (to look up agent type and definition)
   * @param authToken - Container auth token for platform MCP authentication (optional)
   */
  async getMcpConfigsForAgent(
    spaceId: string,
    channelId: string,
    callsign: string,
    authToken?: string,
  ): Promise<McpServerConfig[]> {
    console.log(
      `[AgentManager] getMcpConfigsForAgent - callsign: ${callsign}, channelId: ${channelId}, platformMcpUrl: ${this.config.platformMcpUrl ? "configured" : "missing"}, authToken: ${authToken ? "present" : "missing"}`,
    );

    // Resolve shared environment for ${VAR} expansion
    const sharedEnv = await this.resolveEnvironment(spaceId, channelId);

    const configs: McpServerConfig[] = [];

    // Add built-in platform MCP (miriad) if configured
    if (this.config.platformMcpUrl && authToken) {
      const miriadMcp = {
        name: "miriad",
        transport: "http" as const,
        url: `${this.config.platformMcpUrl}/mcp/${channelId}`,
        headers: {
          Authorization: `Container ${authToken}`,
        },
      };
      console.log(
        `[AgentManager] Adding miriad MCP:`,
        miriadMcp.name,
      );
      configs.push(miriadMcp);

      // Add miriad-files MCP for file upload/download (stdio-based, requires filesystem access)
      const miriadFilesMcp = {
        name: "miriad-files",
        transport: "stdio" as const,
        command: "npx",
        args: ["--yes", "@miriad-systems/assets-mcp"],
        env: {
          CAST_API_URL: this.config.platformMcpUrl,
          CAST_CHANNEL_ID: channelId,
          CAST_CONTAINER_TOKEN: authToken,
        },
      };
      console.log(`[AgentManager] Adding miriad-files MCP`);
      configs.push(miriadFilesMcp);
    } else {
      console.warn(
        `[AgentManager] Miriad MCP NOT added - platformMcpUrl: ${this.config.platformMcpUrl ? "present" : "missing"}, authToken: ${authToken ? "present" : "missing"}`,
      );
    }

    // Add user-configured app MCPs
    const appConfigs = await this.deriveMcpConfigsFromApps(spaceId, channelId);
    console.log(`[AgentManager] App MCPs: ${appConfigs.length} configured`);
    configs.push(...appConfigs);

    // Add agent-specific system.mcp configs (based on agent definition)
    const systemMcpConfigs = await this.deriveMcpConfigsFromSystemMcps(
      spaceId,
      channelId,
      callsign,
    );
    console.log(
      `[AgentManager] System MCPs: ${systemMcpConfigs.length} configured`,
    );
    configs.push(...systemMcpConfigs);

    // Expand ${VAR} references in all configs (except built-in MCPs which have no vars)
    const expandedConfigs = configs.map((config) =>
      config.name === "miriad" || config.name === "miriad-files"
        ? config
        : this.expandMcpConfig(config, sharedEnv),
    );

    console.log(
      `[AgentManager] Total MCP configs for channelId ${channelId}: ${expandedConfigs.length}`,
    );
    return expandedConfigs;
  }

  /**
   * Resolve environment variables and secrets for an agent.
   *
   * Hierarchy (specificity first - channel wins over root):
   * 1. Channel system.environment artifacts (most specific, highest priority)
   * 2. Root system.environment artifacts (fallback)
   *
   * Within each scope, multiple environment artifacts merge alphabetically by slug.
   *
   * @param spaceId - Space ID
   * @param channelId - Channel ID
   * @returns Flat Record<string, string> of resolved environment variables + secrets
   */
  async resolveEnvironment(
    spaceId: string,
    channelId: string,
  ): Promise<Record<string, string>> {
    const { getEnvironmentArtifacts, getRootChannelId, getSecretValue } =
      this.config;

    // Skip if environment resolution not configured
    if (!getEnvironmentArtifacts || !getRootChannelId || !getSecretValue) {
      console.log(
        "[AgentManager] Environment resolution not configured, returning empty",
      );
      return {};
    }

    const result: Record<string, string> = {};

    try {
      // Get root channel ID
      const rootChannelId = await getRootChannelId(spaceId);

      // 1. Root first (base layer)
      if (rootChannelId && rootChannelId !== channelId) {
        const rootEnvs = await getEnvironmentArtifacts(spaceId, rootChannelId);
        // Sort alphabetically by slug for deterministic ordering
        rootEnvs.sort((a, b) => a.slug.localeCompare(b.slug));

        for (const env of rootEnvs) {
          // Merge variables
          if (env.props?.variables) {
            Object.assign(result, env.props.variables);
          }
          // Resolve secrets
          for (const key of env.secretKeys) {
            const value = await getSecretValue(
              spaceId,
              rootChannelId,
              env.slug,
              key,
            );
            if (value !== null) {
              result[key] = value;
            }
          }
        }
        console.log(
          `[AgentManager] Resolved ${rootEnvs.length} root environment artifacts`,
        );
      }

      // 2. Channel overlays (specificity wins)
      const channelEnvs = await getEnvironmentArtifacts(spaceId, channelId);
      // Sort alphabetically by slug for deterministic ordering
      channelEnvs.sort((a, b) => a.slug.localeCompare(b.slug));

      for (const env of channelEnvs) {
        // Merge variables (overwrites root)
        if (env.props?.variables) {
          Object.assign(result, env.props.variables);
        }
        // Resolve secrets (overwrites root)
        for (const key of env.secretKeys) {
          const value = await getSecretValue(spaceId, channelId, env.slug, key);
          if (value !== null) {
            result[key] = value;
          }
        }
      }
      console.log(
        `[AgentManager] Resolved ${channelEnvs.length} channel environment artifacts`,
      );
      console.log(
        `[AgentManager] Total resolved env vars: ${Object.keys(result).length}`,
      );
    } catch (error) {
      console.error("[AgentManager] Error resolving environment:", error);
      // Don't fail activation if environment resolution fails
    }

    return result;
  }

  /**
   * Get agent definition props for an agent.
   * Returns the props from the system.agent artifact (engine, nameTheme, etc.)
   */
  async getAgentProps(
    spaceId: string,
    channelId: string,
    callsign: string,
  ): Promise<AgentDefinition["props"] | undefined> {
    // Get roster to find agent type
    const roster = await this.config.getRoster(spaceId, channelId);
    const rosterEntry = roster.find((r) => r.callsign === callsign);
    const agentType = rosterEntry?.agentType;

    console.log(
      `[AgentManager] getAgentProps: spaceId=${spaceId} callsign=${callsign}, agentType=${agentType}, hasGetAgentDefinition=${!!this.config.getAgentDefinition}`,
    );

    if (!agentType || !this.config.getAgentDefinition) {
      console.log("No agent definition! WOWW!");
      return undefined;
    }

    try {
      const agentDefinition = await this.config.getAgentDefinition(
        spaceId,
        agentType,
      );
      console.log("AGENT DEFINITION!", agentDefinition);
      return agentDefinition?.props;
    } catch (err) {
      console.error(
        `[AgentManager] Error loading agent definition for props:`,
        err,
      );
      return undefined;
    }
  }

  /**
   * Activate a container for an agent.
   * NOTE: No longer checks in-memory state - roster callbackUrl check happens in invoker-adapter.
   * This method just activates unconditionally.
   */
  async activate(
    spaceId: string,
    channelId: string,
    callsign: string,
  ): Promise<ManagedAgent> {
    console.log(`[AgentManager] Activating agent ${callsign} in ${channelId}`);

    // Verify channel exists (needed for error handling)
    const channel = await this.config.getChannel(spaceId, channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    // Build agent ID for v3.0 protocol
    const agentId = this.buildAgentId(spaceId, channelId, callsign);

    // Build system prompt using centralized method
    const systemPrompt = await this.buildPromptForAgent(
      spaceId,
      channelId,
      callsign,
    );

    // Generate auth token
    const authToken = generateContainerToken({ spaceId, channelId, callsign });

    // Get all MCP configs (platform + app + agent-specific MCPs)
    const mcpConfigs = await this.getMcpConfigsForAgent(
      spaceId,
      channelId,
      callsign,
      authToken,
    );

    // Get tunnel hash from roster entry (if available)
    let tunnelHash: string | undefined;
    if (this.config.getRosterByCallsign) {
      const rosterEntry = await this.config.getRosterByCallsign(
        channelId,
        callsign,
      );
      tunnelHash = rosterEntry?.tunnelHash;
      if (tunnelHash) {
        console.log(
          `[AgentManager] Tunnel hash found for ${callsign}: ${tunnelHash.substring(0, 8)}...`,
        );
      }
    }

    // Activate container with v3.0 options
    const activateOptions: ActivateOptions = {
      agentId,
      authToken,
      systemPrompt,
      mcpServers: mcpConfigs.length > 0 ? mcpConfigs : undefined,
      tunnelHash,
      tunnelServerUrl: this.config.tunnelServerUrl,
    };

    const runtimeState = await this.config.runtime.activate(activateOptions);

    const agent: ManagedAgent = {
      callsign,
      channelId,
      spaceId,
      state: "idle",
      runtimeState,
    };

    console.log(
      `[AgentManager] Agent ${callsign} activated, port ${runtimeState.port}`,
    );

    return agent;
  }

  /**
   * Activate a container and send a message to it.
   * NOTE: This always activates - the invoker-adapter handles the "check roster first" logic.
   * The message is NOT pushed directly here - it's saved to storage, and the container
   * will receive it via the pending message queue when it checks in.
   */
  async sendMessage(
    spaceId: string,
    channelId: string,
    callsign: string,
    sender: string,
    content: string,
  ): Promise<void> {
    // Activate container - it will checkin and receive pending messages
    await this.activate(spaceId, channelId, callsign);

    // Note: We don't push the message here. The message is already saved to storage
    // by the message handler. The container will receive it via getPendingMessages
    // when it calls /agents/checkin.
    console.log(
      `[AgentManager] Container activated for ${callsign}, will receive message via checkin`,
    );
  }

  /**
   * Suspend an agent's container.
   * NOTE: With roster as source of truth, you should also clear callbackUrl in roster.
   */
  async suspend(
    spaceId: string,
    channelId: string,
    callsign: string,
  ): Promise<void> {
    const agentId = this.buildAgentId(spaceId, channelId, callsign);
    await this.config.runtime.suspend(agentId, "manual");
    console.log(`[AgentManager] Agent ${callsign} suspended`);
    // Note: Caller should also clear callbackUrl in roster via storage.updateRosterEntry()
  }

  /**
   * Shutdown all containers managed by the runtime.
   */
  async shutdown(): Promise<void> {
    console.log("[AgentManager] Shutting down all agents...");
    await this.config.runtime.shutdown();
  }
}

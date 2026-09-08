import { agentTemplates as bundledAgents } from './content/agents.js';
import { playbooks as bundledPlaybooks } from './content/playbooks.js';
/**
 * Sanity Client
 *
 * Simple HTTP client for fetching onboarding content from Sanity.
 * Uses GROQ queries via the HTTP API to avoid SDK dependencies.
 */

const SANITY_PROJECT_ID = process.env.SANITY_PROJECT_ID || 'z6gp2g0b';
const SANITY_DATASET = process.env.SANITY_DATASET || 'production';
const SANITY_API_VERSION = '2024-01-01';

// =============================================================================
// Types for Sanity Documents
// =============================================================================

export interface SanityAgentTemplate {
  _id: string;
  _type: 'agentTemplate';
  name: string;
  slug: { current: string };
  description?: string;
  engine: string;
  model?: string;
  nameTheme?: string;
  agentName?: string;
  systemPrompt?: string;
  mcpServers?: Array<{ _ref: string }>;
  bootstrapped?: boolean;
  featuredChannelStarter?: boolean;
}

export interface SanityMcpServer {
  _id: string;
  _type: 'mcpServer';
  name: string;
  slug: { current: string };
  capabilities?: string;
  transport: 'stdio' | 'http';
  // stdio fields
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Array<{ key: string; value: string }>;
  // http fields
  url?: string;
  headers?: Array<{ key: string; value: string }>;
  bootstrapped?: boolean;
}

export interface SanityPlaybook {
  _id: string;
  _type: 'playbook';
  name: string;
  slug: { current: string };
  description?: string;
  category?: string;
  tags?: string[];
  content?: string;
  bootstrapped?: boolean;
}

export interface OnboardingContent {
  agentTemplates: SanityAgentTemplate[];
  mcpServers: SanityMcpServer[];
  playbooks: SanityPlaybook[];
}

// =============================================================================
// GROQ Queries
// =============================================================================

const AGENT_TEMPLATES_QUERY = `*[_type == "agentTemplate"]{
  _id,
  _type,
  name,
  slug,
  description,
  engine,
  model,
  nameTheme,
  agentName,
  systemPrompt,
  mcpServers[]{ _ref },
  bootstrapped,
  featuredChannelStarter
}`;

const MCP_SERVERS_QUERY = `*[_type == "mcpServer"]{
  _id,
  _type,
  name,
  slug,
  capabilities,
  transport,
  command,
  args,
  cwd,
  env,
  url,
  headers,
  bootstrapped
}`;

const PLAYBOOKS_QUERY = `*[_type == "playbook"]{
  _id,
  _type,
  name,
  slug,
  description,
  category,
  tags,
  content,
  bootstrapped
}`;

// =============================================================================
// Sanity HTTP API Client
// =============================================================================

async function query<T>(groq: string): Promise<T> {
  const url = new URL(
    `https://${SANITY_PROJECT_ID}.api.sanity.io/v${SANITY_API_VERSION}/data/query/${SANITY_DATASET}`
  );
  url.searchParams.set('query', groq);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Sanity query failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { result: T };
  return data.result;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Fetch all onboarding content from Sanity.
 * This fetches agent templates, MCP servers, and playbooks in parallel.
 */
export async function fetchOnboardingContent(): Promise<OnboardingContent> {
  if (process.env.CONTENT_SOURCE === 'bundled') return {
    agentTemplates:bundledAgents, mcpServers: [],
    playbooks: bundledPlaybooks.map(p => ({...p, _id:p.slug, _type:'playbook', slug:{current:p.slug}, bootstrapped:true})),
  };
  const [agentTemplates, mcpServers, playbooks] = await Promise.all([
    query<SanityAgentTemplate[]>(AGENT_TEMPLATES_QUERY),
    query<SanityMcpServer[]>(MCP_SERVERS_QUERY),
    query<SanityPlaybook[]>(PLAYBOOKS_QUERY),
  ]);

  return {
    agentTemplates,
    mcpServers,
    playbooks,
  };
}

/**
 * Build a lookup map from Sanity _id to document for resolving references.
 */
export function buildMcpLookup(
  mcpServers: SanityMcpServer[]
): Map<string, SanityMcpServer> {
  return new Map(mcpServers.map((mcp) => [mcp._id, mcp]));
}

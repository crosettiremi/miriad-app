/**
 * Space Seeding from Sanity
 *
 * Seeds a new space with content from Sanity CMS.
 */

import type { Storage } from '@cast/storage';
import { fetchOnboardingContent } from './sanity-client';
import { transformOnboardingContent } from './transform';

/**
 * Seed a new space with content from Sanity.
 *
 * Creates:
 * 1. #root channel for system configuration
 * 2. MCP server artifacts (must be first - agents reference them)
 * 3. Agent template artifacts
 * 4. Playbook artifacts
 * 5. #first-channel as the default working channel
 *
 * @param storage - Storage instance
 * @param spaceId - ID of the space to seed
 */
export async function seedSpaceFromSanity(
  storage: Storage,
  spaceId: string
): Promise<void> {
  // Fetch content from Sanity
  const content = await fetchOnboardingContent();
  const transformed = transformOnboardingContent(content);

  // Create #root channel
  const rootChannel = await storage.getChannelByName(spaceId,'root') ?? await storage.createChannel({
    spaceId,
    name: 'root',
    tagline: 'System configuration',
    mission: 'System-level artifacts and configuration for this space.',
  });

  // Create MCP servers first (agents reference them)
  for (const mcp of transformed.mcpServers) {
    if (!await storage.getArtifact(rootChannel.id, mcp.slug)) await storage.createArtifact(rootChannel.id, {
      ...mcp,
      channelId: rootChannel.id,
    });
  }

  // Create agent templates
  for (const agent of transformed.agentTemplates) {
    if (!await storage.getArtifact(rootChannel.id, agent.slug)) await storage.createArtifact(rootChannel.id, {
      ...agent,
      channelId: rootChannel.id,
    });
  }

  // Create playbooks
  for (const playbook of transformed.playbooks) {
    if (!await storage.getArtifact(rootChannel.id, playbook.slug)) await storage.createArtifact(rootChannel.id, {
      ...playbook,
      channelId: rootChannel.id,
    });
  }

  // Create #first-channel as the default working channel
  if (!await storage.getChannelByName(spaceId,'first-channel')) await storage.createChannel({
    spaceId,
    name: 'first-channel',
    tagline: 'Your first channel',
    mission: 'A space to get started with AI agents.',
  });
}

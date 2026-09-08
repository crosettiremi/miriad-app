/**
 * Artifact Handlers
 *
 * REST API routes for artifact CRUD operations.
 *
 * Endpoints:
 * - GET    /channels/:channelId/artifacts/tree?pattern=/**  - Tree view (glob)
 * - GET    /channels/:channelId/artifacts                   - List with filters
 * - GET    /channels/:channelId/artifacts/:slug             - Read single artifact
 * - POST   /channels/:channelId/artifacts                   - Create artifact
 * - PATCH  /channels/:channelId/artifacts/:slug             - CAS update
 * - POST   /channels/:channelId/artifacts/:slug/edit        - Surgical content edit
 * - DELETE /channels/:channelId/artifacts/:slug             - Archive (soft delete)
 * - POST   /channels/:channelId/artifacts/:slug/versions    - Create checkpoint
 * - GET    /channels/:channelId/artifacts/:slug/versions    - List versions
 * - GET    /channels/:channelId/artifacts/:slug/diff        - Diff versions
 *
 * Secrets Endpoints (App Integrations):
 * - PUT    /channels/:channelId/artifacts/:slug/secrets/:key    - Set a secret
 * - DELETE /channels/:channelId/artifacts/:slug/secrets/:key    - Delete a secret
 *
 * Asset Endpoints (Phase E):
 * - POST   /channels/:channelId/assets                      - Upload asset (multipart)
 * - GET    /channels/:channelId/assets/:slug                - Serve asset file
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Storage } from '@cast/storage';
import {
  type ArtifactType,
  type ArtifactStatus,
  type ArtifactCASChange,
  isArtifactType,
  isArtifactStatus,
  getMimeType,
  tymbal,
  slugify,
} from '@cast/core';
import type { ConnectionManager } from '../websocket/index.js';
import type { AssetStorage } from '../assets/index.js';

// =============================================================================
// Types
// =============================================================================

export interface ArtifactHandlerOptions {
  /** Storage backend */
  storage: Storage;
  /** @deprecated spaceId is now extracted from session context via c.get('spaceId') */
  spaceId?: string;
  /** WebSocket connection manager for broadcasts */
  connectionManager: ConnectionManager;
  /** Asset storage backend (optional - required for asset uploads) */
  assetStorage?: AssetStorage;
}

/**
 * Get spaceId from request context. Falls back to options.spaceId for backwards compatibility.
 */
function getSpaceIdFromContext(c: Context, fallback?: string): string {
  const spaceId = c.get('spaceId');
  if (spaceId) return spaceId;
  if (fallback) return fallback;
  throw new Error('spaceId not found in context and no fallback provided');
}

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

const SlugSchema = z.string()
  .min(1, 'Slug is required')
  .regex(/^[a-z0-9-]+(\.[a-z0-9]+)*$/, 'Invalid slug format. Use lowercase letters, numbers, hyphens, and dots for extensions.');

const ArtifactTypeSchema = z.enum([
  'doc',
  'folder',
  'task',
  'code',
  'decision',
  'knowledgebase',
  'asset',
  'system.mcp',
  'system.agent',
  'system.environment',
  'system.focus',
  'system.playbook',
  'system.app',
]);

const ArtifactStatusSchema = z.enum([
  'draft',
  'active',
  'archived',
  'pending',
  'in_progress',
  'done',
  'blocked',
  'published', // Legacy - use 'active' for new artifacts
]);

const CreateArtifactSchema = z.object({
  slug: SlugSchema,
  type: ArtifactTypeSchema,
  tldr: z.string().optional(),
  content: z.string(),
  title: z.string().optional(),
  parentSlug: z.string().optional(),
  status: ArtifactStatusSchema.optional(),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  props: z.record(z.unknown()).optional(),
  sender: z.string().min(1, 'sender is required'),
  replace: z.boolean().optional(), // If true, replace existing artifact
});

// Accept both camelCase (oldValue/newValue) and snake_case (old_value/new_value) for flexibility
const CASChangeSchema = z.object({
  field: z.enum(['title', 'tldr', 'status', 'parentSlug', 'orderKey', 'assignees', 'labels', 'props']),
  // Support both naming conventions
  old_value: z.unknown().optional(),
  new_value: z.unknown().optional(),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
}).transform((data) => ({
  field: data.field,
  // Prefer snake_case, fall back to camelCase
  old_value: data.old_value !== undefined ? data.old_value : data.oldValue,
  new_value: data.new_value !== undefined ? data.new_value : data.newValue,
}));

const CASUpdateSchema = z.object({
  changes: z.array(CASChangeSchema).min(1, 'At least one change is required'),
  sender: z.string().min(1, 'sender is required'),
});

const EditArtifactSchema = z.object({
  old_string: z.string().min(1, 'old_string is required'),
  new_string: z.string(),
  sender: z.string().min(1, 'sender is required'),
});

const CreateVersionSchema = z.object({
  version: z.string().min(1, 'version name is required'),
  message: z.string().optional(),
  sender: z.string().min(1, 'sender is required'),
});

const SetSecretSchema = z.object({
  value: z.string().min(1, 'value is required'),
  expiresAt: z.string().datetime().optional(),
});

const ListQuerySchema = z.object({
  type: ArtifactTypeSchema.optional(),
  status: ArtifactStatusSchema.optional(),
  assignee: z.string().optional(),
  parentSlug: z.string().optional(),
  search: z.string().optional(),
  regex: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validate Knowledge Base constraints.
 * Rules:
 * 1. KB root: type=knowledgebase requires slug='knowledgebase', one per channel
 * 2. KB children: artifacts under /knowledgebase/ must be type 'doc' or 'folder'
 * 3. Published KB docs require non-empty content
 *
 * @returns Error message if validation fails, null if valid
 */
async function validateKnowledgeBaseConstraints(
  storage: Storage,
  channelId: string,
  slug: string,
  type: string,
  parentSlug: string | undefined,
  status: string | undefined,
  content: string,
  isUpdate: boolean = false
): Promise<string | null> {
  // Rule 1: KB root constraints
  if (type === 'knowledgebase') {
    if (slug !== 'knowledgebase') {
      return "Knowledge base root slug must be 'knowledgebase'";
    }
    if (!isUpdate) {
      // Check if channel already has a KB
      const existingKb = await storage.getArtifact(channelId, 'knowledgebase');
      if (existingKb && existingKb.status !== 'archived') {
        return 'Channel already has a knowledge base';
      }
    }
  }

  // Rule 2: KB children must be doc or folder
  // Check if this artifact will be under /knowledgebase/
  const isUnderKb = parentSlug === 'knowledgebase' ||
    (parentSlug && await isDescendantOfKnowledgebase(storage, channelId, parentSlug));

  if (isUnderKb && type !== 'doc' && type !== 'folder') {
    return "Knowledge base content must be type 'doc' or 'folder'";
  }

  // Rule 3: Active KB docs require content
  if (isUnderKb && status === 'active' && type === 'doc') {
    if (!content || !content.trim()) {
      return 'Active knowledge base documents require non-empty content';
    }
  }

  return null;
}

/**
 * Check if an artifact is a descendant of the knowledgebase root.
 */
async function isDescendantOfKnowledgebase(
  storage: Storage,
  channelId: string,
  slug: string
): Promise<boolean> {
  const artifact = await storage.getArtifact(channelId, slug);
  if (!artifact) return false;

  // Check if path starts with knowledgebase (ltree format uses underscores)
  return artifact.path.startsWith('knowledgebase.') || artifact.path === 'knowledgebase';
}

/**
 * Format Zod validation errors for API response.
 */
function formatZodError(error: z.ZodError): { error: string; details: Array<{ path: string; message: string }> } {
  return {
    error: 'validation_error',
    details: error.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    })),
  };
}

/**
 * Broadcast artifact event as a proper Tymbal SetFrame.
 * Uses the standard { i, t, v, c } format for consistency with all other frames.
 */
export async function broadcastArtifactEvent(
  connectionManager: ConnectionManager,
  channelId: string,
  action: 'create' | 'update' | 'archive',
  artifact: { slug: string; type?: string; title?: string; tldr?: string; status: string }
) {
  const frame = JSON.stringify({
    i: ulid(), // Unique frame ID
    t: new Date().toISOString(), // Timestamp
    v: { // SetFrame value
      type: 'artifact',
      action,
      artifact,
    },
    c: channelId, // Channel for client routing
  });
  await connectionManager.broadcast(channelId, frame);
}

// =============================================================================
// Route Factory
// =============================================================================

export function createArtifactRoutes(options: ArtifactHandlerOptions): Hono {
  const { storage, spaceId: fallbackSpaceId, connectionManager, assetStorage } = options;
  const app = new Hono();

  // Helper to get spaceId from context or fallback
  const getSpaceId = (c: Context): string => getSpaceIdFromContext(c, fallbackSpaceId);

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts/tree - Tree view (glob)
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts/tree', async (c) => {
    const channelId = c.req.param('channelId');
    const pattern = c.req.query('pattern') || '/**';
    const format = c.req.query('format') || 'json';

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const tree = await storage.globArtifacts(channel.id, pattern);

      if (format === 'text') {
        // Return indented text format for CLI
        type TreeNode = typeof tree[number];
        const formatTree = (nodes: TreeNode[], indent = 0): string => {
          return nodes.map((node: TreeNode) => {
            const prefix = '  '.repeat(indent);
            const typeAnnotation = node.type !== 'doc' ? ` :${node.type}` : '';
            const statusAnnotation = node.type === 'task' ? ` (${node.status})` : '';
            const assigneeAnnotation = node.assignees.length > 0 ? ` @${node.assignees.join(', @')}` : '';
            const line = `${prefix}/${node.slug}${typeAnnotation}${statusAnnotation}${assigneeAnnotation}`;
            const children = node.children.length > 0 ? '\n' + formatTree(node.children, indent + 1) : '';
            return line + children;
          }).join('\n');
        };
        return c.text(formatTree(tree));
      }

      return c.json({ tree });
    } catch (error) {
      console.error('[Artifacts] Error getting tree:', error);
      return c.json({ error: 'Failed to get artifact tree' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts - List artifacts with filters
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts', async (c) => {
    const channelId = c.req.param('channelId');

    // Parse query params
    const query = ListQuerySchema.safeParse({
      type: c.req.query('type'),
      status: c.req.query('status'),
      assignee: c.req.query('assignee'),
      parentSlug: c.req.query('parentSlug'),
      search: c.req.query('search'),
      regex: c.req.query('regex'),
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });

    if (!query.success) {
      return c.json(formatZodError(query.error), 400);
    }

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const artifacts = await storage.listArtifacts(channel.id, {
        type: query.data.type as ArtifactType | undefined,
        status: query.data.status as ArtifactStatus | undefined,
        assignee: query.data.assignee,
        parentSlug: query.data.parentSlug as string | 'root' | undefined,
        search: query.data.search,
        regex: query.data.regex,
        limit: query.data.limit,
        offset: query.data.offset,
      });

      return c.json({ artifacts });
    } catch (error) {
      console.error('[Artifacts] Error listing artifacts:', error);
      return c.json({ error: 'Failed to list artifacts' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts/:slug - Read single artifact
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts/:slug', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');
    const versionName = c.req.query('version');

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // If version specified, return that specific version
      if (versionName) {
        const version = await storage.getArtifactVersion(channel.id, slug, versionName);
        if (!version) {
          return c.json({ error: `Version '${versionName}' not found for artifact '${slug}'` }, 404);
        }
        return c.json(version);
      }

      // Get current artifact
      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      // Include version list
      const versions = await storage.listArtifactVersions(channel.id, slug);

      return c.json({
        ...artifact,
        versions: versions.map((v) => ({
          versionName: v.versionName,
          versionMessage: v.versionMessage,
          versionCreatedBy: v.versionCreatedBy,
          versionCreatedAt: v.versionCreatedAt,
        })),
      });
    } catch (error) {
      console.error('[Artifacts] Error reading artifact:', error);
      return c.json({ error: 'Failed to read artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /channels/:channelId/artifacts - Create artifact
  // ---------------------------------------------------------------------------
  app.post('/:channelId/artifacts', async (c) => {
    const channelId = c.req.param('channelId');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = CreateArtifactSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { slug, type, tldr, content, title, parentSlug, status, assignees, labels, props, sender, replace } = parsed.data;

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check if artifact already exists
      const existing = await storage.getArtifact(channel.id, slug);

      if (existing && !replace) {
        return c.json({ error: `Artifact already exists: ${slug}. Use replace: true to overwrite.` }, 409);
      }

      if (!existing && replace) {
        return c.json({ error: `Artifact not found: ${slug}. Cannot replace non-existent artifact.` }, 404);
      }

      // Prevent replace on artifacts with secrets (would lose encrypted data)
      if (replace && existing && existing.secrets && Object.keys(existing.secrets).length > 0) {
        return c.json({
          error: `Cannot replace artifact with secrets. Use PATCH to update fields, or disconnect apps first.`,
        }, 409);
      }

      // Validate Knowledge Base constraints
      const kbError = await validateKnowledgeBaseConstraints(
        storage,
        channel.id,
        slug,
        type,
        parentSlug,
        status,
        content,
        !!replace
      );
      if (kbError) {
        return c.json({ error: kbError }, 400);
      }

      let artifact;

      if (replace && existing) {
        // Update existing artifact by archiving and recreating
        // For replace mode, we need to use CAS to update all fields
        // But since we're replacing, we'll archive the old one and create new
        await storage.archiveArtifact(channel.id, slug, sender);

        // Create new artifact with same slug
        artifact = await storage.createArtifact(channel.id, {
          slug,
          channelId: channel.id,
          type: type as ArtifactType,
          title,
          tldr,
          content,
          parentSlug,
          status: status as ArtifactStatus | undefined,
          assignees,
          labels,
          props,
          createdBy: sender,
        });
      } else {
        // Create new artifact
        artifact = await storage.createArtifact(channel.id, {
          slug,
          channelId: channel.id,
          type: type as ArtifactType,
          title,
          tldr,
          content,
          parentSlug,
          status: status as ArtifactStatus | undefined,
          assignees,
          labels,
          props,
          createdBy: sender,
        });
      }

      // Broadcast event
      await broadcastArtifactEvent(connectionManager, channel.id, 'create', {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
      });

      return c.json(artifact, 201);
    } catch (error) {
      console.error('[Artifacts] Error creating artifact:', error);
      // Check for unique constraint violation (duplicate slug)
      if (error instanceof Error && error.message.includes('unique')) {
        return c.json({ error: `Artifact already exists: ${slug}` }, 409);
      }
      return c.json({ error: 'Failed to create artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /channels/:channelId/artifacts/:slug - CAS update
  // ---------------------------------------------------------------------------
  app.patch('/:channelId/artifacts/:slug', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = CASUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { changes, sender } = parsed.data;

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Convert from API format to storage format
      const storageChanges: ArtifactCASChange[] = changes.map((change) => ({
        field: change.field as ArtifactCASChange['field'],
        oldValue: change.old_value,
        newValue: change.new_value,
      }));

      // Check KB constraints for parentSlug or status changes
      const parentSlugChange = changes.find((c) => c.field === 'parentSlug');
      const statusChange = changes.find((c) => c.field === 'status');

      if (parentSlugChange || statusChange) {
        const artifact = await storage.getArtifact(channel.id, slug);
        if (artifact) {
          const newParentSlug = parentSlugChange ? (parentSlugChange.new_value as string | undefined) : artifact.parentSlug;
          const newStatus = statusChange ? (statusChange.new_value as string) : artifact.status;

          const kbError = await validateKnowledgeBaseConstraints(
            storage,
            channel.id,
            slug,
            artifact.type,
            newParentSlug,
            newStatus,
            artifact.content,
            true
          );
          if (kbError) {
            return c.json({ error: kbError }, 400);
          }
        }
      }

      const result = await storage.updateArtifactWithCAS(channel.id, slug, storageChanges, sender);

      if (!result.success) {
        return c.json({
          error: 'conflict',
          message: 'Value changed since you last read it',
          conflict: result.conflict,
        }, 409);
      }

      // Broadcast event
      if (result.artifact) {
        await broadcastArtifactEvent(connectionManager, channel.id, 'update', {
          slug: result.artifact.slug,
          type: result.artifact.type,
          title: result.artifact.title,
          tldr: result.artifact.tldr,
          status: result.artifact.status,
        });
      }

      return c.json(result.artifact);
    } catch (error) {
      console.error('[Artifacts] Error updating artifact:', error);
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }
      return c.json({ error: 'Failed to update artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /channels/:channelId/artifacts/:slug/edit - Surgical content edit
  // ---------------------------------------------------------------------------
  app.post('/:channelId/artifacts/:slug/edit', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = EditArtifactSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { old_string, new_string, sender } = parsed.data;

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const artifact = await storage.editArtifact(channel.id, slug, {
        oldString: old_string,
        newString: new_string,
        updatedBy: sender,
      });

      // Broadcast event
      await broadcastArtifactEvent(connectionManager, channel.id, 'update', {
        slug: artifact.slug,
        type: artifact.type,
        title: artifact.title,
        tldr: artifact.tldr,
        status: artifact.status,
      });

      return c.json(artifact);
    } catch (error) {
      console.error('[Artifacts] Error editing artifact:', error);
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('not found')) {
        if (message.includes('old_string')) {
          return c.json({ error: 'old_string not found in artifact content' }, 404);
        }
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      if (message.includes('ambiguous') || message.includes('multiple')) {
        return c.json({ error: 'old_string matches multiple times - be more specific' }, 409);
      }

      return c.json({ error: 'Failed to edit artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /channels/:channelId/artifacts/:slug - Archive (soft delete)
  // Supports ?recursive=true to archive artifact and all descendants
  // ---------------------------------------------------------------------------
  app.delete('/:channelId/artifacts/:slug', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');
    const sender = c.req.query('sender') || 'system';
    const recursive = c.req.query('recursive') === 'true';

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      if (recursive) {
        // Archive artifact and all descendants
        const result = await storage.archiveArtifactRecursive(channel.id, slug, sender);

        // Broadcast events for each archived artifact
        for (const item of result.archived) {
          await broadcastArtifactEvent(connectionManager, channel.id, 'archive', {
            slug: item.slug,
            status: 'archived',
          });
        }

        return c.json({
          archived: true,
          recursive: true,
          count: result.count,
          items: result.archived,
        });
      } else {
        // Archive single artifact
        const artifact = await storage.archiveArtifact(channel.id, slug, sender);

        // Broadcast event
        await broadcastArtifactEvent(connectionManager, channel.id, 'archive', {
          slug: artifact.slug,
          type: artifact.type,
          title: artifact.title,
          tldr: artifact.tldr,
          status: artifact.status,
        });

        return c.json({ archived: true, artifact });
      }
    } catch (error) {
      console.error('[Artifacts] Error archiving artifact:', error);
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }
      return c.json({ error: 'Failed to archive artifact' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /channels/:channelId/artifacts/:slug/versions - Create checkpoint
  // ---------------------------------------------------------------------------
  app.post('/:channelId/artifacts/:slug/versions', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = CreateVersionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { version: versionName, message: versionMessage, sender } = parsed.data;

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const version = await storage.checkpointArtifact(channel.id, slug, {
        versionName,
        versionMessage,
        createdBy: sender,
      });

      return c.json(version, 201);
    } catch (error) {
      console.error('[Artifacts] Error creating version:', error);
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('not found')) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      if (message.includes('already exists') || message.includes('unique')) {
        return c.json({ error: `Version '${versionName}' already exists for this artifact` }, 409);
      }

      return c.json({ error: 'Failed to create version' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts/:slug/versions - List versions
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts/:slug/versions', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check artifact exists
      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      const versions = await storage.listArtifactVersions(channel.id, slug);

      return c.json({ versions });
    } catch (error) {
      console.error('[Artifacts] Error listing versions:', error);
      return c.json({ error: 'Failed to list versions' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/artifacts/:slug/diff - Diff versions
  // ---------------------------------------------------------------------------
  app.get('/:channelId/artifacts/:slug/diff', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');
    const fromVersion = c.req.query('from');
    const toVersion = c.req.query('to');

    if (!fromVersion) {
      return c.json({ error: "'from' query parameter is required" }, 400);
    }

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const diff = await storage.diffArtifactVersions(
        channel.id,
        slug,
        fromVersion,
        toVersion || undefined
      );

      return c.json({ diff });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: error.message }, 404);
      }
      console.error('[Artifacts] Error generating diff:', error);
      return c.json({ error: 'Failed to generate diff' }, 500);
    }
  });

  // ===========================================================================
  // Secrets Endpoints (App Integrations)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // PUT /channels/:channelId/artifacts/:slug/secrets/:key - Set a secret
  // ---------------------------------------------------------------------------
  app.put('/:channelId/artifacts/:slug/secrets/:key', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');
    const key = c.req.param('key');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = SetSecretSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { value, expiresAt } = parsed.data;

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check artifact exists
      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      // Set the secret
      await storage.setSecret(spaceId, channel.id, slug, key, {
        value,
        expiresAt,
      });

      // Get updated metadata to return
      const metadata = await storage.getSecretMetadata(channel.id, slug, key);

      return c.json({
        key,
        setAt: metadata?.setAt,
        expiresAt: metadata?.expiresAt,
      });
    } catch (error) {
      console.error('[Artifacts] Error setting secret:', error);
      return c.json({ error: 'Failed to set secret' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /channels/:channelId/artifacts/:slug/secrets/:key - Delete a secret
  // ---------------------------------------------------------------------------
  app.delete('/:channelId/artifacts/:slug/secrets/:key', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');
    const key = c.req.param('key');

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check artifact exists
      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      // Check secret exists
      const metadata = await storage.getSecretMetadata(channel.id, slug, key);
      if (!metadata) {
        return c.json({ error: `Secret not found: ${key}` }, 404);
      }

      // Delete the secret
      await storage.deleteSecret(channel.id, slug, key);

      return c.json({ deleted: true, key });
    } catch (error) {
      console.error('[Artifacts] Error deleting secret:', error);
      return c.json({ error: 'Failed to delete secret' }, 500);
    }
  });

  // ===========================================================================
  // Asset Endpoints (Phase E)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // POST /channels/:channelId/assets - Upload asset (multipart or base64 JSON)
  // ---------------------------------------------------------------------------
  app.post('/:channelId/assets', async (c) => {
    if (!assetStorage) {
      return c.json({ error: 'Asset storage not configured' }, 501);
    }

    const channelId = c.req.param('channelId');

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const contentType = c.req.header('Content-Type') || '';

      let slug: string;
      let tldr: string;
      let sender: string;
      let title: string | undefined;
      let parentSlug: string | undefined;
      let attachToMessageId: string | undefined;
      let source: { type: 'path'; path: string } | { type: 'base64'; data: string };

      if (contentType.includes('multipart/form-data')) {
        // Handle multipart form upload
        const formData = await c.req.formData();
        const file = formData.get('file') as File | null;
        slug = formData.get('slug') as string;
        tldr = formData.get('tldr') as string;
        sender = formData.get('sender') as string;
        title = (formData.get('title') as string) || undefined;
        parentSlug = (formData.get('parentSlug') as string) || undefined;
        attachToMessageId = (formData.get('attachToMessageId') as string) || undefined;

        if (!file) {
          return c.json({ error: 'Missing file in form data' }, 400);
        }
        if (!slug || !tldr || !sender) {
          return c.json({ error: 'Missing required fields: slug, tldr, sender' }, 400);
        }

        // Convert file to base64
        const arrayBuffer = await file.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        source = { type: 'base64', data: base64 };
      } else {
        // Handle JSON body with base64 data
        const body = await c.req.json();
        slug = body.slug;
        tldr = body.tldr;
        sender = body.sender;
        title = body.title;
        parentSlug = body.parentSlug;
        attachToMessageId = body.attachToMessageId;

        if (!slug || !tldr || !sender) {
          return c.json({ error: 'Missing required fields: slug, tldr, sender' }, 400);
        }

        if (body.data) {
          source = { type: 'base64', data: body.data };
        } else if (body.path) {
          source = { type: 'path', path: body.path };
        } else {
          return c.json({ error: 'Missing file data (provide "data" for base64 or "path" for file path)' }, 400);
        }
      }

      // Normalize slug from raw filename (handles underscores, spaces, etc.)
      slug = slugify(slug);

      // Validate slug format (should always pass after slugify, but safety check)
      const slugValidation = SlugSchema.safeParse(slug);
      if (!slugValidation.success) {
        return c.json({ error: slugValidation.error.errors[0].message }, 400);
      }

      // Validate message exists if attaching to message
      let targetMessage: Awaited<ReturnType<typeof storage.getMessage>> | undefined;
      if (attachToMessageId) {
        targetMessage = await storage.getMessage(spaceId, attachToMessageId);
        if (!targetMessage) {
          return c.json({ error: 'Message not found' }, 404);
        }
        if (targetMessage.channelId !== channel.id) {
          return c.json({ error: 'Message does not belong to this channel' }, 400);
        }
      }

      // Auto-suffix slug on collision (for human uploads)
      let finalSlug = slug;
      const existingArtifact = await storage.getArtifact(channel.id, slug);
      if (existingArtifact) {
        // Extract base name and extension
        const lastDot = slug.lastIndexOf('.');
        const baseName = lastDot > 0 ? slug.slice(0, lastDot) : slug;
        const ext = lastDot > 0 ? slug.slice(lastDot) : '';

        // Find unique slug with counter suffix
        let counter = 2;
        while (await storage.getArtifact(channel.id, `${baseName}-${counter}${ext}`)) {
          counter++;
          if (counter > 100) return c.json({error:'Too many files with this name; choose another filename'},409);
        }
        finalSlug = `${baseName}-${counter}${ext}`;
      }

      // Save asset to filesystem
      const result = await assetStorage.saveAsset({
        channelId: channel.id,
        slug: finalSlug,
        source,
      });

      // Create artifact record
      const artifact = await storage.createArtifact(channel.id, {
        slug: finalSlug,
        channelId: channel.id,
        type: 'asset',
        title,
        tldr,
        content: '', // Binary content is stored separately
        parentSlug,
        status: 'active',
        contentType: result.contentType,
        fileSize: result.fileSize,
        attachedToMessageId: attachToMessageId,
        createdBy: sender,
      });

      // If attaching to message, update message metadata and broadcast
      if (attachToMessageId && targetMessage) {
        const existingMetadata = (targetMessage.metadata || {}) as Record<string, unknown>;
        const existingSlugs = (existingMetadata.attachmentSlugs as string[]) || [];
        const newAttachmentSlugs = [...existingSlugs, finalSlug];

        await storage.updateMessage(spaceId, attachToMessageId, {
          metadata: {
            ...existingMetadata,
            attachmentSlugs: newAttachmentSlugs,
          },
        });

        // Broadcast updated message via WebSocket so clients see the attachment immediately
        const frame = tymbal.set(attachToMessageId, {
          type: targetMessage.type,
          sender: targetMessage.sender,
          senderType: targetMessage.senderType,
          content: targetMessage.content,
          attachmentSlugs: newAttachmentSlugs,
        });
        await connectionManager.broadcast(channel.id, frame);
      }

      return c.json({
        slug: artifact.slug,
        type: artifact.type,
        contentType: result.contentType,
        fileSize: result.fileSize,
        url: `/channels/${channelId}/assets/${finalSlug}`,
      }, 201);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('exceeds maximum')) {
          return c.json({ error: error.message }, 413);
        }
        if (error.message.includes('not found')) {
          return c.json({ error: error.message }, 404);
        }
        if (error.message.includes('already exists')) {
          return c.json({ error: error.message }, 409);
        }
      }
      console.error('[Artifacts] Error uploading asset:', error);
      return c.json({ error: 'Failed to upload asset' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /channels/:channelId/assets/:slug - Serve artifact content
  //
  // Serves different artifact types:
  // - asset: Binary file from asset storage (images, PDFs, etc.)
  // - code: Text content with MIME type from extension (.js, .json, etc.)
  // - other: Text content as text/plain (doc, task, decision, etc.)
  //
  // Uses streaming when available for assets to handle large files.
  // ---------------------------------------------------------------------------
  app.get('/:channelId/assets/:slug', async (c) => {
    const channelId = c.req.param('channelId');
    const slug = c.req.param('slug');

    try {
      const spaceId = getSpaceId(c);
      // Resolve channel by name or ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      // Asset artifacts: serve binary from asset storage
      if (artifact.type === 'asset') {
        if (!assetStorage) {
          return c.json({ error: 'Asset storage not configured' }, 501);
        }

        const mimeType = artifact.contentType || getMimeType(slug);

        // Use streaming if available (S3 backend) to handle large files
        if (assetStorage.readAssetStream) {
          const { stream, contentLength, contentType } = await assetStorage.readAssetStream(channel.id, slug);

          const headers: Record<string, string> = {
            'Content-Type': contentType || mimeType,
            'Cache-Control': 'public, max-age=31536000, immutable',
          };

          if (contentLength !== undefined) {
            headers['Content-Length'] = contentLength.toString();
          }

          return new Response(stream, { headers });
        }

        // Fallback to buffered read for filesystem backend
        const data = await assetStorage.readAsset(channel.id, slug);

        return new Response(data, {
          headers: {
            'Content-Type': mimeType,
            'Content-Length': data.length.toString(),
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      }

      // Code and other artifacts: serve content as text
      const content = artifact.content || '';
      const contentBuffer = new TextEncoder().encode(content);

      // Code artifacts get MIME type from extension, others get text/plain
      const mimeType = artifact.type === 'code' ? getMimeType(slug) : 'text/plain';
      // Fall back to text/plain if no extension match (getMimeType returns application/octet-stream)
      const finalMimeType = mimeType === 'application/octet-stream' ? 'text/plain' : mimeType;

      return new Response(contentBuffer, {
        headers: {
          'Content-Type': finalMimeType + '; charset=utf-8',
          'Content-Length': contentBuffer.length.toString(),
          'Cache-Control': 'no-cache', // Text artifacts can change, don't cache aggressively
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: error.message }, 404);
      }
      console.error('[Artifacts] Error serving artifact:', error);
      return c.json({ error: 'Failed to serve artifact' }, 500);
    }
  });

  return app;
}

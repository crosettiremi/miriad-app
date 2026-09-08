/**
 * Tests for Artifact REST API Routes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createArtifactRoutes, type ArtifactHandlerOptions } from './artifacts.js';
import type { Storage } from '@cast/storage';
import type { ConnectionManager } from '../websocket/index.js';
import type { AssetStorage } from '../assets/index.js';
import type {
  StoredChannel,
  StoredArtifact,
  ArtifactSummary,
  ArtifactTreeNode,
  ArtifactVersion,
  ArtifactCASResult,
} from '@cast/core';

// =============================================================================
// Test Constants
// =============================================================================

const TEST_SPACE_ID = 'space-1';
const TEST_CHANNEL_ID = 'channel-1';
const TEST_CHANNEL_NAME = 'test-channel';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockChannel(): StoredChannel {
  return {
    id: TEST_CHANNEL_ID,
    spaceId: TEST_SPACE_ID,
    name: TEST_CHANNEL_NAME,
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function createMockArtifact(overrides: Partial<StoredArtifact> = {}): StoredArtifact {
  return {
    id: 'artifact-1',
    channelId: TEST_CHANNEL_ID,
    slug: 'test-artifact',
    type: 'doc',
    title: 'Test Artifact',
    tldr: 'A test artifact',
    content: '# Test\n\nThis is test content.',
    path: 'test_artifact',
    status: 'active',
    refs: [],
    assignees: [],
    labels: [],
    props: {},
    createdBy: 'tester',
    updatedBy: 'tester',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createMockArtifactSummary(overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    slug: 'test-artifact',
    path: 'test_artifact',
    type: 'doc',
    title: 'Test Artifact',
    tldr: 'A test artifact',
    status: 'active',
    assignees: [],
    labels: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createMockTreeNode(overrides: Partial<ArtifactTreeNode> = {}): ArtifactTreeNode {
  return {
    slug: 'test-artifact',
    path: 'test_artifact',
    type: 'doc',
    title: 'Test Artifact',
    status: 'active',
    assignees: [],
    children: [],
    ...overrides,
  };
}

function createMockVersion(overrides: Partial<ArtifactVersion> = {}): ArtifactVersion {
  return {
    id: 'version-1',
    artifactId: 'artifact-1',
    versionName: 'v1.0',
    versionMessage: 'Initial version',
    versionCreatedBy: 'tester',
    versionCreatedAt: '2026-01-01T00:00:00Z',
    content: '# Test\n\nOriginal content.',
    tldr: 'A test artifact',
    ...overrides,
  };
}

function createMockConnectionManager(): ConnectionManager {
  return {
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    getChannelConnections: vi.fn(() => []),
    getConnection: vi.fn(),
    broadcast: vi.fn(async () => {}),
    send: vi.fn(),
    getConnectionCount: vi.fn(() => 0),
    getChannelConnectionCount: vi.fn(() => 0),
    closeAll: vi.fn(),
  };
}

function createMockStorage(): Storage {
  const mockChannel = createMockChannel();
  const mockArtifact = createMockArtifact();

  return {
    // Message operations (not used in artifact routes)
    saveMessage: vi.fn(),
    getMessage: vi.fn(),
    getMessages: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),

    // Channel operations
    createChannel: vi.fn(),
    getChannel: vi.fn(async (spaceId: string, channelId: string) => {
      if (channelId === TEST_CHANNEL_ID) return mockChannel;
      return null;
    }),
    getChannelByName: vi.fn(async (spaceId: string, name: string) => {
      if (name === TEST_CHANNEL_NAME) return mockChannel;
      return null;
    }),
    resolveChannel: vi.fn(async (spaceId: string, idOrName: string) => {
      if (idOrName === TEST_CHANNEL_ID || idOrName === TEST_CHANNEL_NAME) return mockChannel;
      return null;
    }),
    getChannelWithRoster: vi.fn(async () => ({ channel: mockChannel, roster: [] })),
    resolveChannelWithRoster: vi.fn(async (spaceId: string, idOrName: string) => {
      if (idOrName === TEST_CHANNEL_ID || idOrName === TEST_CHANNEL_NAME) {
        return { channel: mockChannel, roster: [] };
      }
      return null;
    }),
    listChannels: vi.fn(),
    updateChannel: vi.fn(),
    archiveChannel: vi.fn(),

    // Roster operations
    addToRoster: vi.fn(),
    getRosterEntry: vi.fn(),
    getRosterByCallsign: vi.fn(),
    listRoster: vi.fn(),
    listArchivedRoster: vi.fn(async () => []),
    updateRosterEntry: vi.fn(),
    removeFromRoster: vi.fn(),

    // Artifact operations
    createArtifact: vi.fn(async () => mockArtifact),
    getArtifact: vi.fn(async (_channelId: string, slug: string) => slug === mockArtifact.slug ? mockArtifact : null),
    updateArtifactWithCAS: vi.fn(async (): Promise<ArtifactCASResult> => ({
      success: true,
      artifact: mockArtifact,
    })),
    editArtifact: vi.fn(async () => mockArtifact),
    archiveArtifact: vi.fn(async () => ({ ...mockArtifact, status: 'archived' as const })),
    archiveArtifactRecursive: vi.fn(async () => ({ archived: [{ slug: 'test-artifact', previousStatus: 'active' }] })),
    listArtifacts: vi.fn(async () => [createMockArtifactSummary()]),
    globArtifacts: vi.fn(async () => [createMockTreeNode()]),
    checkpointArtifact: vi.fn(async () => createMockVersion()),
    getArtifactVersion: vi.fn(async () => createMockVersion()),
    listArtifactVersions: vi.fn(async () => [createMockVersion()]),
    diffArtifactVersions: vi.fn(async () => '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new'),

    // Lifecycle
    initialize: vi.fn(),
    close: vi.fn(),
  } as Storage;
}

function createMockAssetStorage(): AssetStorage {
  return {
    saveAsset: vi.fn(async ({ channelId, slug }) => ({
      filePath: `/tmp/.cast-dev/assets/${channelId}/${slug}`,
      contentType: 'image/png',
      fileSize: 1024,
    })),
    readAsset: vi.fn(async () => Buffer.from('fake binary data')),
    assetExists: vi.fn(async () => false),
    deleteAsset: vi.fn(async () => {}),
    getAssetPath: vi.fn((channelId, slug) => `/tmp/.cast-dev/assets/${channelId}/${slug}`),
  };
}

// =============================================================================
// Test Setup
// =============================================================================

describe('Artifact Routes', () => {
  let app: Hono;
  let mockStorage: Storage;
  let mockConnectionManager: ConnectionManager;
  let mockAssetStorage: AssetStorage;

  beforeEach(() => {
    mockStorage = createMockStorage();
    mockConnectionManager = createMockConnectionManager();
    mockAssetStorage = createMockAssetStorage();

    const options: ArtifactHandlerOptions = {
      storage: mockStorage,
      spaceId: TEST_SPACE_ID,
      connectionManager: mockConnectionManager,
      assetStorage: mockAssetStorage,
    };

    const routes = createArtifactRoutes(options);
    app = new Hono();
    app.route('/channels', routes);
  });

  // ===========================================================================
  // GET /channels/:channelId/artifacts/tree
  // ===========================================================================

  describe('GET /channels/:channelId/artifacts/tree', () => {
    it('returns artifact tree with default pattern', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/tree`);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.tree).toBeDefined();
      expect(json.tree).toHaveLength(1);
      expect(mockStorage.globArtifacts).toHaveBeenCalledWith(TEST_CHANNEL_ID, '/**');
    });

    it('respects pattern query parameter', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/tree?pattern=/auth/**`);

      expect(res.status).toBe(200);
      expect(mockStorage.globArtifacts).toHaveBeenCalledWith(TEST_CHANNEL_ID, '/auth/**');
    });

    it('returns text format when requested', async () => {
      vi.mocked(mockStorage.globArtifacts).mockResolvedValueOnce([
        createMockTreeNode({ slug: 'parent', type: 'doc', children: [
          createMockTreeNode({ slug: 'child', type: 'task', status: 'in_progress', assignees: ['fox'] }),
        ]}),
      ]);

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/tree?format=text`);

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('/parent');
      expect(text).toContain('/child');
      expect(text).toContain(':task');
      expect(text).toContain('@fox');
    });

    it('resolves channel by name', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_NAME}/artifacts/tree`);

      expect(res.status).toBe(200);
      expect(mockStorage.resolveChannel).toHaveBeenCalledWith(TEST_SPACE_ID, TEST_CHANNEL_NAME);
    });

    it('returns 404 for unknown channel', async () => {
      const res = await app.request('/channels/unknown-channel/artifacts/tree');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Channel not found');
    });
  });

  // ===========================================================================
  // GET /channels/:channelId/artifacts
  // ===========================================================================

  describe('GET /channels/:channelId/artifacts', () => {
    it('returns artifact list', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts`);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.artifacts).toBeDefined();
      expect(json.artifacts).toHaveLength(1);
    });

    it('passes type filter to storage', async () => {
      await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts?type=task`);

      expect(mockStorage.listArtifacts).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({ type: 'task' })
      );
    });

    it('passes status filter to storage', async () => {
      await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts?status=in_progress`);

      expect(mockStorage.listArtifacts).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({ status: 'in_progress' })
      );
    });

    it('passes assignee filter to storage', async () => {
      await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts?assignee=fox`);

      expect(mockStorage.listArtifacts).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({ assignee: 'fox' })
      );
    });

    it('passes search filter to storage', async () => {
      await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts?search=auth`);

      expect(mockStorage.listArtifacts).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({ search: 'auth' })
      );
    });

    it('passes pagination to storage', async () => {
      await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts?limit=10&offset=20`);

      expect(mockStorage.listArtifacts).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({ limit: 10, offset: 20 })
      );
    });

    it('validates limit range', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts?limit=1000`);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('validation_error');
    });

    it('returns 404 for unknown channel', async () => {
      const res = await app.request('/channels/unknown-channel/artifacts');

      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // GET /channels/:channelId/artifacts/:slug
  // ===========================================================================

  describe('GET /channels/:channelId/artifacts/:slug', () => {
    it('returns artifact with versions list', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact`);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.slug).toBe('test-artifact');
      expect(json.versions).toBeDefined();
      expect(json.versions).toHaveLength(1);
    });

    it('returns specific version when requested', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact?version=v1.0`);

      expect(res.status).toBe(200);
      expect(mockStorage.getArtifactVersion).toHaveBeenCalledWith(TEST_CHANNEL_ID, 'test-artifact', 'v1.0');
    });

    it('returns 404 for unknown artifact', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(null);

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/unknown`);

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain('not found');
    });

    it('returns 404 for unknown version', async () => {
      vi.mocked(mockStorage.getArtifactVersion).mockResolvedValueOnce(null);

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact?version=unknown`);

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain('Version');
    });
  });

  // ===========================================================================
  // POST /channels/:channelId/artifacts
  // ===========================================================================

  describe('POST /channels/:channelId/artifacts', () => {
    const validBody = {
      slug: 'new-artifact',
      type: 'doc',
      tldr: 'A new artifact',
      content: '# New\n\nContent here.',
      sender: 'tester',
    };

    it('creates artifact successfully', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(null); // artifact doesn't exist yet

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(201);
      expect(mockStorage.createArtifact).toHaveBeenCalled();
      expect(mockConnectionManager.broadcast).toHaveBeenCalled();
    });

    it('accepts optional fields', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(null);

      const bodyWithOptionals = {
        ...validBody,
        title: 'New Title',
        parentSlug: 'parent-artifact',
        status: 'draft',
        assignees: ['fox', 'bear'],
        labels: ['feature'],
        props: { priority: 'high' },
      };

      await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyWithOptionals),
      });

      expect(mockStorage.createArtifact).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({
          title: 'New Title',
          parentSlug: 'parent-artifact',
          status: 'draft',
          assignees: ['fox', 'bear'],
          labels: ['feature'],
          props: { priority: 'high' },
        })
      );
    });

    it('returns 409 when artifact already exists without replace flag', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(createMockArtifact({slug:'new-artifact'}));
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain('already exists');
    });

    it('replaces artifact when replace flag is true', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(createMockArtifact({slug:'new-artifact'}));
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, replace: true }),
      });

      expect(res.status).toBe(201);
      expect(mockStorage.archiveArtifact).toHaveBeenCalled();
      expect(mockStorage.createArtifact).toHaveBeenCalled();
    });

    it('returns 404 when replace is true but artifact does not exist', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(null);

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, replace: true }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain('Cannot replace');
    });

    it('validates required fields', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'test' }), // missing type, tldr, content, sender
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('validation_error');
      expect(json.details.length).toBeGreaterThan(0);
    });

    it('validates slug format', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, slug: 'Invalid Slug!' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('validation_error');
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Invalid JSON body');
    });
  });

  // ===========================================================================
  // PATCH /channels/:channelId/artifacts/:slug
  // ===========================================================================

  describe('PATCH /channels/:channelId/artifacts/:slug', () => {
    it('updates artifact with CAS', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [{ field: 'status', old_value: 'active', new_value: 'archived' }],
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(200);
      expect(mockStorage.updateArtifactWithCAS).toHaveBeenCalled();
      expect(mockConnectionManager.broadcast).toHaveBeenCalled();
    });

    it('accepts camelCase field names', async () => {
      await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [{ field: 'status', oldValue: 'active', newValue: 'archived' }],
          sender: 'tester',
        }),
      });

      expect(mockStorage.updateArtifactWithCAS).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        'test-artifact',
        expect.arrayContaining([
          expect.objectContaining({
            field: 'status',
            oldValue: 'active',
            newValue: 'archived',
          }),
        ]),
        'tester'
      );
    });

    it('returns 409 on CAS conflict', async () => {
      vi.mocked(mockStorage.updateArtifactWithCAS).mockResolvedValueOnce({
        success: false,
        conflict: { field: 'status', expected: 'active', actual: 'draft' },
      });

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [{ field: 'status', old_value: 'active', new_value: 'archived' }],
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe('conflict');
      expect(json.conflict).toBeDefined();
    });

    it('validates at least one change is provided', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [],
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown artifact', async () => {
      vi.mocked(mockStorage.updateArtifactWithCAS).mockRejectedValueOnce(new Error('Artifact not found'));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/unknown`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [{ field: 'status', old_value: 'active', new_value: 'archived' }],
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // POST /channels/:channelId/artifacts/:slug/edit
  // ===========================================================================

  describe('POST /channels/:channelId/artifacts/:slug/edit', () => {
    it('performs surgical edit', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          old_string: 'old text',
          new_string: 'new text',
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(200);
      expect(mockStorage.editArtifact).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        'test-artifact',
        expect.objectContaining({
          oldString: 'old text',
          newString: 'new text',
          updatedBy: 'tester',
        })
      );
      expect(mockConnectionManager.broadcast).toHaveBeenCalled();
    });

    it('returns 404 when old_string not found', async () => {
      vi.mocked(mockStorage.editArtifact).mockRejectedValueOnce(new Error('old_string not found'));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          old_string: 'nonexistent',
          new_string: 'new',
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain('old_string not found');
    });

    it('returns 409 when old_string is ambiguous', async () => {
      vi.mocked(mockStorage.editArtifact).mockRejectedValueOnce(new Error('old_string matches multiple times'));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          old_string: 'the',
          new_string: 'a',
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain('multiple');
    });

    it('validates required fields', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_string: 'new',
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  // DELETE /channels/:channelId/artifacts/:slug
  // ===========================================================================

  describe('DELETE /channels/:channelId/artifacts/:slug', () => {
    it('archives artifact', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact?sender=tester`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.archived).toBe(true);
      expect(json.artifact).toBeDefined();
      expect(mockStorage.archiveArtifact).toHaveBeenCalledWith(TEST_CHANNEL_ID, 'test-artifact', 'tester');
      expect(mockConnectionManager.broadcast).toHaveBeenCalled();
    });

    it('uses system as default sender', async () => {
      await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact`, {
        method: 'DELETE',
      });

      expect(mockStorage.archiveArtifact).toHaveBeenCalledWith(TEST_CHANNEL_ID, 'test-artifact', 'system');
    });

    it('returns 404 for unknown artifact', async () => {
      vi.mocked(mockStorage.archiveArtifact).mockRejectedValueOnce(new Error('Artifact not found'));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/unknown`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // POST /channels/:channelId/artifacts/:slug/versions
  // ===========================================================================

  describe('POST /channels/:channelId/artifacts/:slug/versions', () => {
    it('creates version checkpoint', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 'v2.0',
          message: 'Updated content',
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(201);
      expect(mockStorage.checkpointArtifact).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        'test-artifact',
        expect.objectContaining({
          versionName: 'v2.0',
          versionMessage: 'Updated content',
          createdBy: 'tester',
        })
      );
    });

    it('returns 404 for unknown artifact', async () => {
      vi.mocked(mockStorage.checkpointArtifact).mockRejectedValueOnce(new Error('Artifact not found'));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/unknown/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 'v1.0',
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 409 when version already exists', async () => {
      vi.mocked(mockStorage.checkpointArtifact).mockRejectedValueOnce(new Error('Version already exists'));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 'v1.0',
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toContain('already exists');
    });
  });

  // ===========================================================================
  // GET /channels/:channelId/artifacts/:slug/versions
  // ===========================================================================

  describe('GET /channels/:channelId/artifacts/:slug/versions', () => {
    it('returns version list', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/versions`);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.versions).toBeDefined();
      expect(json.versions).toHaveLength(1);
    });

    it('returns 404 for unknown artifact', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(null);

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/unknown/versions`);

      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // GET /channels/:channelId/artifacts/:slug/diff
  // ===========================================================================

  describe('GET /channels/:channelId/artifacts/:slug/diff', () => {
    it('returns diff between versions', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/diff?from=v1.0&to=v2.0`);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.diff).toBeDefined();
      expect(mockStorage.diffArtifactVersions).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        'test-artifact',
        'v1.0',
        'v2.0'
      );
    });

    it('compares to current when to is omitted', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/diff?from=v1.0`);

      expect(res.status).toBe(200);
      expect(mockStorage.diffArtifactVersions).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        'test-artifact',
        'v1.0',
        undefined
      );
    });

    it('returns 400 when from is missing', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/diff`);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('from');
    });

    it('returns 404 for unknown version', async () => {
      vi.mocked(mockStorage.diffArtifactVersions).mockRejectedValueOnce(new Error("Version 'unknown' not found"));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/artifacts/test-artifact/diff?from=unknown`);

      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  // POST /channels/:channelId/assets (Upload)
  // ===========================================================================

  describe('POST /channels/:channelId/assets', () => {
    it('uploads asset with base64 JSON body', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(null); // no existing artifact
      vi.mocked(mockStorage.createArtifact).mockResolvedValueOnce(createMockArtifact({
        slug: 'test-image.png',
        type: 'asset',
        encoding: 'file',
        contentType: 'image/png',
        fileSize: 1024,
      }));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'test-image.png',
          tldr: 'A test image',
          sender: 'tester',
          data: Buffer.from('fake png data').toString('base64'),
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.slug).toBe('test-image.png');
      expect(json.contentType).toBe('image/png');
      expect(json.url).toContain('/assets/');
      expect(mockAssetStorage.saveAsset).toHaveBeenCalled();
      expect(mockStorage.createArtifact).toHaveBeenCalledWith(
        TEST_CHANNEL_ID,
        expect.objectContaining({
          type: 'asset',
          contentType: 'image/png',
          fileSize: 1024,
        })
      );
    });

    it('uploads asset with path', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(null);
      vi.mocked(mockStorage.createArtifact).mockResolvedValueOnce(createMockArtifact({
        type: 'asset',
      }));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'doc.pdf',
          tldr: 'A document',
          sender: 'tester',
          path: '/tmp/document.pdf',
        }),
      });

      expect(res.status).toBe(201);
      expect(mockAssetStorage.saveAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          source: { type: 'path', path: '/tmp/document.pdf' },
        })
      );
    });

    it('returns 400 when slug is missing', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tldr: 'A test',
          sender: 'tester',
          data: 'abc',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('required');
    });

    it('returns 400 when neither data nor path provided', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'test.png',
          tldr: 'A test',
          sender: 'tester',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Missing file data');
    });

    it('normalizes uploaded filenames', async () => {
      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'Invalid Slug!',
          tldr: 'A test',
          sender: 'tester',
          data: 'abc',
        }),
      });

      expect(res.status).toBe(201);
      expect(mockAssetStorage.saveAsset).toHaveBeenCalledWith(expect.objectContaining({slug:'invalid-slug'}));
    });

    it('returns 413 when file exceeds size limit', async () => {
      vi.mocked(mockAssetStorage.saveAsset).mockRejectedValueOnce(
        new Error('File exceeds maximum allowed size')
      );

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'large.bin',
          tldr: 'A large file',
          sender: 'tester',
          data: 'abc',
        }),
      });

      expect(res.status).toBe(413);
    });

    it('returns 501 when assetStorage not configured', async () => {
      // Create routes without asset storage
      const routesWithoutAssets = createArtifactRoutes({
        storage: mockStorage,
        spaceId: TEST_SPACE_ID,
        connectionManager: mockConnectionManager,
        // assetStorage omitted
      });
      const testApp = new Hono();
      testApp.route('/channels', routesWithoutAssets);

      const res = await testApp.request(`/channels/${TEST_CHANNEL_ID}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'test.png',
          tldr: 'A test',
          sender: 'tester',
          data: 'abc',
        }),
      });

      expect(res.status).toBe(501);
      const json = await res.json();
      expect(json.error).toContain('not configured');
    });
  });

  // ===========================================================================
  // GET /channels/:channelId/assets/:slug (Serve)
  // ===========================================================================

  describe('GET /channels/:channelId/assets/:slug', () => {
    it('serves asset file', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(createMockArtifact({
        type: 'asset',
        encoding: 'file',
        contentType: 'image/png',
      }));
      vi.mocked(mockAssetStorage.readAsset).mockResolvedValueOnce(Buffer.from('binary data'));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets/test-image.png`);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      expect(res.headers.get('Cache-Control')).toContain('immutable');
      const body = await res.arrayBuffer();
      expect(Buffer.from(body).toString()).toBe('binary data');
    });

    it('returns 404 for unknown asset', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(null);

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets/unknown.png`);

      expect(res.status).toBe(404);
    });

    it('serves non-asset artifacts as text/plain', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(createMockArtifact({
        type: 'doc',
        content: '# Hello World\n\nThis is a document.',
      }));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets/readme`);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      const text = await res.text();
      expect(text).toBe('# Hello World\n\nThis is a document.');
    });

    it('serves code artifacts with MIME type from extension', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(createMockArtifact({
        type: 'code',
        content: '{"key": "value"}',
      }));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets/data.json`);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      const text = await res.text();
      expect(text).toBe('{"key": "value"}');
    });

    it('returns 501 for asset type when assetStorage not configured', async () => {
      const routesWithoutAssets = createArtifactRoutes({
        storage: mockStorage,
        spaceId: TEST_SPACE_ID,
        connectionManager: mockConnectionManager,
      });
      const testApp = new Hono();
      testApp.route('/channels', routesWithoutAssets);

      // Mock returns an asset type - should fail without storage
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(createMockArtifact({
        type: 'asset',
        encoding: 'file',
      }));

      const res = await testApp.request(`/channels/${TEST_CHANNEL_ID}/assets/test.png`);

      expect(res.status).toBe(501);
    });

    it('serves code artifacts without assetStorage configured', async () => {
      const routesWithoutAssets = createArtifactRoutes({
        storage: mockStorage,
        spaceId: TEST_SPACE_ID,
        connectionManager: mockConnectionManager,
      });
      const testApp = new Hono();
      testApp.route('/channels', routesWithoutAssets);

      // Mock returns a code artifact - should work without asset storage
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(createMockArtifact({
        type: 'code',
        content: 'console.log("hello")',
      }));

      const res = await testApp.request(`/channels/${TEST_CHANNEL_ID}/assets/script.js`);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    });

    it('falls back to MIME type from slug if contentType not stored', async () => {
      vi.mocked(mockStorage.getArtifact).mockResolvedValueOnce(createMockArtifact({
        type: 'asset',
        encoding: 'file',
        contentType: undefined, // not stored
      }));
      vi.mocked(mockAssetStorage.readAsset).mockResolvedValueOnce(Buffer.from('pdf data'));

      const res = await app.request(`/channels/${TEST_CHANNEL_ID}/assets/document.pdf`);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
    });
  });
});

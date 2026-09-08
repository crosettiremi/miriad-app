import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createMcpRoutes } from './mcp-http.js';
import { generateContainerToken } from '../auth/container-token.js';
import type { Storage } from '@cast/storage';
import type { StoredMessage, StoredChannel } from '@cast/core';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_SPACE_ID = 'test-space';
const TEST_CHANNEL_ID = '01ABCDEFGH123456789012345'; // ULID-style ID
const TEST_CHANNEL_NAME = 'test-channel';
const TEST_CALLSIGN = 'test-agent';

const testChannel: StoredChannel = {
  id: TEST_CHANNEL_ID,
  spaceId: TEST_SPACE_ID,
  name: TEST_CHANNEL_NAME,
  tagline: 'Test workspace',
  mission: 'Testing MCP',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const testMessages: StoredMessage[] = [
  {
    id: 'msg-1',
    spaceId: TEST_SPACE_ID,
    channelId: TEST_CHANNEL_ID,
    sender: 'fox',
    senderType: 'agent',
    type: 'message',
    content: 'Hello from fox',
    timestamp: '2026-01-01T00:00:00Z',
    isComplete: true,
  },
  {
    id: 'msg-2',
    spaceId: TEST_SPACE_ID,
    channelId: TEST_CHANNEL_ID,
    sender: 'bear',
    senderType: 'agent',
    type: 'message',
    content: 'Hello from bear',
    timestamp: '2026-01-01T00:01:00Z',
    isComplete: true,
  },
  {
    id: 'msg-3',
    spaceId: TEST_SPACE_ID,
    channelId: TEST_CHANNEL_ID,
    sender: 'fox',
    senderType: 'agent',
    type: 'message',
    content: 'Testing search functionality',
    timestamp: '2026-01-01T00:02:00Z',
    isComplete: true,
  },
];

// =============================================================================
// Mock Storage
// =============================================================================

function createMockStorage(): Storage {
  return {
    // Space and User operations
    getSpace: vi.fn(async () => ({
      id: TEST_SPACE_ID,
      name: 'Test Space',
      ownerId: 'user-1',
      createdAt: '2026-01-01T00:00:00Z',
    })),
    getUser: vi.fn(async () => ({
      id: 'user-1',
      callsign: 'simen',
      email: 'simen@example.com',
    })),

    // Channel operations
    getChannel: vi.fn(async (spaceId: string, channelId: string) => {
      if (channelId === TEST_CHANNEL_ID) return testChannel;
      return null;
    }),
    getChannelByName: vi.fn(async (spaceId: string, name: string) => {
      if (name === TEST_CHANNEL_NAME) return testChannel;
      return null;
    }),
    getChannelById: vi.fn(async (channelId: string) => {
      if (channelId === TEST_CHANNEL_ID) return testChannel;
      return null;
    }),
    resolveChannel: vi.fn(async (spaceId: string, idOrName: string) => {
      if (idOrName === TEST_CHANNEL_NAME || idOrName === TEST_CHANNEL_ID) return testChannel;
      return null;
    }),
    getChannelWithRoster: vi.fn(async () => null),
    resolveChannelWithRoster: vi.fn(async () => null),
    listChannels: vi.fn(async () => []),
    createChannel: vi.fn(async () => testChannel),
    updateChannel: vi.fn(async () => {}),
    archiveChannel: vi.fn(async () => {}),

    // Message operations
    getMessages: vi.fn(async (spaceId: string, channelId: string, params?: { limit?: number }) => {
      if (channelId === TEST_CHANNEL_ID) {
        const limit = params?.limit ?? 50;
        return testMessages.slice(0, limit);
      }
      return [];
    }),
    getMessage: vi.fn(async () => null),
    getMessagesByChannelId: vi.fn(async () => []),
    saveMessage: vi.fn(async () => testMessages[0]),
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),

    // Roster operations
    addToRoster: vi.fn(async () => ({
      id: 'roster-1',
      channelId: TEST_CHANNEL_ID,
      callsign: TEST_CALLSIGN,
      agentType: 'engineer',
      status: 'active' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    getRosterEntry: vi.fn(async () => null),
    getRosterByCallsign: vi.fn(async () => null),
    listRoster: vi.fn(async () => []),
    listArchivedRoster: vi.fn(async () => []),
    updateRosterEntry: vi.fn(async () => {}),
    removeFromRoster: vi.fn(async () => {}),

    // Artifact operations (Phase A)
    createArtifact: vi.fn(async () => ({
      id: 'artifact-1',
      channelId: TEST_CHANNEL_ID,
      slug: 'test-artifact',
      type: 'doc' as const,
      title: 'Test Artifact',
      tldr: 'Test summary',
      content: '# Test',
      path: 'test_artifact',
      orderKey: '0',
      status: 'draft' as const,
      assignees: [],
      labels: [],
      refs: [],
      version: 1,
      createdBy: TEST_CALLSIGN,
      createdAt: '2026-01-01T00:00:00Z',
    })),
    getArtifact: vi.fn(async () => null), // Default: not found
    updateArtifactWithCAS: vi.fn(async () => ({
      success: true,
      artifact: {
        id: 'artifact-1',
        channelId: TEST_CHANNEL_ID,
        slug: 'test-artifact',
        type: 'doc' as const,
        content: '# Test',
        path: 'test_artifact',
        orderKey: '0',
        status: 'done' as const,
        assignees: [],
        labels: [],
        refs: [],
        version: 2,
        createdBy: TEST_CALLSIGN,
        createdAt: '2026-01-01T00:00:00Z',
        updatedBy: TEST_CALLSIGN,
        updatedAt: '2026-01-01T00:01:00Z',
      },
    })),
    editArtifact: vi.fn(async () => ({
      id: 'artifact-1',
      channelId: TEST_CHANNEL_ID,
      slug: 'test-artifact',
      type: 'doc' as const,
      content: '# Updated',
      path: 'test_artifact',
      orderKey: '0',
      status: 'draft' as const,
      assignees: [],
      labels: [],
      refs: [],
      version: 2,
      createdBy: TEST_CALLSIGN,
      createdAt: '2026-01-01T00:00:00Z',
      updatedBy: TEST_CALLSIGN,
      updatedAt: '2026-01-01T00:01:00Z',
    })),
    archiveArtifact: vi.fn(async () => ({
      id: 'artifact-1',
      channelId: TEST_CHANNEL_ID,
      slug: 'test-artifact',
      type: 'doc' as const,
      content: '# Test',
      path: 'test_artifact',
      orderKey: '0',
      status: 'archived' as const,
      assignees: [],
      labels: [],
      refs: [],
      version: 2,
      createdBy: TEST_CALLSIGN,
      createdAt: '2026-01-01T00:00:00Z',
      updatedBy: TEST_CALLSIGN,
      updatedAt: '2026-01-01T00:01:00Z',
    })),
    listArtifacts: vi.fn(async () => []),
    listPublishedKnowledgeBases: vi.fn(async () => []),
    globArtifacts: vi.fn(async () => []),
    checkpointArtifact: vi.fn(async () => ({
      slug: 'test-artifact',
      channelId: TEST_CHANNEL_ID,
      versionName: 'v1.0',
      versionMessage: 'Initial version',
      tldr: 'Test summary',
      content: '# Test',
      versionCreatedBy: TEST_CALLSIGN,
      versionCreatedAt: '2026-01-01T00:00:00Z',
    })),
    getArtifactVersion: vi.fn(async () => null),
    listArtifactVersions: vi.fn(async () => []),
    diffArtifactVersions: vi.fn(async () => ''),

    // Lifecycle
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

function jsonRpcRequest(method: string, params?: Record<string, unknown>, id: number | string = 1) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('MCP HTTP Routes (JSON-RPC)', () => {
  let app: Hono;
  let mockStorage: Storage;
  let token: string;

  beforeEach(() => {
    mockStorage = createMockStorage();

    const mcpRoutes = createMcpRoutes({
      storage: mockStorage,
      spaceId: TEST_SPACE_ID,
    });

    app = new Hono();
    app.route('/mcp', mcpRoutes);

    // Generate a valid container token
    token = generateContainerToken({
      spaceId: TEST_SPACE_ID,
      channelId: TEST_CHANNEL_ID,
      callsign: TEST_CALLSIGN,
    });
  });

  describe('Authentication', () => {
    it('rejects requests without Authorization header', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('Missing Authorization header');
    });

    it('rejects requests with invalid token format', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid' },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Invalid Authorization format');
    });

    it('rejects requests with invalid token', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: { Authorization: 'Container invalid.token' },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('Invalid container token');
    });
  });

  describe('JSON-RPC Protocol', () => {
    it('rejects invalid JSON', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: 'not json',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe('2.0');
      expect(json.error.code).toBe(-32700); // Parse error
    });

    it('rejects missing jsonrpc version', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 1, method: 'tools/list' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error.code).toBe(-32600); // Invalid request
    });

    it('rejects missing method', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error.code).toBe(-32600); // Invalid request
    });

    it('rejects missing id', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error.code).toBe(-32600); // Invalid request
    });

    it('rejects unknown method', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('unknown/method'),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error.code).toBe(-32601); // Method not found
    });
  });

  describe('Channel Resolution', () => {
    it('resolves channel by name', async () => {
      const res = await app.request(`/mcp/${TEST_CHANNEL_NAME}`, {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(200);
      expect(mockStorage.resolveChannel).toHaveBeenCalledWith(TEST_SPACE_ID, TEST_CHANNEL_NAME);
    });

    it('resolves channel by ID when name lookup fails', async () => {
      const res = await app.request(`/mcp/${TEST_CHANNEL_ID}`, {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(200);
      // resolveChannel handles both name and ID resolution in a single call
      expect(mockStorage.resolveChannel).toHaveBeenCalledWith(TEST_SPACE_ID, TEST_CHANNEL_ID);
    });

    it('returns 404 for non-existent channel', async () => {
      const res = await app.request('/mcp/non-existent', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Channel not found');
    });
  });

  describe('tools/list', () => {
    it('returns all tool definitions', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.jsonrpc).toBe('2.0');
      expect(json.id).toBe(1);
      expect(json.result.tools).toBeDefined();
      expect(Array.isArray(json.result.tools)).toBe(true);
      expect(json.result.tools.length).toBe(24); // Includes structured_ask alongside the original tool set

      // Verify tool names
      const toolNames = json.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('artifact_create');
      expect(toolNames).toContain('artifact_read');
      expect(toolNames).toContain('artifact_list');
      expect(toolNames).toContain('artifact_glob');
      expect(toolNames).toContain('artifact_update');
      expect(toolNames).toContain('artifact_edit');
      expect(toolNames).toContain('artifact_archive');
      expect(toolNames).toContain('artifact_checkpoint');
      expect(toolNames).toContain('artifact_diff');
      expect(toolNames).toContain('message_get');
      expect(toolNames).toContain('message_search');
      expect(toolNames).toContain('read_instructions');
      expect(toolNames).toContain('send_message');
      expect(toolNames).toContain('set_status');
      expect(toolNames).toContain('get_roster');
      expect(toolNames).toContain('get_messages');
      expect(toolNames).toContain('list_agent_types');
      expect(toolNames).toContain('explain_artifact_type');
    });

    it('includes proper inputSchema for each tool', async () => {
      const res = await app.request('/mcp/test-channel', {
        method: 'POST',
        headers: {
          Authorization: `Container ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonRpcRequest('tools/list'),
      });

      const json = await res.json();
      for (const tool of json.result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });
  });

  describe('tools/call', () => {
    describe('message_get', () => {
      it('returns messages from storage', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'message_get', arguments: { limit: 10 } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.jsonrpc).toBe('2.0');
        expect(json.result.isError).toBeUndefined();
        expect(json.result.content).toHaveLength(1);
        expect(json.result.content[0].type).toBe('text');

        const result = JSON.parse(json.result.content[0].text);
        expect(result.count).toBe(3);
        expect(result.messages).toHaveLength(3);
        expect(result.messages[0].sender).toBe('fox');
      });

      it('respects limit parameter', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'message_get', arguments: { limit: 2 } }),
        });

        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);
        expect(result.count).toBe(2);
      });
    });

    describe('message_search', () => {
      it('filters messages by sender', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'message_search', arguments: { sender: 'fox' } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);
        expect(result.count).toBe(2);
        expect(result.messages.every((m: { sender: string }) => m.sender === 'fox')).toBe(true);
      });

      it('filters messages by query', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'message_search', arguments: { query: 'search' } }),
        });

        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);
        expect(result.count).toBe(1);
        expect(result.messages[0].content).toContain('search');
      });
    });

    describe('artifact reads (stubs)', () => {
      it('artifact_list returns empty array', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'artifact_list', arguments: {} }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.artifacts).toEqual([]);
      });

      it('artifact_glob returns empty tree', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'artifact_glob', arguments: { pattern: '/**' } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.content[0].text).toBe('(empty)');
      });

      it('artifact_read returns not found error', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'artifact_read', arguments: { slug: 'test-artifact' } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBe(true);
        expect(json.result.content[0].text).toContain('Artifact not found');
      });
    });

    describe('artifact writes', () => {
      it('artifact_create creates and returns artifact', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'artifact_create',
            arguments: {
              slug: 'test',
              type: 'doc',
              tldr: 'Test document',
              content: '# Test',
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.slug).toBe('test-artifact');
        expect(result.type).toBe('doc');
        expect(mockStorage.createArtifact).toHaveBeenCalled();
      });

      it('artifact_update updates artifact with CAS', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'artifact_update',
            arguments: {
              slug: 'test',
              changes: [{ field: 'status', old_value: 'pending', new_value: 'done' }],
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.success).toBe(true);
        expect(mockStorage.updateArtifactWithCAS).toHaveBeenCalled();
      });

      it('artifact_edit performs surgical edit', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'artifact_edit',
            arguments: {
              slug: 'test',
              old_string: 'old',
              new_string: 'new',
            },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.slug).toBe('test-artifact');
        expect(result.version).toBe(2);
        expect(mockStorage.editArtifact).toHaveBeenCalled();
      });

      it('artifact_archive archives artifact', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'artifact_archive', arguments: { slug: 'test' } }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.isError).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.slug).toBe('test-artifact');
        expect(result.status).toBe('archived');
        expect(mockStorage.archiveArtifact).toHaveBeenCalled();
      });
    });

    describe('read_instructions', () => {
      it('returns instruction content for valid article', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'read_instructions',
            arguments: { article: 'interactive-artifacts' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error).toBeUndefined();
        expect(json.result).toBeDefined();
        expect(json.result.content).toHaveLength(1);
        expect(json.result.content[0].type).toBe('text');
        // Content should include key interactive artifact info
        expect(json.result.content[0].text).toContain('.app.js');
        expect(json.result.content[0].text).toContain('render');
      });

      it('returns instruction content for system-mcp article', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'read_instructions',
            arguments: { article: 'system-mcp' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error).toBeUndefined();
        expect(json.result.content[0].text).toContain('MCP');
      });

      it('returns error for unknown article', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'read_instructions',
            arguments: { article: 'nonexistent-article' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.result.content[0].text).toContain('Unknown article');
        expect(json.result.content[0].text).toContain('nonexistent-article');
      });
    });

    describe('get_roster', () => {
      it('returns roster with active agents and excludes archived', async () => {
        // Mock listRoster to return mixed status entries
        mockStorage.listRoster.mockResolvedValueOnce([
          {
            id: 'roster-1',
            channelId: TEST_CHANNEL_ID,
            callsign: 'fox',
            agentType: 'builder',
            status: 'active',
            createdAt: '2026-01-10T00:00:00Z',
            current: { status: 'implementing auth' },
          },
          {
            id: 'roster-2',
            channelId: TEST_CHANNEL_ID,
            callsign: 'owl',
            agentType: 'reviewer',
            status: 'paused',
            createdAt: '2026-01-10T00:00:00Z',
          },
          {
            id: 'roster-3',
            channelId: TEST_CHANNEL_ID,
            callsign: 'bear',
            agentType: 'tester',
            status: 'archived',
            createdAt: '2026-01-10T00:00:00Z',
          },
        ]);

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'get_roster',
            arguments: {},
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.channel).toBe(TEST_CHANNEL_NAME);
        expect(result.agents).toHaveLength(2); // Excludes archived bear

        // Check fox (active with statusMessage)
        const fox = result.agents.find((a: { callsign: string }) => a.callsign === 'fox');
        expect(fox.agentType).toBe('builder');
        expect(fox.status).toBe('active');
        expect(fox.statusMessage).toBe('implementing auth');

        // Check owl (paused, no statusMessage)
        const owl = result.agents.find((a: { callsign: string }) => a.callsign === 'owl');
        expect(owl.agentType).toBe('reviewer');
        expect(owl.status).toBe('paused');
        expect(owl.statusMessage).toBeUndefined();

        // Hint includes counts and status
        expect(result.hint).toContain('2 agents');
        expect(result.hint).toContain('1 active');
        expect(result.hint).toContain('1 paused');
        expect(result.hint).toContain('@fox: implementing auth');
      });

      it('returns empty roster when no agents', async () => {
        mockStorage.listRoster.mockResolvedValueOnce([]);

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'get_roster',
            arguments: {},
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);
        expect(result.agents).toHaveLength(0);
        expect(result.hint).toBe('0 agents');
      });
    });

    describe('get_messages', () => {
      it('returns messages in chronological order with senderType mapping', async () => {
        // Mock getMessages to return messages with various senderTypes
        mockStorage.getMessages.mockResolvedValueOnce([
          {
            id: 'msg-001',
            spaceId: TEST_SPACE_ID,
            channelId: TEST_CHANNEL_ID,
            sender: 'simen',
            senderType: 'user',
            type: 'user',
            content: 'Hello team',
            timestamp: '2026-01-10T14:00:00Z',
            isComplete: true,
          },
          {
            id: 'msg-002',
            spaceId: TEST_SPACE_ID,
            channelId: TEST_CHANNEL_ID,
            sender: 'fox',
            senderType: 'agent',
            type: 'agent',
            content: 'On it!',
            timestamp: '2026-01-10T14:01:00Z',
            isComplete: true,
          },
          {
            id: 'msg-003',
            spaceId: TEST_SPACE_ID,
            channelId: TEST_CHANNEL_ID,
            sender: 'system',
            senderType: 'system',
            type: 'system',
            content: '@fox joined',
            timestamp: '2026-01-10T14:02:00Z',
            isComplete: true,
          },
        ]);

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'get_messages',
            arguments: { limit: 50 },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.channel).toBe(TEST_CHANNEL_NAME);
        expect(result.messages).toHaveLength(3);

        // Check senderType mapping: 'user' -> 'human'
        expect(result.messages[0].senderType).toBe('human');
        expect(result.messages[1].senderType).toBe('agent');
        expect(result.messages[2].senderType).toBe('system');

        // Verify chronological order (oldest first)
        expect(result.messages[0].id).toBe('msg-001');
        expect(result.messages[2].id).toBe('msg-003');

        expect(result.oldestId).toBe('msg-001');
        expect(result.newestId).toBe('msg-003');
        expect(result.hint).toContain('3 messages');
      });

      it('excludes status messages from results', async () => {
        mockStorage.getMessages.mockResolvedValueOnce([
          {
            id: 'msg-001',
            spaceId: TEST_SPACE_ID,
            channelId: TEST_CHANNEL_ID,
            sender: 'fox',
            senderType: 'agent',
            type: 'agent',
            content: 'Working on it',
            timestamp: '2026-01-10T14:00:00Z',
            isComplete: true,
          },
          {
            id: 'msg-002',
            spaceId: TEST_SPACE_ID,
            channelId: TEST_CHANNEL_ID,
            sender: 'fox',
            senderType: 'agent',
            type: 'status', // This should be excluded
            content: { status: 'implementing auth' },
            timestamp: '2026-01-10T14:01:00Z',
            isComplete: true,
          },
        ]);

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'get_messages',
            arguments: { limit: 50 },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);

        // Status message should be excluded
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].id).toBe('msg-001');
      });

      it('indicates hasOlder when more messages available', async () => {
        // Return limit + 1 messages to indicate hasOlder
        const messages = Array.from({ length: 4 }, (_, i) => ({
          id: `msg-${String(i).padStart(3, '0')}`,
          spaceId: TEST_SPACE_ID,
          channelId: TEST_CHANNEL_ID,
          sender: 'fox',
          senderType: 'agent' as const,
          type: 'agent' as const,
          content: `Message ${i}`,
          timestamp: `2026-01-10T14:0${i}:00Z`,
          isComplete: true,
        }));
        mockStorage.getMessages.mockResolvedValueOnce(messages);

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'get_messages',
            arguments: { limit: 3 },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);

        expect(result.messages).toHaveLength(3);
        expect(result.hasOlder).toBe(true);
        expect(result.hint).toContain('Older history available');
      });

      it('supports since param for forward pagination (polling)', async () => {
        const messages = [
          {
            id: 'msg-004',
            spaceId: TEST_SPACE_ID,
            channelId: TEST_CHANNEL_ID,
            sender: 'fox',
            senderType: 'agent' as const,
            type: 'agent' as const,
            content: 'New message 1',
            timestamp: '2026-01-10T14:04:00Z',
            isComplete: true,
          },
          {
            id: 'msg-005',
            spaceId: TEST_SPACE_ID,
            channelId: TEST_CHANNEL_ID,
            sender: 'bear',
            senderType: 'agent' as const,
            type: 'agent' as const,
            content: 'New message 2',
            timestamp: '2026-01-10T14:05:00Z',
            isComplete: true,
          },
        ];
        mockStorage.getMessages.mockResolvedValueOnce(messages);

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'get_messages',
            arguments: { since: 'msg-003', limit: 10 },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);

        expect(result.messages).toHaveLength(2);
        expect(result.hasNewer).toBe(false); // No more messages
        expect(result.newestId).toBe('msg-005');

        // Verify storage was called with since param
        expect(mockStorage.getMessages).toHaveBeenCalledWith(
          TEST_SPACE_ID,
          TEST_CHANNEL_ID,
          expect.objectContaining({ since: 'msg-003' })
        );
      });

      it('rejects using both before and since params', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'get_messages',
            arguments: { limit: 50, before: 'msg-010', since: 'msg-001' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);

        expect(result.error).toBe('invalid_params');
        expect(result.message).toContain('Cannot use both');
      });
    });

    describe('list_agent_types', () => {
      it('returns merged agent types from channel and root', async () => {
        // Mock channel agents
        mockStorage.listArtifacts.mockImplementation(async (channelId: string) => {
          if (channelId === TEST_CHANNEL_ID) {
            return [
              {
                slug: 'custom-builder',
                type: 'system.agent',
                title: 'Custom Builder',
                tldr: 'Channel-specific builder',
                status: 'active',
                props: { engine: 'claude' },
              },
            ];
          }
          // Root channel
          return [
            {
              slug: 'builder',
              type: 'system.agent',
              title: 'Builder',
              tldr: 'Default builder agent',
              status: 'active',
              props: { engine: 'claude' },
            },
            {
              slug: 'reviewer',
              type: 'system.agent',
              title: 'Reviewer',
              tldr: 'Code reviewer agent',
              status: 'active',
              props: { engine: 'claude' },
            },
          ];
        });

        // Mock root channel lookup
        mockStorage.getChannelByName.mockImplementation(async (spaceId: string, name: string) => {
          if (name === 'root') {
            return { id: 'root-channel-id', name: 'root', spaceId };
          }
          if (name === TEST_CHANNEL_NAME) return testChannel;
          return null;
        });

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'list_agent_types',
            arguments: {},
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.channel).toBe(TEST_CHANNEL_NAME);
        expect(result.agentTypes).toHaveLength(3);

        // Check custom-builder from channel
        const customBuilder = result.agentTypes.find((a: { slug: string }) => a.slug === 'custom-builder');
        expect(customBuilder.source).toBe('channel');
        expect(customBuilder.engine).toBe('claude');

        // Check builder from root
        const builder = result.agentTypes.find((a: { slug: string }) => a.slug === 'builder');
        expect(builder.source).toBe('root');

        // Hint includes counts
        expect(result.hint).toContain('3 agent types');
        expect(result.hint).toContain('1 from channel');
        expect(result.hint).toContain('2 from root');
      });

      it('handles channel override of root agent type', async () => {
        // Mock channel overriding root's builder
        mockStorage.listArtifacts.mockImplementation(async (channelId: string) => {
          if (channelId === TEST_CHANNEL_ID) {
            return [
              {
                slug: 'builder', // Same slug as root - should override
                type: 'system.agent',
                title: 'Custom Builder',
                tldr: 'Channel-specific builder override',
                status: 'active',
                props: { engine: 'openai' },
              },
            ];
          }
          // Root channel
          return [
            {
              slug: 'builder',
              type: 'system.agent',
              title: 'Default Builder',
              tldr: 'Default builder agent',
              status: 'active',
              props: { engine: 'claude' },
            },
          ];
        });

        mockStorage.getChannelByName.mockImplementation(async (spaceId: string, name: string) => {
          if (name === 'root') {
            return { id: 'root-channel-id', name: 'root', spaceId };
          }
          if (name === TEST_CHANNEL_NAME) return testChannel;
          return null;
        });

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'list_agent_types',
            arguments: {},
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);

        // Should only have one builder (channel override)
        expect(result.agentTypes).toHaveLength(1);
        const builder = result.agentTypes[0];
        expect(builder.slug).toBe('builder');
        expect(builder.source).toBe('channel');
        expect(builder.title).toBe('Custom Builder');
        expect(builder.engine).toBe('openai');
      });

      it('handles missing root channel gracefully', async () => {
        mockStorage.listArtifacts.mockResolvedValueOnce([
          {
            slug: 'builder',
            type: 'system.agent',
            title: 'Builder',
            tldr: 'Channel builder',
            status: 'active',
          },
        ]);
        mockStorage.getChannelByName.mockImplementation(async (spaceId: string, name: string) => {
          if (name === 'root') return null; // No root channel
          if (name === TEST_CHANNEL_NAME) return testChannel;
          return null;
        });

        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'list_agent_types',
            arguments: {},
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);

        // Should return only channel agents
        expect(result.agentTypes).toHaveLength(1);
        expect(result.agentTypes[0].source).toBe('channel');
      });
    });

    describe('explain_artifact_type', () => {
      it('returns metadata for system.agent type', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'explain_artifact_type',
            arguments: { type: 'system.agent' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error).toBeUndefined();

        const result = JSON.parse(json.result.content[0].text);
        expect(result.type).toBe('system.agent');
        expect(result.description).toContain('Agent definition');
        expect(result.statusValues).toContain('active');
        expect(result.propsSchema).toBeDefined();
        expect(result.propsSchema.properties.engine).toBeDefined();
        expect(result.example).toBeDefined();
        expect(result.hint).toContain('#root');
      });

      it('returns metadata for task type with correct status values', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'explain_artifact_type',
            arguments: { type: 'task' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);

        expect(result.type).toBe('task');
        expect(result.statusValues).toEqual(['pending', 'in_progress', 'done', 'blocked']);
        expect(result.example.status).toBe('pending');
        expect(result.hint).toContain('compare-and-swap');
      });

      it('returns error for unknown type', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', {
            name: 'explain_artifact_type',
            arguments: { type: 'invalid-type' },
          }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        const result = JSON.parse(json.result.content[0].text);

        expect(result.error).toBe('unknown_type');
        expect(result.message).toContain('invalid-type');
        expect(result.hint).toContain('Supported types');
      });
    });

    describe('error handling', () => {
      it('returns error for unknown tool', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { name: 'unknown_tool', arguments: {} }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error.code).toBe(-32601); // Method not found
        expect(json.error.message).toContain('Unknown tool');
      });

      it('returns error for missing tool name', async () => {
        const res = await app.request('/mcp/test-channel', {
          method: 'POST',
          headers: {
            Authorization: `Container ${token}`,
            'Content-Type': 'application/json',
          },
          body: jsonRpcRequest('tools/call', { arguments: {} }),
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.error.code).toBe(-32602); // Invalid params
        expect(json.error.message).toContain('Missing tool name');
      });
    });
  });
});

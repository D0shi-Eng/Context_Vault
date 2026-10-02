import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeApplication } from '../../src/infrastructure/composition-root.js';

/**
 * Transport-boundary probes for all six tools.
 *
 * Each case sends an input that the strict MCP schema must reject before
 * any use case runs. Rejection is observed as a transport-level error
 * with no structured content. These tests pin the adapter validation
 * policy independently of the use-case validation behind it.
 */
describe('MCP input boundaries', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];
  let sandboxPath: string;
  let workspacePath: string;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(tmpdir(), 'contextvault-mcp-boundary-'));
    workspacePath = path.join(sandboxPath, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\n');
  });

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
    await rm(sandboxPath, { force: true, recursive: true });
  });

  it.each([
    [
      'inspect with an unknown source kind',
      'contextvault_inspect',
      {
        source: { kind: 'remote_url', rootId: 'repo', path: 'notes.txt' },
      },
    ],
    [
      'inspect with a malformed root identifier',
      'contextvault_inspect',
      {
        source: { kind: 'workspace_file', rootId: 'REPO!', path: 'notes.txt' },
      },
    ],
    [
      'inspect with an empty path',
      'contextvault_inspect',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: '' },
      },
    ],
    [
      'inspect with an unexpected field',
      'contextvault_inspect',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        verbose: true,
      },
    ],
    [
      'prepare with a retention below the minimum',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        ttlSeconds: 59,
      },
    ],
    [
      'prepare with a retention above the maximum',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        ttlSeconds: 7201,
      },
    ],
    [
      'prepare with a fractional retention',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        ttlSeconds: 120.5,
      },
    ],
    [
      'prepare with an unexpected field',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        taskQuery: 'not part of the contract',
      },
    ],
    [
      'prepare with an empty selector allowlist',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        retrieval: { allowedSelectorTypes: [], maxBytes: 1024, ttlSeconds: 600 },
      },
    ],
    [
      'prepare with an oversized selector allowlist',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        retrieval: {
          allowedSelectorTypes: ['chunk', 'json_node', 'line_range', 'chunk'],
          maxBytes: 1024,
          ttlSeconds: 600,
        },
      },
    ],
    [
      'prepare with an unknown selector type',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        retrieval: { allowedSelectorTypes: ['semantic'], maxBytes: 1024, ttlSeconds: 600 },
      },
    ],
    [
      'prepare with a zero grant byte budget',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 0, ttlSeconds: 600 },
      },
    ],
    [
      'prepare with an oversized grant byte budget',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 1_048_577, ttlSeconds: 600 },
      },
    ],
    [
      'prepare with a grant ttl below the minimum',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 1024, ttlSeconds: 59 },
      },
    ],
    [
      'prepare with an unexpected grant field',
      'contextvault_prepare',
      {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        retrieval: {
          allowedSelectorTypes: ['chunk'],
          maxBytes: 1024,
          ttlSeconds: 600,
          override: true,
        },
      },
    ],
    [
      'retrieve with a leading-junk capability',
      'contextvault_retrieve',
      {
        capability: `Xcv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
    ],
    [
      'retrieve with a trailing-junk capability',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}!`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
    ],
    [
      'retrieve with a truncated capability',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(42)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
    ],
    [
      'retrieve with an unknown selector kind',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'semantic', query: 'alpha' },
      },
    ],
    [
      'retrieve with a malformed chunk identifier',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001!' },
      },
    ],
    [
      'retrieve with a leading-junk chunk identifier',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'Xcv_chunk_000000000001' },
      },
    ],
    [
      'retrieve with a leading-junk node identifier',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'json_node', nodeId: 'Xcv_node_000001' },
      },
    ],
    [
      'retrieve with a trailing-junk chunk identifier',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001!' },
      },
    ],
    [
      'retrieve with a trailing-junk node identifier',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'json_node', nodeId: 'cv_node_000001!' },
      },
    ],
    [
      'retrieve with a zero start line',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'line_range', startLine: 0, endLine: 2 },
      },
    ],
    [
      'retrieve with a zero byte budget',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        maxBytes: 0,
      },
    ],
    [
      'retrieve with an oversized byte budget',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        maxBytes: 1_048_577,
      },
    ],
    [
      'retrieve with a fractional byte budget',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        maxBytes: 10.5,
      },
    ],
    [
      'retrieve with an unexpected field',
      'contextvault_retrieve',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        sourcePath: '/etc/passwd',
      },
    ],
    [
      'verify with a trailing-junk envelope identifier',
      'contextvault_verify',
      {
        envelopeId: `cv_env_${'a'.repeat(16)}!`,
        checks: [{ kind: 'source_freshness' }],
      },
    ],
    [
      'verify with a leading-junk envelope identifier',
      'contextvault_verify',
      {
        envelopeId: `Xcv_env_${'a'.repeat(16)}`,
        checks: [{ kind: 'source_freshness' }],
      },
    ],
    [
      'verify with an unknown check kind',
      'contextvault_verify',
      {
        envelopeId: `cv_env_${'a'.repeat(16)}`,
        checks: [{ kind: 'semantic_truth' }],
      },
    ],
    [
      'verify with a malformed chunk identifier',
      'contextvault_verify',
      {
        envelopeId: `cv_env_${'a'.repeat(16)}`,
        checks: [{ kind: 'chunk_integrity', chunkId: 'chunk-1' }],
      },
    ],
    [
      'verify with an empty check list',
      'contextvault_verify',
      {
        envelopeId: `cv_env_${'a'.repeat(16)}`,
        checks: [],
      },
    ],
    [
      'verify with an oversized check list',
      'contextvault_verify',
      {
        envelopeId: `cv_env_${'a'.repeat(16)}`,
        checks: Array.from({ length: 17 }, () => ({ kind: 'source_freshness' })),
      },
    ],
    ['stats with an unexpected field', 'contextvault_stats', { verbose: true }],
    [
      'purge with a trailing-junk envelope identifier',
      'contextvault_purge',
      {
        operation: 'preview',
        target: { kind: 'envelope', envelopeId: `cv_env_${'a'.repeat(16)}!` },
      },
    ],
    [
      'purge with a leading-junk envelope identifier',
      'contextvault_purge',
      {
        operation: 'preview',
        target: { kind: 'envelope', envelopeId: `Xcv_env_${'a'.repeat(16)}` },
      },
    ],
    [
      'purge with a trailing-junk intent identifier',
      'contextvault_purge',
      {
        operation: 'execute',
        purgeIntentId: `cv_pur_${'a'.repeat(16)}!`,
      },
    ],
    [
      'purge with a leading-junk intent identifier',
      'contextvault_purge',
      {
        operation: 'execute',
        purgeIntentId: `Xcv_pur_${'a'.repeat(16)}`,
      },
    ],
    [
      'purge preview with an intent field',
      'contextvault_purge',
      {
        operation: 'preview',
        target: { kind: 'all_derived_state' },
        purgeIntentId: `cv_pur_${'a'.repeat(16)}`,
      },
    ],
    [
      'purge execute with a target field',
      'contextvault_purge',
      {
        operation: 'execute',
        purgeIntentId: `cv_pur_${'a'.repeat(16)}`,
        target: { kind: 'all_derived_state' },
      },
    ],
    [
      'purge preview without any target',
      'contextvault_purge',
      {
        operation: 'preview',
      },
    ],
    [
      'purge execute without any intent',
      'contextvault_purge',
      {
        operation: 'execute',
      },
    ],
  ])('rejects %s at the transport boundary', async (_name, tool, args) => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({ name: tool, arguments: args });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  async function createConnectedClient(workspaceRoot: string): Promise<Client> {
    const application = await composeApplication('24.19.0', [
      `--workspace-root=repo=${workspaceRoot}`,
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-boundary-test-client', version: '0.0.0' });
    closeCallbacks.push(
      async () => client.close(),
      async () => application.server.close(),
    );
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }
});

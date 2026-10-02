import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SERVER_IDENTITY } from '../../src/domain/server-identity.js';

/**
 * Full lifecycle proof through the production stdio entrypoint.
 *
 * initialize -> list six tools -> inspect -> prepare without a grant ->
 * retrieval denied -> prepare with a bounded grant -> retrieve the exact
 * excerpt -> verify integrity -> stats -> purge preview -> purge execute ->
 * retrieval denied -> source file untouched -> restart -> prior state and
 * grants unavailable. No mocks: the real server binary serves every step.
 */
describe('MCP stdio lifecycle', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];
  const temporaryPaths: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
    await Promise.all(
      temporaryPaths
        .splice(0)
        .map(async (temporaryPath) => rm(temporaryPath, { force: true, recursive: true })),
    );
  });

  it('completes the full prepare, retrieve, verify, stats, and purge lifecycle', async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), 'contextvault-lifecycle-'));
    temporaryPaths.push(workspacePath);
    const sourceContent = 'alpha\nbeta\ngamma\n';
    const sourceFile = path.join(workspacePath, 'notes.txt');
    await writeFile(sourceFile, sourceContent);

    const client = await connectClient(workspacePath);

    // initialize: the server identifies itself exactly.
    expect(client.getServerVersion()).toEqual(SERVER_IDENTITY);

    // list: exactly the six implemented tools, nothing else.
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'contextvault_inspect',
      'contextvault_prepare',
      'contextvault_retrieve',
      'contextvault_verify',
      'contextvault_stats',
      'contextvault_purge',
    ]);

    // inspect: content-free metadata for the authorized source.
    const inspected = await callTool(client, 'contextvault_inspect', {
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
    });
    expect(inspected.ok).toBe(true);
    expect(asRecord(inspected.source).mediaType).toBe('text/plain');
    expect(JSON.stringify(inspected)).not.toContain('alpha');

    // prepare without a retrieval grant: retrieval stays disabled.
    const ungranted = await callTool(client, 'contextvault_prepare', {
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
    });
    expect(asRecord(ungranted.envelope).retrievalAllowed).toBe(false);

    // retrieval denied: no grant was ever issued for this envelope.
    const denied = await callTool(client, 'contextvault_retrieve', {
      capability: `cv1_${'a'.repeat(43)}`,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });
    expect(denied.ok).toBe(false);
    expect(asRecord(denied.error).code).toBe('CV_CAPABILITY_INVALID');

    // prepare with a bounded retrieval grant.
    const prepared = await callTool(client, 'contextvault_prepare', {
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
      retrieval: { allowedSelectorTypes: ['chunk', 'line_range'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const envelope = asRecord(prepared.envelope);
    expect(prepared.ok).toBe(true);
    expect(envelope.retrievalAllowed).toBe(true);
    const envelopeId = envelope.envelopeId as string;
    const capability = asRecord(envelope.retrieval).capability as string;
    expect(capability).toMatch(/^cv1_[A-Za-z0-9_-]{43}$/u);

    // retrieve: the exact excerpt for the granted chunk selector.
    const retrieved = await callTool(client, 'contextvault_retrieve', {
      capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });
    expect(retrieved.ok).toBe(true);
    expect(retrieved.content).toBe(sourceContent);
    expect(retrieved.truncated).toBe(false);
    expect(retrieved.hasMore).toBe(false);
    expect(retrieved.sourceDigest).toBe(envelope.sourceDigest);

    // verify: freshness, chunk integrity, and provenance consistency.
    const verified = await callTool(client, 'contextvault_verify', {
      envelopeId,
      checks: [
        { kind: 'source_freshness' },
        { kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000001' },
        { kind: 'provenance_consistency' },
      ],
    });
    expect(verified.ok).toBe(true);
    const results = verified.results as Record<string, unknown>[];
    expect(results.map((entry) => entry.status)).toEqual(['valid', 'valid', 'valid']);

    // stats: the session counters reflect the lifecycle so far.
    const measured = await callTool(client, 'contextvault_stats', {});
    const counters = asRecord(measured.counters);
    expect(counters.activeEnvelopeCount).toBe(2);
    expect(counters.activeGrantCount).toBe(1);
    expect(counters.authorizedRootCount).toBe(1);
    expect(counters.successfulRequests).toBeGreaterThan(0);

    // purge preview then execute for the granted envelope.
    const preview = await callTool(client, 'contextvault_purge', {
      operation: 'preview',
      target: { kind: 'envelope', envelopeId },
    });
    expect(preview.ok).toBe(true);
    const executed = await callTool(client, 'contextvault_purge', {
      operation: 'execute',
      purgeIntentId: preview.purgeIntentId,
    });
    expect(executed.ok).toBe(true);
    expect(executed.deletedEnvelopes).toBe(1);
    expect(executed.revokedGrants).toBe(1);

    // retrieval denied after the purge revoked the grant.
    const afterPurge = await callTool(client, 'contextvault_retrieve', {
      capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });
    expect(afterPurge.ok).toBe(false);
    expect(asRecord(afterPurge.error).code).toBe('CV_CAPABILITY_INVALID');

    // The original source still exists and is byte-identical.
    const surviving = await readFile(sourceFile, 'utf8');
    expect(surviving).toBe(sourceContent);

    // restart: a fresh process has no prior envelopes or grants.
    await closeClient(client);
    const restarted = await connectClient(workspacePath);
    const restartedVerify = await callTool(restarted, 'contextvault_verify', {
      envelopeId,
      checks: [{ kind: 'source_freshness' }],
    });
    expect(restartedVerify.ok).toBe(true);
    expect((restartedVerify.results as Record<string, unknown>[])[0]?.status).toBe('unavailable');
    const restartedRetrieve = await callTool(restarted, 'contextvault_retrieve', {
      capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });
    expect(restartedRetrieve.ok).toBe(false);
    expect(asRecord(restartedRetrieve.error).code).toBe('CV_CAPABILITY_INVALID');
    const restartedStats = await callTool(restarted, 'contextvault_stats', {});
    expect(asRecord(restartedStats.counters).activeEnvelopeCount).toBe(0);
    expect(asRecord(restartedStats.counters).activeGrantCount).toBe(0);
    await closeClient(restarted);
  }, 60_000);

  async function connectClient(workspaceRoot: string): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/main.js'), `--workspace-root=repo=${workspaceRoot}`],
      cwd: path.resolve('.'),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'contextvault-lifecycle-client', version: '0.0.0' });
    closeCallbacks.push(async () => client.close());
    await client.connect(transport);
    return client;
  }

  async function closeClient(client: Client): Promise<void> {
    await client.close();
  }

  async function callTool(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError === true) {
      return asRecord(result.structuredContent);
    }
    return asRecord(result.structuredContent);
  }
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a structured object result.');
  }
  return value as Record<string, unknown>;
}

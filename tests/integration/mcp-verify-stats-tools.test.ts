import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeApplication } from '../../src/infrastructure/composition-root.js';
import { createSchemaValidator } from '../contract/schema-validator.js';

const VERIFY_OUTPUT_SCHEMA_ID = 'https://contextvault.local/schemas/mcp/verify.output.schema.json';
const STATS_OUTPUT_SCHEMA_ID = 'https://contextvault.local/schemas/mcp/stats.output.schema.json';

describe('contextvault_verify MCP tool', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];
  let sandboxPath: string;
  let workspacePath: string;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(tmpdir(), 'contextvault-mcp-verify-'));
    workspacePath = path.join(sandboxPath, 'workspace');
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
    await rm(sandboxPath, { force: true, recursive: true });
  });

  it('verifies source freshness and chunk integrity for a prepared envelope', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\n');
    const client = await createConnectedClient(workspacePath);
    const envelopeId = await prepareEnvelope(client);

    const result = await client.callTool({
      name: 'contextvault_verify',
      arguments: {
        envelopeId,
        checks: [
          { kind: 'source_freshness' },
          { kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000001' },
        ],
      },
    });

    const structured = asRecord(result.structuredContent);
    expect(result.isError).not.toBe(true);
    expect(structured.ok).toBe(true);
    expect(structured.envelopeId).toBe(envelopeId);
    const results = asArray(structured.results);
    expect(results).toEqual([
      {
        kind: 'source_freshness',
        status: 'valid',
        reasonCode: 'digest_matches_prepared_state',
      },
      {
        kind: 'chunk_integrity',
        chunkId: 'cv_chunk_000000000001',
        status: 'valid',
        reasonCode: 'digest_matches_prepared_state',
      },
    ]);
    await expectValidOutput(VERIFY_OUTPUT_SCHEMA_ID, result.structuredContent);
  });

  it('reports stale integrity after the source is replaced', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\n');
    const client = await createConnectedClient(workspacePath);
    const envelopeId = await prepareEnvelope(client);
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nREPLACED\n');

    const result = await client.callTool({
      name: 'contextvault_verify',
      arguments: { envelopeId, checks: [{ kind: 'source_freshness' }] },
    });

    const results = asArray(asRecord(result.structuredContent).results);
    expect(results).toEqual([
      { kind: 'source_freshness', status: 'stale', reasonCode: 'source_digest_mismatch' },
    ]);
    expect(JSON.stringify(result)).not.toContain('REPLACED');
    expect(JSON.stringify(result)).not.toContain(workspacePath);
  });

  it('reports unavailable checks for an unknown envelope without content', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_verify',
      arguments: {
        envelopeId: `cv_env_${'u'.repeat(24)}`,
        checks: [{ kind: 'source_freshness' }, { kind: 'provenance_consistency' }],
      },
    });

    const structured = asRecord(result.structuredContent);
    expect(result.isError).not.toBe(true);
    expect(structured.ok).toBe(true);
    const results = asArray(structured.results);
    expect(results.every((entry) => entry.status === 'unavailable')).toBe(true);
    expect(results.every((entry) => entry.reasonCode === 'envelope_absent')).toBe(true);
  });

  it('rejects natural-language claim shapes at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_verify',
      arguments: {
        envelopeId: `cv_env_${'u'.repeat(24)}`,
        claims: [{ claimId: 'claim-1', text: 'The file says hello.' }],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('rejects an empty check list at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_verify',
      arguments: { envelopeId: `cv_env_${'u'.repeat(24)}`, checks: [] },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  async function prepareEnvelope(client: Client): Promise<string> {
    const prepared = asRecord(
      (
        await client.callTool({
          name: 'contextvault_prepare',
          arguments: {
            source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
          },
        })
      ).structuredContent,
    );
    const envelopeId = asRecord(prepared.envelope).envelopeId;
    if (typeof envelopeId !== 'string') {
      throw new Error('Expected an envelope identifier in the prepare response.');
    }
    return envelopeId;
  }

  async function createConnectedClient(workspaceRoot: string): Promise<Client> {
    const application = await composeApplication('24.19.0', [
      `--workspace-root=repo=${workspaceRoot}`,
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-verify-test-client', version: '0.0.0' });
    closeCallbacks.push(
      async () => client.close(),
      async () => application.server.close(),
    );
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    // Enabling tool-list caching turns on client-side output-schema
    // validation, so malformed success payloads fail the call.
    await client.listTools();
    return client;
  }
});

describe('contextvault_stats MCP tool', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];
  let sandboxPath: string;
  let workspacePath: string;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(tmpdir(), 'contextvault-mcp-stats-'));
    workspacePath = path.join(sandboxPath, 'workspace');
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
    await rm(sandboxPath, { force: true, recursive: true });
  });

  it('reports exact counters that track the session lifecycle', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\n');
    const client = await createConnectedClient(workspacePath);

    const before = asRecord(
      (await client.callTool({ name: 'contextvault_stats', arguments: {} })).structuredContent,
    );
    expect(asRecord(before.counters).activeEnvelopeCount).toBe(0);
    expect(asRecord(before.counters).authorizedRootCount).toBe(1);

    await client.callTool({
      name: 'contextvault_prepare',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
      },
    });

    const after = asRecord(
      (await client.callTool({ name: 'contextvault_stats', arguments: {} })).structuredContent,
    );
    const counters = asRecord(after.counters);
    expect(counters.activeEnvelopeCount).toBe(1);
    expect(counters.activeGrantCount).toBe(1);
    expect(counters.authorizedRootCount).toBe(1);
    expect(counters.serializedDerivedRecordBytes).toBeGreaterThan(0);
    // The snapshot is measured before the current stats call records its
    // own outcome: the completed prepare plus the first stats call.
    expect(counters.successfulRequests).toBe(2);
    expect(counters.failedRequests).toBe(0);
    expect(after.measuredAt).toBeTypeOf('string');
    await expectValidOutput(STATS_OUTPUT_SCHEMA_ID, after);
  });

  it('counts failed requests exactly and keeps counters content-free', async () => {
    const client = await createConnectedClient(workspacePath);

    const denied = await client.callTool({
      name: 'contextvault_prepare',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'unknown-root', path: 'notes.txt' },
      },
    });
    expect(denied.isError).toBe(true);

    const stats = asRecord(
      (await client.callTool({ name: 'contextvault_stats', arguments: {} })).structuredContent,
    );
    const counters = asRecord(stats.counters);
    expect(counters.failedRequests).toBe(1);
    // The current stats call has not recorded its own outcome yet.
    expect(counters.successfulRequests).toBe(0);
    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain('unknown-root');
    expect(serialized).not.toContain(workspacePath);
    await expectValidOutput(STATS_OUTPUT_SCHEMA_ID, stats);
  });

  it('rejects unexpected input fields at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_stats',
      arguments: { verbose: true },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  async function createConnectedClient(workspaceRoot: string): Promise<Client> {
    const application = await composeApplication('24.19.0', [
      `--workspace-root=repo=${workspaceRoot}`,
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-stats-test-client', version: '0.0.0' });
    closeCallbacks.push(
      async () => client.close(),
      async () => application.server.close(),
    );
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    // Enabling tool-list caching turns on client-side output-schema
    // validation, so malformed success payloads fail the call.
    await client.listTools();
    return client;
  }
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a structured object result.');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Expected an array value.');
  }
  return value as Record<string, unknown>[];
}

async function expectValidOutput(schemaId: string, value: unknown): Promise<void> {
  const validator = await createSchemaValidator();
  const validate = validator.getSchema(schemaId);
  expect(validate).toBeDefined();
  expect(validate?.(value), JSON.stringify(validate?.errors)).toBe(true);
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeApplication } from '../../src/infrastructure/composition-root.js';
import { createSchemaValidator } from '../contract/schema-validator.js';

const RETRIEVE_OUTPUT_SCHEMA_ID =
  'https://contextvault.local/schemas/mcp/retrieve.output.schema.json';

describe('contextvault_retrieve MCP tool', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];
  let sandboxPath: string;
  let workspacePath: string;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(tmpdir(), 'contextvault-mcp-retrieve-'));
    workspacePath = path.join(sandboxPath, 'workspace');
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
    await rm(sandboxPath, { force: true, recursive: true });
  });

  it('denies retrieval for an envelope prepared without a grant', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\n');
    const client = await createConnectedClient(workspacePath);

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
    expect(asRecord(prepared.envelope).retrievalAllowed).toBe(false);

    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
    });

    const structured = asRecord(result.structuredContent);
    expect(result.isError).toBe(true);
    expect(structured.ok).toBe(false);
    expect(asRecord(structured.error).code).toBe('CV_CAPABILITY_INVALID');
  });

  it('returns the exact prepared excerpt for a granted chunk selector', async () => {
    const sourceContent = 'alpha\nbeta\ngamma\n';
    await writeFile(path.join(workspacePath, 'notes.txt'), sourceContent);
    const client = await createConnectedClient(workspacePath);

    const prepared = asRecord(
      (
        await client.callTool({
          name: 'contextvault_prepare',
          arguments: {
            source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
            retrieval: {
              allowedSelectorTypes: ['chunk', 'line_range'],
              maxBytes: 4096,
              ttlSeconds: 600,
            },
          },
        })
      ).structuredContent,
    );
    const envelope = asRecord(prepared.envelope);
    expect(envelope.retrievalAllowed).toBe(true);
    const capability = asRecord(envelope.retrieval).capability as string;
    expect(capability).toMatch(/^cv1_[A-Za-z0-9_-]{43}$/u);

    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
    });

    const structured = asRecord(result.structuredContent);
    expect(result.isError).not.toBe(true);
    expect(structured.ok).toBe(true);
    expect(structured.envelopeId).toBe(envelope.envelopeId);
    expect(structured.sourceDigest).toBe(envelope.sourceDigest);
    expect(structured.content).toBe(sourceContent);
    expect(structured.byteCount).toBe(sourceContent.length);
    expect(structured.truncated).toBe(false);
    expect(structured.hasMore).toBe(false);
    // The excerpt is content-revealing by design; the envelope metadata
    // around it stays free of local paths.
    expect(JSON.stringify(result)).toContain('alpha');
    expect(JSON.stringify(result)).not.toContain(workspacePath);
    await expectValidRetrieveOutput(result.structuredContent);
  });

  it('honors an explicit request byte budget below the grant ceiling', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\ngamma\n');
    const client = await createConnectedClient(workspacePath);
    const capability = await prepareGrant(client, ['line_range'], 4096);

    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability,
        selector: { kind: 'line_range', startLine: 1, endLine: 3 },
        maxBytes: 6,
      },
    });

    const structured = asRecord(result.structuredContent);
    expect(result.isError).not.toBe(true);
    expect(structured.content).toBe('alpha\n');
    expect(structured.byteCount).toBe(6);
    expect(structured.truncated).toBe(true);
    expect(structured.hasMore).toBe(true);
    await expectValidRetrieveOutput(result.structuredContent);
  });

  it('retrieves a bounded line range and enforces the grant byte ceiling', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\ngamma\ndelta\n');
    const client = await createConnectedClient(workspacePath);
    const capability = await prepareGrant(client, ['line_range'], 11);

    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability,
        selector: { kind: 'line_range', startLine: 1, endLine: 4 },
      },
    });

    const structured = asRecord(result.structuredContent);
    expect(structured.content).toBe('alpha\nbeta\n');
    expect(structured.byteCount).toBe(11);
    expect(structured.truncated).toBe(true);
    expect(structured.hasMore).toBe(true);
    await expectValidRetrieveOutput(result.structuredContent);
  });

  it('retrieves an exact JSON node excerpt from the original source bytes', async () => {
    const sourceContent = '{"name": "ada", "tags": ["x", "y"]}\n';
    await writeFile(path.join(workspacePath, 'data.json'), sourceContent);
    const client = await createConnectedClient(workspacePath);
    const capability = await prepareGrant(client, ['json_node'], 4096, 'data.json');

    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability,
        selector: { kind: 'json_node', nodeId: 'cv_node_000003' },
      },
    });

    const structured = asRecord(result.structuredContent);
    expect(result.isError).not.toBe(true);
    expect(structured.content).toBe('["x", "y"]');
    expect(sourceContent).toContain(structured.content as string);
    expect(structured.truncated).toBe(false);
    await expectValidRetrieveOutput(result.structuredContent);
  });

  it('detects a source replaced after preparation', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\n');
    const client = await createConnectedClient(workspacePath);
    const capability = await prepareGrant(client, ['chunk'], 4096);

    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nREPLACED\n');
    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
    });

    const structured = asRecord(result.structuredContent);
    expect(result.isError).toBe(true);
    expect(asRecord(structured.error).code).toBe('CV_SOURCE_CHANGED');
    expect(JSON.stringify(result)).not.toContain('REPLACED');
  });

  it('rejects a tampered capability without distinguishing the failure', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\n');
    const client = await createConnectedClient(workspacePath);
    const capability = await prepareGrant(client, ['chunk'], 4096);
    const tampered = `${capability.slice(0, -1)}${capability.endsWith('a') ? 'b' : 'a'}`;

    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability: tampered,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
    });

    expect(result.isError).toBe(true);
    expect(asRecord(asRecord(result.structuredContent).error).code).toBe('CV_CAPABILITY_INVALID');
  });

  it('rejects a malformed capability at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability: 'not-a-capability',
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('rejects unexpected input fields at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        sourcePath: '/etc/passwd',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('never issues a content-retrieval grant for confirmed-secret material', async () => {
    const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    await writeFile(path.join(workspacePath, 'key.txt'), `${marker}\n`);
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_prepare',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'key.txt' },
        retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
      },
    });

    const structured = asRecord(result.structuredContent);
    expect(result.isError).toBe(true);
    expect(asRecord(structured.error).code).toBe('CV_RETRIEVAL_POLICY_DENIED');
    expect(asRecord(structured.error).safeDetails).toEqual({ reason: 'confirmed_secret' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });

  async function prepareGrant(
    client: Client,
    selectorTypes: string[],
    maxBytes: number,
    fileName = 'notes.txt',
  ): Promise<string> {
    const prepared = asRecord(
      (
        await client.callTool({
          name: 'contextvault_prepare',
          arguments: {
            source: { kind: 'workspace_file', rootId: 'repo', path: fileName },
            retrieval: { allowedSelectorTypes: selectorTypes, maxBytes, ttlSeconds: 600 },
          },
        })
      ).structuredContent,
    );
    const capability = asRecord(asRecord(prepared.envelope).retrieval).capability;
    if (typeof capability !== 'string') {
      throw new Error('Expected a retrieval capability in the prepare response.');
    }
    return capability;
  }

  async function createConnectedClient(workspaceRoot: string): Promise<Client> {
    const application = await composeApplication('24.19.0', [
      `--workspace-root=repo=${workspaceRoot}`,
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-retrieve-test-client', version: '0.0.0' });
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

async function expectValidRetrieveOutput(value: unknown): Promise<void> {
  const validator = await createSchemaValidator();
  const validate = validator.getSchema(RETRIEVE_OUTPUT_SCHEMA_ID);
  expect(validate).toBeDefined();
  expect(validate?.(value), JSON.stringify(validate?.errors)).toBe(true);
}

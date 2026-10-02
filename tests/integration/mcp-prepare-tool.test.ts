import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeApplication } from '../../src/infrastructure/composition-root.js';
import { createSchemaValidator } from '../contract/schema-validator.js';

const PREPARE_OUTPUT_SCHEMA_ID =
  'https://contextvault.local/schemas/mcp/prepare.output.schema.json';

describe('contextvault_prepare MCP tool', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];
  let sandboxPath: string;
  let workspacePath: string;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(tmpdir(), 'contextvault-mcp-prepare-'));
    workspacePath = path.join(sandboxPath, 'workspace');
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
    await rm(sandboxPath, { force: true, recursive: true });
  });

  it('prepares an authorized text file with raw-content-free bounded metadata', async () => {
    const sourceContent = 'alpha\nbeta\n';
    await writeFile(path.join(workspacePath, 'notes.txt'), sourceContent);
    const client = await createConnectedClient(workspacePath);

    const result = await callPrepare(client, 'repo', 'notes.txt');
    const serialized = JSON.stringify(result);
    const structured = asRecord(result.structuredContent);
    const envelope = asRecord(structured.envelope);

    expect(result.isError).not.toBe(true);
    expect(structured.schemaVersion).toBe('1.0');
    expect(structured.ok).toBe(true);
    expect(envelope.envelopeId).toMatch(/^cv_env_[A-Za-z0-9_-]{24}$/u);
    expect(envelope.sourceId).toMatch(/^cv_src_[A-Za-z0-9_-]{43}$/u);
    expect(envelope.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(envelope.mediaType).toBe('text/plain');
    expect(envelope.bytes).toBe(sourceContent.length);
    expect(envelope.preparationKind).toBe('text_chunks');
    expect(envelope.disclosureClass).toBe(
      'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
    );
    expect(envelope.retrievalAllowed).toBe(false);
    expect(envelope.lineCount).toBe(2);
    expect(asArray(envelope.chunks)).toHaveLength(1);
    expect(asArray(envelope.chunks)[0]).toMatchObject({
      chunkId: 'cv_chunk_000000000001',
      byteStart: 0,
      byteEndExclusive: sourceContent.length,
      lineStart: 1,
      lineEndExclusive: 3,
      byteLength: sourceContent.length,
      truncated: false,
    });
    expect(envelope.structuralFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const preparedText = extractSingleTextContent(result);
    expect(preparedText.length).toBeGreaterThan(0);
    expect(preparedText).toBe(JSON.stringify(structured));
    expect(serialized).not.toContain('alpha');
    expect(serialized).not.toContain('beta');
    expect(serialized).not.toContain(workspacePath);
    await expectValidPrepareOutput(result.structuredContent);
  });

  it('prepares Markdown without disclosing heading text', async () => {
    await writeFile(path.join(workspacePath, 'guide.md'), '# Secret Heading\n\nBody.\n');
    const client = await createConnectedClient(workspacePath);

    const result = await callPrepare(client, 'repo', 'guide.md');
    const structured = asRecord(result.structuredContent);
    const envelope = asRecord(structured.envelope);
    const serialized = JSON.stringify(result);

    expect(envelope.mediaType).toBe('text/markdown');
    expect(envelope.lineCount).toBe(3);
    expect(serialized).not.toContain('Secret Heading');
    expect(serialized).not.toContain('Body.');
  });

  it('prepares JSON with redacted sensitive keys and no values', async () => {
    const sourceContent = '{"name":"allowed-value","password":"s3cr3t-value"}';
    await writeFile(path.join(workspacePath, 'settings.json'), sourceContent);
    const client = await createConnectedClient(workspacePath);

    const result = await callPrepare(client, 'repo', 'settings.json');
    const structured = asRecord(result.structuredContent);
    const envelope = asRecord(structured.envelope);
    const serialized = JSON.stringify(result);
    const jsonNodes = asArray(envelope.jsonNodes);

    expect(envelope.preparationKind).toBe('json_structure');
    expect(jsonNodes).toHaveLength(3);
    expect(jsonNodes[0]).toMatchObject({ nodeType: 'object', childCount: 2, pointer: '' });
    expect(jsonNodes[1]).toMatchObject({
      nodeType: 'string',
      pointer: '/name',
      pointerRedacted: false,
    });
    expect(jsonNodes[2]).toMatchObject({ nodeType: 'string', pointerRedacted: true });
    const redactedNode = jsonNodes[2];
    if (!redactedNode?.pointer) {
      throw new Error('Expected a redacted JSON node with a pointer.');
    }
    expect(redactedNode.pointer).toMatch(/^\/cv_node_000003$/u);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('s3cr3t-value');
    expect(serialized).not.toContain('allowed-value');
  });

  it('produces a stable structural fingerprint across repeated preparations', async () => {
    await writeFile(path.join(workspacePath, 'stable.txt'), 'stable content\n');
    const client = await createConnectedClient(workspacePath);

    const first = asRecord((await callPrepare(client, 'repo', 'stable.txt')).structuredContent);
    const second = asRecord((await callPrepare(client, 'repo', 'stable.txt')).structuredContent);

    const firstEnvelope = asRecord(first.envelope);
    const secondEnvelope = asRecord(second.envelope);
    expect(secondEnvelope.structuralFingerprint).toBe(firstEnvelope.structuralFingerprint);
    expect(secondEnvelope.chunks).toEqual(firstEnvelope.chunks);
    expect(secondEnvelope.sourceDigest).toBe(firstEnvelope.sourceDigest);
    expect(secondEnvelope.envelopeId).not.toBe(firstEnvelope.envelopeId);
  });

  it('honors a caller-provided retention inside the supported bounds', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'retained briefly\n');
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_prepare',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        ttlSeconds: 120,
      },
    });
    const structured = asRecord(result.structuredContent);
    const envelope = asRecord(structured.envelope);

    expect(result.isError).not.toBe(true);
    const created = new Date(envelope.createdAt as string).getTime();
    const expires = new Date(envelope.expiresAt as string).getTime();
    expect(expires - created).toBe(120 * 1000);
    await expectValidPrepareOutput(result.structuredContent);
  });

  it('returns a minimal envelope for confirmed secret material without naming it', async () => {
    const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    await writeFile(path.join(workspacePath, 'key.txt'), marker);
    const client = await createConnectedClient(workspacePath);

    const result = await callPrepare(client, 'repo', 'key.txt');
    const structured = asRecord(result.structuredContent);
    const envelope = asRecord(structured.envelope);
    const serialized = JSON.stringify(result);

    expect(envelope.preparationKind).toBe('minimal');
    expect(envelope.secretRisk).toBe('confirmed');
    expect(envelope.sensitivity).toBe('prohibited');
    expect(envelope.retrievalAllowed).toBe(false);
    expect(asArray(envelope.chunks)).toEqual([]);
    expect(asArray(envelope.omissions)).toHaveLength(1);
    expect(asArray(envelope.omissions)[0]).toMatchObject({ reason: 'policy', retrievable: false });
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('-----BEGIN');
  });

  it('fails safely for unsupported preparation media', async () => {
    await writeFile(path.join(workspacePath, 'table.csv'), 'a,b\n1,2\n');
    const client = await createConnectedClient(workspacePath);

    const result = await callPrepare(client, 'repo', 'table.csv');
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(structured.ok).toBe(false);
    expect(error.code).toBe('CV_PREPARE_MEDIA_UNSUPPORTED');
    expect(error.retryable).toBe(false);
    await expectValidPrepareOutput(result.structuredContent);
  });

  it.each([
    ['malformed json', '{"broken":', 'CV_JSON_MALFORMED'],
    ['excessive json depth', `${'['.repeat(70)}${']'.repeat(70)}`, 'CV_PARSE_DEPTH_EXCEEDED'],
  ])('fails safely on %s without leaking parser details', async (_name, content, code) => {
    await writeFile(path.join(workspacePath, 'broken.json'), content);
    const client = await createConnectedClient(workspacePath);

    const result = await callPrepare(client, 'repo', 'broken.json');
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(error.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain(content.slice(0, 8));
    await expectValidPrepareOutput(result.structuredContent);
  });

  it('returns the authorization class for an unknown root', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'text\n');
    const client = await createConnectedClient(workspacePath);

    const result = await callPrepare(client, 'other-root', 'notes.txt');
    const error = asRecord(asRecord(result.structuredContent).error);

    expect(result.isError).toBe(true);
    expect(error.code).toBe('CV_AUTHORIZATION_DENIED');
  });

  it('returns a safe traversal error without disclosing local paths', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await callPrepare(client, 'repo', '../outside.txt');
    const serialized = JSON.stringify(result);
    const error = asRecord(asRecord(result.structuredContent).error);

    expect(result.isError).toBe(true);
    expect(error.code).toBe('CV_PATH_OUTSIDE_WORKSPACE');
    expect(serialized).not.toContain(workspacePath);
    expect(serialized).not.toContain('outside.txt');
  });

  it('rejects an out-of-bounds retention at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_prepare',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        ttlSeconds: 59,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('rejects unexpected input fields at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_prepare',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' },
        taskQuery: 'not part of this slice',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('rejects an unsupported source kind at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_prepare',
      arguments: {
        source: { kind: 'remote_url', rootId: 'repo', path: 'notes.txt' },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('advertises non-destructive, non-idempotent, closed-world annotations', async () => {
    const client = await createConnectedClient(workspacePath);

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'contextvault_prepare');

    expect(tool).toBeDefined();
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  async function createConnectedClient(workspaceRoot: string): Promise<Client> {
    const application = await composeApplication('24.19.0', [
      `--workspace-root=repo=${workspaceRoot}`,
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-prepare-test-client', version: '0.0.0' });
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

function callPrepare(
  client: Client,
  rootId: string,
  sourcePath: string,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool({
    name: 'contextvault_prepare',
    arguments: {
      source: { kind: 'workspace_file', rootId, path: sourcePath },
    },
  });
}

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

async function expectValidPrepareOutput(value: unknown): Promise<void> {
  const validator = await createSchemaValidator();
  const validate = validator.getSchema(PREPARE_OUTPUT_SCHEMA_ID);
  expect(validate).toBeDefined();
  expect(validate?.(value), JSON.stringify(validate?.errors)).toBe(true);
}

function extractSingleTextContent(result: unknown): string {
  const items = (result as { readonly content?: unknown }).content;
  if (!Array.isArray(items) || items.length !== 1) {
    throw new TypeError('Expected exactly one content item.');
  }
  const item = items[0] as { readonly type?: unknown; readonly text?: unknown };
  if (item.type !== 'text' || typeof item.text !== 'string') {
    throw new TypeError('Expected a single text content item.');
  }
  return item.text;
}

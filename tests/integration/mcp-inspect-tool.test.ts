import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeApplication } from '../../src/infrastructure/composition-root.js';
import { createSchemaValidator } from '../contract/schema-validator.js';

const INSPECT_OUTPUT_SCHEMA_ID =
  'https://contextvault.local/schemas/mcp/inspect.output.schema.json';

describe('contextvault_inspect MCP tool', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];
  let sandboxPath: string;
  let workspacePath: string;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(tmpdir(), 'contextvault-mcp-inspect-'));
    workspacePath = path.join(sandboxPath, 'workspace');
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
    await rm(sandboxPath, { force: true, recursive: true });
  });

  it('returns schema-valid content-free metadata for an authorized source', async () => {
    const sourceContent = '{"status":"healthy"}\n';
    await writeFile(path.join(workspacePath, 'status.json'), sourceContent);
    const client = await createConnectedClient(workspacePath);

    const result = await callInspect(client, 'repo', 'status.json');
    const serialized = JSON.stringify(result);
    const structured = asRecord(result.structuredContent);
    const source = asRecord(structured.source);

    expect(result.isError).not.toBe(true);
    expect(structured.schemaVersion).toBe('1.0');
    expect(structured.ok).toBe(true);
    expect(source.sourceId).toMatch(/^cv_src_[A-Za-z0-9_-]{43}$/u);
    expect(source.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(source.mediaType).toBe('application/json');
    expect(source.bytes).toBe(Buffer.byteLength(sourceContent));
    expect(source.sensitivity).toBe('internal');
    expect(source.secretRisk).toBe('none');
    expect(source.supportedSelectors).toEqual(['json_node', 'line_range']);
    expect(source.inspectedAt).toBeTypeOf('string');
    expect(serialized).not.toContain(sourceContent.trim());
    expect(serialized).not.toContain(workspacePath);
    await expectValidInspectOutput(result.structuredContent);
  });

  it('returns a stable safe error for traversal without disclosing local paths', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await callInspect(client, 'repo', '../outside.txt');
    const serialized = JSON.stringify(result);
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(structured.schemaVersion).toBe('1.0');
    expect(structured.ok).toBe(false);
    expect(error.code).toBe('CV_PATH_OUTSIDE_WORKSPACE');
    expect(error.correlationId).toMatch(/^cv_corr_[A-Za-z0-9_-]{24}$/u);
    expect(error.retryable).toBe(false);
    expect(serialized).not.toContain(workspacePath);
    expect(serialized).not.toContain('outside.txt');
    await expectValidInspectOutput(result.structuredContent);
  });

  it('returns the same authorization class for an unknown root', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await callInspect(client, 'other', 'status.json');
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(structured.ok).toBe(false);
    expect(error.code).toBe('CV_AUTHORIZATION_DENIED');
    expect(error.retryable).toBe(false);
  });

  it('marks recognized credential structure as prohibited without returning its value', async () => {
    const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    await writeFile(path.join(workspacePath, 'sample.txt'), marker);
    const client = await createConnectedClient(workspacePath);

    const result = await callInspect(client, 'repo', 'sample.txt');
    const serialized = JSON.stringify(result);
    const structured = asRecord(result.structuredContent);
    const source = asRecord(structured.source);

    expect(structured.ok).toBe(true);
    expect(source.sensitivity).toBe('prohibited');
    expect(source.secretRisk).toBe('confirmed');
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain(workspacePath);
  });

  it('rejects unknown input fields at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_inspect',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'status.json' },
        unexpected: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(workspacePath);
  });

  it('rejects an unsupported source kind at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await callInspectWithKind(client, 'remote_url');

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it.each([
    ['1repo', 'a leading digit'],
    ['Repo', 'an uppercase initial letter'],
    ['repo id', 'a space'],
    ['', 'an empty identifier'],
    [`a${'b'.repeat(64)}`, 'an over-length identifier'],
  ])('rejects a root identifier containing %s', async (rootId) => {
    const client = await createConnectedClient(workspacePath);

    const result = await callInspect(client, rootId, 'status.json');

    expect(result.isError).toBe(true);
    // The transport schema must reject the identifier before the use case runs,
    // so the request never reaches the application layer at all.
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(workspacePath);
  });

  it.each([
    ['', 'an empty path'],
    ['a'.repeat(4097), 'an over-length path'],
  ])('rejects %s at the MCP schema boundary', async (sourcePath) => {
    const client = await createConnectedClient(workspacePath);

    const result = await callInspect(client, 'repo', sourcePath);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it.each([
    ['a', 'the minimum supported length'],
    ['a'.repeat(64), 'the maximum supported length'],
  ])('accepts a root identifier at %s (%s) and then denies it as unauthorized', async (rootId) => {
    await writeFile(path.join(workspacePath, 'status.json'), '{"status":"healthy"}\n');
    const client = await createConnectedClient(workspacePath);

    const result = await callInspect(client, rootId, 'status.json');
    const error = asRecord(asRecord(result.structuredContent).error);

    // The identifier passes schema and domain validation, so the request is
    // answered with the authorization class rather than a schema rejection.
    expect(result.isError).toBe(true);
    expect(error.code).toBe('CV_AUTHORIZATION_DENIED');
    expect(JSON.stringify(result)).not.toContain(workspacePath);
  });

  it('accepts an authorized root identifier at the maximum supported length', async () => {
    const longestRootId = 'a'.repeat(64);
    await writeFile(path.join(workspacePath, 'status.json'), '{"status":"healthy"}\n');
    const application = await composeApplication('24.19.0', [
      `--workspace-root=${longestRootId}=${workspacePath}`,
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-inspect-boundary-client', version: '0.0.0' });
    closeCallbacks.push(
      async () => client.close(),
      async () => application.server.close(),
    );
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await callInspect(client, longestRootId, 'status.json');

    expect(result.isError).not.toBe(true);
    expect(asRecord(asRecord(result.structuredContent).source).sensitivity).toBe('internal');
  });

  it('advertises read-only, non-destructive, idempotent, closed-world annotations', async () => {
    const client = await createConnectedClient(workspacePath);

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'contextvault_inspect');

    expect(tool).toBeDefined();
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('returns exactly one content item per call', async () => {
    // The source must exist so the success branch is exercised as well as the
    // error branch; otherwise the assertion would only cover the error envelope.
    await writeFile(path.join(workspacePath, 'status.json'), '{"status":"healthy"}\n');
    const client = await createConnectedClient(workspacePath);

    const success = await callInspect(client, 'repo', 'status.json');
    const failure = await callInspect(client, 'repo', '../outside.txt');

    expect(success.isError).not.toBe(true);
    expect(success.content).toHaveLength(1);
    expect(failure.content).toHaveLength(1);
  });

  async function createConnectedClient(workspaceRoot: string): Promise<Client> {
    const application = await composeApplication('24.19.0', [
      `--workspace-root=repo=${workspaceRoot}`,
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-inspect-test-client', version: '0.0.0' });
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

function callInspect(
  client: Client,
  rootId: string,
  sourcePath: string,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool({
    name: 'contextvault_inspect',
    arguments: {
      source: { kind: 'workspace_file', rootId, path: sourcePath },
    },
  });
}

function callInspectWithKind(
  client: Client,
  kind: string,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool({
    name: 'contextvault_inspect',
    arguments: {
      source: { kind, rootId: 'repo', path: 'status.json' },
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a structured object result.');
  }
  return value as Record<string, unknown>;
}

async function expectValidInspectOutput(value: unknown): Promise<void> {
  const validator = await createSchemaValidator();
  const validate = validator.getSchema(INSPECT_OUTPUT_SCHEMA_ID);
  expect(validate).toBeDefined();
  expect(validate?.(value), JSON.stringify(validate?.errors)).toBe(true);
}

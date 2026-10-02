import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { composeApplication } from '../../src/infrastructure/composition-root.js';
import { createSchemaValidator } from '../contract/schema-validator.js';

const PURGE_OUTPUT_SCHEMA_ID = 'https://contextvault.local/schemas/mcp/purge.output.schema.json';

describe('contextvault_purge MCP tool', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];
  let sandboxPath: string;
  let workspacePath: string;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(tmpdir(), 'contextvault-mcp-purge-'));
    workspacePath = path.join(sandboxPath, 'workspace');
    await mkdir(workspacePath, { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
    await rm(sandboxPath, { force: true, recursive: true });
  });

  it('previews and executes an envelope-bound purge without touching the source file', async () => {
    const sourceContent = 'delete the envelope, not the file\n';
    await writeFile(path.join(workspacePath, 'notes.txt'), sourceContent);
    const client = await createConnectedClient(workspacePath);

    const prepared = asRecord((await callPrepare(client, 'repo', 'notes.txt')).structuredContent);
    const envelopeId = asRecord(prepared.envelope).envelopeId as string;
    const digestBefore = (await readFile(path.join(workspacePath, 'notes.txt'))).toString('base64');

    const preview = await callPurgePreview(client, { kind: 'envelope', envelopeId });
    const previewStructured = asRecord(preview.structuredContent);

    expect(preview.isError).not.toBe(true);
    expect(previewStructured.schemaVersion).toBe('1.0');
    expect(previewStructured.ok).toBe(true);
    expect(previewStructured.purgeIntentId).toMatch(/^cv_pur_[A-Za-z0-9_-]{24}$/u);
    expect(previewStructured.target).toEqual({ kind: 'envelope', envelopeId });
    expect(previewStructured.summary).toMatchObject({ envelopeCount: 1 });
    expect(JSON.stringify(previewStructured)).not.toContain(workspacePath);
    await expectValidPurgeOutput(previewStructured);

    const purgeIntentId = previewStructured.purgeIntentId as string;
    const executed = await callPurgeExecute(client, purgeIntentId);
    const executedStructured = asRecord(executed.structuredContent);

    expect(executed.isError).not.toBe(true);
    expect(executedStructured.schemaVersion).toBe('1.0');
    expect(executedStructured.ok).toBe(true);
    expect(executedStructured.targetKind).toBe('envelope');
    expect(executedStructured.deletedEnvelopes).toBe(1);
    expect(executedStructured.deletedDerivedBytes).toBeGreaterThan(0);
    expect(executedStructured.revokedIntents).toBe(0);
    await expectValidPurgeOutput(executedStructured);

    const executedText = extractSingleTextContent(executed);
    expect(executedText.length).toBeGreaterThan(0);

    const digestAfter = (await readFile(path.join(workspacePath, 'notes.txt'))).toString('base64');
    expect(digestAfter).toBe(digestBefore);
    await expect(stat(path.join(workspacePath, 'notes.txt'))).resolves.toBeTruthy();
  });

  it('rejects replayed purge intents with one generic invalid-intent error', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'text\n');
    const client = await createConnectedClient(workspacePath);
    const envelopeId = await prepareEnvelope(client, 'repo', 'notes.txt');

    const preview = asRecord(
      (await callPurgePreview(client, { kind: 'envelope', envelopeId })).structuredContent,
    );
    const purgeIntentId = preview.purgeIntentId as string;

    const firstExecution = await callPurgeExecute(client, purgeIntentId);
    expect(firstExecution.isError).not.toBe(true);

    const replay = await callPurgeExecute(client, purgeIntentId);
    const error = asRecord(asRecord(replay.structuredContent).error);

    expect(replay.isError).toBe(true);
    expect(error.code).toBe('CV_PURGE_INTENT_INVALID');
    await expectValidPurgeOutput(replay.structuredContent);
  });

  it('rejects an expired purge intent with a dedicated error', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'text\n');
    const client = await createConnectedClient(workspacePath);
    const envelopeId = await prepareEnvelope(client, 'repo', 'notes.txt');

    const preview = asRecord(
      (await callPurgePreview(client, { kind: 'envelope', envelopeId })).structuredContent,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 4 * 60 * 60 * 1000));

    const expired = await callPurgeExecute(client, preview.purgeIntentId as string);
    const error = asRecord(asRecord(expired.structuredContent).error);

    expect(expired.isError).toBe(true);
    expect(error.code).toBe('CV_PURGE_INTENT_EXPIRED');
    await expectValidPurgeOutput(expired.structuredContent);
  });

  it('rejects an envelope purge intent after the envelope was purged by another intent', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'text\n');
    const client = await createConnectedClient(workspacePath);
    const envelopeId = await prepareEnvelope(client, 'repo', 'notes.txt');

    const first = asRecord(
      (await callPurgePreview(client, { kind: 'envelope', envelopeId })).structuredContent,
    );
    const second = asRecord(
      (await callPurgePreview(client, { kind: 'envelope', envelopeId })).structuredContent,
    );

    await callPurgeExecute(client, first.purgeIntentId as string);

    const staleSibling = await callPurgeExecute(client, second.purgeIntentId as string);
    const error = asRecord(asRecord(staleSibling.structuredContent).error);

    expect(staleSibling.isError).toBe(true);
    expect(error.code).toBe('CV_PURGE_INTENT_INVALID');
  });

  it('purges all derived state and keeps every original source intact', async () => {
    const sourceContent = 'whole state purge\n';
    await writeFile(path.join(workspacePath, 'one.txt'), sourceContent);
    await writeFile(path.join(workspacePath, 'two.md'), '# Second\n');
    const client = await createConnectedClient(workspacePath);

    await prepareEnvelope(client, 'repo', 'one.txt');
    await prepareEnvelope(client, 'repo', 'two.md');

    const preview = asRecord(
      (await callPurgePreview(client, { kind: 'all_derived_state' })).structuredContent,
    );
    expect(preview.summary).toMatchObject({ envelopeCount: 2 });

    const executed = await callPurgeExecute(client, preview.purgeIntentId as string);
    const structured = asRecord(executed.structuredContent);

    expect(structured.schemaVersion).toBe('1.0');
    expect(structured.ok).toBe(true);
    expect(structured.targetKind).toBe('all_derived_state');
    expect(structured.deletedEnvelopes).toBe(2);
    expect(structured.deletedDerivedBytes).toBeGreaterThan(0);
    expect(structured.revokedIntents).toBe(0);

    const serialized = JSON.stringify(executed);
    expect(serialized).not.toContain('whole state purge');
    expect(serialized).not.toContain(workspacePath);
    const digestAfter = (await readFile(path.join(workspacePath, 'one.txt'))).toString('base64');
    expect(digestAfter).toBe(Buffer.from(sourceContent).toString('base64'));
  });

  it('loses all derived state when the process restarts', async () => {
    await writeFile(path.join(workspacePath, 'notes.txt'), 'text\n');
    const firstApplication = await composeApplication('24.19.0', [
      `--workspace-root=repo=${workspacePath}`,
    ]);
    const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const firstClient = new Client({ name: 'contextvault-purge-restart-a', version: '0.0.0' });
    closeCallbacks.push(
      async () => firstClient.close(),
      async () => firstApplication.server.close(),
    );
    await firstApplication.server.connect(firstServerTransport);
    await firstClient.connect(firstClientTransport);

    const envelopeId = await prepareEnvelope(firstClient, 'repo', 'notes.txt');
    await firstClient.close();
    await firstApplication.server.close();

    const restartedApplication = await composeApplication('24.19.0', [
      `--workspace-root=repo=${workspacePath}`,
    ]);
    const [restartedTransport, restartedServerTransport] = InMemoryTransport.createLinkedPair();
    const restartedClient = new Client({ name: 'contextvault-purge-restart-b', version: '0.0.0' });
    closeCallbacks.push(
      async () => restartedClient.close(),
      async () => restartedApplication.server.close(),
    );
    await restartedApplication.server.connect(restartedServerTransport);
    await restartedClient.connect(restartedTransport);

    const preview = await callPurgePreview(restartedClient, { kind: 'envelope', envelopeId });
    const error = asRecord(asRecord(preview.structuredContent).error);

    expect(preview.isError).toBe(true);
    expect(error.code).toBe('CV_ENVELOPE_NOT_FOUND');
  });

  it('returns a not-found error for an unknown envelope target', async () => {
    const client = await createConnectedClient(workspacePath);

    const preview = await callPurgePreview(client, {
      kind: 'envelope',
      envelopeId: 'cv_env_unknown0000000001',
    });
    const error = asRecord(asRecord(preview.structuredContent).error);

    expect(preview.isError).toBe(true);
    expect(error.code).toBe('CV_ENVELOPE_NOT_FOUND');
  });

  it('rejects a purge request that carries a source path at the MCP boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const result = await client.callTool({
      name: 'contextvault_purge',
      arguments: {
        operation: 'preview',
        target: { kind: 'envelope', envelopeId: 'cv_env_abcdefghijklmnop' },
        path: 'secret.txt',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('rejects cross-operation field combinations at the MCP schema boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const previewWithIntent = await client.callTool({
      name: 'contextvault_purge',
      arguments: {
        operation: 'preview',
        target: { kind: 'all_derived_state' },
        purgeIntentId: 'cv_pur_abcdefghijklmnop',
      },
    });
    expect(previewWithIntent.isError).toBe(true);
    expect(previewWithIntent.structuredContent).toBeUndefined();

    const executeWithTarget = await client.callTool({
      name: 'contextvault_purge',
      arguments: {
        operation: 'execute',
        purgeIntentId: 'cv_pur_abcdefghijklmnop',
        target: { kind: 'all_derived_state' },
      },
    });
    expect(executeWithTarget.isError).toBe(true);
    expect(executeWithTarget.structuredContent).toBeUndefined();
  });

  it('rejects a malformed intent identifier and unknown fields at the MCP boundary', async () => {
    const client = await createConnectedClient(workspacePath);

    const malformedIntent = await client.callTool({
      name: 'contextvault_purge',
      arguments: { operation: 'execute', purgeIntentId: 'not-an-intent-id' },
    });
    expect(malformedIntent.isError).toBe(true);
    expect(malformedIntent.structuredContent).toBeUndefined();

    const unknownField = await client.callTool({
      name: 'contextvault_purge',
      arguments: {
        operation: 'preview',
        target: { kind: 'all_derived_state' },
        confirm: true,
      },
    });
    expect(unknownField.isError).toBe(true);
    expect(unknownField.structuredContent).toBeUndefined();
  });

  it('advertises destructive, non-idempotent, closed-world annotations', async () => {
    const client = await createConnectedClient(workspacePath);

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'contextvault_purge');

    expect(tool).toBeDefined();
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  async function createConnectedClient(workspaceRoot: string): Promise<Client> {
    const application = await composeApplication('24.19.0', [
      `--workspace-root=repo=${workspaceRoot}`,
    ]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-purge-test-client', version: '0.0.0' });
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

  async function prepareEnvelope(
    client: Client,
    rootId: string,
    sourcePath: string,
  ): Promise<string> {
    const prepared = asRecord((await callPrepare(client, rootId, sourcePath)).structuredContent);
    return asRecord(prepared.envelope).envelopeId as string;
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

function callPurgePreview(
  client: Client,
  target: { kind: 'envelope'; envelopeId: string } | { kind: 'all_derived_state' },
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool({
    name: 'contextvault_purge',
    arguments: { operation: 'preview', target },
  });
}

function callPurgeExecute(
  client: Client,
  purgeIntentId: string,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool({
    name: 'contextvault_purge',
    arguments: { operation: 'execute', purgeIntentId },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a structured object result.');
  }
  return value as Record<string, unknown>;
}

async function expectValidPurgeOutput(value: unknown): Promise<void> {
  const validator = await createSchemaValidator();
  const validate = validator.getSchema(PURGE_OUTPUT_SCHEMA_ID);
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

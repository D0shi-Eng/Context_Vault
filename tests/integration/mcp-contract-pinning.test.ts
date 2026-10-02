import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { composeApplication } from '../../src/infrastructure/composition-root.js';
import {
  CAPABILITY_TOKEN_PATTERN,
  CHUNK_ID_PATTERN,
  ENVELOPE_ID_PATTERN,
  NODE_ID_PATTERN,
  OMISSION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_ID_PATTERN,
} from '../../src/adapters/inbound/mcp/common-schemas.js';
import { buildErrorResult } from '../../src/adapters/inbound/mcp/shared-handler.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';

/**
 * Contract pinning for MCP adapter schemas, patterns, and annotations.
 *
 * Each assertion targets a mutation survivor class:
 * - Regex anchor removals are killed by exact pattern strings from ListTools
 *   and by direct prefix/suffix probes against the exported patterns.
 * - Numeric bound mutations (.min -> .max(0)) are killed by exact
 *   minimum/maximum assertions from the advertised JSON Schema.
 * - Boolean annotation mutations are killed by exact annotation assertions.
 * - Object-shape mutations are killed by required-property assertions.
 * - Title/description literals are asserted non-empty (kills "" without
 *   pinning exact prose).
 */
describe('MCP adapter contract pinning', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
  });

  it('advertises exact tool annotations for all six tools', async () => {
    const client = await createClient();
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));

    expect(byName.get('contextvault_inspect')?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('contextvault_prepare')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get('contextvault_retrieve')?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('contextvault_verify')?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('contextvault_stats')?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get('contextvault_purge')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('advertises non-empty titles and descriptions for all tools', async () => {
    const client = await createClient();
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(6);
    for (const tool of tools.tools) {
      expect(typeof tool.title).toBe('string');
      expect(tool.title?.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description?.length).toBeGreaterThan(0);
    }
  });

  it('advertises exact anchored input patterns', async () => {
    const client = await createClient();
    const tools = await client.listTools();
    const serialized = JSON.stringify(tools.tools);
    for (const pattern of [
      '^[a-z][a-z0-9_-]{0,63}$',
      '^cv1_[A-Za-z0-9_-]{43,512}$',
      '^cv_chunk_[A-Za-z0-9_-]{8,128}$',
      '^cv_node_[A-Za-z0-9_-]{1,128}$',
      '^cv_env_[A-Za-z0-9_-]{16,128}$',
      '^cv_pur_[A-Za-z0-9_-]{16,128}$',
    ]) {
      expect(serialized).toContain(pattern);
    }
    // No unanchored weakening may be advertised.
    expect(serialized).not.toContain('"pattern":"cv_');
    expect(serialized).not.toContain('"pattern":"sha256:');
    expect(serialized).not.toContain('"pattern":"CV_');
  });

  it('advertises exact numeric bounds for request budgets and ranges', async () => {
    const client = await createClient();
    const tools = await client.listTools();
    const retrieve = tools.tools.find((tool) => tool.name === 'contextvault_retrieve');
    const retrieveSchema = retrieve?.inputSchema as Record<string, unknown>;
    const retrieveProps = retrieveSchema.properties as Record<string, Record<string, unknown>>;
    expect(retrieveProps.maxBytes).toMatchObject({ minimum: 1, maximum: 1048576 });

    const prepare = tools.tools.find((tool) => tool.name === 'contextvault_prepare');
    const prepareSchema = prepare?.inputSchema as Record<string, unknown>;
    const prepareProps = prepareSchema.properties as Record<string, Record<string, unknown>>;
    expect(prepareProps.ttlSeconds).toMatchObject({ minimum: 60, maximum: 7200 });

    const verify = tools.tools.find((tool) => tool.name === 'contextvault_verify');
    const verifySchema = verify?.inputSchema as Record<string, unknown>;
    const verifyProps = verifySchema.properties as Record<string, Record<string, unknown>>;
    expect(verifyProps.checks).toMatchObject({ minItems: 1, maxItems: 16 });
  });

  it('advertises exact output patterns and counter bounds', async () => {
    const client = await createClient();
    const tools = await client.listTools();
    const serialized = JSON.stringify(tools.tools.map((tool) => tool.outputSchema));
    for (const pattern of [
      '^cv_env_[A-Za-z0-9_-]{16,128}$',
      '^cv_src_[A-Za-z0-9_-]{16,128}$',
      '^sha256:[0-9a-f]{64}$',
      '^CV_[A-Z0-9_]{3,80}$',
      '^cv_corr_[A-Za-z0-9_-]{16,128}$',
      '^cv_omit_[A-Za-z0-9_-]{8,128}$',
      '^cv_pur_[A-Za-z0-9_-]{16,128}$',
      '^cv_chunk_[A-Za-z0-9_-]{8,128}$',
      '^cv_node_[A-Za-z0-9_-]{1,128}$',
    ]) {
      expect(serialized).toContain(pattern);
    }

    const stats = tools.tools.find((tool) => tool.name === 'contextvault_stats');
    const statsOutput = stats?.outputSchema as Record<string, unknown>;
    const statsProps = statsOutput.properties as Record<string, unknown>;
    const counters = (statsProps.counters as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    for (const name of [
      'activeEnvelopeCount',
      'activeGrantCount',
      'authorizedRootCount',
      'serializedDerivedRecordBytes',
      'provenanceRecordsRetained',
      'successfulRequests',
      'failedRequests',
      'envelopesRemovedByExpiry',
      'envelopesRemovedByPurge',
      'grantsRevoked',
      'purgeIntentsConsumed',
    ]) {
      expect(counters[name]).toMatchObject({ minimum: 0 });
      expect(counters[name]).not.toMatchObject({ maximum: 0 });
    }
    const required = (statsProps.counters as Record<string, unknown>).required as unknown[];
    expect(required).toContain('activeEnvelopeCount');
    expect(required).toContain('failedRequests');
    expect(required).toContain('envelopesRemovedByExpiry');
    expect(required).toContain('purgeIntentsConsumed');

    const prepare = tools.tools.find((tool) => tool.name === 'contextvault_prepare');
    const prepareOutput = JSON.stringify(prepare?.outputSchema);
    for (const fragment of [
      '"minimum":0',
      '"minimum":1',
      '"maximum":64',
      '"maxItems":1024',
      '"maximum":1048576',
      '"maximum":67108864',
      '"maximum":1000000',
    ]) {
      expect(prepareOutput).toContain(fragment);
    }
    expect(prepareOutput).toContain('text_chunks');
    expect(prepareOutput).toContain('json_structure');
    expect(prepareOutput).toContain('minimal');

    const purge = tools.tools.find((tool) => tool.name === 'contextvault_purge');
    const purgeOutput = JSON.stringify(purge?.outputSchema);
    expect(purgeOutput).toContain('"maximum":64');
    expect(purgeOutput).toContain('"maximum":16');
    expect(purgeOutput).toContain('"maximum":32');
    expect(purgeOutput).toContain('"maximum":4194304');

    const inspect = tools.tools.find((tool) => tool.name === 'contextvault_inspect');
    const inspectOutput = JSON.stringify(inspect?.outputSchema);
    for (const value of ['public', 'internal', 'confidential', 'restricted', 'prohibited']) {
      expect(inspectOutput).toContain(value);
    }
    for (const value of ['none', 'suspected', 'confirmed', 'unknown']) {
      expect(inspectOutput).toContain(value);
    }
  });

  it('rejects unanchored identifier forgeries against exported patterns', () => {
    const validSource = `cv_src_${'a'.repeat(16)}`;
    const validEnvelope = `cv_env_${'a'.repeat(16)}`;
    const validDigest = `sha256:${'a'.repeat(64)}`;
    expect(SOURCE_ID_PATTERN.test(validSource)).toBe(true);
    expect(ENVELOPE_ID_PATTERN.test(validEnvelope)).toBe(true);
    expect(SHA256_PATTERN.test(validDigest)).toBe(true);

    // Leading junk must fail even though the valid suffix is present.
    expect(SOURCE_ID_PATTERN.test(`X${validSource}`)).toBe(false);
    expect(ENVELOPE_ID_PATTERN.test(`X${validEnvelope}`)).toBe(false);
    expect(SHA256_PATTERN.test(`X${validDigest}`)).toBe(false);
    expect(CHUNK_ID_PATTERN.test(`Xcv_chunk_${'a'.repeat(12)}`)).toBe(false);
    expect(NODE_ID_PATTERN.test(`Xcv_node_${'a'.repeat(8)}`)).toBe(false);
    expect(OMISSION_ID_PATTERN.test(`Xcv_omit_${'a'.repeat(8)}`)).toBe(false);
    expect(CAPABILITY_TOKEN_PATTERN.test(`Xcv1_${'a'.repeat(43)}`)).toBe(false);

    // Trailing junk must fail even though the valid prefix is present.
    expect(SOURCE_ID_PATTERN.test(`${validSource}!`)).toBe(false);
    expect(ENVELOPE_ID_PATTERN.test(`${validEnvelope}!`)).toBe(false);
    expect(SHA256_PATTERN.test(`${validDigest}0`)).toBe(false);
    expect(CHUNK_ID_PATTERN.test(`cv_chunk_${'a'.repeat(12)}!`)).toBe(false);
    expect(NODE_ID_PATTERN.test(`cv_node_${'a'.repeat(8)}!`)).toBe(false);
    expect(CAPABILITY_TOKEN_PATTERN.test(`cv1_${'a'.repeat(43)}!`)).toBe(false);

    // Embedded valid values inside longer strings must fail.
    expect(SOURCE_ID_PATTERN.test(`!!${validSource}!!`)).toBe(false);
    expect(SHA256_PATTERN.test(`xx${validDigest}yy`)).toBe(false);
  });

  it('enforces pattern length boundaries exactly', () => {
    expect(SOURCE_ID_PATTERN.test(`cv_src_${'a'.repeat(15)}`)).toBe(false);
    expect(SOURCE_ID_PATTERN.test(`cv_src_${'a'.repeat(16)}`)).toBe(true);
    expect(SOURCE_ID_PATTERN.test(`cv_src_${'a'.repeat(128)}`)).toBe(true);
    expect(SOURCE_ID_PATTERN.test(`cv_src_${'a'.repeat(129)}`)).toBe(false);

    expect(SHA256_PATTERN.test(`sha256:${'a'.repeat(63)}`)).toBe(false);
    expect(SHA256_PATTERN.test(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(SHA256_PATTERN.test(`sha256:${'a'.repeat(65)}`)).toBe(false);
    expect(SHA256_PATTERN.test(`sha256:${'A'.repeat(64)}`)).toBe(false);

    expect(CAPABILITY_TOKEN_PATTERN.test(`cv1_${'a'.repeat(42)}`)).toBe(false);
    expect(CAPABILITY_TOKEN_PATTERN.test(`cv1_${'a'.repeat(43)}`)).toBe(true);
    expect(CAPABILITY_TOKEN_PATTERN.test(`cv1_${'a'.repeat(512)}`)).toBe(true);
    expect(CAPABILITY_TOKEN_PATTERN.test(`cv1_${'a'.repeat(513)}`)).toBe(false);

    expect(ENVELOPE_ID_PATTERN.test(`cv_env_${'é'.repeat(16)}`)).toBe(false);
    expect(SOURCE_ID_PATTERN.test(`cv_src_${'a'.repeat(16)}\u{1F600}`)).toBe(false);
  });

  it('maps unknown failures to the generic internal error without leaking internals', () => {
    const generic = buildErrorResult(new Error('boom'), 'cv_corr_fallback00000000');
    expect(generic.ok).toBe(false);
    expect(generic.error.code).toBe('CV_INTERNAL_ERROR');
    expect(generic.error.message.length).toBeGreaterThan(0);
    expect(generic.error.retryable).toBe(false);

    const domain = new ContextVaultError({
      code: 'CV_INPUT_INVALID',
      message: 'The retrieval selector is invalid.',
    });
    const mapped = buildErrorResult(domain, 'cv_corr_fallback00000000');
    expect(mapped.error.code).toBe('CV_INPUT_INVALID');
    expect(mapped.error.message.length).toBeGreaterThan(0);

    const undefinedMapped = buildErrorResult(undefined, 'cv_corr_fallback00000000');
    expect(undefinedMapped.error.code).toBe('CV_INTERNAL_ERROR');
  });

  it('returns non-empty error messages that satisfy the output schema', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const sandboxPath = await mkdtemp(path.join(tmpdir(), 'contract-pinning-error-'));
    const workspacePath = path.join(sandboxPath, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, 'notes.txt'), 'alpha\nbeta\n');
    try {
      const { composeApplication: compose } =
        await import('../../src/infrastructure/composition-root.js');
      const application = await compose('24.19.0', [`--workspace-root=repo=${workspacePath}`]);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'error-pinning-client', version: '0.0.0' });
      closeCallbacks.push(
        async () => client.close(),
        async () => application.server.close(),
      );
      await application.server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();

      const denied = await client.callTool({
        name: 'contextvault_retrieve',
        arguments: {
          capability: `cv1_${'z'.repeat(43)}`,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        },
      });
      expect(denied.isError).toBe(true);
      const structured = denied.structuredContent as Record<string, unknown>;
      expect(structured.ok).toBe(false);
      const error = structured.error as Record<string, unknown>;
      expect(typeof error.code).toBe('string');
      expect(error.code).toBe('CV_CAPABILITY_INVALID');
      expect(typeof error.message).toBe('string');
      expect((error.message as string).length).toBeGreaterThan(0);
      expect(typeof error.correlationId).toBe('string');
      expect((error.correlationId as string).length).toBeGreaterThan(0);
      expect(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u.test(error.correlationId as string)).toBe(true);
    } finally {
      await rm(sandboxPath, { force: true, recursive: true });
    }
  });

  async function createClient(): Promise<Client> {
    const application = await composeApplication('24.19.0', []);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract-pinning-client', version: '0.0.0' });
    closeCallbacks.push(
      async () => client.close(),
      async () => application.server.close(),
    );
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpServer } from '../../src/adapters/inbound/mcp/create-mcp-server.js';
import type { McpServerDependencies } from '../../src/adapters/inbound/mcp/create-mcp-server.js';
import {
  CAPABILITY_TOKEN_PATTERN,
  CHUNK_ID_PATTERN,
  ENVELOPE_ID_PATTERN,
  NODE_ID_PATTERN,
  OMISSION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_ID_PATTERN,
  chunkDescriptorSchema,
  jsonNodeDescriptorSchema,
  omissionSchema,
  retrievalSelectorSchema,
  sourceReferenceSchema,
} from '../../src/adapters/inbound/mcp/common-schemas.js';
import { buildErrorResult } from '../../src/adapters/inbound/mcp/shared-handler.js';
import type { RequestCounters } from '../../src/domain/stats/stats-policy.js';
import {
  ContextVaultError,
  isContextVaultError,
} from '../../src/domain/errors/context-vault-error.js';

const CORRELATION_ID = `cv_corr_${'c'.repeat(24)}`;

function createCounterStub(): RequestCounters {
  return {
    recordSuccess: (): void => undefined,
    recordFailure: (): void => undefined,
    snapshot: () => ({ successful: 0, failed: 0 }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a structured object result.');
  }
  return value as Record<string, unknown>;
}

describe('mcp handler propagation hardening', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
  });

  it('omits optional prepare fields instead of forwarding undefined values', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer({
      correlationIds: { create: (): string => CORRELATION_ID },
      requestCounters: createCounterStub(),
      inspectSource: { execute: () => Promise.reject(new Error('unused')) },
      prepareSource: {
        execute: ((request: unknown) => {
          seen.push(request);
          return Promise.resolve({
            schemaVersion: '1.0' as const,
            ok: true as const,
            envelope: minimalEnvelope(),
          });
        }) as unknown as McpServerDependencies['prepareSource']['execute'],
      },
      retrieveSource: { execute: () => Promise.reject(new Error('unused')) },
      verifyEnvelope: { execute: () => Promise.reject(new Error('unused')) },
      collectSessionStats: {
        execute: () => ({
          schemaVersion: '1.0' as const,
          ok: true as const,
          counters: {
            activeEnvelopeCount: 0,
            activeGrantCount: 0,
            authorizedRootCount: 1,
            serializedDerivedRecordBytes: 0,
            provenanceRecordsRetained: 0,
            successfulRequests: 0,
            failedRequests: 0,
            envelopesRemovedByExpiry: 0,
            envelopesRemovedByPurge: 0,
            grantsRevoked: 0,
            purgeIntentsConsumed: 0,
          },
          measuredAt: new Date('2026-09-10T12:00:00.000Z').toISOString(),
        }),
      },
      purgeDerivedState: {
        preview: (): never => {
          throw new Error('unused');
        },
        execute: (): never => {
          throw new Error('unused');
        },
      },
    });
    const client = await connectClient(server);
    await client.callTool({
      name: 'contextvault_prepare',
      arguments: { source: { kind: 'workspace_file', rootId: 'repo', path: 'file.txt' } },
    });
    const request = asRecord(seen[0]);
    expect(request).not.toHaveProperty('ttlSeconds');
    expect(request).not.toHaveProperty('retrieval');
    expect('source' in request).toBe(true);
  });

  it('forwards explicit prepare ttl and retrieval hints unchanged', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer({
      correlationIds: { create: (): string => CORRELATION_ID },
      requestCounters: createCounterStub(),
      inspectSource: { execute: () => Promise.reject(new Error('unused')) },
      prepareSource: {
        execute: ((request: unknown) => {
          seen.push(request);
          return Promise.resolve({
            schemaVersion: '1.0' as const,
            ok: true as const,
            envelope: minimalEnvelope(),
          });
        }) as unknown as McpServerDependencies['prepareSource']['execute'],
      },
      retrieveSource: { execute: () => Promise.reject(new Error('unused')) },
      verifyEnvelope: { execute: () => Promise.reject(new Error('unused')) },
      collectSessionStats: {
        execute: () => ({
          schemaVersion: '1.0' as const,
          ok: true as const,
          counters: {
            activeEnvelopeCount: 0,
            activeGrantCount: 0,
            authorizedRootCount: 1,
            serializedDerivedRecordBytes: 0,
            provenanceRecordsRetained: 0,
            successfulRequests: 0,
            failedRequests: 0,
            envelopesRemovedByExpiry: 0,
            envelopesRemovedByPurge: 0,
            grantsRevoked: 0,
            purgeIntentsConsumed: 0,
          },
          measuredAt: new Date('2026-09-10T12:00:00.000Z').toISOString(),
        }),
      },
      purgeDerivedState: {
        preview: (): never => {
          throw new Error('unused');
        },
        execute: (): never => {
          throw new Error('unused');
        },
      },
    });
    const client = await connectClient(server);
    await client.callTool({
      name: 'contextvault_prepare',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'file.txt' },
        ttlSeconds: 120,
        retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 64 },
      },
    });
    const request = asRecord(seen[0]);
    expect(request.ttlSeconds).toBe(120);
    expect(asRecord(request.retrieval).maxBytes).toBe(64);
  });

  it('omits optional retrieve maxBytes instead of forwarding undefined', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer(baseDependencies(seen));
    const client = await connectClient(server);
    await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability: `cv1_${'k'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: `cv_chunk_${'a'.repeat(12)}` },
      },
    });
    const request = asRecord(seen[0]);
    expect(request).not.toHaveProperty('maxBytes');
  });

  it('forwards explicit retrieve maxBytes unchanged', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer(baseDependencies(seen));
    const client = await connectClient(server);
    await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability: `cv1_${'k'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: `cv_chunk_${'a'.repeat(12)}` },
        maxBytes: 128,
      },
    });
    expect(asRecord(seen[0]).maxBytes).toBe(128);
  });

  it('omits missing verify chunkId instead of forwarding undefined', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer(baseVerifyDependencies(seen));
    const client = await connectClient(server);
    const result = await client.callTool({
      name: 'contextvault_verify',
      arguments: {
        envelopeId: `cv_env_${'e'.repeat(16)}`,
        checks: [{ kind: 'source_freshness' }],
      },
    });
    const structured = asRecord(result.structuredContent);
    const results = structured.results as Record<string, unknown>[];
    expect(results[0]).not.toHaveProperty('chunkId');
    expect(seen).toHaveLength(1);
  });

  it('preserves a present verify chunkId through the handler', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer(baseVerifyDependencies(seen));
    const client = await connectClient(server);
    const chunkId = `cv_chunk_${'b'.repeat(12)}`;
    const result = await client.callTool({
      name: 'contextvault_verify',
      arguments: {
        envelopeId: `cv_env_${'e'.repeat(16)}`,
        checks: [{ kind: 'chunk_integrity', chunkId }],
      },
    });
    const structured = asRecord(result.structuredContent);
    const results = structured.results as Record<string, unknown>[];
    expect(results[0]?.chunkId).toBe(chunkId);
  });

  it('collapses unknown failures to a safe internal envelope', () => {
    const plain = buildErrorResult(new Error('boom'), CORRELATION_ID);
    expect(plain.error.code).toBe('CV_INTERNAL_ERROR');
    expect(plain.error.message.length).toBeGreaterThan(0);
    expect(plain.error.correlationId).toBe(CORRELATION_ID);
    expect(plain.ok).toBe(false);
    const absent = buildErrorResult(undefined, CORRELATION_ID);
    expect(absent.error.code).toBe('CV_INTERNAL_ERROR');
    expect(absent.error.message.length).toBeGreaterThan(0);
    const known = buildErrorResult(
      new ContextVaultError({
        code: 'CV_SOURCE_NOT_FOUND',
        message: 'The requested source was not found.',
      }),
      CORRELATION_ID,
    );
    expect(known.error.code).toBe('CV_SOURCE_NOT_FOUND');
    expect(known.error.message.length).toBeGreaterThan(0);
  });

  it('maps an unknown retrieve failure to a shaped internal envelope', async () => {
    const server = createMcpServer({
      correlationIds: { create: (): string => CORRELATION_ID },
      requestCounters: createCounterStub(),
      inspectSource: { execute: () => Promise.reject(new Error('unused')) },
      prepareSource: { execute: () => Promise.reject(new Error('unused')) },
      retrieveSource: {
        execute: () => Promise.reject(new Error('sensitive-nested-failure')),
      },
      verifyEnvelope: { execute: () => Promise.reject(new Error('unused')) },
      collectSessionStats: {
        execute: (): never => {
          throw new Error('unused');
        },
      },
      purgeDerivedState: {
        preview: (): never => {
          throw new Error('unused');
        },
        execute: (): never => {
          throw new Error('unused');
        },
      },
    });
    const client = await connectClient(server);
    const result = await client.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability: `cv1_${'k'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: `cv_chunk_${'a'.repeat(12)}` },
      },
    });
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);
    expect(result.isError).toBe(true);
    expect(structured.ok).toBe(false);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error.message).toBeTypeOf('string');
    expect((error.message as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('sensitive-nested-failure');
  });

  it('fails closed with a non-empty message for a malformed purge shape', async () => {
    const malformed: unknown = { schemaVersion: '1.0', ok: true, unexpected: 'shape' };
    const server = createMcpServer({
      correlationIds: { create: (): string => CORRELATION_ID },
      requestCounters: createCounterStub(),
      inspectSource: { execute: () => Promise.reject(new Error('unused')) },
      prepareSource: { execute: () => Promise.reject(new Error('unused')) },
      retrieveSource: { execute: () => Promise.reject(new Error('unused')) },
      verifyEnvelope: { execute: () => Promise.reject(new Error('unused')) },
      collectSessionStats: {
        execute: (): never => {
          throw new Error('unused');
        },
      },
      purgeDerivedState: {
        preview: () => malformed as never,
        execute: () => malformed as never,
      },
    });
    const client = await connectClient(server);
    const preview = await client.callTool({
      name: 'contextvault_purge',
      arguments: { operation: 'preview', target: { kind: 'all_derived_state' } },
    });
    const previewError = asRecord(asRecord(preview.structuredContent).error);
    expect(preview.isError).toBe(true);
    expect(previewError.code).toBe('CV_INTERNAL_ERROR');
    expect((previewError.message as string).length).toBeGreaterThan(0);
    const execute = await client.callTool({
      name: 'contextvault_purge',
      arguments: { operation: 'execute', purgeIntentId: `cv_pur_${'p'.repeat(16)}` },
    });
    const executeError = asRecord(asRecord(execute.structuredContent).error);
    expect(execute.isError).toBe(true);
    expect(executeError.code).toBe('CV_INTERNAL_ERROR');
    expect((executeError.message as string).length).toBeGreaterThan(0);
  });

  it('advertises exact tool annotations through ListTools', async () => {
    const server = createMcpServer(baseDependencies([]));
    const client = await connectClient(server);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
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
  });

  async function connectClient(server: ReturnType<typeof createMcpServer>): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract-hardening-client', version: '0.0.0' });
    closeCallbacks.push(
      async () => client.close(),
      async () => server.close(),
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    return client;
  }
});

describe('mcp schema contract hardening', () => {
  it('anchors omission identifiers at both ends', () => {
    expect(OMISSION_ID_PATTERN.test(`cv_omit_${'a'.repeat(8)}`)).toBe(true);
    expect(OMISSION_ID_PATTERN.test(`cv_omit_${'a'.repeat(8)}!`)).toBe(false);
    expect(OMISSION_ID_PATTERN.test(`cv_omit_${'a'.repeat(8)} extra`)).toBe(false);
    expect(
      omissionSchema.safeParse({
        omissionId: `cv_omit_${'a'.repeat(8)}`,
        locator: { kind: 'byte_range', value: '0-8' },
        reason: 'policy',
        itemCount: 1,
        retrievable: false,
      }).success,
    ).toBe(true);
  });

  it('anchors envelope, chunk, and digest patterns at both ends', () => {
    expect(ENVELOPE_ID_PATTERN.test(`cv_env_${'e'.repeat(16)}`)).toBe(true);
    expect(ENVELOPE_ID_PATTERN.test(`cv_env_${'e'.repeat(16)}!`)).toBe(false);
    expect(CHUNK_ID_PATTERN.test(`cv_chunk_${'c'.repeat(8)}`)).toBe(true);
    expect(CHUNK_ID_PATTERN.test(`cv_chunk_${'c'.repeat(8)}!`)).toBe(false);
    expect(SHA256_PATTERN.test(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(SHA256_PATTERN.test(`sha256:${'a'.repeat(64)}!`)).toBe(false);
    expect(SHA256_PATTERN.test(`sha256:${'A'.repeat(64)}`)).toBe(false);
  });

  it('requires non-negative numeric bounds and positive counts', () => {
    const base = {
      chunkId: `cv_chunk_${'c'.repeat(8)}`,
      byteStart: 0,
      byteEndExclusive: 8,
      lineStart: 1,
      lineEndExclusive: 2,
      byteLength: 8,
      chunkDigest: `sha256:${'a'.repeat(64)}`,
      truncated: false,
    };
    expect(chunkDescriptorSchema.safeParse(base).success).toBe(true);
    expect(chunkDescriptorSchema.safeParse({ ...base, byteStart: 4 }).success).toBe(true);
    expect(chunkDescriptorSchema.safeParse({ ...base, lineStart: 7 }).success).toBe(true);
    expect(
      omissionSchema.safeParse({
        omissionId: `cv_omit_${'a'.repeat(8)}`,
        locator: { kind: 'byte_range', value: '0-8' },
        reason: 'budget',
        itemCount: 3,
        retrievable: false,
      }).success,
    ).toBe(true);
  });

  it('pins categorical enums instead of accepting empty text', () => {
    expect(
      chunkDescriptorSchema.safeParse({
        chunkId: `cv_chunk_${'c'.repeat(8)}`,
        byteStart: 0,
        byteEndExclusive: 1,
        lineStart: 1,
        lineEndExclusive: 2,
        byteLength: 1,
        chunkDigest: `sha256:${'a'.repeat(64)}`,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      omissionSchema.safeParse({
        omissionId: `cv_omit_${'a'.repeat(8)}`,
        locator: { kind: '', value: '0-8' },
        reason: 'policy',
        itemCount: 1,
        retrievable: false,
      }).success,
    ).toBe(false);
    expect(
      omissionSchema.safeParse({
        omissionId: `cv_omit_${'a'.repeat(8)}`,
        locator: { kind: 'byte_range', value: '0-8' },
        reason: '',
        itemCount: 1,
        retrievable: false,
      }).success,
    ).toBe(false);
    expect(
      retrievalSelectorSchema.safeParse({ kind: 'chunk', chunkId: `cv_chunk_${'c'.repeat(8)}` })
        .success,
    ).toBe(true);
    expect(retrievalSelectorSchema.safeParse({ kind: '', chunkId: 'x' }).success).toBe(false);
  });

  it('keeps selector object shapes exact', () => {
    expect(
      retrievalSelectorSchema.safeParse({ kind: 'chunk', chunkId: `cv_chunk_${'c'.repeat(8)}` })
        .success,
    ).toBe(true);
    expect(
      retrievalSelectorSchema.safeParse({
        kind: 'line_range',
        startLine: 1,
        endLine: 2,
      }).success,
    ).toBe(true);
    expect(
      retrievalSelectorSchema.safeParse({
        kind: 'json_node',
        nodeId: `cv_node_${'n'.repeat(6)}`,
      }).success,
    ).toBe(true);
    expect(
      sourceReferenceSchema.safeParse({
        kind: 'workspace_file',
        rootId: 'repo',
        path: 'file.txt',
      }).success,
    ).toBe(true);
  });

  it('returns shaped success and error envelopes through the transport', async () => {
    const seen: unknown[] = [];
    const server = createMcpServer(baseDependencies(seen));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract-shape-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    try {
      const success = await client.callTool({
        name: 'contextvault_retrieve',
        arguments: {
          capability: `cv1_${'k'.repeat(43)}`,
          selector: { kind: 'chunk', chunkId: `cv_chunk_${'a'.repeat(12)}` },
        },
      });
      const structured = asRecord(success.structuredContent);
      expect(structured.schemaVersion).toBe('1.0');
      expect(structured.ok).toBe(true);
      expect(structured.envelopeId).toMatch(/^cv_env_/u);
      expect(structured.content).toBe('alpha');
      expect(structured.truncated).toBe(false);
      expect(structured.hasMore).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('mcp focused contract boundaries', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];

  afterEach(async (): Promise<void> => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
  });

  async function connectTestClient(server: ReturnType<typeof createMcpServer>): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract-boundary-client', version: '0.0.0' });
    closeCallbacks.push(
      async (): Promise<void> => {
        await client.close();
      },
      async (): Promise<void> => {
        await server.close();
      },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    return client;
  }

  function getToolRecord(
    tools: readonly { name: string; outputSchema?: unknown }[],
    name: string,
  ): { name: string; outputSchema?: unknown } {
    const found = tools.find((tool) => tool.name === name);
    if (found === undefined) {
      throw new Error(`Expected tool ${name}.`);
    }
    return found;
  }

  function getOutputProperties(tool: { outputSchema?: unknown }): Record<string, unknown> {
    const outputSchema = asRecord(tool.outputSchema);
    return asRecord(outputSchema.properties);
  }

  function getPatternForField(properties: Record<string, unknown>, field: string): string {
    const fieldSchema = asRecord(properties[field]);
    const pattern = fieldSchema.pattern;
    if (typeof pattern !== 'string') {
      throw new Error(`Expected a pattern string for ${field}.`);
    }
    return pattern;
  }

  function expectNineProbes(params: {
    pattern: string;
    valid: string;
    tooShort: string;
    minValid: string;
    maxValid: string;
    tooLong: string;
  }): void {
    const live = new RegExp(params.pattern, 'u');
    expect(live.test(params.valid)).toBe(true);
    expect(live.test(`${params.valid}!`)).toBe(false);
    expect(live.test(`X${params.valid}`)).toBe(false);
    expect(live.test(`!!${params.valid}!!`)).toBe(false);
    expect(live.test(params.tooShort)).toBe(false);
    expect(live.test(params.minValid)).toBe(true);
    expect(live.test(params.maxValid)).toBe(true);
    expect(live.test(params.tooLong)).toBe(false);
    expect(live.test(`${params.valid}é`)).toBe(false);
  }

  it('pins retrieve output envelopeId with nine probes', async () => {
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    const { tools } = await client.listTools();
    const tool = getToolRecord(tools, 'contextvault_retrieve');
    const props = getOutputProperties(tool);
    const pattern = getPatternForField(props, 'envelopeId');
    expect(pattern).toBe('^cv_env_[A-Za-z0-9_-]{16,128}$');
    const valid = `cv_env_${'e'.repeat(16)}`;
    expectNineProbes({
      pattern,
      valid,
      tooShort: `cv_env_${'e'.repeat(15)}`,
      minValid: `cv_env_${'e'.repeat(16)}`,
      maxValid: `cv_env_${'e'.repeat(128)}`,
      tooLong: `cv_env_${'e'.repeat(129)}`,
    });
  });

  it('pins retrieve output digests with nine probes', async () => {
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    const { tools } = await client.listTools();
    const tool = getToolRecord(tools, 'contextvault_retrieve');
    const props = getOutputProperties(tool);
    for (const field of ['sourceDigest', 'excerptDigest']) {
      const pattern = getPatternForField(props, field);
      expect(pattern).toBe('^sha256:[0-9a-f]{64}$');
      const valid = `sha256:${'a'.repeat(64)}`;
      expectNineProbes({
        pattern,
        valid,
        tooShort: `sha256:${'a'.repeat(63)}`,
        minValid: valid,
        maxValid: valid,
        tooLong: `sha256:${'a'.repeat(65)}`,
      });
      expect(new RegExp(pattern, 'u').test(`sha256:${'A'.repeat(64)}`)).toBe(false);
    }
  });

  it('pins inspect output identifiers with nine probes', async () => {
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    const { tools } = await client.listTools();
    const tool = getToolRecord(tools, 'contextvault_inspect');
    const outputProps = getOutputProperties(tool);
    const sourceProps = asRecord(asRecord(outputProps.source).properties);
    const sourceIdPattern = getPatternForField(sourceProps, 'sourceId');
    expect(sourceIdPattern).toBe('^cv_src_[A-Za-z0-9_-]{16,128}$');
    expectNineProbes({
      pattern: sourceIdPattern,
      valid: `cv_src_${'a'.repeat(16)}`,
      tooShort: `cv_src_${'a'.repeat(15)}`,
      minValid: `cv_src_${'a'.repeat(16)}`,
      maxValid: `cv_src_${'a'.repeat(128)}`,
      tooLong: `cv_src_${'a'.repeat(129)}`,
    });
    const digestPattern = getPatternForField(sourceProps, 'sourceDigest');
    expect(digestPattern).toBe('^sha256:[0-9a-f]{64}$');
    expectNineProbes({
      pattern: digestPattern,
      valid: `sha256:${'a'.repeat(64)}`,
      tooShort: `sha256:${'a'.repeat(63)}`,
      minValid: `sha256:${'a'.repeat(64)}`,
      maxValid: `sha256:${'a'.repeat(64)}`,
      tooLong: `sha256:${'a'.repeat(65)}`,
    });
  });

  it('pins prepare output identifiers with nine probes', async () => {
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    const { tools } = await client.listTools();
    const tool = getToolRecord(tools, 'contextvault_prepare');
    const outputProps = getOutputProperties(tool);
    const envelopeProps = asRecord(asRecord(outputProps.envelope).properties);
    const envelopePattern = getPatternForField(envelopeProps, 'envelopeId');
    expect(envelopePattern).toBe('^cv_env_[A-Za-z0-9_-]{16,128}$');
    expectNineProbes({
      pattern: envelopePattern,
      valid: `cv_env_${'e'.repeat(16)}`,
      tooShort: `cv_env_${'e'.repeat(15)}`,
      minValid: `cv_env_${'e'.repeat(16)}`,
      maxValid: `cv_env_${'e'.repeat(128)}`,
      tooLong: `cv_env_${'e'.repeat(129)}`,
    });
    const sourcePattern = getPatternForField(envelopeProps, 'sourceId');
    expect(sourcePattern).toBe('^cv_src_[A-Za-z0-9_-]{16,128}$');
    expectNineProbes({
      pattern: sourcePattern,
      valid: `cv_src_${'a'.repeat(16)}`,
      tooShort: `cv_src_${'a'.repeat(15)}`,
      minValid: `cv_src_${'a'.repeat(16)}`,
      maxValid: `cv_src_${'a'.repeat(128)}`,
      tooLong: `cv_src_${'a'.repeat(129)}`,
    });
    for (const field of ['sourceDigest', 'structuralFingerprint']) {
      const pattern = getPatternForField(envelopeProps, field);
      expect(pattern).toBe('^sha256:[0-9a-f]{64}$');
      expectNineProbes({
        pattern,
        valid: `sha256:${'a'.repeat(64)}`,
        tooShort: `sha256:${'a'.repeat(63)}`,
        minValid: `sha256:${'a'.repeat(64)}`,
        maxValid: `sha256:${'a'.repeat(64)}`,
        tooLong: `sha256:${'a'.repeat(65)}`,
      });
    }
  });

  it('exhausts json nodeType values and rejects empty and unknown', () => {
    const base = {
      nodeId: `cv_node_${'n'.repeat(6)}`,
      depth: 0,
      childCount: 0,
      pointer: null,
      pointerRedacted: true,
    };
    for (const nodeType of ['object', 'array', 'string', 'number', 'boolean', 'null']) {
      expect(jsonNodeDescriptorSchema.safeParse({ ...base, nodeType }).success).toBe(true);
    }
    expect(jsonNodeDescriptorSchema.safeParse({ ...base, nodeType: '' }).success).toBe(false);
    expect(jsonNodeDescriptorSchema.safeParse({ ...base, nodeType: 'unknown' }).success).toBe(
      false,
    );
    expect(jsonNodeDescriptorSchema.safeParse({ ...base }).success).toBe(false);
  });

  it('keeps retrieval discriminated union exact for all three variants', () => {
    const chunkId = `cv_chunk_${'c'.repeat(8)}`;
    const nodeId = `cv_node_${'n'.repeat(6)}`;
    expect(retrievalSelectorSchema.safeParse({ kind: 'chunk', chunkId }).success).toBe(true);
    expect(retrievalSelectorSchema.safeParse({ kind: 'json_node', nodeId }).success).toBe(true);
    expect(
      retrievalSelectorSchema.safeParse({ kind: 'line_range', startLine: 1, endLine: 2 }).success,
    ).toBe(true);
    expect(retrievalSelectorSchema.safeParse({ kind: '', chunkId }).success).toBe(false);
    expect(retrievalSelectorSchema.safeParse({ kind: 'chunk' }).success).toBe(false);
    expect(retrievalSelectorSchema.safeParse({ kind: 'json_node' }).success).toBe(false);
    expect(retrievalSelectorSchema.safeParse({ kind: 'line_range', startLine: 1 }).success).toBe(
      false,
    );
    expect(retrievalSelectorSchema.safeParse({ kind: 'chunk', chunkId, extra: 1 }).success).toBe(
      false,
    );
    expect(retrievalSelectorSchema.safeParse({ kind: 'json_node', nodeId, extra: 1 }).success).toBe(
      false,
    );
    expect(
      retrievalSelectorSchema.safeParse({ kind: 'line_range', startLine: 1, endLine: 2, extra: 1 })
        .success,
    ).toBe(false);
    expect(retrievalSelectorSchema.safeParse({ kind: 'unknown', chunkId }).success).toBe(false);
  });

  it('exhausts omission locator and reason enums', () => {
    const base = {
      omissionId: `cv_omit_${'a'.repeat(8)}`,
      itemCount: 1,
      retrievable: false as const,
    };
    for (const kind of ['byte_range', 'line_range', 'json_pointer']) {
      expect(
        omissionSchema.safeParse({ ...base, locator: { kind, value: '0-8' }, reason: 'policy' })
          .success,
      ).toBe(true);
    }
    for (const reason of ['budget', 'duplicate', 'policy', 'unsupported']) {
      expect(
        omissionSchema.safeParse({
          ...base,
          locator: { kind: 'byte_range', value: '0-8' },
          reason,
        }).success,
      ).toBe(true);
    }
    expect(
      omissionSchema.safeParse({ ...base, locator: { kind: '', value: '0-8' }, reason: 'policy' })
        .success,
    ).toBe(false);
    expect(
      omissionSchema.safeParse({
        ...base,
        locator: { kind: 'byte_range', value: '0-8' },
        reason: '',
      }).success,
    ).toBe(false);
    expect(
      omissionSchema.safeParse({
        ...base,
        locator: { kind: 'byte_range', value: '0-8' },
        reason: 'unknown',
      }).success,
    ).toBe(false);
  });

  it('accepts every verify check kind through the transport', async () => {
    for (const checks of [
      [{ kind: 'source_freshness' }],
      [{ kind: 'chunk_integrity', chunkId: `cv_chunk_${'b'.repeat(12)}` }],
      [{ kind: 'provenance_consistency' }],
    ]) {
      const seen: unknown[] = [];
      const server = createMcpServer(baseVerifyDependencies(seen));
      const client = await connectTestClient(server);
      const result = await client.callTool({
        name: 'contextvault_verify',
        arguments: { envelopeId: `cv_env_${'e'.repeat(16)}`, checks },
      });
      expect(result.isError).not.toBe(true);
      const structured = asRecord(result.structuredContent);
      expect(structured.ok).toBe(true);
    }
    const seen: unknown[] = [];
    const server = createMcpServer(baseVerifyDependencies(seen));
    const client = await connectTestClient(server);
    const rejected = await client.callTool({
      name: 'contextvault_verify',
      arguments: { envelopeId: `cv_env_${'e'.repeat(16)}`, checks: [{ kind: '' }] },
    });
    expect(rejected.isError).toBe(true);
    for (const badChecks of [
      [{ kind: 'source_freshness', extra: 1 }],
      [{ kind: 'chunk_integrity' }],
      [{ kind: 'chunk_integrity', chunkId: `cv_chunk_${'b'.repeat(12)}`, extra: 1 }],
      [{ kind: 'provenance_consistency', extra: 1 }],
      [{ kind: 'unknown' }],
      [{ kind: 'chunk_integrity', chunkId: '' }],
    ]) {
      const badServer = createMcpServer(baseVerifyDependencies([]));
      const badClient = await connectTestClient(badServer);
      const badResult = await badClient.callTool({
        name: 'contextvault_verify',
        arguments: { envelopeId: `cv_env_${'e'.repeat(16)}`, checks: badChecks },
      });
      expect(badResult.isError).toBe(true);
    }
  });

  it('pins verification result status enum through ListTools', async () => {
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    const { tools } = await client.listTools();
    const tool = getToolRecord(tools, 'contextvault_verify');
    const serialized = JSON.stringify(tool.outputSchema);
    for (const status of ['valid', 'stale', 'invalid', 'unavailable']) {
      expect(serialized).toContain(status);
    }
    expect(serialized).not.toContain('""');
  });

  it('pins inspect selector kinds and sensitivity enums through ListTools', async () => {
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    const { tools } = await client.listTools();
    const tool = getToolRecord(tools, 'contextvault_inspect');
    const serialized = JSON.stringify(tool.outputSchema);
    for (const kind of ['chunk', 'json_node', 'line_range']) {
      expect(serialized).toContain(kind);
    }
    for (const retiredKind of [
      'json_path',
      'symbol',
      'row_range',
      'event_id',
      'time_range',
      'exact_text',
    ]) {
      expect(serialized).not.toContain(retiredKind);
    }
    for (const value of ['public', 'internal', 'confidential', 'restricted', 'prohibited']) {
      expect(serialized).toContain(value);
    }
    for (const value of ['none', 'suspected', 'confirmed', 'unknown']) {
      expect(serialized).toContain(value);
    }
  });

  it('pins prepare sensitivity and secretRisk enums through ListTools', async () => {
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    const { tools } = await client.listTools();
    const tool = getToolRecord(tools, 'contextvault_prepare');
    const serialized = JSON.stringify(tool.outputSchema);
    for (const value of ['public', 'internal', 'confidential', 'restricted', 'prohibited']) {
      expect(serialized).toContain(value);
    }
    for (const value of ['none', 'suspected', 'confirmed', 'unknown']) {
      expect(serialized).toContain(value);
    }
    for (const value of ['text_chunks', 'json_structure', 'minimal']) {
      expect(serialized).toContain(value);
    }
  });

  it('requires exact purge operation shapes with the documented message', async () => {
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    for (const args of [
      {
        operation: 'preview',
        target: { kind: 'all_derived_state' },
        purgeIntentId: `cv_pur_${'p'.repeat(16)}`,
      },
      {
        operation: 'execute',
        purgeIntentId: `cv_pur_${'p'.repeat(16)}`,
        target: { kind: 'all_derived_state' },
      },
      { operation: 'preview' },
      { operation: 'execute' },
    ]) {
      const result = await client.callTool({ name: 'contextvault_purge', arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const text = JSON.stringify(result.content);
      expect(text).toContain('purge request fields do not match');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('pins success ok as true through the transport and documents dead literals', async () => {
    // The SDK-facing output schemas expose ok as a plain boolean, so the
    // private success literals (ok true in each success schema) are never
    // advertised and never validated. The transport pins true for success
    // and false for errors, which proves the dead literals equivalent.
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    const { tools } = await client.listTools();
    for (const name of [
      'contextvault_inspect',
      'contextvault_prepare',
      'contextvault_retrieve',
      'contextvault_verify',
      'contextvault_stats',
      'contextvault_purge',
    ]) {
      const tool = getToolRecord(tools, name);
      const props = getOutputProperties(tool);
      const okSchema = asRecord(props.ok);
      expect(okSchema.type).toBe('boolean');
    }
    const seen: unknown[] = [];
    const retrieveServer = createMcpServer(baseDependencies(seen));
    const retrieveClient = await connectTestClient(retrieveServer);
    const success = await retrieveClient.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability: `cv1_${'k'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: `cv_chunk_${'a'.repeat(12)}` },
      },
    });
    expect(asRecord(success.structuredContent).ok).toBe(true);
    expect(success.isError).not.toBe(true);
    const verifyServer = createMcpServer(baseVerifyDependencies([]));
    const verifyClient = await connectTestClient(verifyServer);
    const verified = await verifyClient.callTool({
      name: 'contextvault_verify',
      arguments: {
        envelopeId: `cv_env_${'e'.repeat(16)}`,
        checks: [{ kind: 'source_freshness' }],
      },
    });
    expect(asRecord(verified.structuredContent).ok).toBe(true);
    expect(verified.isError).not.toBe(true);
    const failingServer = createMcpServer({
      correlationIds: { create: (): string => CORRELATION_ID },
      requestCounters: createCounterStub(),
      inspectSource: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
      prepareSource: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
      retrieveSource: {
        execute: (): Promise<never> => Promise.reject(new Error('sensitive-nested-failure')),
      },
      verifyEnvelope: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
      collectSessionStats: {
        execute: (): never => {
          throw new Error('unused');
        },
      },
      purgeDerivedState: {
        preview: (): never => {
          throw new Error('unused');
        },
        execute: (): never => {
          throw new Error('unused');
        },
      },
    });
    const failingClient = await connectTestClient(failingServer);
    const failure = await failingClient.callTool({
      name: 'contextvault_retrieve',
      arguments: {
        capability: `cv1_${'k'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: `cv_chunk_${'a'.repeat(12)}` },
      },
    });
    expect(failure.isError).toBe(true);
    expect(asRecord(failure.structuredContent).ok).toBe(false);
  });

  it('enforces purge counter bounds exactly', async () => {
    // ListTools per-field checks pin the advertised output bounds, so a
    // min-to-max mutation on any single counter is observable.
    const server = createMcpServer(baseDependencies([]));
    const client = await connectTestClient(server);
    const { tools } = await client.listTools();
    const tool = getToolRecord(tools, 'contextvault_purge');
    const props = getOutputProperties(tool);
    const deletedEnvelopes = asRecord(props.deletedEnvelopes);
    expect(deletedEnvelopes.minimum).toBe(0);
    expect(deletedEnvelopes.maximum).toBe(64);
    const deletedBytes = asRecord(props.deletedDerivedBytes);
    expect(deletedBytes.minimum).toBe(0);
    expect(deletedBytes.maximum).toBe(4194304);
    const revokedIntents = asRecord(props.revokedIntents);
    expect(revokedIntents.minimum).toBe(0);
    expect(revokedIntents.maximum).toBe(16);
    const revokedGrants = asRecord(props.revokedGrants);
    expect(revokedGrants.minimum).toBe(0);
    expect(revokedGrants.maximum).toBe(64);
    const removedProvenance = asRecord(props.removedProvenanceRecords);
    expect(removedProvenance.minimum).toBe(0);
    expect(removedProvenance.maximum).toBe(32);
    const serialized = JSON.stringify(tool.outputSchema);
    expect(serialized).not.toContain('"maximum":0');
    // Handler checks pin the internal execute bounds with boundary values.
    // A min(0) to max(0) mutant only admits 0, so 1 must succeed originally.
    async function callExecuteWithCounters(counters: Record<string, unknown>): Promise<unknown> {
      const executeServer = createMcpServer({
        correlationIds: { create: (): string => CORRELATION_ID },
        requestCounters: createCounterStub(),
        inspectSource: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
        prepareSource: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
        retrieveSource: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
        verifyEnvelope: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
        collectSessionStats: {
          execute: (): never => {
            throw new Error('unused');
          },
        },
        purgeDerivedState: {
          preview: (): never => {
            throw new Error('unused');
          },
          execute: () =>
            ({
              schemaVersion: '1.0',
              ok: true,
              targetKind: 'envelope',
              deletedEnvelopes: 0,
              deletedDerivedBytes: 0,
              revokedIntents: 0,
              revokedGrants: 0,
              removedProvenanceRecords: 0,
              ...counters,
            }) as never,
        },
      });
      const executeClient = await connectTestClient(executeServer);
      return executeClient.callTool({
        name: 'contextvault_purge',
        arguments: { operation: 'execute', purgeIntentId: `cv_pur_${'p'.repeat(16)}` },
      });
    }
    for (const counters of [
      { revokedIntents: 1 },
      { revokedGrants: 1 },
      { removedProvenanceRecords: 1 },
      { revokedIntents: 16 },
      { revokedGrants: 64 },
      { removedProvenanceRecords: 32 },
      { revokedIntents: 0, revokedGrants: 0, removedProvenanceRecords: 0 },
    ]) {
      const result = (await callExecuteWithCounters(counters)) as Record<string, unknown>;
      expect(result.isError).not.toBe(true);
      expect(asRecord(result.structuredContent).ok).toBe(true);
    }
    for (const counters of [
      { revokedIntents: -1 },
      { revokedGrants: -1 },
      { removedProvenanceRecords: -1 },
      { revokedIntents: 17 },
      { revokedGrants: 65 },
      { removedProvenanceRecords: 33 },
      { revokedIntents: 1.5 },
      { revokedIntents: Number.NaN },
    ]) {
      const result = (await callExecuteWithCounters(counters)) as Record<string, unknown>;
      expect(result.isError).toBe(true);
      expect(asRecord(asRecord(result.structuredContent).error).code).toBe('CV_INTERNAL_ERROR');
    }
  });

  it('rejects unanchored capability and chunk forgeries at the transport', () => {
    const validCapability = `cv1_${'a'.repeat(43)}`;
    expect(CAPABILITY_TOKEN_PATTERN.test(validCapability)).toBe(true);
    expect(CAPABILITY_TOKEN_PATTERN.test(`${validCapability}!`)).toBe(false);
    expect(CAPABILITY_TOKEN_PATTERN.test(`X${validCapability}`)).toBe(false);
    expect(CAPABILITY_TOKEN_PATTERN.test(`xx${validCapability}yy`)).toBe(false);
    expect(CAPABILITY_TOKEN_PATTERN.test(`cv1_${'a'.repeat(42)}`)).toBe(false);
    expect(CAPABILITY_TOKEN_PATTERN.test(`cv1_${'a'.repeat(512)}`)).toBe(true);
    expect(CAPABILITY_TOKEN_PATTERN.test(`cv1_${'a'.repeat(513)}`)).toBe(false);
    const validChunk = `cv_chunk_${'c'.repeat(8)}`;
    expect(CHUNK_ID_PATTERN.test(validChunk)).toBe(true);
    expect(CHUNK_ID_PATTERN.test(`${validChunk}!`)).toBe(false);
    expect(CHUNK_ID_PATTERN.test(`X${validChunk}`)).toBe(false);
    expect(CHUNK_ID_PATTERN.test(`cv_chunk_${'c'.repeat(7)}`)).toBe(false);
    expect(CHUNK_ID_PATTERN.test(`cv_chunk_${'c'.repeat(128)}`)).toBe(true);
    expect(CHUNK_ID_PATTERN.test(`cv_chunk_${'c'.repeat(129)}`)).toBe(false);
    const validNode = `cv_node_${'n'.repeat(6)}`;
    expect(NODE_ID_PATTERN.test(validNode)).toBe(true);
    expect(NODE_ID_PATTERN.test(`${validNode}!`)).toBe(false);
    expect(NODE_ID_PATTERN.test(`X${validNode}`)).toBe(false);
    expect(NODE_ID_PATTERN.test('cv_node_')).toBe(false);
    expect(ENVELOPE_ID_PATTERN.test(`cv_env_${'e'.repeat(16)}`)).toBe(true);
    expect(ENVELOPE_ID_PATTERN.test(`cv_env_${'e'.repeat(16)}!`)).toBe(false);
    expect(SOURCE_ID_PATTERN.test(`cv_src_${'s'.repeat(16)}`)).toBe(true);
    expect(SOURCE_ID_PATTERN.test(`cv_src_${'s'.repeat(16)}!`)).toBe(false);
    expect(SHA256_PATTERN.test(`sha256:${'a'.repeat(64)}`)).toBe(true);
  });

  it('proves the shared error guard equivalent with a truth table', () => {
    expect(isContextVaultError(undefined)).toBe(false);
    const generic = buildErrorResult(undefined, CORRELATION_ID);
    expect(generic.error.code).toBe('CV_INTERNAL_ERROR');
    expect(generic.error.message.length).toBeGreaterThan(0);
    const known = buildErrorResult(
      new ContextVaultError({
        code: 'CV_SOURCE_NOT_FOUND',
        message: 'The requested source was not found.',
      }),
      CORRELATION_ID,
    );
    expect(known.error.code).toBe('CV_SOURCE_NOT_FOUND');
    expect(known.error.message.length).toBeGreaterThan(0);
  });

  it('keeps internal purge-shape text out of the client envelope', async () => {
    // Both preview and execute branches map a malformed use-case result to
    // CV_INTERNAL_ERROR without surfacing the internal literal text.
    const malformed: unknown = { schemaVersion: '1.0', ok: true, unexpected: 'shape' };
    const server = createMcpServer({
      correlationIds: { create: (): string => CORRELATION_ID },
      requestCounters: createCounterStub(),
      inspectSource: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
      prepareSource: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
      retrieveSource: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
      verifyEnvelope: { execute: (): Promise<never> => Promise.reject(new Error('unused')) },
      collectSessionStats: {
        execute: (): never => {
          throw new Error('unused');
        },
      },
      purgeDerivedState: {
        preview: () => malformed as never,
        execute: () => malformed as never,
      },
    });
    const client = await connectTestClient(server);
    const preview = await client.callTool({
      name: 'contextvault_purge',
      arguments: { operation: 'preview', target: { kind: 'all_derived_state' } },
    });
    const previewError = asRecord(asRecord(preview.structuredContent).error);
    expect(preview.isError).toBe(true);
    expect(previewError.code).toBe('CV_INTERNAL_ERROR');
    expect((previewError.message as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(preview)).not.toContain('Purge result did not conform');
    const execute = await client.callTool({
      name: 'contextvault_purge',
      arguments: { operation: 'execute', purgeIntentId: `cv_pur_${'p'.repeat(16)}` },
    });
    const executeError = asRecord(asRecord(execute.structuredContent).error);
    expect(execute.isError).toBe(true);
    expect(executeError.code).toBe('CV_INTERNAL_ERROR');
    expect((executeError.message as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(execute)).not.toContain('Purge result did not conform');
  });
});

function minimalEnvelope(): Record<string, unknown> {
  return {
    envelopeId: `cv_env_${'e'.repeat(16)}`,
    sourceId: `cv_src_${'s'.repeat(16)}`,
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    mediaType: 'text/plain',
    bytes: 6,
    sensitivity: 'public',
    secretRisk: 'none',
    preparationKind: 'text_chunks',
    disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
    retrievalAllowed: false,
    lineCount: 1,
    chunks: [],
    jsonNodes: [],
    omissions: [],
    structuralFingerprint: `sha256:${'b'.repeat(64)}`,
    createdAt: new Date('2026-09-10T12:00:00.000Z').toISOString(),
    expiresAt: new Date('2026-09-10T12:30:00.000Z').toISOString(),
  };
}

function baseDependencies(seen: unknown[]): McpServerDependencies {
  return {
    correlationIds: { create: (): string => CORRELATION_ID },
    requestCounters: createCounterStub(),
    inspectSource: { execute: () => Promise.reject(new Error('unused')) },
    prepareSource: {
      execute: () =>
        Promise.resolve({
          schemaVersion: '1.0' as const,
          ok: true as const,
          envelope: minimalEnvelope() as never,
        }),
    },
    retrieveSource: {
      execute: ((request: unknown): Promise<unknown> => {
        seen.push(request);
        return Promise.resolve({
          schemaVersion: '1.0' as const,
          ok: true as const,
          envelopeId: `cv_env_${'e'.repeat(16)}`,
          sourceId: `cv_src_${'s'.repeat(16)}`,
          sourceDigest: `sha256:${'a'.repeat(64)}`,
          selector: { kind: 'chunk', chunkId: `cv_chunk_${'a'.repeat(12)}` },
          locator: { kind: 'chunk', value: `cv_chunk_${'a'.repeat(12)}` },
          byteCount: 5,
          excerptDigest: `sha256:${'c'.repeat(64)}`,
          content: 'alpha',
          truncated: false,
          hasMore: false,
        });
      }) as unknown as McpServerDependencies['retrieveSource']['execute'],
    },
    verifyEnvelope: { execute: () => Promise.reject(new Error('unused')) },
    collectSessionStats: {
      execute: () => ({
        schemaVersion: '1.0' as const,
        ok: true as const,
        counters: {
          activeEnvelopeCount: 0,
          activeGrantCount: 0,
          authorizedRootCount: 1,
          serializedDerivedRecordBytes: 0,
          provenanceRecordsRetained: 0,
          successfulRequests: 0,
          failedRequests: 0,
          envelopesRemovedByExpiry: 0,
          envelopesRemovedByPurge: 0,
          grantsRevoked: 0,
          purgeIntentsConsumed: 0,
        },
        measuredAt: new Date('2026-09-10T12:00:00.000Z').toISOString(),
      }),
    },
    purgeDerivedState: {
      preview: (): never => {
        throw new Error('unused');
      },
      execute: (): never => {
        throw new Error('unused');
      },
    },
  };
}

function baseVerifyDependencies(seen: unknown[]): McpServerDependencies {
  return {
    correlationIds: { create: (): string => CORRELATION_ID },
    requestCounters: createCounterStub(),
    inspectSource: { execute: () => Promise.reject(new Error('unused')) },
    prepareSource: {
      execute: () =>
        Promise.resolve({
          schemaVersion: '1.0' as const,
          ok: true as const,
          envelope: minimalEnvelope() as never,
        }),
    },
    retrieveSource: { execute: () => Promise.reject(new Error('unused')) },
    verifyEnvelope: {
      execute: ((request: unknown) => {
        seen.push(request);
        const typed = request as {
          envelopeId: string;
          checks: {
            kind: 'source_freshness' | 'chunk_integrity' | 'provenance_consistency';
            chunkId?: string;
          }[];
        };
        return Promise.resolve({
          schemaVersion: '1.0' as const,
          ok: true as const,
          envelopeId: typed.envelopeId,
          results: typed.checks.map((check) => ({
            kind: check.kind,
            ...(check.chunkId === undefined ? {} : { chunkId: check.chunkId }),
            status: 'valid' as const,
            reasonCode: 'digest_matches_prepared_state',
          })),
          verifiedAt: new Date('2026-09-10T12:00:00.000Z').toISOString(),
        });
      }) as unknown as McpServerDependencies['verifyEnvelope']['execute'],
    },
    collectSessionStats: {
      execute: () => ({
        schemaVersion: '1.0' as const,
        ok: true as const,
        counters: {
          activeEnvelopeCount: 0,
          activeGrantCount: 0,
          authorizedRootCount: 1,
          serializedDerivedRecordBytes: 0,
          provenanceRecordsRetained: 0,
          successfulRequests: 0,
          failedRequests: 0,
          envelopesRemovedByExpiry: 0,
          envelopesRemovedByPurge: 0,
          grantsRevoked: 0,
          purgeIntentsConsumed: 0,
        },
        measuredAt: new Date('2026-09-10T12:00:00.000Z').toISOString(),
      }),
    },
    purgeDerivedState: {
      preview: (): never => {
        throw new Error('unused');
      },
      execute: (): never => {
        throw new Error('unused');
      },
    },
  };
}

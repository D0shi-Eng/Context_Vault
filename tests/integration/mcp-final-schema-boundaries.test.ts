import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  VerificationReasonCode,
  VerificationStatus,
  VerifyRequestInput,
  VerifySuccess,
} from '../../src/domain/verification/verification-policy.js';
import type { RequestCounterSnapshot } from '../../src/domain/stats/stats-policy.js';

// This file intentionally avoids static imports of ContextVault source
// modules (the type-only import above is erased before runtime). Every
// adapter schema below is constructed at module load, so under per-test
// mutation analysis the construction lines are attributed to the first
// test that dynamically imports each module. Each `it` block below is
// therefore the sole covering test for its module's construction
// mutants, and each block asserts the full distinguishing boundary set
// for exactly the module it loads first. Do not split these blocks and
// do not add static source imports without re-checking attribution.

const FALLBACK_CORRELATION_ID = 'cv_corr_fallback00000000';
const VALID_CORRELATION_ID = `cv_corr_${'c'.repeat(16)}`;
const VALID_ENVELOPE_ID = `cv_env_${'e'.repeat(16)}`;
const VALID_CHUNK_ID = `cv_chunk_${'k'.repeat(8)}`;
const VALID_NODE_ID = `cv_node_${'n'.repeat(6)}`;
const VALID_OMISSION_ID = `cv_omit_${'o'.repeat(8)}`;
const VALID_DIGEST = `sha256:${'d'.repeat(64)}`;

describe('final schema boundaries shared adapter schemas', () => {
  it('pins the workspace source reference, every identifier pattern, and every descriptor', async () => {
    const schemas = await import('../../src/adapters/inbound/mcp/common-schemas.js');

    expect(
      schemas.sourceReferenceSchema.safeParse({
        kind: 'workspace_file',
        rootId: 'repo',
        path: 'ab',
      }).success,
    ).toBe(true);
    expect(
      schemas.sourceReferenceSchema.safeParse({ kind: 'chunk', rootId: 'repo', path: 'ab' })
        .success,
    ).toBe(false);
    for (const rootId of ['Xrepo', 'repo!', 'Repo', 'repO', '']) {
      expect(
        schemas.sourceReferenceSchema.safeParse({ kind: 'workspace_file', rootId, path: 'ab' })
          .success,
      ).toBe(false);
    }
    expect(
      schemas.sourceReferenceSchema.safeParse({ kind: 'workspace_file', rootId: 'repo', path: '' })
        .success,
    ).toBe(false);

    const cases: { pattern: RegExp; valid: string; short: string }[] = [
      { pattern: schemas.ENVELOPE_ID_PATTERN, valid: VALID_ENVELOPE_ID, short: 'cv_env_a' },
      {
        pattern: schemas.SOURCE_ID_PATTERN,
        valid: `cv_src_${'s'.repeat(16)}`,
        short: 'cv_src_a',
      },
      { pattern: schemas.SHA256_PATTERN, valid: VALID_DIGEST, short: 'sha256:a' },
      { pattern: schemas.CHUNK_ID_PATTERN, valid: VALID_CHUNK_ID, short: 'cv_chunk_a' },
      { pattern: schemas.NODE_ID_PATTERN, valid: VALID_NODE_ID, short: 'cv_node_' },
      { pattern: schemas.OMISSION_ID_PATTERN, valid: VALID_OMISSION_ID, short: 'cv_omit_a' },
      {
        pattern: schemas.CAPABILITY_TOKEN_PATTERN,
        valid: `cv1_${'t'.repeat(43)}`,
        short: 'cv1_a',
      },
    ];
    for (const entry of cases) {
      expect(entry.pattern.test(entry.valid)).toBe(true);
      expect(entry.pattern.test(`X${entry.valid}`)).toBe(false);
      expect(entry.pattern.test(`${entry.valid}!`)).toBe(false);
      expect(entry.pattern.test(entry.short)).toBe(false);
    }
    expect(schemas.ENVELOPE_ID_PATTERN.test(`cv_env_${'!'.repeat(16)}`)).toBe(false);
    expect(schemas.SHA256_PATTERN.test(`sha256:${'G'.repeat(64)}`)).toBe(false);
    expect(schemas.NODE_ID_PATTERN.test('cv_node_ab')).toBe(true);

    expect(
      schemas.chunkDescriptorSchema.safeParse({
        chunkId: VALID_CHUNK_ID,
        byteStart: 5,
        byteEndExclusive: 9,
        lineStart: 2,
        lineEndExclusive: 4,
        byteLength: 100,
        chunkDigest: VALID_DIGEST,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      schemas.jsonNodeDescriptorSchema.safeParse({
        nodeId: VALID_NODE_ID,
        nodeType: 'object',
        depth: 3,
        childCount: 10,
        pointer: '/a',
        pointerRedacted: false,
      }).success,
    ).toBe(true);
    for (const nodeType of ['array', 'string', 'number', 'boolean', 'null']) {
      expect(
        schemas.jsonNodeDescriptorSchema.safeParse({
          nodeId: VALID_NODE_ID,
          nodeType,
          depth: 3,
          childCount: 10,
          pointer: '/a',
          pointerRedacted: false,
        }).success,
      ).toBe(true);
    }
    expect(
      schemas.jsonNodeDescriptorSchema.safeParse({
        nodeId: VALID_NODE_ID,
        nodeType: 'semantic',
        depth: 3,
        childCount: 10,
        pointer: '/a',
        pointerRedacted: false,
      }).success,
    ).toBe(false);
    for (const locator of [
      { kind: 'byte_range', value: 'xy' },
      { kind: 'line_range', value: 'xy' },
      { kind: 'json_pointer', value: 'xy' },
    ]) {
      expect(
        schemas.omissionSchema.safeParse({
          omissionId: VALID_OMISSION_ID,
          locator,
          reason: 'budget',
          itemCount: 2,
          retrievable: false,
        }).success,
      ).toBe(true);
    }
    for (const reason of ['duplicate', 'policy', 'unsupported']) {
      expect(
        schemas.omissionSchema.safeParse({
          omissionId: VALID_OMISSION_ID,
          locator: { kind: 'byte_range', value: 'xy' },
          reason,
          itemCount: 2,
          retrievable: false,
        }).success,
      ).toBe(true);
    }
    expect(
      schemas.omissionSchema.safeParse({
        omissionId: VALID_OMISSION_ID,
        locator: { kind: 'byte_range', value: 'xy' },
        reason: 'budget',
        itemCount: 2,
        retrievable: true,
      }).success,
    ).toBe(false);

    for (const kind of ['chunk', 'json_node', 'line_range']) {
      expect(schemas.retrievalSelectorKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(schemas.retrievalSelectorKindSchema.safeParse('semantic').success).toBe(false);
    expect(
      schemas.retrievalSelectorSchema.safeParse({ kind: 'json_node', nodeId: VALID_NODE_ID })
        .success,
    ).toBe(true);
    expect(
      schemas.retrievalSelectorSchema.safeParse({
        kind: 'line_range',
        startLine: 1,
        endLine: 1000000,
      }).success,
    ).toBe(true);
    expect(
      schemas.retrievalSelectorSchema.safeParse({
        kind: 'line_range',
        startLine: 2,
        endLine: 1000000,
      }).success,
    ).toBe(true);
    expect(
      schemas.retrievalSelectorSchema.safeParse({
        kind: 'line_range',
        startLine: 1,
        endLine: 1000001,
      }).success,
    ).toBe(false);
  });
});

describe('final schema boundaries shared error envelope', () => {
  it('pins the correlation fallback, the detail union, and the envelope literals', async () => {
    const handler = await import('../../src/adapters/inbound/mcp/shared-handler.js');
    const factoryFor = (value: string): { create: () => string } => ({
      create: () => value,
    });

    expect(handler.createSafeCorrelationId(factoryFor('bogus'))).toBe(FALLBACK_CORRELATION_ID);
    expect(handler.createSafeCorrelationId(factoryFor(VALID_CORRELATION_ID))).toBe(
      VALID_CORRELATION_ID,
    );
    for (const nearMiss of [
      `XX${VALID_CORRELATION_ID}`,
      `${VALID_CORRELATION_ID}!`,
      'cv_corr_a',
      `cv_corr_${'!'.repeat(16)}`,
    ]) {
      expect(handler.createSafeCorrelationId(factoryFor(nearMiss))).toBe(FALLBACK_CORRELATION_ID);
    }
    expect(
      handler.createSafeCorrelationId({
        create: () => {
          throw new Error('clock unavailable');
        },
      }),
    ).toBe(FALLBACK_CORRELATION_ID);

    expect(handler.safeDetailValueSchema.safeParse('ab').success).toBe(true);
    expect(handler.safeDetailValueSchema.safeParse('d'.repeat(300)).success).toBe(false);
    const content = {
      code: 'CV_ABC',
      message: 'hello',
      correlationId: VALID_CORRELATION_ID,
      retryable: false,
    };
    expect(handler.safeErrorContentSchema.safeParse(content).success).toBe(true);
    for (const code of ['xxCV_ABC', 'CV_ABCxx', 'CV_aBC', '']) {
      expect(handler.safeErrorContentSchema.safeParse({ ...content, code }).success).toBe(false);
    }
    for (const correlationId of [
      `XX${VALID_CORRELATION_ID}`,
      `${VALID_CORRELATION_ID}!`,
      'cv_corr_a',
      `cv_corr_${'!'.repeat(16)}`,
    ]) {
      expect(handler.safeErrorContentSchema.safeParse({ ...content, correlationId }).success).toBe(
        false,
      );
    }
    expect(handler.safeErrorContentSchema.safeParse({ ...content, message: '' }).success).toBe(
      false,
    );
    expect(
      handler.safeErrorContentSchema.safeParse({ ...content, message: 'm'.repeat(513) }).success,
    ).toBe(false);

    expect(
      handler.safeErrorContentSchema.safeParse({ ...content, safeDetails: { abc: 'x' } }).success,
    ).toBe(true);
    for (const key of ['Xabc', 'abc!', 'Abc', 'ab!']) {
      expect(
        handler.safeErrorContentSchema.safeParse({ ...content, safeDetails: { [key]: 'x' } })
          .success,
      ).toBe(false);
    }
    const envelope = { schemaVersion: '1.0', ok: false, error: content };
    expect(handler.safeErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(handler.safeErrorEnvelopeSchema.safeParse({ ...envelope, ok: true }).success).toBe(
      false,
    );
  });
});

describe('final schema boundaries verification identifier prefixes', () => {
  it('rejects identifier shapes without their required prefixes', async () => {
    const policy = await import('../../src/domain/verification/verification-policy.js');

    expect(() =>
      policy.validateVerifyRequest({
        envelopeId: `zz_${'a'.repeat(16)}`,
        checks: [{ kind: 'source_freshness' }],
      }),
    ).toThrow();
    expect(() =>
      policy.validateVerifyRequest({
        envelopeId: VALID_ENVELOPE_ID,
        checks: [{ kind: 'chunk_integrity', chunkId: `zz_${'b'.repeat(8)}` }],
      }),
    ).toThrow();
    expect(() =>
      policy.validateVerifyRequest({
        envelopeId: VALID_ENVELOPE_ID,
        checks: [{ kind: 'source_freshness' }],
      }),
    ).not.toThrow();
  });
});

describe('final schema boundaries verify tool contract', () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.allSettled(closers.splice(0).map((close) => close()));
  });

  it('accepts the three documented check kinds and returns four covering results', async () => {
    const client = await createVerifyClient();
    const result = await client.callTool({
      name: 'contextvault_verify',
      arguments: {
        envelopeId: VALID_ENVELOPE_ID,
        checks: [
          { kind: 'source_freshness' },
          { kind: 'chunk_integrity', chunkId: VALID_CHUNK_ID },
          { kind: 'provenance_consistency' },
          { kind: 'source_freshness' },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    const structured = asRecord(result.structuredContent);
    expect(structured.ok).toBe(true);
    expect(structured.envelopeId).toBe(VALID_ENVELOPE_ID);
    expect(asArray(structured.results)).toEqual([
      {
        kind: 'source_freshness',
        status: 'valid',
        reasonCode: 'digest_matches_prepared_state',
      },
      {
        kind: 'chunk_integrity',
        chunkId: VALID_CHUNK_ID,
        status: 'stale',
        reasonCode: 'source_digest_mismatch',
      },
      {
        kind: 'provenance_consistency',
        status: 'invalid',
        reasonCode: 'provenance_record_foreign',
      },
      {
        kind: 'source_freshness',
        status: 'unavailable',
        reasonCode: 'envelope_absent',
      },
    ]);

    const unknownKind = await client.callTool({
      name: 'contextvault_verify',
      arguments: { envelopeId: VALID_ENVELOPE_ID, checks: [{ kind: 'semantic' }] },
    });
    expect(unknownKind.isError).toBe(true);

    const overlong = await client.callTool({
      name: 'contextvault_verify',
      arguments: {
        envelopeId: VALID_ENVELOPE_ID,
        checks: Array.from({ length: 17 }, () => ({ kind: 'source_freshness' })),
      },
    });
    expect(overlong.isError).toBe(true);
  });

  async function createVerifyClient(): Promise<Client> {
    const verifyTool = await import('../../src/adapters/inbound/mcp/verify-tool.js');
    const server = new McpServer({ name: 'contextvault-final-boundary-test', version: '0.0.0' });
    verifyTool.registerVerifyTool(server, {
      correlationIds: { create: (): string => VALID_CORRELATION_ID },
      requestCounters: {
        recordSuccess: (): void => undefined,
        recordFailure: (): void => undefined,
        snapshot: (): RequestCounterSnapshot => ({ successful: 0, failed: 0 }),
      },
      verifyEnvelope: {
        execute: (request: VerifyRequestInput): Promise<VerifySuccess> =>
          Promise.resolve({
            schemaVersion: '1.0',
            ok: true,
            envelopeId: request.envelopeId,
            results: request.checks.map((check, index) => ({
              kind: check.kind,
              chunkId: check.kind === 'chunk_integrity' ? check.chunkId : undefined,
              status: statusFor(index),
              reasonCode: reasonFor(index),
            })),
            verifiedAt: new Date('2026-09-20T22:40:00.000Z').toISOString(),
          }),
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-final-boundary-client', version: '0.0.0' });
    closers.push(
      async () => client.close(),
      async () => server.close(),
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // Enabling tool-list caching turns on client-side output-schema
    // validation, so a weakened output schema fails the success call.
    await client.listTools();
    return client;
  }
});

function statusFor(index: number): VerificationStatus {
  const slot = index % 4;
  if (slot === 1) {
    return 'stale';
  }
  if (slot === 2) {
    return 'invalid';
  }
  if (slot === 3) {
    return 'unavailable';
  }
  return 'valid';
}

function reasonFor(index: number): VerificationReasonCode {
  const slot = index % 4;
  if (slot === 1) {
    return 'source_digest_mismatch';
  }
  if (slot === 2) {
    return 'provenance_record_foreign';
  }
  if (slot === 3) {
    return 'envelope_absent';
  }
  return 'digest_matches_prepared_state';
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

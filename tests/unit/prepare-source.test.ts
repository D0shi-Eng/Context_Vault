import { describe, expect, it, vi } from 'vitest';

import type { AuthorizedFileReader } from '../../src/application/ports/authorized-file-reader.js';
import type { InspectionClock } from '../../src/application/ports/inspection-services.js';
import { PrepareSource } from '../../src/application/preparation/prepare-source.js';
import { PreparationGate } from '../../src/application/preparation/preparation-gate.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  STRICT_PREPARATION_LIMITS,
  validatePreparationLimits,
  type PreparationLimits,
} from '../../src/domain/preparation/preparation-limits.js';
import {
  canonicalStructuralPayload,
  PREPARE_DISCLOSURE_CLASSIFICATION,
} from '../../src/domain/preparation/preparation-types.js';
import { NodeCapabilityTokens } from '../../src/infrastructure/crypto/node-capability-tokens.js';
import { NodeInspectionCryptography } from '../../src/infrastructure/inspection/node-inspection-cryptography.js';
import { NodeOpaqueIdentifiers } from '../../src/infrastructure/preparation/node-opaque-identifiers.js';
import { InMemoryVault } from '../../src/infrastructure/vault/in-memory-vault.js';

const SESSION_ID = 'cv_ses_abcdefghijklmnop';
const BASE_INSTANT = new Date('2026-09-10T12:00:00.000Z');
const cryptography = new NodeInspectionCryptography();

function createPrepareSource(options: {
  read: AuthorizedFileReader['read'];
  limits?: PreparationLimits;
  clock?: InspectionClock;
}): { useCase: PrepareSource; vault: InMemoryVault } {
  const limits = validatePreparationLimits(options.limits ?? STRICT_PREPARATION_LIMITS);
  const vault = new InMemoryVault(SESSION_ID, limits);
  const clock: InspectionClock = options.clock ?? { now: (): Date => new Date(BASE_INSTANT) };
  const useCase = new PrepareSource(
    {
      clock,
      cryptography,
      fileReader: { read: options.read, authorizedRootCount: 1 },
      vault,
      identifiers: new NodeOpaqueIdentifiers(),
      limits,
      tokens: new NodeCapabilityTokens(),
      tokenDigester: new NodeCapabilityTokens(),
    },
    new PreparationGate(limits.maxConcurrentPreparations),
  );
  return { useCase, vault };
}

function source(path: string): { kind: string; rootId: string; path: string } {
  return { kind: 'workspace_file', rootId: 'repo', path };
}

describe('PreparationGate', () => {
  it('rejects a non-positive or fractional concurrency limit', () => {
    expect(() => new PreparationGate(0)).toThrow(ContextVaultError);
    expect(() => new PreparationGate(-1)).toThrow(ContextVaultError);
    expect(() => new PreparationGate(1.5)).toThrow(ContextVaultError);
  });

  it('tracks the active count across acquire and release cycles', () => {
    const gate = new PreparationGate(2);
    expect(gate.activeCount).toBe(0);

    gate.acquire();
    expect(gate.activeCount).toBe(1);
    gate.acquire();
    expect(gate.activeCount).toBe(2);
    gate.release();
    expect(gate.activeCount).toBe(1);
    gate.release();
    gate.release();
    expect(gate.activeCount).toBe(0);
  });
});

describe('canonicalStructuralPayload', () => {
  it('serializes the deterministic fields in a fixed key order', () => {
    const payload = canonicalStructuralPayload({
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      mediaType: 'text/plain',
      bytes: 7,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks',
      lineCount: 1,
      chunks: [],
      jsonNodes: [],
      omissions: [],
    });

    expect(payload).toBe(
      JSON.stringify({
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        mediaType: 'text/plain',
        bytes: 7,
        sensitivity: 'internal',
        secretRisk: 'none',
        preparationKind: 'text_chunks',
        lineCount: 1,
        chunks: [],
        jsonNodes: [],
        omissions: [],
      }),
    );
    expect(payload).toContain('"sourceDigest"');
    expect(payload).not.toContain('envelopeId');
  });
});

describe('PrepareSource', () => {
  it('builds a bounded text envelope with deterministic structural metadata', async () => {
    const bytes = new TextEncoder().encode('alpha\nbeta\n');
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'notes/summary.txt',
    });
    const { useCase, vault } = createPrepareSource({ read });

    const result = await useCase.execute({ source: source('notes/summary.txt') });

    expect(result.schemaVersion).toBe('1.0');
    expect(result.ok).toBe(true);
    expect(result.envelope.envelopeId).toMatch(/^cv_env_[A-Za-z0-9_-]{24}$/u);
    expect(result.envelope.sourceId).toMatch(/^cv_src_/u);
    expect(result.envelope.sourceDigest).toBe(cryptography.sha256(bytes));
    expect(result.envelope.mediaType).toBe('text/plain');
    expect(result.envelope.bytes).toBe(bytes.byteLength);
    expect(result.envelope.sensitivity).toBe('internal');
    expect(result.envelope.secretRisk).toBe('none');
    expect(result.envelope.preparationKind).toBe('text_chunks');
    expect(result.envelope.disclosureClass).toBe(PREPARE_DISCLOSURE_CLASSIFICATION);
    expect(result.envelope.retrievalAllowed).toBe(false);
    expect(result.envelope.lineCount).toBe(2);
    expect(result.envelope.chunks).toHaveLength(1);
    expect(result.envelope.chunks[0]).toMatchObject({
      chunkId: 'cv_chunk_000000000001',
      byteStart: 0,
      byteEndExclusive: bytes.byteLength,
      lineStart: 1,
      lineEndExclusive: 3,
      byteLength: bytes.byteLength,
      truncated: false,
      chunkDigest: cryptography.sha256(bytes),
    });
    expect(result.envelope.jsonNodes).toEqual([]);
    expect(result.envelope.omissions).toEqual([]);
    expect(result.envelope.createdAt).toBe('2026-09-10T12:00:00.000Z');
    expect(result.envelope.expiresAt).toBe('2026-09-10T12:30:00.000Z');

    const expectedFingerprint = cryptography.sha256(
      new TextEncoder().encode(
        canonicalStructuralPayload({
          sourceDigest: result.envelope.sourceDigest,
          mediaType: 'text/plain',
          bytes: bytes.byteLength,
          sensitivity: 'internal',
          secretRisk: 'none',
          preparationKind: 'text_chunks',
          lineCount: 2,
          chunks: result.envelope.chunks,
          jsonNodes: [],
          omissions: [],
        }),
      ),
    );
    expect(result.envelope.structuralFingerprint).toBe(expectedFingerprint);

    expect(read).toHaveBeenCalledWith({
      rootId: 'repo',
      normalizedRelativePath: 'notes/summary.txt',
      maximumBytes: 32 * 1024 * 1024,
      signal: undefined,
    });
    expect(vault.snapshot().envelopeCount).toBe(1);
    expect(vault.snapshot().version).toBe(1);
    const storedRecord = vault.list()[0];
    if (!storedRecord) {
      throw new Error('Expected a stored derived record.');
    }
    expect(storedRecord.retrievalAllowed).toBe(false);
    expect(storedRecord.sessionId).toBe(SESSION_ID);
  });

  it('prepares Markdown through the same bounded chunking path', async () => {
    const bytes = new TextEncoder().encode('# Heading\n\nBody line.\n');
    const { useCase } = createPrepareSource({
      read: vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
        bytes,
        normalizedRelativePath: 'docs/guide.md',
      }),
    });

    const result = await useCase.execute({ source: source('docs/guide.md') });
    const serialized = JSON.stringify(result);

    expect(result.envelope.mediaType).toBe('text/markdown');
    expect(result.envelope.preparationKind).toBe('text_chunks');
    expect(result.envelope.lineCount).toBe(3);
    expect(serialized).not.toContain('# Heading');
    expect(serialized).not.toContain('Body line.');
  });

  it('discloses redacted JSON structure without keys, values, or content', async () => {
    const bytes = new TextEncoder().encode('{"name":"allowed","password":"secret-value"}');
    const { useCase } = createPrepareSource({
      read: vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
        bytes,
        normalizedRelativePath: 'config/settings.json',
      }),
    });

    const result = await useCase.execute({ source: source('config/settings.json') });
    const serialized = JSON.stringify(result);

    expect(result.envelope.preparationKind).toBe('json_structure');
    expect(result.envelope.lineCount).toBe(0);
    expect(result.envelope.chunks).toEqual([]);
    expect(result.envelope.jsonNodes).toHaveLength(3);
    expect(result.envelope.jsonNodes[0]).toMatchObject({
      nodeType: 'object',
      depth: 0,
      childCount: 2,
      pointer: '',
      pointerRedacted: false,
    });
    expect(result.envelope.jsonNodes[1]).toMatchObject({
      nodeType: 'string',
      depth: 0,
      pointer: '/name',
      pointerRedacted: false,
    });
    expect(result.envelope.jsonNodes[2]).toMatchObject({
      nodeType: 'string',
      depth: 0,
      pointerRedacted: true,
    });
    const redactedNode = result.envelope.jsonNodes[2];
    if (!redactedNode?.pointer) {
      throw new Error('Expected a redacted JSON node with a pointer.');
    }
    expect(redactedNode.pointer).toMatch(/^\/cv_node_000003$/u);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('allowed');
  });

  it('returns a stable structural fingerprint for unchanged source bytes and limits', async () => {
    const bytes = new TextEncoder().encode('stable content\n');
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'stable.txt',
    });
    const { useCase } = createPrepareSource({ read });

    const first = await useCase.execute({ source: source('stable.txt') });
    const second = await useCase.execute({ source: source('stable.txt') });

    expect(second.envelope.structuralFingerprint).toBe(first.envelope.structuralFingerprint);
    expect(second.envelope.chunks).toEqual(first.envelope.chunks);
    expect(second.envelope.omissions).toEqual(first.envelope.omissions);
    expect(second.envelope.envelopeId).not.toBe(first.envelope.envelopeId);
  });

  it('returns a minimal envelope for sources with confirmed secret risk', async () => {
    // The marker is assembled from fragments so the repository secret scan
    // does not flag this synthetic test fixture as real key material.
    const marker = [
      ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
      '\nMII...\n',
      ['-----END ', 'PRIVATE KEY-----'].join(''),
      '\n',
    ].join('');
    const bytes = new TextEncoder().encode(marker);
    const { useCase } = createPrepareSource({
      read: vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
        bytes,
        normalizedRelativePath: 'keys/private.txt',
      }),
    });

    const result = await useCase.execute({ source: source('keys/private.txt') });
    const serialized = JSON.stringify(result);

    expect(result.envelope.preparationKind).toBe('minimal');
    expect(result.envelope.secretRisk).toBe('confirmed');
    expect(result.envelope.sensitivity).toBe('prohibited');
    expect(result.envelope.retrievalAllowed).toBe(false);
    expect(result.envelope.chunks).toEqual([]);
    expect(result.envelope.jsonNodes).toEqual([]);
    expect(result.envelope.lineCount).toBe(0);
    expect(result.envelope.omissions).toEqual([
      {
        omissionId: 'cv_omit_000000000001',
        locator: { kind: 'byte_range', value: `0-${String(bytes.byteLength)}` },
        reason: 'policy',
        itemCount: 1,
        retrievable: false,
      },
    ]);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('MII');
  });

  it('fails safely for unsupported preparation media without committing state', async () => {
    const { useCase, vault } = createPrepareSource({
      read: vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
        bytes: new Uint8Array(4),
        normalizedRelativePath: 'data/table.csv',
      }),
    });

    await expectPrepareError(
      () => useCase.execute({ source: source('data/table.csv') }),
      'CV_PREPARE_MEDIA_UNSUPPORTED',
    );
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('fails safely for sources that are not valid UTF-8 text', async () => {
    const bytes = new Uint8Array([0x68, 0x00, 0x69]);
    const { useCase, vault } = createPrepareSource({
      read: vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
        bytes,
        normalizedRelativePath: 'binary.txt',
      }),
    });

    await expectPrepareError(
      () => useCase.execute({ source: source('binary.txt') }),
      'CV_INPUT_UTF8_INVALID',
    );
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it.each([
    ['malformed json', '{"broken":', 'CV_JSON_MALFORMED'],
    ['excessive depth', `${'['.repeat(70)}${']'.repeat(70)}`, 'CV_PARSE_DEPTH_EXCEEDED'],
  ])('fails safely on %s without committing state', async (_name, content, code) => {
    const bytes = new TextEncoder().encode(content);
    const { useCase, vault } = createPrepareSource({
      read: vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
        bytes,
        normalizedRelativePath: 'data/broken.json',
      }),
    });

    await expectPrepareError(() => useCase.execute({ source: source('data/broken.json') }), code);
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('validates retention bounds and applies the default TTL', async () => {
    const bytes = new TextEncoder().encode('text\n');
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'ttl.txt',
    });
    const { useCase } = createPrepareSource({ read });

    await expect(
      useCase.execute({ source: source('ttl.txt'), ttlSeconds: 59 }),
    ).rejects.toMatchObject({ code: 'CV_INPUT_INVALID' });

    const defaulted = await useCase.execute({ source: source('ttl.txt') });
    expect(
      new Date(defaulted.envelope.expiresAt).getTime() -
        new Date(defaulted.envelope.createdAt).getTime(),
    ).toBe(1800 * 1000);

    const custom = await useCase.execute({ source: source('ttl.txt'), ttlSeconds: 120 });
    expect(
      new Date(custom.envelope.expiresAt).getTime() - new Date(custom.envelope.createdAt).getTime(),
    ).toBe(120 * 1000);
  });

  it('rejects a cancelled request before any read or state change', async () => {
    const read = vi.fn<AuthorizedFileReader['read']>();
    const { useCase, vault } = createPrepareSource({ read });
    const controller = new AbortController();
    controller.abort();

    await expectRetryablePrepareError(
      () => useCase.execute({ source: source('notes.txt') }, controller.signal),
      'CV_OPERATION_CANCELLED',
    );
    expect(read).not.toHaveBeenCalled();
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('leaves no partial state when the reader reports a mid-read mutation', async () => {
    const { useCase, vault } = createPrepareSource({
      read: vi.fn<AuthorizedFileReader['read']>().mockRejectedValue(
        new ContextVaultError({
          code: 'CV_SOURCE_CHANGED',
          message: 'The source changed during preparation.',
          retryable: true,
        }),
      ),
    });

    await expectPrepareError(
      () => useCase.execute({ source: source('mutating.txt') }),
      'CV_SOURCE_CHANGED',
    );
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('fails closed when the preparation deadline is exceeded', async () => {
    let callCount = 0;
    const clock: InspectionClock = {
      now: () => new Date(BASE_INSTANT.getTime() + callCount++ * 10),
    };
    const read = vi.fn<AuthorizedFileReader['read']>();
    const { useCase, vault } = createPrepareSource({
      read,
      clock,
      limits: { ...STRICT_PREPARATION_LIMITS, prepareDeadlineMilliseconds: 1 },
    });

    await expectRetryablePrepareError(
      () => useCase.execute({ source: source('slow.txt') }),
      'CV_DEADLINE_EXCEEDED',
    );
    expect(read).not.toHaveBeenCalled();
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('rejects a preparation exactly at the configured deadline instant', async () => {
    let callCount = 0;
    const clock: InspectionClock = {
      now: () => new Date(BASE_INSTANT.getTime() + callCount++ * 100),
    };
    const read = vi.fn<AuthorizedFileReader['read']>();
    const { useCase, vault } = createPrepareSource({
      read,
      clock,
      limits: { ...STRICT_PREPARATION_LIMITS, prepareDeadlineMilliseconds: 100 },
    });

    await expectRetryablePrepareError(
      () => useCase.execute({ source: source('boundary.txt') }),
      'CV_DEADLINE_EXCEEDED',
    );
    expect(read).not.toHaveBeenCalled();
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('rejects a concurrent preparation beyond the configured concurrency limit', async () => {
    let releaseRead: (() => void) | undefined;
    const gatePromise = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const bytes = new TextEncoder().encode('text\n');
    const { useCase, vault } = createPrepareSource({
      read: vi.fn<AuthorizedFileReader['read']>().mockImplementation(() => {
        return gatePromise.then(() => ({ bytes, normalizedRelativePath: 'slow.txt' }));
      }),
      limits: { ...STRICT_PREPARATION_LIMITS, maxConcurrentPreparations: 1 },
    });

    const first = useCase.execute({ source: source('slow.txt') });

    await expectRetryablePrepareError(
      () => useCase.execute({ source: source('other.txt') }),
      'CV_RESOURCE_CONCURRENCY_LIMIT',
    );

    releaseRead?.();
    await first;
    expect(vault.snapshot().envelopeCount).toBe(1);

    // The gate must hand the slot back after the operation finishes so a
    // follow-up preparation is not locked out by a stale release count.
    const followUp = await useCase.execute({ source: source('other.txt') });
    expect(followUp.envelope.preparationKind).toBe('text_chunks');
    expect(vault.snapshot().envelopeCount).toBe(2);
  });

  it('enforces the active-envelope limit across repeated preparations', async () => {
    const bytes = new TextEncoder().encode('text\n');
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'filler.txt',
    });
    const { useCase, vault } = createPrepareSource({
      read,
      limits: { ...STRICT_PREPARATION_LIMITS, maxActiveEnvelopes: 1 },
    });

    await useCase.execute({ source: source('filler.txt') });
    await expectPrepareError(
      () => useCase.execute({ source: source('filler.txt') }),
      'CV_RESOURCE_ENVELOPE_LIMIT',
    );
    expect(vault.snapshot().envelopeCount).toBe(1);
  });

  it('sweeps expired envelopes before enforcing the active-envelope cap', async () => {
    let currentMilliseconds = BASE_INSTANT.getTime();
    const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
    const bytes = new TextEncoder().encode('text\n');
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'cycled.txt',
    });
    const { useCase, vault } = createPrepareSource({
      read,
      clock,
      limits: { ...STRICT_PREPARATION_LIMITS, maxActiveEnvelopes: 2 },
    });

    await useCase.execute({ source: source('cycled.txt'), ttlSeconds: 60 });
    await useCase.execute({ source: source('cycled.txt'), ttlSeconds: 60 });
    expect(vault.snapshot().envelopeCount).toBe(2);

    // The cap still applies while both envelopes are live.
    await expectPrepareError(
      () => useCase.execute({ source: source('cycled.txt') }),
      'CV_RESOURCE_ENVELOPE_LIMIT',
    );
    expect(vault.snapshot().envelopeCount).toBe(2);

    currentMilliseconds += 61 * 1000;
    const renewed = await useCase.execute({ source: source('cycled.txt'), ttlSeconds: 60 });
    expect(renewed.envelope.preparationKind).toBe('text_chunks');
    expect(vault.snapshot().envelopeCount).toBe(1);
    expect(vault.lifecycleCounters().envelopesRemovedByExpiry).toBe(2);
  });

  it('keeps live envelopes and their grants while sweeping only expired state before the cap', async () => {
    let currentMilliseconds = BASE_INSTANT.getTime();
    const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
    const bytes = new TextEncoder().encode('text\n');
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'mixed-age.txt',
    });
    const { useCase, vault } = createPrepareSource({
      read,
      clock,
      limits: { ...STRICT_PREPARATION_LIMITS, maxActiveEnvelopes: 2 },
    });

    await useCase.execute({
      source: source('mixed-age.txt'),
      ttlSeconds: 60,
      retrieval: { allowedSelectorTypes: ['chunk'] },
    });
    currentMilliseconds += 30 * 1000;
    await useCase.execute({ source: source('mixed-age.txt'), ttlSeconds: 60 });
    currentMilliseconds += 31 * 1000;

    const renewed = await useCase.execute({ source: source('mixed-age.txt'), ttlSeconds: 60 });
    expect(renewed.envelope.preparationKind).toBe('text_chunks');
    expect(vault.snapshot().envelopeCount).toBe(2);
    const counters = vault.lifecycleCounters();
    expect(counters.envelopesRemovedByExpiry).toBe(1);
    expect(counters.grantsRevoked).toBe(1);
    expect(counters.envelopesRemovedByPurge).toBe(0);
  });

  it('rejects at the final pre-assembly deadline checkpoint before any commit', async () => {
    // The fake clock advances on every now() call: call 1 is the startedAt
    // stamp, call 2 the expiry sweep, call 3 the pre-read deadline check,
    // and call 4 the post-read deadline check. A deadline of 100 with
    // 25 ms per call passes all four and fails exactly at the final
    // pre-assembly checkpoint, so no derived state can be committed after
    // the deadline in either ordering.
    let callCount = 0;
    const clock: InspectionClock = {
      now: (): Date => new Date(BASE_INSTANT.getTime() + callCount++ * 25),
    };
    const bytes = new TextEncoder().encode('text\n');
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'late.txt',
    });
    const { useCase, vault } = createPrepareSource({
      read,
      clock,
      limits: { ...STRICT_PREPARATION_LIMITS, prepareDeadlineMilliseconds: 100 },
    });

    await expectRetryablePrepareError(
      () => useCase.execute({ source: source('late.txt') }),
      'CV_DEADLINE_EXCEEDED',
    );
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('enforces the total derived-state limit without committing a partial record', async () => {
    const bytes = new TextEncoder().encode('text\n');
    const { useCase, vault } = createPrepareSource({
      read: vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
        bytes,
        normalizedRelativePath: 'budget.txt',
      }),
      limits: { ...STRICT_PREPARATION_LIMITS, maxTotalDerivedStateBytes: 1 },
    });

    await expectPrepareError(
      () => useCase.execute({ source: source('budget.txt') }),
      'CV_RESOURCE_DERIVED_STATE_LIMIT',
    );
    expect(vault.snapshot()).toEqual({
      envelopeCount: 0,
      totalDerivedBytes: 0,
      version: 0,
    });
  });

  it.each([
    [
      'an unknown source kind',
      { kind: 'remote_url', rootId: 'repo', path: 'x.txt' },
      'CV_INPUT_INVALID',
    ],
    [
      'an invalid root identifier',
      { kind: 'workspace_file', rootId: 'REPO', path: 'x.txt' },
      'CV_INPUT_INVALID',
    ],
    [
      'a traversal path',
      { kind: 'workspace_file', rootId: 'repo', path: '../outside.txt' },
      'CV_PATH_OUTSIDE_WORKSPACE',
    ],
    [
      'an absolute path',
      { kind: 'workspace_file', rootId: 'repo', path: '/etc/passwd' },
      'CV_PATH_ABSOLUTE_DENIED',
    ],
  ])('rejects %s independently of the transport', async (_name, candidate, code) => {
    const read = vi.fn<AuthorizedFileReader['read']>();
    const { useCase } = createPrepareSource({ read });

    await expectPrepareError(() => useCase.execute({ source: candidate }), code);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['a symbol', Symbol('hostile-grant')],
    ['a bigint', 1n],
    ['a number', 42],
    ['a string', 'grant'],
    ['a boolean', true],
    ['null', null],
    ['an array', ['chunk']],
    ['an object with an unknown key', { selector: 'chunk' }],
    [
      'a callable carrying a well-formed grant',
      Object.assign(() => undefined, {
        allowedSelectorTypes: ['chunk'],
        maxBytes: 4096,
        ttlSeconds: 600,
      }),
    ],
    ['a non-array selector list with array-like shape', { allowedSelectorTypes: { length: 1 } }],
  ] as const)(
    'rejects %s as the retrieval grant at the use case boundary',
    async (_name, grant) => {
      const read = vi.fn<AuthorizedFileReader['read']>();
      const { useCase, vault } = createPrepareSource({ read });

      // This barrier is independent of the MCP schema: a request that
      // bypasses the adapter must fail closed with the typed input error,
      // and no reader, vault write, or grant issuance may observe it.
      await expectPrepareError(
        () => useCase.execute({ source: source('barrier.txt'), retrieval: grant }),
        'CV_INPUT_INVALID',
      );
      expect(read).not.toHaveBeenCalled();
      expect(vault.snapshot().envelopeCount).toBe(0);
      expect(vault.lifecycleCounters().grantsRevoked).toBe(0);
    },
  );

  it('forwards the caller signal to the authorized file reader', async () => {
    const bytes = new TextEncoder().encode('text\n');
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'signal.txt',
    });
    const { useCase } = createPrepareSource({ read });
    const controller = new AbortController();

    await useCase.execute({ source: source('signal.txt') }, controller.signal);

    expect(read).toHaveBeenCalledWith({
      rootId: 'repo',
      normalizedRelativePath: 'signal.txt',
      maximumBytes: 32 * 1024 * 1024,
      signal: controller.signal,
    });
  });

  it('rejects a cancellation that lands while the read is in flight', async () => {
    const controller = new AbortController();
    let releaseRead: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const bytes = new TextEncoder().encode('text\n');
    const parkedRead: AuthorizedFileReader['read'] = () =>
      gate.then(() => ({ bytes, normalizedRelativePath: 'slow.txt' }));
    const read = vi.fn<AuthorizedFileReader['read']>(parkedRead);
    const { useCase, vault } = createPrepareSource({ read });

    const pending = useCase.execute({ source: source('slow.txt') }, controller.signal);
    controller.abort();
    releaseRead?.();

    await expectRetryablePrepareError(() => pending, 'CV_OPERATION_CANCELLED');
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('fails closed when the preparation deadline passes during the read', async () => {
    let currentMilliseconds = BASE_INSTANT.getTime();
    const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
    const bytes = new TextEncoder().encode('text\n');
    const advancingRead: AuthorizedFileReader['read'] = () => {
      currentMilliseconds += 200;
      return Promise.resolve({ bytes, normalizedRelativePath: 'slow.txt' });
    };
    const read = vi.fn<AuthorizedFileReader['read']>(advancingRead);
    const { useCase, vault } = createPrepareSource({
      read,
      clock,
      limits: { ...STRICT_PREPARATION_LIMITS, prepareDeadlineMilliseconds: 100 },
    });

    await expectRetryablePrepareError(
      () => useCase.execute({ source: source('slow.txt') }),
      'CV_DEADLINE_EXCEEDED',
    );
    expect(vault.snapshot().envelopeCount).toBe(0);
  });
});

async function expectPrepareError(execute: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await execute();
    expect.fail(`Expected a ContextVaultError with code ${code}.`);
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
}

async function expectRetryablePrepareError(
  execute: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await execute();
    expect.fail(`Expected a retryable ContextVaultError with code ${code}.`);
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(true);
      return;
    }
    throw error;
  }
}

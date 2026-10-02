import { describe, expect, it, vi, type Mock } from 'vitest';

import type { AuthorizedFileReader } from '../../src/application/ports/authorized-file-reader.js';
import type { InspectionClock } from '../../src/application/ports/inspection-services.js';
import { VerifyEnvelope } from '../../src/application/verification/verify-envelope.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  STRICT_PREPARATION_LIMITS,
  validatePreparationLimits,
} from '../../src/domain/preparation/preparation-limits.js';
import { PrepareSource } from '../../src/application/preparation/prepare-source.js';
import { PreparationGate } from '../../src/application/preparation/preparation-gate.js';
import { RetrieveSource } from '../../src/application/retrieval/retrieve-source.js';
import { NodeCapabilityTokens } from '../../src/infrastructure/crypto/node-capability-tokens.js';
import { NodeInspectionCryptography } from '../../src/infrastructure/inspection/node-inspection-cryptography.js';
import { NodeOpaqueIdentifiers } from '../../src/infrastructure/preparation/node-opaque-identifiers.js';
import { InMemoryVault } from '../../src/infrastructure/vault/in-memory-vault.js';

const SESSION_ID = 'cv_ses_abcdefghijklmnop';
const BASE_MILLISECONDS = new Date('2026-09-10T12:00:00.000Z').getTime();

function createHarness(): {
  verify: VerifyEnvelope;
  prepare: PrepareSource;
  retrieve: RetrieveSource;
  vault: InMemoryVault;
  read: Mock<AuthorizedFileReader['read']>;
  setSourceBytes: (bytes: Uint8Array) => void;
  clock: { advance: (milliseconds: number) => void };
} {
  let currentMilliseconds = BASE_MILLISECONDS;
  const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
  let sourceBytes: Uint8Array = new TextEncoder().encode('alpha\nbeta\ngamma\n');
  const read = vi.fn<AuthorizedFileReader['read']>(() =>
    Promise.resolve({
      bytes: sourceBytes,
      normalizedRelativePath: 'notes/guide.txt',
    }),
  );
  const fileReader: AuthorizedFileReader = { authorizedRootCount: 1, read };
  const cryptography = new NodeInspectionCryptography();
  const capabilityTokens = new NodeCapabilityTokens();
  const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
  const vault = new InMemoryVault(SESSION_ID, limits);
  const prepare = new PrepareSource(
    {
      clock,
      cryptography,
      fileReader,
      vault,
      identifiers: new NodeOpaqueIdentifiers(),
      limits,
      tokens: capabilityTokens,
      tokenDigester: capabilityTokens,
    },
    new PreparationGate(limits.maxConcurrentPreparations),
  );
  const retrieve = new RetrieveSource({
    clock,
    cryptography,
    fileReader,
    vault,
    retrievalVault: vault,
    tokenDigester: capabilityTokens,
    digestComparator: capabilityTokens,
  });
  const verify = new VerifyEnvelope({
    clock,
    cryptography,
    fileReader,
    vault,
    retrievalVault: vault,
  });
  return {
    verify,
    prepare,
    retrieve,
    vault,
    read,
    setSourceBytes: (bytes: Uint8Array): void => {
      sourceBytes = bytes;
    },
    clock: {
      advance: (milliseconds: number): void => {
        currentMilliseconds += milliseconds;
      },
    },
  };
}

describe('VerifyEnvelope source freshness', () => {
  it('reports valid freshness for an unchanged prepared source', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'source_freshness' }],
    });

    expect(result.schemaVersion).toBe('1.0');
    expect(result.ok).toBe(true);
    expect(result.envelopeId).toBe(prepared.envelope.envelopeId);
    expect(result.results).toEqual([
      {
        kind: 'source_freshness',
        chunkId: undefined,
        status: 'valid',
        reasonCode: 'digest_matches_prepared_state',
      },
    ]);
    expect(new Date(result.verifiedAt).getTime()).toBe(BASE_MILLISECONDS);
  });

  it('reports stale freshness after the source is replaced', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    harness.setSourceBytes(new TextEncoder().encode('alpha\nbeta\nREPLACED\n'));

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'source_freshness' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'source_freshness',
        chunkId: undefined,
        status: 'stale',
        reasonCode: 'source_digest_mismatch',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('REPLACED');
  });

  it('reports unavailable for an envelope purged or never prepared', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    harness.vault.removeEnvelopeWithDerived(prepared.envelope.envelopeId);

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'source_freshness' }, { kind: 'provenance_consistency' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'source_freshness',
        chunkId: undefined,
        status: 'unavailable',
        reasonCode: 'envelope_absent',
      },
      {
        kind: 'provenance_consistency',
        chunkId: undefined,
        status: 'unavailable',
        reasonCode: 'envelope_absent',
      },
    ]);
  });

  it('reports unavailable for an expired envelope after the sweep', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      ttlSeconds: 60,
    });
    harness.clock.advance(60 * 1000);

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'source_freshness' }],
    });

    expect(result.results[0]?.status).toBe('unavailable');
    expect(result.results[0]?.reasonCode).toBe('envelope_absent');
  });

  it('reports unavailable chunk integrity and echoes the requested chunkId when the envelope is absent', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    harness.vault.removeEnvelopeWithDerived(prepared.envelope.envelopeId);

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000001' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'chunk_integrity',
        chunkId: 'cv_chunk_000000000001',
        status: 'unavailable',
        reasonCode: 'envelope_absent',
      },
    ]);
  });
});

describe('VerifyEnvelope chunk integrity', () => {
  it('reports valid integrity for a prepared chunk descriptor', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000001' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'chunk_integrity',
        chunkId: 'cv_chunk_000000000001',
        status: 'valid',
        reasonCode: 'digest_matches_prepared_state',
      },
    ]);
  });

  it('verifies a later chunk against its own span, not the whole source', async () => {
    const harness = createHarness();
    // Two chunks: the second chunk's digest covers only its own span, so
    // hashing the whole source instead would report a false mismatch.
    harness.setSourceBytes(new TextEncoder().encode(`${'first line\n'.repeat(400)}second part\n`));
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    expect(prepared.envelope.chunks.length).toBeGreaterThan(1);
    const secondChunkId = prepared.envelope.chunks[1]?.chunkId;
    if (!secondChunkId) {
      throw new Error('Expected a second chunk descriptor.');
    }

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'chunk_integrity', chunkId: secondChunkId }],
    });

    expect(result.results).toEqual([
      {
        kind: 'chunk_integrity',
        chunkId: secondChunkId,
        status: 'valid',
        reasonCode: 'digest_matches_prepared_state',
      },
    ]);
  });

  it('reports invalid integrity for a chunk digest that drifted from its span', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    const record = harness.vault.find(prepared.envelope.envelopeId);
    if (!record || record.chunks.length === 0) {
      throw new Error('Expected a stored chunk descriptor.');
    }
    // A hand-committed copy simulates a record whose chunk digest no
    // longer matches its span while the source itself is unchanged.
    const drifted = {
      ...record,
      envelopeId: 'cv_env_drifted000000001',
      chunks: [
        {
          ...record.chunks[0],
          chunkDigest: `sha256:${'f'.repeat(64)}`,
        },
      ],
    } as typeof record;
    harness.vault.commitEnvelope(drifted, null);

    const result = await harness.verify.execute({
      envelopeId: 'cv_env_drifted000000001',
      checks: [{ kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000001' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'chunk_integrity',
        chunkId: 'cv_chunk_000000000001',
        status: 'invalid',
        reasonCode: 'chunk_digest_mismatch',
      },
    ]);
  });

  it('reports invalid integrity for an unknown chunk identifier', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000999' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'chunk_integrity',
        chunkId: 'cv_chunk_000000000999',
        status: 'invalid',
        reasonCode: 'chunk_descriptor_unknown',
      },
    ]);
  });

  it('reports stale chunk integrity when the source changed', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    harness.setSourceBytes(new TextEncoder().encode('alpha\nbeta\nREPLACED\n'));

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000001' }],
    });

    expect(result.results[0]?.status).toBe('stale');
    expect(result.results[0]?.reasonCode).toBe('source_digest_mismatch');
  });
});

describe('VerifyEnvelope provenance consistency', () => {
  it('reports unavailable provenance when nothing was ever retrieved', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'provenance_consistency' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'provenance_consistency',
        chunkId: undefined,
        status: 'unavailable',
        reasonCode: 'provenance_chain_empty',
      },
    ]);
  });

  it('reports consistent provenance after a confirmed retrieval', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant.');
    }
    await harness.retrieve.execute({
      capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'provenance_consistency' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'provenance_consistency',
        chunkId: undefined,
        status: 'valid',
        reasonCode: 'provenance_chain_consistent',
      },
    ]);
  });

  it('reports invalid provenance when a retained record binds elsewhere', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    const envelope = harness.vault.find(prepared.envelope.envelopeId);
    if (!envelope) {
      throw new Error('Expected a stored envelope.');
    }
    // Provenance is append-only by envelope key; only the source digest
    // diverges here, so only the digest comparison can deny it.
    harness.vault.appendProvenance({
      envelopeId: envelope.envelopeId,
      sourceId: envelope.sourceId,
      sourceDigest: `sha256:${'f'.repeat(64)}`,
      selectorKind: 'chunk',
      excerptDigest: `sha256:${'e'.repeat(64)}`,
      byteCount: 8,
      truncated: false,
      recordedAt: new Date(BASE_MILLISECONDS).toISOString(),
    });

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'provenance_consistency' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'provenance_consistency',
        chunkId: undefined,
        status: 'invalid',
        reasonCode: 'provenance_record_foreign',
      },
    ]);
  });

  it.each([['a foreign source binding', 'cv_src_foreign00000001']])(
    'reports invalid provenance for %s',
    async (_name, divergentSourceId) => {
      const harness = createHarness();
      const prepared = await harness.prepare.execute({
        source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      });
      const envelope = harness.vault.find(prepared.envelope.envelopeId);
      if (!envelope) {
        throw new Error('Expected a stored envelope.');
      }
      // The record is stored under the envelope key (as the vault keys
      // it) while its source binding diverges: only the binding
      // comparison can deny it.
      harness.vault.appendProvenance({
        envelopeId: envelope.envelopeId,
        sourceId: divergentSourceId,
        sourceDigest: envelope.sourceDigest,
        selectorKind: 'chunk',
        excerptDigest: `sha256:${'e'.repeat(64)}`,
        byteCount: 8,
        truncated: false,
        recordedAt: new Date(BASE_MILLISECONDS).toISOString(),
      });

      const result = await harness.verify.execute({
        envelopeId: prepared.envelope.envelopeId,
        checks: [{ kind: 'provenance_consistency' }],
      });

      expect(result.results).toEqual([
        {
          kind: 'provenance_consistency',
          chunkId: undefined,
          status: 'invalid',
          reasonCode: 'provenance_record_foreign',
        },
      ]);
    },
  );

  it('rejects malformed verification requests without touching state', async () => {
    const harness = createHarness();

    await expect(harness.verify.execute({ envelopeId: 'bad', checks: [] })).rejects.toThrow();
    await expect(
      harness.verify.execute({
        envelopeId: 'cv_env_abcdefghijklmnop',
        checks: [{ kind: 'semantic_truth' }],
      } as never),
    ).rejects.toThrow();
    await expect(
      harness.verify.execute({
        envelopeId: 'cv_env_abcdefghijklmnop',
        checks: [{ kind: 'chunk_integrity' }],
      } as never),
    ).rejects.toThrow();
  });

  it('forwards the caller signal to the authorized file reader', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    const controller = new AbortController();

    await harness.verify.execute(
      {
        envelopeId: prepared.envelope.envelopeId,
        checks: [{ kind: 'source_freshness' }],
      },
      controller.signal,
    );

    expect(harness.read).toHaveBeenCalledWith({
      rootId: 'repo',
      normalizedRelativePath: 'notes/guide.txt',
      maximumBytes: 32 * 1024 * 1024,
      signal: controller.signal,
    });
  });
});

describe('VerifyEnvelope source_unreadable', () => {
  it.each([
    ['a deleted source', 'CV_SOURCE_NOT_FOUND'],
    ['an unauthorized source', 'CV_AUTHORIZATION_DENIED'],
    ['a path outside the workspace', 'CV_PATH_OUTSIDE_WORKSPACE'],
    ['a source rejected as a reparse point', 'CV_PATH_REPARSE_POINT_DENIED'],
    ['a special file type', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['an over-limit source', 'CV_RESOURCE_SOURCE_TOO_LARGE'],
    ['a source lost to a mid-read race', 'CV_SOURCE_CHANGED'],
  ] as const)('reports per-check unreadable state for %s', async (_name, code) => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant.');
    }
    await harness.retrieve.execute({
      capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });
    harness.read.mockRejectedValueOnce(
      new ContextVaultError({ code, message: 'synthetic reader failure detail' }),
    );

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [
        { kind: 'source_freshness' },
        { kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000001' },
        { kind: 'provenance_consistency' },
      ],
    });

    expect(result.results).toEqual([
      {
        kind: 'source_freshness',
        chunkId: undefined,
        status: 'unavailable',
        reasonCode: 'source_unreadable',
      },
      {
        kind: 'chunk_integrity',
        chunkId: 'cv_chunk_000000000001',
        status: 'unavailable',
        reasonCode: 'source_unreadable',
      },
      {
        kind: 'provenance_consistency',
        chunkId: undefined,
        status: 'valid',
        reasonCode: 'provenance_chain_consistent',
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('notes/guide.txt');
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain('synthetic reader failure detail');
  });

  it('keeps the envelope-local descriptor verdict when the source is unreadable', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    harness.read.mockRejectedValueOnce(
      new ContextVaultError({ code: 'CV_SOURCE_NOT_FOUND', message: 'gone' }),
    );

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000999' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'chunk_integrity',
        chunkId: 'cv_chunk_000000000999',
        status: 'invalid',
        reasonCode: 'chunk_descriptor_unknown',
      },
    ]);
  });

  it('keeps envelope_absent precedence and never reads when the envelope is gone', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    harness.vault.removeEnvelopeWithDerived(prepared.envelope.envelopeId);
    harness.read.mockRejectedValueOnce(
      new ContextVaultError({ code: 'CV_SOURCE_NOT_FOUND', message: 'gone' }),
    );
    const readCallsBeforeVerify = harness.read.mock.calls.length;

    const result = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'source_freshness' }],
    });

    expect(result.results).toEqual([
      {
        kind: 'source_freshness',
        chunkId: undefined,
        status: 'unavailable',
        reasonCode: 'envelope_absent',
      },
    ]);
    expect(harness.read.mock.calls.length).toBe(readCallsBeforeVerify);
  });

  it('still propagates failures that are not source-readability states', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    harness.read.mockRejectedValueOnce(
      new ContextVaultError({
        code: 'CV_OPERATION_CANCELLED',
        message: 'The operation was cancelled.',
        retryable: true,
      }),
    );

    await expect(
      harness.verify.execute({
        envelopeId: prepared.envelope.envelopeId,
        checks: [{ kind: 'source_freshness' }],
      }),
    ).rejects.toMatchObject({ code: 'CV_OPERATION_CANCELLED' });
  });

  it('recovers on the next attempt after one unreadable response', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    harness.read.mockRejectedValueOnce(
      new ContextVaultError({ code: 'CV_SOURCE_NOT_FOUND', message: 'gone' }),
    );

    const first = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'source_freshness' }],
    });
    const second = await harness.verify.execute({
      envelopeId: prepared.envelope.envelopeId,
      checks: [{ kind: 'source_freshness' }],
    });

    expect(first.results[0]).toMatchObject({
      status: 'unavailable',
      reasonCode: 'source_unreadable',
    });
    expect(second.results[0]).toMatchObject({
      status: 'valid',
      reasonCode: 'digest_matches_prepared_state',
    });
  });
});

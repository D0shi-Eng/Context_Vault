import { describe, expect, it } from 'vitest';

import type { AuthorizedFileReader } from '../../src/application/ports/authorized-file-reader.js';
import type { InspectionClock } from '../../src/application/ports/inspection-services.js';
import type { RequestCounters } from '../../src/domain/stats/stats-policy.js';
import { CollectSessionStats } from '../../src/application/stats/collect-session-stats.js';
import {
  STRICT_PREPARATION_LIMITS,
  validatePreparationLimits,
} from '../../src/domain/preparation/preparation-limits.js';
import { InMemoryRequestCounters } from '../../src/infrastructure/vault/in-memory-request-counters.js';
import { InMemoryVault } from '../../src/infrastructure/vault/in-memory-vault.js';
import { PrepareSource } from '../../src/application/preparation/prepare-source.js';
import { PreparationGate } from '../../src/application/preparation/preparation-gate.js';
import { PurgeDerivedState } from '../../src/application/preparation/purge-derived-state.js';
import { NodeCapabilityTokens } from '../../src/infrastructure/crypto/node-capability-tokens.js';
import { NodeInspectionCryptography } from '../../src/infrastructure/inspection/node-inspection-cryptography.js';
import { NodeOpaqueIdentifiers } from '../../src/infrastructure/preparation/node-opaque-identifiers.js';
import { RetrieveSource } from '../../src/application/retrieval/retrieve-source.js';

const SESSION_ID = 'cv_ses_abcdefghijklmnop';
const BASE_MILLISECONDS = new Date('2026-09-10T12:00:00.000Z').getTime();

function createStatsHarness(): {
  stats: CollectSessionStats;
  prepare: PrepareSource;
  purge: PurgeDerivedState;
  vault: InMemoryVault;
  counters: RequestCounters;
  fileReader: AuthorizedFileReader;
  clockValue: InspectionClock;
  clock: { advance: (milliseconds: number) => void };
} {
  let currentMilliseconds = BASE_MILLISECONDS;
  const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
  const fileReader: AuthorizedFileReader = {
    authorizedRootCount: 3,
    read: () =>
      Promise.resolve({
        bytes: new TextEncoder().encode('alpha\nbeta\n'),
        normalizedRelativePath: 'notes/guide.txt',
      }),
  };
  const cryptography = new NodeInspectionCryptography();
  const capabilityTokens = new NodeCapabilityTokens();
  const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
  const vault = new InMemoryVault(SESSION_ID, limits);
  const counters = new InMemoryRequestCounters();
  return {
    stats: new CollectSessionStats({
      clock,
      fileReader,
      vault,
      retrievalVault: vault,
      requestCounters: counters,
    }),
    prepare: new PrepareSource(
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
    ),
    purge: new PurgeDerivedState({
      clock,
      cryptography,
      identifiers: new NodeOpaqueIdentifiers(),
      vault,
    }),
    vault,
    counters,
    fileReader,
    clockValue: clock,
    clock: {
      advance: (milliseconds: number): void => {
        currentMilliseconds += milliseconds;
      },
    },
  };
}

describe('CollectSessionStats formulas', () => {
  it('reports zero counters for a fresh session', () => {
    const harness = createStatsHarness();

    const result = harness.stats.execute();

    expect(result.schemaVersion).toBe('1.0');
    expect(result.ok).toBe(true);
    expect(result.counters).toEqual({
      activeEnvelopeCount: 0,
      activeGrantCount: 0,
      authorizedRootCount: 3,
      serializedDerivedRecordBytes: 0,
      provenanceRecordsRetained: 0,
      successfulRequests: 0,
      failedRequests: 0,
      envelopesRemovedByExpiry: 0,
      envelopesRemovedByPurge: 0,
      grantsRevoked: 0,
      purgeIntentsConsumed: 0,
    });
    expect(new Date(result.measuredAt).getTime()).toBe(BASE_MILLISECONDS);
  });

  it('counts active envelopes, grants, and serialized bytes exactly', async () => {
    const harness = createStatsHarness();
    const first = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const second = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });

    const result = harness.stats.execute();
    const expectedBytes = harness.vault
      .list()
      .reduce((total, record) => total + record.derivedBytes, 0);

    expect(result.counters.activeEnvelopeCount).toBe(2);
    expect(result.counters.activeGrantCount).toBe(1);
    expect(result.counters.serializedDerivedRecordBytes).toBe(expectedBytes);
    expect(expectedBytes).toBeGreaterThan(0);
    expect(first.envelope.envelopeId).not.toBe(second.envelope.envelopeId);
  });

  it('counts retained provenance records after confirmed retrievals', async () => {
    const harness = createStatsHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant.');
    }
    const retrieve = new RetrieveSource({
      clock: harness.clockValue,
      cryptography: new NodeInspectionCryptography(),
      fileReader: harness.fileReader,
      vault: harness.vault,
      retrievalVault: harness.vault,
      tokenDigester: new NodeCapabilityTokens(),
      digestComparator: new NodeCapabilityTokens(),
    });
    await retrieve.execute({
      capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });
    await retrieve.execute({
      capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });

    const result = harness.stats.execute();

    expect(result.counters.provenanceRecordsRetained).toBe(2);
  });

  it('counts request outcomes exactly as recorded', () => {
    const harness = createStatsHarness();
    harness.counters.recordSuccess();
    harness.counters.recordSuccess();
    harness.counters.recordFailure();

    const result = harness.stats.execute();

    expect(result.counters.successfulRequests).toBe(2);
    expect(result.counters.failedRequests).toBe(1);
  });

  it('sweeps expired envelopes before counting and reports the expiry', async () => {
    const harness = createStatsHarness();
    await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      ttlSeconds: 60,
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 60 },
    });
    harness.clock.advance(60 * 1000);

    const result = harness.stats.execute();

    expect(result.counters.activeEnvelopeCount).toBe(0);
    expect(result.counters.activeGrantCount).toBe(0);
    expect(result.counters.serializedDerivedRecordBytes).toBe(0);
    expect(result.counters.envelopesRemovedByExpiry).toBe(1);
    expect(result.counters.grantsRevoked).toBe(1);
  });

  it('reports purge bookkeeping after an envelope purge with grant revocation', async () => {
    const harness = createStatsHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: prepared.envelope.envelopeId },
    });
    const executed = harness.purge.execute({
      operation: 'execute',
      purgeIntentId: preview.purgeIntentId,
    });

    const result = harness.stats.execute();

    expect(executed.revokedGrants).toBe(1);
    expect(result.counters.activeEnvelopeCount).toBe(0);
    expect(result.counters.activeGrantCount).toBe(0);
    expect(result.counters.envelopesRemovedByPurge).toBe(1);
    expect(result.counters.grantsRevoked).toBe(1);
    expect(result.counters.purgeIntentsConsumed).toBe(1);
  });

  it('never exposes content, paths, tokens, or savings metrics', async () => {
    const harness = createStatsHarness();
    await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });

    const serialized = JSON.stringify(harness.stats.execute());

    expect(serialized).not.toContain('alpha');
    expect(serialized).not.toContain('guide.txt');
    expect(serialized).not.toContain('cv1_');
    expect(serialized).not.toContain('netSav');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('Token');
  });
});

describe('InMemoryRequestCounters', () => {
  it('starts at zero and accumulates outcomes independently', () => {
    const counters = new InMemoryRequestCounters();
    expect(counters.snapshot()).toEqual({ successful: 0, failed: 0 });
    counters.recordSuccess();
    counters.recordFailure();
    counters.recordFailure();
    expect(counters.snapshot()).toEqual({ successful: 1, failed: 2 });
    expect(Object.isFrozen(counters.snapshot())).toBe(true);
  });
});

describe('PreparedEnvelopeRecord server-side binding', () => {
  it('binds the authorized root and path without disclosing them', async () => {
    const harness = createStatsHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    const record = harness.vault.find(prepared.envelope.envelopeId);
    if (record === undefined) {
      throw new Error('Expected a stored envelope record.');
    }

    expect(record.rootId).toBe('repo');
    expect(record.normalizedRelativePath).toBe('notes/guide.txt');
    expect(JSON.stringify(prepared)).not.toContain('repo');
  });

  it('mirrors the retrieval permission between the record and the disclosure', async () => {
    const harness = createStatsHarness();
    const ungranted = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
    });
    const granted = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const ungrantedRecord = harness.vault.find(ungranted.envelope.envelopeId);
    const grantedRecord = harness.vault.find(granted.envelope.envelopeId);
    if (!ungrantedRecord || !grantedRecord) {
      throw new Error('Expected stored envelope records.');
    }

    expect(ungranted.envelope.retrievalAllowed).toBe(false);
    expect(ungrantedRecord.retrievalAllowed).toBe(false);
    expect(granted.envelope.retrievalAllowed).toBe(true);
    expect(grantedRecord.retrievalAllowed).toBe(true);
  });
});

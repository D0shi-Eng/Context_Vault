import { describe, expect, it } from 'vitest';

import type { InspectionClock } from '../../src/application/ports/inspection-services.js';
import type { PreparationVault } from '../../src/application/ports/preparation-services.js';
import { PurgeDerivedState } from '../../src/application/preparation/purge-derived-state.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  STRICT_PREPARATION_LIMITS,
  validatePreparationLimits,
  type PreparationLimits,
} from '../../src/domain/preparation/preparation-limits.js';
import type { PreparedEnvelopeRecord } from '../../src/domain/preparation/preparation-types.js';
import { NodeInspectionCryptography } from '../../src/infrastructure/inspection/node-inspection-cryptography.js';
import { NodeOpaqueIdentifiers } from '../../src/infrastructure/preparation/node-opaque-identifiers.js';
import { InMemoryVault } from '../../src/infrastructure/vault/in-memory-vault.js';

const SESSION_ID = 'cv_ses_abcdefghijklmnop';
const BASE_MILLISECONDS = new Date('2026-09-10T12:00:00.000Z').getTime();
const limits: PreparationLimits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);

function envelopeRecord(envelopeId: string, derivedBytes: number): PreparedEnvelopeRecord {
  return Object.freeze({
    envelopeId,
    sessionId: SESSION_ID,
    createdAt: new Date(BASE_MILLISECONDS),
    expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
    rootId: 'workspace',
    normalizedRelativePath: 'notes.txt',
    sourceId: 'cv_src_abcdefghijklmnop',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    mediaType: 'text/plain',
    bytes: 32,
    sensitivity: 'internal',
    secretRisk: 'none',
    preparationKind: 'text_chunks',
    disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
    retrievalAllowed: false,
    lineCount: 2,
    structuralFingerprint: `sha256:${'b'.repeat(64)}`,
    derivedBytes,
    chunks: [],
    jsonNodes: [],
    omissions: [],
  });
}

function vaultRecordWithShortTtl(vault: InMemoryVault): void {
  vault.commitEnvelope(
    {
      ...envelopeRecord('cv_env_first000000000001', 512),
      expiresAt: new Date(BASE_MILLISECONDS + 60 * 1000),
    },
    null,
  );
}

function createPurgeHarness(clock?: InspectionClock): {
  purge: PurgeDerivedState;
  vault: InMemoryVault;
} {
  const vault = new InMemoryVault(SESSION_ID, limits);
  const purge = new PurgeDerivedState({
    clock: clock ?? { now: (): Date => new Date(BASE_MILLISECONDS) },
    cryptography: new NodeInspectionCryptography(),
    identifiers: new NodeOpaqueIdentifiers(),
    vault,
  });
  return { purge, vault };
}

describe('PurgeDerivedState preview', () => {
  it('binds an intent to the exact envelope target with counts and derived bytes only', () => {
    const { purge, vault } = createPurgeHarness();
    vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);

    const preview = purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });

    expect(preview.schemaVersion).toBe('1.0');
    expect(preview.ok).toBe(true);
    expect(preview.purgeIntentId).toMatch(/^cv_pur_[A-Za-z0-9_-]{24}$/u);
    expect(preview.target).toEqual({ kind: 'envelope', envelopeId: 'cv_env_first000000000001' });
    expect(preview.summary).toEqual({ envelopeCount: 1, derivedBytes: 512 });
    expect(new Date(preview.expiresAt).getTime()).toBe(BASE_MILLISECONDS + 1800 * 1000);
    expect(JSON.stringify(preview)).toContain('512');
    expect(vault.findIntent(preview.purgeIntentId)).toBeDefined();
  });

  it('binds a whole-state intent to the exact global counts and bytes', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 256), null);
    harness.vault.commitEnvelope(envelopeRecord('cv_env_second00000000001', 768), null);

    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'all_derived_state' },
    });

    expect(preview.target).toEqual({ kind: 'all_derived_state' });
    expect(preview.summary).toEqual({ envelopeCount: 2, derivedBytes: 1024 });
  });

  it('fails safely when the target envelope does not exist', () => {
    const { purge } = createPurgeHarness();

    expectPurgeError(
      () =>
        purge.preview({
          operation: 'preview',
          target: { kind: 'envelope', envelopeId: 'cv_env_unknown0000000001' },
        }),
      'CV_ENVELOPE_NOT_FOUND',
    );
  });

  it('sweeps expired envelopes before binding the target snapshot', () => {
    let currentMilliseconds = BASE_MILLISECONDS;
    const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
    const { purge, vault } = createPurgeHarness(clock);
    vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);

    currentMilliseconds = BASE_MILLISECONDS + 1800 * 1000;
    const preview = purge.preview({ operation: 'preview', target: { kind: 'all_derived_state' } });

    expect(preview.summary).toEqual({ envelopeCount: 0, derivedBytes: 0 });
    expect(vault.snapshot().envelopeCount).toBe(0);
  });
});

describe('PurgeDerivedState execute', () => {
  it('removes exactly the bound envelope and returns counts only', () => {
    const { purge, vault } = createPurgeHarness();
    vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    const preview = purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });

    const executed = purge.execute({ operation: 'execute', purgeIntentId: preview.purgeIntentId });

    expect(executed).toEqual({
      schemaVersion: '1.0',
      ok: true,
      targetKind: 'envelope',
      deletedEnvelopes: 1,
      deletedDerivedBytes: 512,
      revokedIntents: 0,
      revokedGrants: 0,
      removedProvenanceRecords: 0,
    });
    expect(vault.snapshot()).toEqual({
      envelopeCount: 0,
      totalDerivedBytes: 0,
      version: 2,
    });
  });

  it('rejects replayed intents with one generic invalid-intent error', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });
    harness.purge.execute({ operation: 'execute', purgeIntentId: preview.purgeIntentId });

    expectPurgeError(
      () => harness.purge.execute({ operation: 'execute', purgeIntentId: preview.purgeIntentId }),
      'CV_PURGE_INTENT_INVALID',
    );
  });

  it('rejects an expired intent distinctly from a consumed intent', () => {
    let currentMilliseconds = BASE_MILLISECONDS;
    const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
    const harness = createPurgeHarness(clock);
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });

    currentMilliseconds = BASE_MILLISECONDS + 1800 * 1000;
    expectPurgeError(
      () => harness.purge.execute({ operation: 'execute', purgeIntentId: preview.purgeIntentId }),
      'CV_PURGE_INTENT_EXPIRED',
    );
  });

  it('treats an envelope that expires after the preview as a stale target', () => {
    let currentMilliseconds = BASE_MILLISECONDS;
    const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
    const harness = createPurgeHarness(clock);
    vaultRecordWithShortTtl(harness.vault);
    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });

    // The intent is still valid, but the envelope expired in the meantime.
    currentMilliseconds = BASE_MILLISECONDS + 120 * 1000;
    expectPurgeError(
      () => harness.purge.execute({ operation: 'execute', purgeIntentId: preview.purgeIntentId }),
      'CV_PURGE_INTENT_STALE',
    );
  });

  it('rejects a stale whole-state intent after unrelated derived state was added', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'all_derived_state' },
    });

    harness.vault.commitEnvelope(envelopeRecord('cv_env_second00000000001', 256), null);

    expectPurgeError(
      () => harness.purge.execute({ operation: 'execute', purgeIntentId: preview.purgeIntentId }),
      'CV_PURGE_INTENT_STALE',
    );
    const intent = harness.vault.findIntent(preview.purgeIntentId);
    expect(intent).toBeDefined();
    expect(intent?.consumed).toBe(false);
  });

  it('keeps an envelope-specific intent valid when unrelated envelopes change', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });

    harness.vault.commitEnvelope(envelopeRecord('cv_env_second00000000001', 256), null);
    const executed = harness.purge.execute({
      operation: 'execute',
      purgeIntentId: preview.purgeIntentId,
    });

    expect(executed.deletedEnvelopes).toBe(1);
    expect(executed.deletedDerivedBytes).toBe(512);
    expect(harness.vault.find('cv_env_second00000000001')).toBeDefined();
  });

  it('revokes only the executed envelope intent and keeps a sibling intent usable', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    harness.vault.commitEnvelope(envelopeRecord('cv_env_second00000000001', 256), null);
    const first = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });
    const second = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_second00000000001' },
    });

    const executed = harness.purge.execute({
      operation: 'execute',
      purgeIntentId: first.purgeIntentId,
    });

    expect(executed.revokedIntents).toBe(0);
    // The sibling intent for the other envelope must survive: an
    // envelope purge revokes only its own target-bound intents.
    const sibling = harness.purge.execute({
      operation: 'execute',
      purgeIntentId: second.purgeIntentId,
    });
    expect(sibling.deletedEnvelopes).toBe(1);
    expect(sibling.targetKind).toBe('envelope');
  });

  it('rejects intents bound to a different private session', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    harness.vault.saveIntent({
      intentId: 'cv_pur_foreigner00000001',
      sessionId: 'cv_ses_otheruser0000001',
      targetKind: 'envelope',
      envelopeId: 'cv_env_first000000000001',
      snapshotDigest: `sha256:${'c'.repeat(64)}`,
      envelopeCount: 1,
      derivedBytes: 512,
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      consumed: false,
    });

    expectPurgeError(
      () =>
        harness.purge.execute({ operation: 'execute', purgeIntentId: 'cv_pur_foreigner00000001' }),
      'CV_PURGE_INTENT_INVALID',
    );
  });

  it('treats a revoked sibling intent as a generic invalid intent', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    const first = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });
    const second = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });

    harness.purge.execute({ operation: 'execute', purgeIntentId: first.purgeIntentId });

    expectPurgeError(
      () => harness.purge.execute({ operation: 'execute', purgeIntentId: second.purgeIntentId }),
      'CV_PURGE_INTENT_INVALID',
    );
  });

  it('purges all derived state and revokes pending target-bound intents', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 256), null);
    harness.vault.commitEnvelope(envelopeRecord('cv_env_second00000000001', 768), null);
    const envelopeIntent = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });
    const wholeStateIntent = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'all_derived_state' },
    });

    const executed = harness.purge.execute({
      operation: 'execute',
      purgeIntentId: wholeStateIntent.purgeIntentId,
    });

    expect(executed).toEqual({
      schemaVersion: '1.0',
      ok: true,
      targetKind: 'all_derived_state',
      deletedEnvelopes: 2,
      deletedDerivedBytes: 1024,
      revokedIntents: 1,
      revokedGrants: 0,
      removedProvenanceRecords: 0,
    });
    expect(harness.vault.snapshot().envelopeCount).toBe(0);
    expectPurgeError(
      () =>
        harness.purge.execute({
          operation: 'execute',
          purgeIntentId: envelopeIntent.purgeIntentId,
        }),
      'CV_PURGE_INTENT_INVALID',
    );
  });

  it('rejects a stale whole-state intent when derived state was reduced', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 256), null);
    const wholeStateIntent = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'all_derived_state' },
    });

    harness.vault.removeEnvelopeWithDerived('cv_env_first000000000001');

    expectPurgeError(
      () =>
        harness.purge.execute({
          operation: 'execute',
          purgeIntentId: wholeStateIntent.purgeIntentId,
        }),
      'CV_PURGE_INTENT_STALE',
    );
  });

  it('rejects a malformed request shape without touching state', () => {
    const harness = createPurgeHarness();

    expectPurgeError(() => harness.purge.execute({ operation: 'execute' }), 'CV_INPUT_INVALID');
    expectPurgeError(() => harness.purge.preview({ operation: 'preview' }), 'CV_INPUT_INVALID');
    expectPurgeError(() => harness.purge.preview('not-an-object'), 'CV_INPUT_INVALID');
  });

  it('rejects an execute-shaped request aimed at the preview operation', () => {
    const harness = createPurgeHarness();

    expectPurgeError(
      () =>
        harness.purge.preview({ operation: 'execute', purgeIntentId: 'cv_pur_abcdefghijklmnop' }),
      'CV_INPUT_INVALID',
    );
  });

  it('rejects a preview-shaped request aimed at the execute operation', () => {
    const harness = createPurgeHarness();

    expectPurgeError(
      () => harness.purge.execute({ operation: 'preview', target: { kind: 'all_derived_state' } }),
      'CV_INPUT_INVALID',
    );
  });

  it('keeps the operation-mismatch message human readable', () => {
    const harness = createPurgeHarness();

    for (const call of [
      (): void => {
        harness.purge.preview({ operation: 'execute', purgeIntentId: 'cv_pur_abcdefghijklmnop' });
      },
      (): void => {
        harness.purge.execute({ operation: 'preview', target: { kind: 'all_derived_state' } });
      },
    ]) {
      try {
        call();
        expect.fail('Expected a ContextVaultError for the mismatched operation.');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ContextVaultError);
        expect((error as ContextVaultError).message).toBe('The purge request is invalid.');
      }
    }
  });

  it('rejects an envelope intent whose target lost its envelope identity', () => {
    const harness = createPurgeHarness();
    harness.vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    harness.vault.saveIntent({
      intentId: 'cv_pur_headless00000001',
      sessionId: SESSION_ID,
      targetKind: 'envelope',
      envelopeId: null,
      snapshotDigest: `sha256:${'c'.repeat(64)}`,
      envelopeCount: 1,
      derivedBytes: 512,
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      consumed: false,
    });

    expectPurgeError(
      () =>
        harness.purge.execute({ operation: 'execute', purgeIntentId: 'cv_pur_headless00000001' }),
      'CV_PURGE_INTENT_STALE',
    );
  });

  it('fails closed when the intent can no longer be consumed', () => {
    const harness = createPurgeHarness();
    const vault = harness.vault;
    vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });

    // Simulates a revocation racing the consumption step: the intent that
    // passed snapshot verification disappears before it can be consumed.
    const raceVault: PreparationVault = {
      sessionId: vault.sessionId,
      commitEnvelope: (record, grant) => {
        vault.commitEnvelope(record, grant);
      },
      find: (id) => vault.find(id),
      list: () => vault.list(),
      snapshot: () => vault.snapshot(),
      removeEnvelopeWithDerived: (id) => vault.removeEnvelopeWithDerived(id),
      removeAllDerivedState: () => vault.removeAllDerivedState(),
      sweepExpired: (now) => vault.sweepExpired(now),
      findIntent: (id) => vault.findIntent(id),
      saveIntent: (intent) => {
        vault.saveIntent(intent);
      },
      consumeIntent: () => undefined,
      revokeIntents: (targetKind, envelopeId) => vault.revokeIntents(targetKind, envelopeId),
      lifecycleCounters: () => vault.lifecycleCounters(),
    };
    const racingPurge = new PurgeDerivedState({
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
      cryptography: new NodeInspectionCryptography(),
      identifiers: new NodeOpaqueIdentifiers(),
      vault: raceVault,
    });

    expectPurgeError(
      () => racingPurge.execute({ operation: 'execute', purgeIntentId: preview.purgeIntentId }),
      'CV_PURGE_INTENT_INVALID',
    );
  });

  it('returns zero counts when the envelope disappears between checks and deletion', () => {
    const harness = createPurgeHarness();
    const vault = harness.vault;
    vault.commitEnvelope(envelopeRecord('cv_env_first000000000001', 512), null);
    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });

    const vanishingVault: PreparationVault = {
      sessionId: vault.sessionId,
      commitEnvelope: (record, grant) => {
        vault.commitEnvelope(record, grant);
      },
      find: (id) => vault.find(id),
      list: () => vault.list(),
      snapshot: () => vault.snapshot(),
      removeEnvelopeWithDerived: () => ({
        envelopeCount: 0,
        derivedBytes: 0,
        grantsRevoked: 0,
        provenanceRecordsRemoved: 0,
      }),
      removeAllDerivedState: () => vault.removeAllDerivedState(),
      sweepExpired: (now) => vault.sweepExpired(now),
      findIntent: (id) => vault.findIntent(id),
      saveIntent: (intent) => {
        vault.saveIntent(intent);
      },
      consumeIntent: (id) => vault.consumeIntent(id),
      revokeIntents: (targetKind, envelopeId) => vault.revokeIntents(targetKind, envelopeId),
      lifecycleCounters: () => vault.lifecycleCounters(),
    };
    const racingPurge = new PurgeDerivedState({
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
      cryptography: new NodeInspectionCryptography(),
      identifiers: new NodeOpaqueIdentifiers(),
      vault: vanishingVault,
    });

    const executed = racingPurge.execute({
      operation: 'execute',
      purgeIntentId: preview.purgeIntentId,
    });
    expect(executed.deletedEnvelopes).toBe(0);
    expect(executed.deletedDerivedBytes).toBe(0);
    expect(executed.revokedIntents).toBeGreaterThanOrEqual(0);
  });
});

function expectPurgeError(execute: () => unknown, code: string): void {
  try {
    execute();
    expect.fail(`Expected a ContextVaultError with code ${code}.`);
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
}

describe('PurgeDerivedState grant and provenance revocation', () => {
  const GRANT_DIGEST = 'd'.repeat(64);

  function commitGrant(
    vault: InMemoryVault,
    envelopeId: string,
    tokenDigest: string = GRANT_DIGEST,
  ): void {
    vault.commitEnvelope(envelopeRecord(envelopeId, 256), {
      tokenDigest,
      allowedSelectorTypes: ['chunk'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });
  }

  function commitProvenance(vault: InMemoryVault, envelopeId: string): void {
    vault.appendProvenance({
      envelopeId,
      sourceId: 'cv_src_abcdefghijklmnop',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      selectorKind: 'chunk',
      excerptDigest: `sha256:${'e'.repeat(64)}`,
      byteCount: 32,
      truncated: false,
      recordedAt: new Date(BASE_MILLISECONDS).toISOString(),
    });
  }

  function executePurge(
    harness: { purge: PurgeDerivedState },
    envelopeId: string,
  ): ReturnType<PurgeDerivedState['execute']> {
    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId },
    });
    return harness.purge.execute({
      operation: 'execute',
      purgeIntentId: preview.purgeIntentId,
    });
  }

  it('revokes the envelope grant and removes its provenance on purge', () => {
    const harness = createPurgeHarness();
    commitGrant(harness.vault, 'cv_env_first000000000001');
    commitProvenance(harness.vault, 'cv_env_first000000000001');

    const executed = executePurge(harness, 'cv_env_first000000000001');

    expect(executed.revokedGrants).toBe(1);
    expect(executed.removedProvenanceRecords).toBe(1);
    expect(harness.vault.findGrantByTokenDigest(GRANT_DIGEST)).toBeUndefined();
    expect(harness.vault.listProvenanceForEnvelope('cv_env_first000000000001')).toEqual([]);
  });

  it('keeps an unrelated envelope grant alive when purging one envelope', () => {
    const harness = createPurgeHarness();
    commitGrant(harness.vault, 'cv_env_first000000000001');
    commitGrant(harness.vault, 'cv_env_second00000000001', 'e'.repeat(64));

    const executed = executePurge(harness, 'cv_env_first000000000001');

    expect(executed.revokedGrants).toBe(1);
    expect(harness.vault.find('cv_env_second00000000001')).toBeDefined();
    expect(harness.vault.findGrantByTokenDigest('e'.repeat(64))).toBeDefined();
    expect(harness.vault.countActiveGrants(new Date(BASE_MILLISECONDS))).toBe(1);
  });

  it('revokes every grant and provenance record on whole-state purge', () => {
    const harness = createPurgeHarness();
    commitGrant(harness.vault, 'cv_env_first000000000001');
    commitGrant(harness.vault, 'cv_env_second00000000001', 'e'.repeat(64));
    commitProvenance(harness.vault, 'cv_env_first000000000001');
    commitProvenance(harness.vault, 'cv_env_second00000000001');

    const preview = harness.purge.preview({
      operation: 'preview',
      target: { kind: 'all_derived_state' },
    });
    const executed = harness.purge.execute({
      operation: 'execute',
      purgeIntentId: preview.purgeIntentId,
    });

    expect(executed.revokedGrants).toBe(2);
    expect(executed.removedProvenanceRecords).toBe(2);
    expect(harness.vault.countActiveGrants(new Date(BASE_MILLISECONDS))).toBe(0);
  });

  it('revokes expired-envelope grants through the expiry sweep', () => {
    let currentMilliseconds = BASE_MILLISECONDS;
    const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
    const harness = createPurgeHarness(clock);
    harness.vault.commitEnvelope(
      {
        ...envelopeRecord('cv_env_first000000000001', 256),
        expiresAt: new Date(BASE_MILLISECONDS + 60 * 1000),
      },
      {
        tokenDigest: GRANT_DIGEST,
        allowedSelectorTypes: ['chunk'],
        maxBytes: 4096,
        expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
      },
    );

    currentMilliseconds = BASE_MILLISECONDS + 120 * 1000;
    const removal = harness.vault.sweepExpired(new Date(currentMilliseconds));

    expect(removal.envelopeCount).toBe(1);
    expect(removal.grantsRevoked).toBe(1);
    expect(harness.vault.findGrantByTokenDigest(GRANT_DIGEST)).toBeUndefined();
    expect(harness.vault.lifecycleCounters().envelopesRemovedByExpiry).toBe(1);
  });
});

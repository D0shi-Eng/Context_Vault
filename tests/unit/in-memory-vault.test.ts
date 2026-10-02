import { describe, expect, it } from 'vitest';

import type { PreparationVault } from '../../src/application/ports/preparation-services.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  MAX_PENDING_PURGE_INTENTS,
  type PreparationLimits,
} from '../../src/domain/preparation/preparation-limits.js';
import type { PreparedEnvelopeRecord } from '../../src/domain/preparation/preparation-types.js';
import type { PurgeIntentRecord } from '../../src/domain/preparation/purge-intent-policy.js';
import type { RetrievalProvenanceRecord } from '../../src/domain/retrieval/retrieval-types.js';
import {
  InMemoryVault,
  MAX_PROVENANCE_RECORDS_PER_ENVELOPE,
  MAX_RETAINED_PROVENANCE_RECORDS,
} from '../../src/infrastructure/vault/in-memory-vault.js';

const limits: PreparationLimits = Object.freeze({
  maxActiveEnvelopes: 2,
  maxTotalDerivedStateBytes: 1024,
  maxSerializedMetadataBytes: 512,
  maxConcurrentPreparations: 1,
  prepareDeadlineMilliseconds: 30_000,
});

const UNBOUNDED_LIMITS: PreparationLimits = Object.freeze({
  maxActiveEnvelopes: 64,
  maxTotalDerivedStateBytes: 64 * 1024 * 1024,
  maxSerializedMetadataBytes: 512,
  maxConcurrentPreparations: 1,
  prepareDeadlineMilliseconds: 30_000,
});

const BASE_MILLISECONDS = new Date('2026-09-10T12:00:00.000Z').getTime();

function envelopeRecord(overrides: Partial<PreparedEnvelopeRecord> = {}): PreparedEnvelopeRecord {
  return Object.freeze({
    envelopeId: `cv_env_${Math.random().toString(36).slice(2, 12)}`,
    sessionId: 'cv_ses_abcdefghijklmnop',
    createdAt: new Date(BASE_MILLISECONDS),
    expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
    rootId: 'workspace',
    normalizedRelativePath: 'docs/example.txt',
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
    derivedBytes: 256,
    chunks: [],
    jsonNodes: [],
    omissions: [],
    ...overrides,
  });
}

function grantCommit(overrides: Record<string, unknown> = {}): {
  tokenDigest: string;
  allowedSelectorTypes: readonly ('chunk' | 'json_node' | 'line_range')[];
  maxBytes: number;
  expiresAt: Date;
} {
  return {
    tokenDigest: randomHexDigest(),
    allowedSelectorTypes: ['chunk', 'line_range'],
    maxBytes: 4096,
    expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
    ...overrides,
  };
}

function randomHexDigest(): string {
  let digest = '';
  while (digest.length < 64) {
    digest += Math.floor(Math.random() * 16).toString(16);
  }
  return digest;
}

function createVault(): InMemoryVault {
  return new InMemoryVault('cv_ses_abcdefghijklmnop', limits);
}

describe('InMemoryVault envelopes', () => {
  it('exposes the bound private session identifier', () => {
    expect(createVault().sessionId).toBe('cv_ses_abcdefghijklmnop');
  });

  it('exposes the running derived-state byte accounting', () => {
    const vault = createVault();
    expect(vault.totalDerivedBytes).toBe(0);
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), null);
    expect(vault.totalDerivedBytes).toBe(256);
  });

  it('tags thrown errors with the ContextVaultError name for downstream mapping', () => {
    const vault = createVault();
    try {
      vault.commitEnvelope(
        envelopeRecord({ envelopeId: 'cv_env_first0000000001', derivedBytes: 513 }),
        null,
      );
      expect.fail('Expected the oversized record to be rejected.');
    } catch (error: unknown) {
      if (error instanceof ContextVaultError) {
        expect(error.name).toBe('ContextVaultError');
        return;
      }
      throw error;
    }
  });

  it('adds, finds, and lists derived envelope records with exact accounting', () => {
    const vault = createVault();
    const first = envelopeRecord({ envelopeId: 'cv_env_first0000000001' });
    const second = envelopeRecord({ envelopeId: 'cv_env_second00000001' });

    vault.commitEnvelope(first, null);
    vault.commitEnvelope(second, null);

    expect(vault.find('cv_env_first0000000001')).toBe(first);
    expect(vault.list()).toEqual([first, second]);
    expect(vault.snapshot()).toEqual({
      envelopeCount: 2,
      totalDerivedBytes: 512,
      version: 2,
    });
  });

  it('increments the version on every committed mutation', () => {
    const vault = createVault();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), null);
    expect(vault.snapshot().version).toBe(1);
    vault.removeEnvelopeWithDerived('cv_env_first0000000001');
    expect(vault.snapshot().version).toBe(2);
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_second00000001' }), null);
    expect(vault.snapshot().version).toBe(3);
    vault.removeAllDerivedState();
    expect(vault.snapshot().version).toBe(4);
  });

  it('enforces the active-envelope limit without leaving partial state', () => {
    const vault = createVault();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), null);
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_second00000001' }), null);

    expectVaultError(() => {
      vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_third000000000' }), null);
    }, 'CV_RESOURCE_ENVELOPE_LIMIT');
    expect(vault.snapshot()).toEqual({
      envelopeCount: 2,
      totalDerivedBytes: 512,
      version: 2,
    });
  });

  it('enforces the per-envelope serialized metadata limit before committing', () => {
    const vault = createVault();
    expectVaultError(() => {
      vault.commitEnvelope(
        envelopeRecord({ envelopeId: 'cv_env_first0000000001', derivedBytes: 513 }),
        null,
      );
    }, 'CV_RESOURCE_ENVELOPE_TOO_LARGE');
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('enforces the total derived-state limit without partial commits', () => {
    const vault = new InMemoryVault('cv_ses_abcdefghijklmnop', {
      ...limits,
      maxActiveEnvelopes: 64,
    });
    vault.commitEnvelope(
      envelopeRecord({ envelopeId: 'cv_env_first0000000001', derivedBytes: 512 }),
      null,
    );
    vault.commitEnvelope(
      envelopeRecord({ envelopeId: 'cv_env_second00000001', derivedBytes: 512 }),
      null,
    );

    expectVaultError(() => {
      vault.commitEnvelope(
        envelopeRecord({ envelopeId: 'cv_env_third000000000', derivedBytes: 1 }),
        null,
      );
    }, 'CV_RESOURCE_DERIVED_STATE_LIMIT');
    expect(vault.snapshot()).toEqual({
      envelopeCount: 2,
      totalDerivedBytes: 1024,
      version: 2,
    });
  });

  it('rejects a duplicate envelope identifier as an internal allocation failure', () => {
    const vault = createVault();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), null);
    expectVaultError(() => {
      vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), null);
    }, 'CV_INTERNAL_ERROR');
  });

  it('removes exactly the requested envelope and reduces the accounting', () => {
    const vault = createVault();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), null);
    const removal = vault.removeEnvelopeWithDerived('cv_env_first0000000001');

    expect(removal).toEqual({
      envelopeCount: 1,
      derivedBytes: 256,
      grantsRevoked: 0,
      provenanceRecordsRemoved: 0,
    });
    expect(vault.find('cv_env_first0000000001')).toBeUndefined();
    expect(vault.snapshot().totalDerivedBytes).toBe(0);

    expect(vault.removeEnvelopeWithDerived('cv_env_first0000000001').envelopeCount).toBe(0);
  });

  it('removes all derived state for the whole-session purge', () => {
    const vault = createVault();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), null);
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_second00000001' }), null);

    const removal = vault.removeAllDerivedState();
    expect(removal.envelopeCount).toBe(2);
    expect(removal.derivedBytes).toBe(512);
    expect(vault.snapshot()).toEqual({
      envelopeCount: 0,
      totalDerivedBytes: 0,
      version: 4,
    });
  });
});

describe('InMemoryVault grants', () => {
  it('commits an envelope with its grant atomically and looks it up by digest only', () => {
    const vault = createVault();
    const commit = grantCommit();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), commit);

    const grant = vault.findGrantByTokenDigest(commit.tokenDigest);
    if (grant === undefined) {
      throw new Error('Expected a stored grant record.');
    }
    expect(grant.envelopeId).toBe('cv_env_first0000000001');
    expect(grant.sessionId).toBe('cv_ses_abcdefghijklmnop');
    expect(grant.sourceId).toBe('cv_src_abcdefghijklmnop');
    expect(grant.sourceDigest).toBe(envelopeRecord().sourceDigest);
    expect(grant.revoked).toBe(false);
    expect(vault.countActiveGrants(new Date(BASE_MILLISECONDS))).toBe(1);
    // A raw token never exists in the store: the digest is the only key.
    expect(JSON.stringify(vault.findGrantByTokenDigest(commit.tokenDigest))).not.toContain('cv1_');
  });

  it('fails closed when the grant budget is exhausted, without committing the envelope', () => {
    const vault = new InMemoryVault('cv_ses_abcdefghijklmnop', UNBOUNDED_LIMITS);
    for (let index = 0; index < 64; index += 1) {
      vault.commitEnvelope(
        envelopeRecord({ envelopeId: `cv_env_fill${String(index).padStart(16, '0')}` }),
        grantCommit(),
      );
    }
    expectVaultError(() => {
      vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_over00000000001' }), grantCommit());
    }, 'CV_RESOURCE_ENVELOPE_LIMIT');
    expect(vault.find('cv_env_over00000000001')).toBeUndefined();
    expect(vault.snapshot().envelopeCount).toBe(64);
  });

  it('bounds grants structurally at the active-envelope limit', () => {
    const vault = new InMemoryVault('cv_ses_abcdefghijklmnop', UNBOUNDED_LIMITS);
    for (let index = 0; index < 64; index += 1) {
      vault.commitEnvelope(
        envelopeRecord({ envelopeId: `cv_env_fill${String(index).padStart(16, '0')}` }),
        grantCommit(),
      );
    }
    expect(vault.snapshot().envelopeCount).toBe(64);
    expect(vault.countActiveGrants(new Date(BASE_MILLISECONDS))).toBe(64);
  });

  it('removes an envelope with its grants and provenance in one step', () => {
    const vault = createVault();
    const commit = grantCommit();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), commit);
    vault.appendProvenance(provenanceRecord({ envelopeId: 'cv_env_first0000000001' }));

    const removal = vault.removeEnvelopeWithDerived('cv_env_first0000000001');
    expect(removal).toEqual({
      envelopeCount: 1,
      derivedBytes: 256,
      grantsRevoked: 1,
      provenanceRecordsRemoved: 1,
    });
    expect(vault.findGrantByTokenDigest(commit.tokenDigest)).toBeUndefined();
    expect(vault.listProvenanceForEnvelope('cv_env_first0000000001')).toEqual([]);
    expect(vault.lifecycleCounters()).toEqual({
      envelopesRemovedByExpiry: 0,
      envelopesRemovedByPurge: 1,
      grantsRevoked: 1,
      purgeIntentsConsumed: 0,
    });
  });
});

describe('InMemoryVault provenance', () => {
  it('retains provenance records per envelope and lists them in order', () => {
    const vault = createVault();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), null);
    const first = provenanceRecord({ envelopeId: 'cv_env_first0000000001' });
    const second = provenanceRecord({ envelopeId: 'cv_env_first0000000001' });
    vault.appendProvenance(first);
    vault.appendProvenance(second);

    expect(vault.listProvenanceForEnvelope('cv_env_first0000000001')).toEqual([first, second]);
    expect(vault.listProvenanceForEnvelope('cv_env_unknown000000001')).toEqual([]);
  });

  it('evicts the oldest record per envelope at the per-envelope cap', () => {
    const vault = createVault();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_first0000000001' }), null);
    const oldest = provenanceRecord({ envelopeId: 'cv_env_first0000000001' });
    vault.appendProvenance(oldest);
    for (let index = 1; index <= MAX_PROVENANCE_RECORDS_PER_ENVELOPE; index += 1) {
      vault.appendProvenance(
        provenanceRecord({
          envelopeId: 'cv_env_first0000000001',
          excerptDigest: `sha256:${index.toString().padStart(64, '0')}`,
        }),
      );
    }

    const retained = vault.listProvenanceForEnvelope('cv_env_first0000000001');
    expect(retained).toHaveLength(MAX_PROVENANCE_RECORDS_PER_ENVELOPE);
    expect(retained[0]?.excerptDigest).not.toBe(oldest.excerptDigest);
    expect(retained[0]?.excerptDigest).toBe(`sha256:${'1'.padStart(64, '0')}`);
  });

  it('stays globally bounded across envelopes by evicting the oldest record overall', () => {
    const vault = new InMemoryVault('cv_ses_abcdefghijklmnop', UNBOUNDED_LIMITS);
    const fillId = (index: number): string => `cv_env_fill${String(index).padStart(16, '0')}`;
    for (let index = 0; index < MAX_RETAINED_PROVENANCE_RECORDS; index += 1) {
      vault.commitEnvelope(envelopeRecord({ envelopeId: fillId(index) }), null);
      vault.appendProvenance(provenanceRecord({ envelopeId: fillId(index) }));
    }
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_last00000000001' }), null);
    vault.appendProvenance(provenanceRecord({ envelopeId: 'cv_env_last00000000001' }));

    expect(vault.listProvenanceForEnvelope(fillId(0))).toEqual([]);
    expect(vault.listProvenanceForEnvelope('cv_env_last00000000001')).toHaveLength(1);
  });
});

describe('InMemoryVault expiry sweep', () => {
  it('removes only expired envelopes together with grants and provenance', () => {
    const vault = createVault();
    const expiringGrant = grantCommit();
    vault.commitEnvelope(
      envelopeRecord({
        envelopeId: 'cv_env_expire000000001',
        expiresAt: new Date(BASE_MILLISECONDS + 60 * 1000),
      }),
      expiringGrant,
    );
    vault.appendProvenance(provenanceRecord({ envelopeId: 'cv_env_expire000000001' }));
    const survivingGrant = grantCommit();
    vault.commitEnvelope(envelopeRecord({ envelopeId: 'cv_env_survive0000001' }), survivingGrant);

    const removal = vault.sweepExpired(new Date(BASE_MILLISECONDS + 120 * 1000));

    expect(removal).toEqual({
      envelopeCount: 1,
      derivedBytes: 256,
      grantsRevoked: 1,
      provenanceRecordsRemoved: 1,
    });
    expect(vault.find('cv_env_expire000000001')).toBeUndefined();
    expect(vault.find('cv_env_survive0000001')).toBeDefined();
    expect(vault.findGrantByTokenDigest(survivingGrant.tokenDigest)).toBeDefined();
    expect(vault.lifecycleCounters().envelopesRemovedByExpiry).toBe(1);
  });

  it('counts an unexpired grant active and drops it after its own expiry', () => {
    const vault = createVault();
    vault.commitEnvelope(
      envelopeRecord({ envelopeId: 'cv_env_first0000000001' }),
      grantCommit({ expiresAt: new Date(BASE_MILLISECONDS + 1000) }),
    );
    expect(vault.countActiveGrants(new Date(BASE_MILLISECONDS))).toBe(1);
    expect(vault.countActiveGrants(new Date(BASE_MILLISECONDS + 1000))).toBe(0);
  });

  it('sweeps an envelope exactly at its expiry instant', () => {
    const vault = createVault();
    vault.commitEnvelope(
      envelopeRecord({
        envelopeId: 'cv_env_first0000000001',
        expiresAt: new Date(BASE_MILLISECONDS + 60 * 1000),
      }),
      null,
    );

    expect(vault.sweepExpired(new Date(BASE_MILLISECONDS + 60 * 1000 - 1)).envelopeCount).toBe(0);
    expect(vault.find('cv_env_first0000000001')).toBeDefined();
    const removal = vault.sweepExpired(new Date(BASE_MILLISECONDS + 60 * 1000));
    expect(removal.envelopeCount).toBe(1);
    expect(vault.find('cv_env_first0000000001')).toBeUndefined();
  });

  it('holds exactly the retained provenance cap without early eviction', () => {
    const vault = new InMemoryVault('cv_ses_abcdefghijklmnop', UNBOUNDED_LIMITS);
    const fillId = (index: number): string => `cv_env_fill${String(index).padStart(16, '0')}`;
    for (let index = 0; index < MAX_RETAINED_PROVENANCE_RECORDS; index += 1) {
      vault.commitEnvelope(envelopeRecord({ envelopeId: fillId(index) }), null);
      vault.appendProvenance(provenanceRecord({ envelopeId: fillId(index) }));
    }
    // At exactly the cap nothing is evicted yet.
    expect(vault.listProvenanceForEnvelope(fillId(0))).toHaveLength(1);
    expect(totalProvenance(vault)).toBe(MAX_RETAINED_PROVENANCE_RECORDS);
  });

  it('keeps exact provenance accounting across eviction and removal cycles', () => {
    const vault = new InMemoryVault('cv_ses_abcdefghijklmnop', UNBOUNDED_LIMITS);
    const fillId = (index: number): string => `cv_env_fill${String(index).padStart(16, '0')}`;
    // Nine appends on one envelope exercises the per-envelope ring: the
    // oldest record drops and the envelope keeps eight.
    vault.commitEnvelope(envelopeRecord({ envelopeId: fillId(0) }), null);
    for (let index = 0; index < MAX_PROVENANCE_RECORDS_PER_ENVELOPE + 1; index += 1) {
      vault.appendProvenance(
        provenanceRecord({
          envelopeId: fillId(0),
          excerptDigest: `sha256:${index.toString().padStart(64, '0')}`,
        }),
      );
    }
    expect(vault.listProvenanceForEnvelope(fillId(0))).toHaveLength(
      MAX_PROVENANCE_RECORDS_PER_ENVELOPE,
    );
    expect(totalProvenance(vault)).toBe(MAX_PROVENANCE_RECORDS_PER_ENVELOPE);

    // Fill distinct envelopes up to exactly the global cap.
    for (let index = 1; index <= MAX_RETAINED_PROVENANCE_RECORDS - 8; index += 1) {
      vault.commitEnvelope(envelopeRecord({ envelopeId: fillId(index) }), null);
      vault.appendProvenance(provenanceRecord({ envelopeId: fillId(index) }));
    }
    expect(totalProvenance(vault)).toBe(MAX_RETAINED_PROVENANCE_RECORDS);

    // The next append crosses the cap: exactly the oldest record drops.
    vault.commitEnvelope(envelopeRecord({ envelopeId: fillId(100) }), null);
    vault.appendProvenance(provenanceRecord({ envelopeId: fillId(100) }));
    expect(totalProvenance(vault)).toBe(MAX_RETAINED_PROVENANCE_RECORDS);
    expect(vault.listProvenanceForEnvelope(fillId(0))).toHaveLength(
      MAX_PROVENANCE_RECORDS_PER_ENVELOPE - 1,
    );

    // Removing the envelope drops its records from the total exactly.
    vault.removeEnvelopeWithDerived(fillId(0));
    expect(totalProvenance(vault)).toBe(
      MAX_RETAINED_PROVENANCE_RECORDS - MAX_PROVENANCE_RECORDS_PER_ENVELOPE + 1,
    );

    // Refill toward the cap, then overflow once more: the second eviction
    // must drop exactly the oldest remaining record and nothing else.
    // A lingering empty entry would absorb the eviction and over-retain.
    for (let index = 200; index < 200 + MAX_PROVENANCE_RECORDS_PER_ENVELOPE - 1; index += 1) {
      vault.commitEnvelope(envelopeRecord({ envelopeId: fillId(index) }), null);
      vault.appendProvenance(provenanceRecord({ envelopeId: fillId(index) }));
    }
    expect(totalProvenance(vault)).toBe(MAX_RETAINED_PROVENANCE_RECORDS);
    vault.commitEnvelope(envelopeRecord({ envelopeId: fillId(300) }), null);
    vault.appendProvenance(provenanceRecord({ envelopeId: fillId(300) }));
    expect(totalProvenance(vault)).toBe(MAX_RETAINED_PROVENANCE_RECORDS);
    expect(vault.listProvenanceForEnvelope(fillId(1))).toEqual([]);
    expect(vault.listProvenanceForEnvelope(fillId(300))).toHaveLength(1);

    // One more overflow must drop the next oldest record. An eviction
    // that left an empty entry behind would absorb this eviction instead
    // and over-retain.
    vault.commitEnvelope(envelopeRecord({ envelopeId: fillId(301) }), null);
    vault.appendProvenance(provenanceRecord({ envelopeId: fillId(301) }));
    expect(totalProvenance(vault)).toBe(MAX_RETAINED_PROVENANCE_RECORDS);
    expect(vault.listProvenanceForEnvelope(fillId(2))).toEqual([]);
  });
});

describe('InMemoryVault intents', () => {
  function intentRecord(overrides: Partial<PurgeIntentRecord> = {}): PurgeIntentRecord {
    return {
      intentId: `cv_pur_${Math.random().toString(36).slice(2, 12)}`,
      sessionId: 'cv_ses_abcdefghijklmnop',
      targetKind: 'envelope',
      envelopeId: 'cv_env_first0000000001',
      snapshotDigest: `sha256:${'c'.repeat(64)}`,
      envelopeCount: 1,
      derivedBytes: 256,
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      consumed: false,
      ...overrides,
    };
  }

  it('stores and retrieves pending intents', () => {
    const vault = createVault();
    const first = intentRecord({ intentId: 'cv_pur_first000000000001' });
    const second = intentRecord({ intentId: 'cv_pur_second0000000001' });
    vault.saveIntent(first);
    vault.saveIntent(second);
    expect(vault.findIntent('cv_pur_first000000000001')).toBe(first);
    expect(vault.findIntent('cv_pur_second0000000001')).toBe(second);
  });

  it('evicts the oldest intent beyond the pending cap so state stays bounded', () => {
    const vault = createVault();
    const oldest = intentRecord({ intentId: 'cv_pur_oldest00000000001' });
    vault.saveIntent(oldest);
    for (let index = 0; index < MAX_PENDING_PURGE_INTENTS; index += 1) {
      vault.saveIntent(intentRecord({ intentId: `cv_pur_${index.toString().padStart(16, '0')}` }));
    }
    expect(vault.findIntent('cv_pur_oldest00000000001')).toBeUndefined();
    expect(vault.findIntent('cv_pur_0000000000000000')).toBeDefined();
  });

  it('consumes an intent exactly once and reports the lifetime count', () => {
    const vault = createVault();
    const intent = intentRecord({ intentId: 'cv_pur_once000000000001' });
    vault.saveIntent(intent);

    const consumed = vault.consumeIntent('cv_pur_once000000000001');
    expect(consumed?.consumed).toBe(true);
    expect(vault.consumeIntent('cv_pur_once000000000001')).toBeUndefined();
    expect(vault.consumeIntent('cv_pur_unknown0000000001')).toBeUndefined();
    expect(vault.lifecycleCounters().purgeIntentsConsumed).toBe(1);
  });

  it('revokes only pending intents bound to the purged envelope target', () => {
    const vault: PreparationVault = createVault();
    const matching = intentRecord({ intentId: 'cv_pur_match00000000001' });
    const otherEnvelope = intentRecord({
      intentId: 'cv_pur_other00000000001',
      envelopeId: 'cv_env_second00000001',
    });
    const consumed = intentRecord({ intentId: 'cv_pur_used000000000001', consumed: true });
    vault.saveIntent(matching);
    vault.saveIntent(otherEnvelope);
    vault.saveIntent(consumed);

    const revoked = vault.revokeIntents('envelope', 'cv_env_first0000000001');
    expect(revoked).toBe(1);
    expect(vault.findIntent('cv_pur_match00000000001')).toBeUndefined();
    expect(vault.findIntent('cv_pur_other00000000001')).toBeDefined();
    expect(vault.findIntent('cv_pur_used000000000001')).toBeDefined();
  });

  it('keeps a whole-state intent that shares the envelope id during an envelope revoke', () => {
    const vault: PreparationVault = createVault();
    const matching = intentRecord({ intentId: 'cv_pur_match00000000001' });
    const wholeState = intentRecord({
      intentId: 'cv_pur_whole00000000001',
      targetKind: 'all_derived_state',
      envelopeId: 'cv_env_first0000000001',
    });
    vault.saveIntent(matching);
    vault.saveIntent(wholeState);

    const revoked = vault.revokeIntents('envelope', 'cv_env_first0000000001');
    expect(revoked).toBe(1);
    expect(vault.findIntent('cv_pur_match00000000001')).toBeUndefined();
    expect(vault.findIntent('cv_pur_whole00000000001')).toBeDefined();
  });

  it('revokes all pending intents when the whole derived state is purged', () => {
    const vault = createVault();
    vault.saveIntent(intentRecord({ intentId: 'cv_pur_first000000000001' }));
    vault.saveIntent(intentRecord({ intentId: 'cv_pur_second0000000001' }));

    expect(vault.revokeIntents('all_derived_state', null)).toBe(2);
    expect(vault.findIntent('cv_pur_first000000000001')).toBeUndefined();
    expect(vault.findIntent('cv_pur_second0000000001')).toBeUndefined();
  });
});

describe('InMemoryVault configuration', () => {
  it('rejects an invalid session identifier at construction time', () => {
    expect(() => new InMemoryVault('not-a-session-id', limits)).toThrow(ContextVaultError);
  });

  it.each([
    ['a trailing invalid character', 'cv_ses_abcdefghijklmnop!'],
    ['an over-length identity', `cv_ses_${'a'.repeat(200)}`],
    ['a short but well-formed identity', 'cv_ses_abc'],
    ['a missing prefix', 'abcdefghijklmnop'],
    ['a missing prefix with a valid identity suffix', `zzzzzzz${'a'.repeat(20)}`],
    ['an empty identifier', ''],
    ['a character before the uppercase range', `cv_ses_${'@'.repeat(16)}`],
    ['a character after the uppercase range', `cv_ses_${'['.repeat(16)}`],
    ['a character before the lowercase range', `cv_ses_${'`'.repeat(16)}`],
    ['a character after the lowercase range', `cv_ses_${'{'.repeat(16)}`],
    ['a character before the digit range', `cv_ses_${'/'.repeat(16)}`],
    ['a character after the digit range', `cv_ses_${':'.repeat(16)}`],
  ])('rejects %s', (_name, candidate) => {
    expect(() => new InMemoryVault(candidate, limits)).toThrow(ContextVaultError);
  });

  it('accepts session identifiers exactly at the supported identity bounds', () => {
    expect(() => new InMemoryVault(`cv_ses_${'a'.repeat(16)}`, limits)).not.toThrow();
    expect(() => new InMemoryVault(`cv_ses_${'a'.repeat(128)}`, limits)).not.toThrow();
  });
});

function totalProvenance(vault: InMemoryVault): number {
  let retained = 0;
  for (const envelope of vault.list()) {
    retained += vault.listProvenanceForEnvelope(envelope.envelopeId).length;
  }
  return retained;
}

function provenanceRecord(
  overrides: Partial<RetrievalProvenanceRecord> = {},
): RetrievalProvenanceRecord {
  return {
    envelopeId: 'cv_env_first0000000001',
    sourceId: 'cv_src_abcdefghijklmnop',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    selectorKind: 'chunk',
    excerptDigest: `sha256:${'d'.repeat(64)}`,
    byteCount: 32,
    truncated: false,
    recordedAt: new Date(BASE_MILLISECONDS).toISOString(),
    ...overrides,
  };
}

function expectVaultError(execute: () => unknown, code: string): void {
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

import type {
  DerivedStateRemoval,
  PreparedGrantCommit,
  PreparationVault,
  VaultLifecycleCounters,
  VaultSnapshot,
} from '../../application/ports/preparation-services.js';
import type {
  RetrievalGrantRecord,
  RetrievalProvenanceRecord,
} from '../../domain/retrieval/retrieval-types.js';
import type { RetrievalVault } from '../../application/ports/retrieval-services.js';
import { ContextVaultError } from '../../domain/errors/context-vault-error.js';
import {
  MAX_PENDING_PURGE_INTENTS,
  type PreparationLimits,
} from '../../domain/preparation/preparation-limits.js';
import type { PreparedEnvelopeRecord } from '../../domain/preparation/preparation-types.js';
import type { PurgeIntentRecord } from '../../domain/preparation/purge-intent-policy.js';

const SESSION_ID_PREFIX = 'cv_ses_';
const SESSION_IDENTITY_MINIMUM = 16;
const SESSION_IDENTITY_LIMIT = 128;

/**
 * Maximum provenance records retained per process.
 */
export const MAX_RETAINED_PROVENANCE_RECORDS = 32;

/**
 * Maximum provenance records retained per envelope.
 */
export const MAX_PROVENANCE_RECORDS_PER_ENVELOPE = 8;

/** Validates a derived-state session identity without a compound regex. */
export function isWellFormedSessionId(candidate: string): boolean {
  if (!candidate.startsWith(SESSION_ID_PREFIX)) {
    return false;
  }
  const identity = candidate.slice(SESSION_ID_PREFIX.length);
  if (identity.length < SESSION_IDENTITY_MINIMUM || identity.length > SESSION_IDENTITY_LIMIT) {
    return false;
  }
  for (const character of identity) {
    const allowed =
      (character >= 'A' && character <= 'Z') ||
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9') ||
      character === '_' ||
      character === '-';
    if (!allowed) {
      return false;
    }
  }
  return true;
}

/**
 * Memory-only implementation of the derived-state vault.
 *
 * Envelopes, retrieval grants, provenance records, and purge intents
 * live exclusively in process memory. Every mutation validates the
 * configured resource limits before committing so that no partial state
 * can remain after a failure, envelopes always remove their grants and
 * provenance with them, and no filesystem is ever touched from here.
 */
export class InMemoryVault implements PreparationVault, RetrievalVault {
  readonly #sessionId: string;
  readonly #limits: PreparationLimits;
  readonly #envelopes = new Map<string, PreparedEnvelopeRecord>();
  readonly #grants = new Map<string, RetrievalGrantRecord>();
  readonly #provenance = new Map<string, RetrievalProvenanceRecord[]>();
  readonly #intents = new Map<string, PurgeIntentRecord>();
  #totalDerivedBytes = 0;
  #version = 0;
  #envelopesRemovedByExpiry = 0;
  #envelopesRemovedByPurge = 0;
  #grantsRevoked = 0;
  #purgeIntentsConsumed = 0;
  #provenanceCount = 0;

  constructor(sessionId: string, limits: PreparationLimits) {
    if (!isWellFormedSessionId(sessionId)) {
      throw new ContextVaultError({
        code: 'CV_CONFIGURATION_INVALID',
        message: 'The derived-state session identity is invalid.',
      });
    }
    this.#sessionId = sessionId;
    this.#limits = limits;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get totalDerivedBytes(): number {
    return this.#totalDerivedBytes;
  }

  commitEnvelope(record: PreparedEnvelopeRecord, grant: PreparedGrantCommit | null): void {
    if (this.#envelopes.has(record.envelopeId)) {
      throw internalIdCollisionError();
    }
    if (this.#envelopes.size >= this.#limits.maxActiveEnvelopes) {
      throw envelopeLimitError();
    }
    if (record.derivedBytes > this.#limits.maxSerializedMetadataBytes) {
      throw envelopeTooLargeError();
    }
    if (this.#totalDerivedBytes + record.derivedBytes > this.#limits.maxTotalDerivedStateBytes) {
      throw derivedStateLimitError();
    }

    // Grants are bounded structurally: at most one grant is committed per
    // envelope, commit is atomic, and the active-envelope limit caps the
    // store, so grants can never exceed the envelope bound.
    this.#envelopes.set(record.envelopeId, record);
    this.#totalDerivedBytes += record.derivedBytes;
    this.#version += 1;
    if (grant !== null) {
      this.#grants.set(grant.tokenDigest, {
        tokenDigest: grant.tokenDigest,
        sessionId: record.sessionId,
        envelopeId: record.envelopeId,
        sourceId: record.sourceId,
        sourceDigest: record.sourceDigest,
        allowedSelectorTypes: grant.allowedSelectorTypes,
        maxBytes: grant.maxBytes,
        expiresAt: grant.expiresAt,
        revoked: false,
      });
    }
  }

  find(envelopeId: string): PreparedEnvelopeRecord | undefined {
    return this.#envelopes.get(envelopeId);
  }

  list(): readonly PreparedEnvelopeRecord[] {
    return [...this.#envelopes.values()];
  }

  snapshot(): VaultSnapshot {
    return Object.freeze({
      envelopeCount: this.#envelopes.size,
      totalDerivedBytes: this.#totalDerivedBytes,
      version: this.#version,
    });
  }

  removeEnvelopeWithDerived(envelopeId: string): DerivedStateRemoval {
    const record = this.#envelopes.get(envelopeId);
    if (!record) {
      return Object.freeze(emptyRemoval());
    }
    return Object.freeze(this.#removeRecordWithDerived(record, 'purge'));
  }

  removeAllDerivedState(): DerivedStateRemoval {
    const records = [...this.#envelopes.values()];
    let derivedBytes = 0;
    let grantsRevoked = 0;
    let provenanceRecordsRemoved = 0;
    for (const record of records) {
      const removal = this.#removeRecordWithDerived(record, 'purge');
      derivedBytes += removal.derivedBytes;
      grantsRevoked += removal.grantsRevoked;
      provenanceRecordsRemoved += removal.provenanceRecordsRemoved;
    }
    return Object.freeze({
      envelopeCount: records.length,
      derivedBytes,
      grantsRevoked,
      provenanceRecordsRemoved,
    });
  }

  sweepExpired(now: Date): DerivedStateRemoval {
    const expired = [...this.#envelopes.values()].filter(
      (record) => record.expiresAt.getTime() <= now.getTime(),
    );
    let derivedBytes = 0;
    let grantsRevoked = 0;
    let provenanceRecordsRemoved = 0;
    for (const record of expired) {
      const removal = this.#removeRecordWithDerived(record, 'expiry');
      derivedBytes += removal.derivedBytes;
      grantsRevoked += removal.grantsRevoked;
      provenanceRecordsRemoved += removal.provenanceRecordsRemoved;
    }
    return Object.freeze({
      envelopeCount: expired.length,
      derivedBytes,
      grantsRevoked,
      provenanceRecordsRemoved,
    });
  }

  findIntent(intentId: string): PurgeIntentRecord | undefined {
    return this.#intents.get(intentId);
  }

  saveIntent(intent: PurgeIntentRecord): void {
    if (this.#intents.size >= MAX_PENDING_PURGE_INTENTS) {
      for (const [oldestIntentId] of this.#intents) {
        this.#intents.delete(oldestIntentId);
        break;
      }
    }
    this.#intents.set(intent.intentId, intent);
  }

  consumeIntent(intentId: string): PurgeIntentRecord | undefined {
    const intent = this.#intents.get(intentId);
    if (!intent || intent.consumed) {
      return undefined;
    }
    intent.consumed = true;
    this.#purgeIntentsConsumed += 1;
    return intent;
  }

  revokeIntents(targetKind: 'envelope' | 'all_derived_state', envelopeId: string | null): number {
    let revoked = 0;
    for (const [intentId, intent] of [...this.#intents.entries()]) {
      if (intent.consumed) {
        continue;
      }
      const matchesTarget =
        targetKind === 'all_derived_state' ||
        (intent.targetKind === 'envelope' && intent.envelopeId === envelopeId);
      if (matchesTarget) {
        this.#intents.delete(intentId);
        revoked += 1;
      }
    }
    return revoked;
  }

  lifecycleCounters(): VaultLifecycleCounters {
    return Object.freeze({
      envelopesRemovedByExpiry: this.#envelopesRemovedByExpiry,
      envelopesRemovedByPurge: this.#envelopesRemovedByPurge,
      grantsRevoked: this.#grantsRevoked,
      purgeIntentsConsumed: this.#purgeIntentsConsumed,
    });
  }

  findGrantByTokenDigest(tokenDigest: string): RetrievalGrantRecord | undefined {
    return this.#grants.get(tokenDigest);
  }

  countActiveGrants(now: Date): number {
    let active = 0;
    for (const grant of this.#grants.values()) {
      if (!grant.revoked && grant.expiresAt.getTime() > now.getTime()) {
        active += 1;
      }
    }
    return active;
  }

  appendProvenance(record: RetrievalProvenanceRecord): void {
    if (this.#provenanceCount >= MAX_RETAINED_PROVENANCE_RECORDS) {
      this.#evictOldestProvenance();
    }
    const envelopeRecords = this.#provenance.get(record.envelopeId);
    if (envelopeRecords === undefined) {
      this.#provenance.set(record.envelopeId, [record]);
      this.#provenanceCount += 1;
      return;
    }
    if (envelopeRecords.length >= MAX_PROVENANCE_RECORDS_PER_ENVELOPE) {
      envelopeRecords.shift();
      this.#provenanceCount -= 1;
    }
    envelopeRecords.push(record);
    this.#provenanceCount += 1;
  }

  listProvenanceForEnvelope(envelopeId: string): readonly RetrievalProvenanceRecord[] {
    return this.#provenance.get(envelopeId) ?? [];
  }

  #removeRecordWithDerived(
    record: PreparedEnvelopeRecord,
    reason: 'purge' | 'expiry',
  ): DerivedStateRemoval {
    this.#envelopes.delete(record.envelopeId);
    this.#totalDerivedBytes -= record.derivedBytes;
    this.#version += 1;
    if (reason === 'purge') {
      this.#envelopesRemovedByPurge += 1;
    } else {
      this.#envelopesRemovedByExpiry += 1;
    }
    const grantsRevoked = this.#removeGrantsForEnvelope(record.envelopeId);
    const provenanceRemoved = this.#removeProvenanceForEnvelope(record.envelopeId);
    return {
      envelopeCount: 1,
      derivedBytes: record.derivedBytes,
      grantsRevoked,
      provenanceRecordsRemoved: provenanceRemoved,
    };
  }

  #removeGrantsForEnvelope(envelopeId: string): number {
    let revoked = 0;
    for (const [tokenDigest, grant] of [...this.#grants.entries()]) {
      if (grant.envelopeId === envelopeId) {
        this.#grants.delete(tokenDigest);
        this.#grantsRevoked += 1;
        revoked += 1;
      }
    }
    return revoked;
  }

  #removeProvenanceForEnvelope(envelopeId: string): number {
    const records = this.#provenance.get(envelopeId);
    if (records === undefined) {
      return 0;
    }
    this.#provenanceCount -= records.length;
    this.#provenance.delete(envelopeId);
    return records.length;
  }

  #evictOldestProvenance(): void {
    // Public methods never leave an empty per-envelope list behind, so
    // the first entry always holds the oldest retained record.
    for (const [envelopeId, records] of this.#provenance) {
      records.shift();
      this.#provenanceCount -= 1;
      if (records.length === 0) {
        this.#provenance.delete(envelopeId);
      }
      return;
    }
  }
}

function emptyRemoval(): DerivedStateRemoval {
  return {
    envelopeCount: 0,
    derivedBytes: 0,
    grantsRevoked: 0,
    provenanceRecordsRemoved: 0,
  };
}

function internalIdCollisionError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_INTERNAL_ERROR',
    message: 'The derived envelope identifier could not be allocated safely.',
  });
}

function envelopeLimitError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_RESOURCE_ENVELOPE_LIMIT',
    message: 'The maximum number of active derived envelopes was reached.',
  });
}

function envelopeTooLargeError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_RESOURCE_ENVELOPE_TOO_LARGE',
    message: 'The derived metadata exceeds the supported serialized size.',
  });
}

function derivedStateLimitError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_RESOURCE_DERIVED_STATE_LIMIT',
    message: 'The maximum total derived-state size was reached.',
  });
}

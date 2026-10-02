import type { PreparedEnvelopeRecord } from '../../domain/preparation/preparation-types.js';
import type { RetrievalSelectorKind } from '../../domain/retrieval/retrieval-types.js';
import type { PurgeIntentRecord } from '../../domain/preparation/purge-intent-policy.js';

/**
 * Generates opaque, non-content-derived identifiers for sessions,
 * envelopes, and purge intents. Implementations live in infrastructure.
 */
export interface OpaqueIdentifierFactory {
  createSessionId(): string;
  createEnvelopeId(): string;
  createPurgeIntentId(): string;
}

/** Point-in-time counters describing all derived state in the session. */
export interface VaultSnapshot {
  readonly envelopeCount: number;
  readonly totalDerivedBytes: number;
  readonly version: number;
}

/**
 * The grant bound atomically to a committed envelope.
 *
 * The vault composes the full server-side grant record from this input
 * plus the committed envelope identity, so a grant can never exist bound
 * to an envelope that was not committed in the same operation.
 */
export interface PreparedGrantCommit {
  readonly tokenDigest: string;
  readonly allowedSelectorTypes: readonly RetrievalSelectorKind[];
  readonly maxBytes: number;
  readonly expiresAt: Date;
}

/** Exact counts describing one derived-state removal. */
export interface DerivedStateRemoval {
  readonly envelopeCount: number;
  readonly derivedBytes: number;
  readonly grantsRevoked: number;
  readonly provenanceRecordsRemoved: number;
}

/** Lifetime bookkeeping counters maintained by the store itself. */
export interface VaultLifecycleCounters {
  readonly envelopesRemovedByExpiry: number;
  readonly envelopesRemovedByPurge: number;
  readonly grantsRevoked: number;
  readonly purgeIntentsConsumed: number;
}

/**
 * Memory-only store for ContextVault-owned derived state.
 *
 * Implementations must enforce the configured resource limits atomically
 * before committing a record, must never persist to disk, must never
 * touch the filesystem from the purge path, and must remove grants and
 * provenance together with the envelope they were derived from.
 */
export interface PreparationVault {
  readonly sessionId: string;
  /** Commits an envelope and, when given, its retrieval grant atomically. */
  commitEnvelope(record: PreparedEnvelopeRecord, grant: PreparedGrantCommit | null): void;
  find(envelopeId: string): PreparedEnvelopeRecord | undefined;
  list(): readonly PreparedEnvelopeRecord[];
  snapshot(): VaultSnapshot;
  /** Removes one envelope together with its grants and provenance. */
  removeEnvelopeWithDerived(envelopeId: string): DerivedStateRemoval;
  /** Removes every envelope together with all grants and provenance. */
  removeAllDerivedState(): DerivedStateRemoval;
  /** Removes expired envelopes together with their grants and provenance. */
  sweepExpired(now: Date): DerivedStateRemoval;
  findIntent(intentId: string): PurgeIntentRecord | undefined;
  saveIntent(intent: PurgeIntentRecord): void;
  consumeIntent(intentId: string): PurgeIntentRecord | undefined;
  revokeIntents(targetKind: 'envelope' | 'all_derived_state', envelopeId: string | null): number;
  lifecycleCounters(): VaultLifecycleCounters;
}

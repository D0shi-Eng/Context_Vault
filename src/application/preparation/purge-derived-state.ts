import type { InspectionClock, InspectionCryptography } from '../ports/inspection-services.js';
import type { OpaqueIdentifierFactory, PreparationVault } from '../ports/preparation-services.js';
import { ContextVaultError } from '../../domain/errors/context-vault-error.js';
import {
  buildSnapshotSeed,
  isIntentExpired,
  isIntentSnapshotCurrent,
  validatePurgeRequest,
} from '../../domain/preparation/purge-intent-policy.js';
import { DEFAULT_TTL_SECONDS } from '../../domain/preparation/preparation-limits.js';

export interface PurgePreviewSuccess {
  readonly schemaVersion: '1.0';
  readonly ok: true;
  readonly purgeIntentId: string;
  readonly target:
    | { readonly kind: 'envelope'; readonly envelopeId: string }
    | { readonly kind: 'all_derived_state' };
  readonly summary: {
    readonly envelopeCount: number;
    readonly derivedBytes: number;
  };
  readonly expiresAt: string;
}

export interface PurgeExecuteSuccess {
  readonly schemaVersion: '1.0';
  readonly ok: true;
  readonly targetKind: 'envelope' | 'all_derived_state';
  readonly deletedEnvelopes: number;
  readonly deletedDerivedBytes: number;
  readonly revokedIntents: number;
  readonly revokedGrants: number;
  readonly removedProvenanceRecords: number;
}

export interface PurgeDerivedStateDependencies {
  readonly clock: InspectionClock;
  readonly cryptography: InspectionCryptography;
  readonly identifiers: OpaqueIdentifierFactory;
  readonly vault: PreparationVault;
}

/**
 * Prepares and consumes target-bound purge intents over derived state.
 *
 * The use case never receives or constructs a source path, never calls a
 * filesystem API, and removes only ContextVault-owned in-memory records.
 * Envelope purges remove that envelope's retrieval grants and provenance
 * records together with it; whole-state purges remove all of them.
 */
export class PurgeDerivedState {
  readonly #clock: InspectionClock;
  readonly #cryptography: InspectionCryptography;
  readonly #identifiers: OpaqueIdentifierFactory;
  readonly #vault: PreparationVault;

  constructor(dependencies: PurgeDerivedStateDependencies) {
    this.#clock = dependencies.clock;
    this.#cryptography = dependencies.cryptography;
    this.#identifiers = dependencies.identifiers;
    this.#vault = dependencies.vault;
  }

  preview(request: unknown): PurgePreviewSuccess {
    const validated = validatePurgeRequest(request);
    if (validated.operation !== 'preview') {
      throw invalidPurgeInput();
    }
    const preview = validated;
    const now = this.#clock.now();
    this.#sweepExpiredEnvelopes(now);

    const envelopeId = preview.target.kind === 'envelope' ? preview.target.envelopeId : null;
    const snapshot = this.#currentTargetSnapshot(preview.target.kind, envelopeId);
    if (!snapshot) {
      throw envelopeNotFound();
    }

    const intentId = this.#identifiers.createPurgeIntentId();
    const expiresAt = new Date(now.getTime() + DEFAULT_TTL_SECONDS * 1000);
    this.#vault.saveIntent({
      intentId,
      sessionId: this.#vault.sessionId,
      targetKind: preview.target.kind,
      envelopeId,
      snapshotDigest: snapshot.snapshotDigest,
      envelopeCount: snapshot.envelopeCount,
      derivedBytes: snapshot.derivedBytes,
      expiresAt,
      consumed: false,
    });

    return Object.freeze({
      schemaVersion: '1.0' as const,
      ok: true as const,
      purgeIntentId: intentId,
      target: Object.freeze({ ...preview.target }),
      summary: Object.freeze({
        envelopeCount: snapshot.envelopeCount,
        derivedBytes: snapshot.derivedBytes,
      }),
      expiresAt: expiresAt.toISOString(),
    });
  }

  execute(request: unknown): PurgeExecuteSuccess {
    const validated = validatePurgeRequest(request);
    if (validated.operation !== 'execute') {
      throw invalidPurgeInput();
    }
    const command = validated;

    const intent = this.#vault.findIntent(command.purgeIntentId);
    if (!intent || intent.consumed || intent.sessionId !== this.#vault.sessionId) {
      throw invalidPurgeIntent();
    }
    const now = this.#clock.now();
    if (isIntentExpired(intent, now)) {
      throw expiredPurgeIntent();
    }
    this.#sweepExpiredEnvelopes(now);

    const snapshot = this.#currentTargetSnapshot(intent.targetKind, intent.envelopeId);
    if (!snapshot || !isIntentSnapshotCurrent(intent, snapshot)) {
      throw stalePurgeIntent();
    }

    const consumed = this.#vault.consumeIntent(command.purgeIntentId);
    if (!consumed) {
      throw invalidPurgeIntent();
    }

    // Envelope intents bind to their own envelope only; whole-state intents
    // bind to the global snapshot. The envelope identifier is null exactly
    // when the intent targets all derived state. Both paths remove grants
    // and provenance in the same synchronous step, so a concurrent
    // preparation or retrieval cannot restore revoked state: JavaScript
    // runs this removal atomically with the checks above.
    const envelopeTargetId = intent.targetKind === 'envelope' ? intent.envelopeId : null;
    const deleted =
      envelopeTargetId === null
        ? this.#vault.removeAllDerivedState()
        : this.#vault.removeEnvelopeWithDerived(envelopeTargetId);
    const revokedIntents =
      envelopeTargetId === null
        ? this.#vault.revokeIntents('all_derived_state', null)
        : this.#vault.revokeIntents('envelope', envelopeTargetId);

    return Object.freeze({
      schemaVersion: '1.0' as const,
      ok: true as const,
      targetKind: intent.targetKind,
      deletedEnvelopes: deleted.envelopeCount,
      deletedDerivedBytes: deleted.derivedBytes,
      revokedIntents,
      revokedGrants: deleted.grantsRevoked,
      removedProvenanceRecords: deleted.provenanceRecordsRemoved,
    });
  }

  #sweepExpiredEnvelopes(now: Date): void {
    this.#vault.sweepExpired(now);
  }

  /**
   * Computes the current target-scoped snapshot digest.
   * Envelope-specific snapshots bind only to their own envelope identity
   * and bytes, so unrelated envelope changes never invalidate them.
   * Whole-state snapshots additionally bind to the store version.
   */
  #currentTargetSnapshot(
    targetKind: 'envelope' | 'all_derived_state',
    envelopeId: string | null,
  ): TargetSnapshot | undefined {
    if (targetKind === 'envelope') {
      if (envelopeId === null) {
        return undefined;
      }
      const record = this.#vault.find(envelopeId);
      if (!record) {
        return undefined;
      }
      return {
        envelopeCount: 1,
        derivedBytes: record.derivedBytes,
        snapshotDigest: this.#digestSeed(
          buildSnapshotSeed({
            sessionId: this.#vault.sessionId,
            targetKind: 'envelope',
            envelopeId,
            targetFingerprint: record.structuralFingerprint,
            envelopeCount: 1,
            derivedBytes: record.derivedBytes,
          }),
        ),
      };
    }

    const snapshot = this.#vault.snapshot();
    return {
      envelopeCount: snapshot.envelopeCount,
      derivedBytes: snapshot.totalDerivedBytes,
      snapshotDigest: this.#digestSeed(
        buildSnapshotSeed({
          sessionId: this.#vault.sessionId,
          targetKind: 'all_derived_state',
          envelopeId: null,
          targetFingerprint: null,
          envelopeCount: snapshot.envelopeCount,
          derivedBytes: snapshot.totalDerivedBytes,
          version: snapshot.version,
        }),
      ),
    };
  }

  #digestSeed(seed: string): string {
    return this.#cryptography.sha256(new TextEncoder().encode(seed));
  }
}

interface TargetSnapshot {
  readonly envelopeCount: number;
  readonly derivedBytes: number;
  readonly snapshotDigest: string;
}

function envelopeNotFound(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_ENVELOPE_NOT_FOUND',
    message: 'The requested derived envelope does not exist.',
  });
}

function invalidPurgeIntent(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_PURGE_INTENT_INVALID',
    message: 'The purge intent is invalid or was already consumed.',
  });
}

function expiredPurgeIntent(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_PURGE_INTENT_EXPIRED',
    message: 'The purge intent has expired.',
  });
}

function stalePurgeIntent(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_PURGE_INTENT_STALE',
    message: 'The purge intent no longer matches the target state.',
  });
}

function invalidPurgeInput(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_INPUT_INVALID',
    message: 'The purge request is invalid.',
  });
}

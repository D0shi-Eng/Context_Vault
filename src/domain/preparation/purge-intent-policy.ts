/**
 * Pure state-transition rules for target-bound purge intents.
 *
 * Intents bind to the private server-side session, the exact target
 * snapshot (counts and derived bytes), and a one-time-use flag. Domain
 * rules receive time as an explicit parameter so they remain pure; the
 * application use case supplies the clock and the hashing port.
 */

import { ContextVaultError } from '../errors/context-vault-error.js';

export type PurgeTargetKind = 'envelope' | 'all_derived_state';

export interface PurgePreviewTargetEnvelope {
  readonly kind: 'envelope';
  readonly envelopeId: string;
}

export interface PurgePreviewTargetAllDerivedState {
  readonly kind: 'all_derived_state';
}

export type PurgePreviewTarget = PurgePreviewTargetEnvelope | PurgePreviewTargetAllDerivedState;

export interface PurgePreviewInput {
  readonly operation: 'preview';
  readonly target: PurgePreviewTarget;
}

export interface PurgeExecuteInput {
  readonly operation: 'execute';
  readonly purgeIntentId: string;
}

export type PurgeRequest = PurgeExecuteInput | PurgePreviewInput;

export interface PurgeIntentRecord {
  readonly intentId: string;
  readonly sessionId: string;
  readonly targetKind: PurgeTargetKind;
  readonly envelopeId: string | null;
  readonly snapshotDigest: string;
  readonly envelopeCount: number;
  readonly derivedBytes: number;
  readonly expiresAt: Date;
  consumed: boolean;
}

/**
 * Current target-scoped snapshot observed by the application layer.
 * Envelope-specific snapshots bind only to their own envelope so
 * unrelated envelope changes never invalidate them, while whole-state
 * snapshots bind to the exact global counts and bytes.
 */
export interface PurgeTargetSnapshot {
  readonly envelopeCount: number;
  readonly derivedBytes: number;
  readonly snapshotDigest: string;
}

const INTENT_ID_PREFIX = 'cv_pur_';
const ENVELOPE_ID_PREFIX = 'cv_env_';
const IDENTIFIER_IDENTITY_MINIMUM = 16;
const IDENTIFIER_IDENTITY_LIMIT = 128;

/** Validates an opaque purge-intent identifier without a compound regex. */
export function isWellFormedPurgeIntentId(candidate: string): boolean {
  if (!candidate.startsWith(INTENT_ID_PREFIX)) {
    return false;
  }
  const identity = candidate.slice(INTENT_ID_PREFIX.length);
  if (
    identity.length < IDENTIFIER_IDENTITY_MINIMUM ||
    identity.length > IDENTIFIER_IDENTITY_LIMIT
  ) {
    return false;
  }
  return hasIdentifierIdentityCharacters(identity);
}

/** Validates an opaque envelope identifier without a compound regex. */
export function isWellFormedEnvelopeId(candidate: string): boolean {
  if (!candidate.startsWith(ENVELOPE_ID_PREFIX)) {
    return false;
  }
  const identity = candidate.slice(ENVELOPE_ID_PREFIX.length);
  if (
    identity.length < IDENTIFIER_IDENTITY_MINIMUM ||
    identity.length > IDENTIFIER_IDENTITY_LIMIT
  ) {
    return false;
  }
  return hasIdentifierIdentityCharacters(identity);
}

function hasIdentifierIdentityCharacters(identity: string): boolean {
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
 * Independently validates an untrusted purge request.
 * This boundary deliberately mirrors neither the MCP schema nor any
 * transport shape, so requests bypassing the adapter stay fail-closed.
 * Unknown fields are rejected so a source path can never ride along.
 */
export function validatePurgeRequest(request: unknown): PurgeRequest {
  if (typeof request !== 'object' || request === null) {
    throw invalidPurgeInput();
  }
  const candidate = request as Record<string, unknown>;

  if (candidate.operation === 'execute') {
    if (!hasOnlyKeys(candidate, ['operation', 'purgeIntentId'])) {
      throw invalidPurgeInput();
    }
    if (
      typeof candidate.purgeIntentId !== 'string' ||
      !isWellFormedPurgeIntentId(candidate.purgeIntentId)
    ) {
      throw invalidPurgeInput();
    }
    return Object.freeze({
      operation: 'execute',
      purgeIntentId: candidate.purgeIntentId,
    });
  }

  if (candidate.operation === 'preview') {
    if (!hasOnlyKeys(candidate, ['operation', 'target'])) {
      throw invalidPurgeInput();
    }
    const target = candidate.target;
    if (typeof target !== 'object' || target === null) {
      throw invalidPurgeInput();
    }
    const targetRecord = target as Record<string, unknown>;
    const kind = targetRecord.kind;
    if (kind === 'envelope') {
      if (!hasOnlyKeys(targetRecord, ['kind', 'envelopeId'])) {
        throw invalidPurgeInput();
      }
      const envelopeId = targetRecord.envelopeId;
      if (typeof envelopeId !== 'string' || !isWellFormedEnvelopeId(envelopeId)) {
        throw invalidPurgeInput();
      }
      return Object.freeze({
        operation: 'preview',
        target: Object.freeze({ kind: 'envelope', envelopeId }),
      });
    }
    if (kind === 'all_derived_state') {
      if (!hasOnlyKeys(targetRecord, ['kind'])) {
        throw invalidPurgeInput();
      }
      return Object.freeze({
        operation: 'preview',
        target: Object.freeze({ kind: 'all_derived_state' }),
      });
    }
    throw invalidPurgeInput();
  }

  throw invalidPurgeInput();
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** A pending intent is expired once the current time reaches its expiry. */
export function isIntentExpired(intent: PurgeIntentRecord, now: Date): boolean {
  return intent.expiresAt.getTime() <= now.getTime();
}

/** Determines whether an intent still matches the target it was bound to. */
export function isIntentSnapshotCurrent(
  intent: PurgeIntentRecord,
  snapshot: PurgeTargetSnapshot,
): boolean {
  return (
    intent.envelopeCount === snapshot.envelopeCount &&
    intent.derivedBytes === snapshot.derivedBytes &&
    intent.snapshotDigest === snapshot.snapshotDigest
  );
}

/** Builds the deterministic seed that the application layer hashes. */
export function buildSnapshotSeed(input: {
  readonly sessionId: string;
  readonly targetKind: PurgeTargetKind;
  readonly envelopeId: string | null;
  readonly targetFingerprint: string | null;
  readonly envelopeCount: number;
  readonly derivedBytes: number;
  /** Whole-state snapshots bind to the store version; envelope snapshots must not. */
  readonly version?: number;
}): string {
  return [
    input.sessionId,
    input.targetKind,
    input.envelopeId ?? '-',
    input.targetFingerprint ?? '-',
    String(input.envelopeCount),
    String(input.derivedBytes),
    String(input.version ?? '-'),
  ].join('|');
}

function invalidPurgeInput(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_INPUT_INVALID',
    message: 'The purge request is invalid.',
  });
}

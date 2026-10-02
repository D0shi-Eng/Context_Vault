/**
 * Pure types and rules for deterministic integrity verification.
 *
 * Verification is integrity-only and deterministic. It never accepts a
 * natural-language claim as a truth-verification task, never judges
 * semantics, and never returns source content. An integrity chain inside
 * one process proves internal consistency only - never independent
 * authenticity or truth.
 *
 * Machine-checkable states:
 * - `valid`: the checked invariant holds right now.
 * - `stale`: the referenced source no longer matches its prepared digest.
 * - `invalid`: the referenced record exists but fails its own integrity
 *   check.
 * - `unavailable`: the referenced record no longer exists in this session.
 */

import { ContextVaultError } from '../errors/context-vault-error.js';

export type VerificationCheckKind =
  'source_freshness' | 'chunk_integrity' | 'provenance_consistency';

export type VerificationStatus = 'valid' | 'stale' | 'invalid' | 'unavailable';

export type VerificationReasonCode =
  | 'digest_matches_prepared_state'
  | 'source_digest_mismatch'
  | 'chunk_digest_mismatch'
  | 'chunk_descriptor_unknown'
  | 'provenance_chain_consistent'
  | 'provenance_chain_empty'
  | 'provenance_record_foreign'
  | 'envelope_absent'
  | 'source_unreadable';

export type VerificationCheckRequest =
  | { readonly kind: 'source_freshness' }
  | { readonly kind: 'chunk_integrity'; readonly chunkId: string }
  | { readonly kind: 'provenance_consistency' };

export interface VerificationCheckResult {
  readonly kind: VerificationCheckKind;
  readonly chunkId: string | undefined;
  readonly status: VerificationStatus;
  readonly reasonCode: VerificationReasonCode;
}

export interface VerifyRequestInput {
  readonly envelopeId: string;
  readonly checks: readonly VerificationCheckRequest[];
}

export interface VerifySuccess {
  readonly schemaVersion: '1.0';
  readonly ok: true;
  readonly envelopeId: string;
  readonly results: readonly VerificationCheckResult[];
  readonly verifiedAt: string;
}

/** Maximum checks accepted in one verification request. */
export const MAX_VERIFICATION_CHECKS = 16;

/**
 * Validates an untrusted verification request. Each check must name a
 * supported kind; `chunk_integrity` must also carry a well-formed chunk
 * identifier shape (prefix and charset only; existence is checked later).
 */
export function validateVerifyRequest(candidate: unknown): VerifyRequestInput {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw verifyRequestInvalid();
  }
  const record = candidate as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === 'envelopeId' || key === 'checks')) {
    throw verifyRequestInvalid();
  }
  if (typeof record.envelopeId !== 'string' || !isWellFormedEnvelopeIdShape(record.envelopeId)) {
    throw verifyRequestInvalid();
  }
  if (
    !Array.isArray(record.checks) ||
    record.checks.length < 1 ||
    record.checks.length > MAX_VERIFICATION_CHECKS
  ) {
    throw verifyRequestInvalid();
  }

  const checks = record.checks.map((entry) => validateCheckRequest(entry));
  return Object.freeze({ envelopeId: record.envelopeId, checks: Object.freeze(checks) });
}

function validateCheckRequest(entry: unknown): VerificationCheckRequest {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw verifyRequestInvalid();
  }
  const record = entry as Record<string, unknown>;
  if (Object.keys(record).length > 2) {
    throw verifyRequestInvalid();
  }
  switch (record.kind) {
    case 'source_freshness':
      if (record.chunkId !== undefined) {
        throw verifyRequestInvalid();
      }
      return Object.freeze({ kind: 'source_freshness' });
    case 'provenance_consistency':
      if (record.chunkId !== undefined) {
        throw verifyRequestInvalid();
      }
      return Object.freeze({ kind: 'provenance_consistency' });
    case 'chunk_integrity':
      if (typeof record.chunkId !== 'string' || !isWellFormedChunkIdShape(record.chunkId)) {
        throw verifyRequestInvalid();
      }
      return Object.freeze({ kind: 'chunk_integrity', chunkId: record.chunkId });
    default:
      throw verifyRequestInvalid();
  }
}

const ENVELOPE_ID_PREFIX = 'cv_env_';
const CHUNK_ID_PREFIX = 'cv_chunk_';
const IDENTIFIER_IDENTITY_MINIMUM = 16;
const LOCATOR_IDENTITY_MINIMUM = 8;
const LOCATOR_IDENTITY_LIMIT = 128;

function isWellFormedEnvelopeIdShape(candidate: string): boolean {
  return hasPrefixAndIdentity(candidate, ENVELOPE_ID_PREFIX, IDENTIFIER_IDENTITY_MINIMUM);
}

function isWellFormedChunkIdShape(candidate: string): boolean {
  return hasPrefixAndIdentity(candidate, CHUNK_ID_PREFIX, LOCATOR_IDENTITY_MINIMUM);
}

function hasPrefixAndIdentity(candidate: string, prefix: string, minimumIdentity: number): boolean {
  if (!candidate.startsWith(prefix)) {
    return false;
  }
  const identity = candidate.slice(prefix.length);
  if (identity.length < minimumIdentity || identity.length > LOCATOR_IDENTITY_LIMIT) {
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

function verifyRequestInvalid(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_INPUT_INVALID',
    message: 'The verification request is invalid.',
  });
}

/**
 * Pure validation and narrowing rules for retrieval grant requests.
 *
 * The client request is an untrusted hint. The server policy narrows
 * every field: the TTL never exceeds the envelope expiry or the hard
 * grant ceiling, the byte budget never exceeds the grant or server
 * ceilings, and the selector-type allowlist is intersected with what the
 * preparation kind can actually support. Confirmed-secret material and
 * minimal envelopes never receive a content-retrieval grant.
 */

import { ContextVaultError } from '../errors/context-vault-error.js';
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from '../preparation/preparation-limits.js';
import type {
  RetrievalGrantDecision,
  RetrievalGrantRequest,
  RetrievalSelectorKind,
} from './retrieval-types.js';
import { ALL_RETRIEVAL_SELECTOR_KINDS } from './retrieval-types.js';

/** Minimum grant time-to-live in seconds. */
export const MIN_GRANT_TTL_SECONDS = MIN_TTL_SECONDS;

/** Maximum grant time-to-live in seconds. */
export const MAX_GRANT_TTL_SECONDS = MAX_TTL_SECONDS;

/** Default grant time-to-live in seconds when the client omits the field. */
export const DEFAULT_GRANT_TTL_SECONDS = DEFAULT_TTL_SECONDS;

/** Default maximum output bytes when the client omits the field. */
export const DEFAULT_GRANT_MAX_BYTES = 262_144;

/** Hard ceiling for a grant's maximum output bytes. */
export const MAX_GRANT_MAX_BYTES = 1_048_576;

/** Selector types a text-chunk envelope can support for exact retrieval. */
const TEXT_CHUNK_SELECTOR_TYPES: readonly RetrievalSelectorKind[] = Object.freeze([
  'chunk',
  'line_range',
]);

/** Selector types a JSON structural envelope can support for exact retrieval. */
const JSON_STRUCTURE_SELECTOR_TYPES: readonly RetrievalSelectorKind[] = Object.freeze([
  'json_node',
  'line_range',
]);

const SELECTOR_KIND_SET: ReadonlySet<unknown> = new Set(ALL_RETRIEVAL_SELECTOR_KINDS);

/**
 * Validates an untrusted retrieval request value.
 * Returns `undefined` when the field is absent, which means the caller
 * did not ask for a retrieval grant and the default no-retrieval
 * contract stays in force.
 */
export function validateGrantRequest(candidate: unknown): RetrievalGrantRequest | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw grantRequestInvalid();
  }
  const record = candidate as Record<string, unknown>;
  assertOnlyKeys(record, ['allowedSelectorTypes', 'maxBytes', 'ttlSeconds']);

  const allowedSelectorTypes = validateSelectorTypes(record.allowedSelectorTypes);
  const maxBytes = validateIntegerField(
    record.maxBytes,
    1,
    MAX_GRANT_MAX_BYTES,
    DEFAULT_GRANT_MAX_BYTES,
  );
  const ttlSeconds = validateIntegerField(
    record.ttlSeconds,
    MIN_GRANT_TTL_SECONDS,
    MAX_GRANT_TTL_SECONDS,
    DEFAULT_GRANT_TTL_SECONDS,
  );

  return Object.freeze({ allowedSelectorTypes, maxBytes, ttlSeconds });
}

/**
 * Narrows a validated grant request against the prepared envelope state.
 * Returns a denial decision instead of throwing for policy-based
 * rejections, so callers can surface one stable authorization result.
 */
export function narrowGrantRequest(
  request: RetrievalGrantRequest,
  context: {
    readonly preparationKind: 'text_chunks' | 'json_structure' | 'minimal';
    readonly secretRisk: string;
    readonly envelopeTtlSeconds: number;
  },
): RetrievalGrantDecision {
  if (request.allowedSelectorTypes.length === 0) {
    return Object.freeze({ ok: false, reason: 'policy' });
  }
  if (context.secretRisk === 'confirmed') {
    return Object.freeze({ ok: false, reason: 'confirmed_secret' });
  }
  const supported = supportedSelectorTypes(context.preparationKind);
  if (supported.length === 0) {
    return Object.freeze({ ok: false, reason: 'unsupported_preparation' });
  }

  const narrowedSelectorTypes = request.allowedSelectorTypes.filter((kind) =>
    supported.includes(kind),
  );
  if (narrowedSelectorTypes.length === 0) {
    return Object.freeze({ ok: false, reason: 'policy' });
  }

  const narrowedMaxBytes = Math.min(request.maxBytes, MAX_GRANT_MAX_BYTES);
  const narrowedTtlSeconds = Math.min(request.ttlSeconds, context.envelopeTtlSeconds);

  return Object.freeze({
    ok: true,
    narrowed: Object.freeze({
      allowedSelectorTypes: Object.freeze(narrowedSelectorTypes),
      maxBytes: narrowedMaxBytes,
      ttlSeconds: narrowedTtlSeconds,
    }),
  });
}

/** Selector types the server can honor exactly for one preparation kind. */
export function supportedSelectorTypes(
  preparationKind: 'text_chunks' | 'json_structure' | 'minimal',
): readonly RetrievalSelectorKind[] {
  switch (preparationKind) {
    case 'text_chunks':
      return TEXT_CHUNK_SELECTOR_TYPES;
    case 'json_structure':
      return JSON_STRUCTURE_SELECTOR_TYPES;
    default:
      return Object.freeze([]);
  }
}

const CAPABILITY_PREFIX = 'cv1_';
/** Base64url length of the 256-bit token identity issued by the server. */
const MIN_CAPABILITY_IDENTITY = 43;
const MAX_CAPABILITY_IDENTITY = 512;

/**
 * Validates the opaque capability-token shape without a compound regex.
 * Shape rejection happens before any digest computation so malformed
 * tokens never reach the lookup path.
 */
export function isWellFormedCapability(candidate: string): boolean {
  if (!candidate.startsWith(CAPABILITY_PREFIX)) {
    return false;
  }
  const identity = candidate.slice(CAPABILITY_PREFIX.length);
  if (identity.length < MIN_CAPABILITY_IDENTITY || identity.length > MAX_CAPABILITY_IDENTITY) {
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

/** Untrusted retrieve request exactly as it arrives from a caller. */
export interface CapabilityRequest {
  readonly capability: string;
  readonly selector: unknown;
  readonly maxBytes: unknown;
}

/**
 * Independently validates an untrusted retrieve request.
 * The boundary deliberately mirrors neither the MCP schema nor any
 * transport shape, so requests bypassing the adapter stay fail-closed.
 */
export function validateCapabilityRequest(candidate: unknown): CapabilityRequest {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw capabilityRequestInvalid();
  }
  const record = candidate as Record<string, unknown>;
  if (
    !Object.keys(record).every(
      (key) => key === 'capability' || key === 'selector' || key === 'maxBytes',
    )
  ) {
    throw capabilityRequestInvalid();
  }
  if (typeof record.capability !== 'string') {
    throw capabilityRequestInvalid();
  }
  if (record.selector === undefined) {
    throw capabilityRequestInvalid();
  }
  return Object.freeze({
    capability: record.capability,
    selector: record.selector,
    maxBytes: record.maxBytes,
  });
}

function validateSelectorTypes(candidate: unknown): readonly RetrievalSelectorKind[] {
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    candidate.length > ALL_RETRIEVAL_SELECTOR_KINDS.length
  ) {
    throw grantRequestInvalid();
  }
  if (new Set(candidate).size !== candidate.length) {
    throw grantRequestInvalid();
  }
  if (candidate.some((value) => !SELECTOR_KIND_SET.has(value))) {
    throw grantRequestInvalid();
  }
  return Object.freeze(candidate as RetrievalSelectorKind[]);
}

function validateIntegerField(
  candidate: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (candidate === undefined) {
    return fallback;
  }
  if (
    typeof candidate !== 'number' ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw grantRequestInvalid();
  }
  return candidate;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (!Object.keys(record).every((key) => allowed.includes(key))) {
    throw grantRequestInvalid();
  }
}

function grantRequestInvalid(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_INPUT_INVALID',
    message: 'The retrieval grant request is invalid.',
  });
}

function capabilityRequestInvalid(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_INPUT_INVALID',
    message: 'The retrieval request is invalid.',
  });
}

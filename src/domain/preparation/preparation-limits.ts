/**
 * Centralized resource limits for the preparation and purge lifecycle.
 *
 * Every numeric bound used by the preparation domain must be declared here.
 * Handlers and use cases must import these values instead of duplicating
 * literals so that the safety envelope stays auditable in one place.
 */

import { ContextVaultError } from '../errors/context-vault-error.js';

/** Maximum number of in-memory envelopes that may exist at one time. */
export const MAX_ACTIVE_ENVELOPES = 64;

/** Maximum combined serialized derived-state bytes across all envelopes. */
export const MAX_TOTAL_DERIVED_STATE_BYTES = 4 * 1024 * 1024;

/** Maximum serialized derived metadata bytes for a single envelope. */
export const MAX_SERIALIZED_METADATA_BYTES = 256 * 1024;

/** Maximum structural descriptors emitted for one envelope. */
export const MAX_CHUNKS_PER_ENVELOPE = 1024;

/** Maximum JSON nesting depth accepted during structural scanning. */
export const MAX_JSON_PARSE_DEPTH = 64;

/** Maximum JSON nodes accepted during structural scanning. */
export const MAX_JSON_PARSE_NODES = 50_000;

/** Maximum JSON Pointer characters disclosed for one node. */
export const MAX_JSON_POINTER_LENGTH = 2048;

/** Maximum JSON Pointer segments disclosed for one node. */
export const MAX_JSON_POINTER_SEGMENTS = 128;

/** Maximum JSON node descriptors disclosed for one envelope. */
export const MAX_EMITTED_JSON_NODES = 1024;

/** Maximum key segments tracked per object for duplicate-key detection. */
export const MAX_TRACKED_JSON_KEYS_PER_OBJECT = 4096;

/** Maximum characters retained for one JSON Pointer segment. */
export const MAX_JSON_KEY_CHARACTERS = 256;

/** Maximum cumulative characters retained for real in-memory JSON locators. */
export const MAX_RETAINED_JSON_LOCATOR_CHARACTERS = 131_072;

/** Maximum plain-text lines accepted for structural scanning. */
export const MAX_TEXT_LINES = 1_000_000;

/** Target chunk size in bytes for multi-line text chunks. */
export const MAX_CHUNK_BYTES = 4096;

/** Minimum envelope time-to-live in seconds. */
export const MIN_TTL_SECONDS = 60;

/** Default envelope time-to-live in seconds. */
export const DEFAULT_TTL_SECONDS = 1800;

/** Maximum envelope time-to-live in seconds. */
export const MAX_TTL_SECONDS = 7200;

/** Default number of concurrent preparation operations. */
export const DEFAULT_CONCURRENT_PREPARATIONS = 2;

/** Hard concurrency ceiling for preparation operations. */
export const MAX_CONCURRENT_PREPARATIONS = 4;

/** Default preparation deadline in milliseconds. */
export const DEFAULT_PREPARE_DEADLINE_MILLISECONDS = 30_000;

/** Hard preparation deadline ceiling in milliseconds. */
export const HARD_PREPARE_DEADLINE_MILLISECONDS = 60_000;

/** Maximum pending purge intents retained per session. */
export const MAX_PENDING_PURGE_INTENTS = 16;

/** Hard ceiling for a bounded retrieval output in bytes. */
export const MAX_RETRIEVAL_OUTPUT_BYTES = 1_048_576;

/** Default retrieval deadline in milliseconds. */
export const RETRIEVE_DEADLINE_MILLISECONDS = 30_000;

/**
 * Hard configuration ceilings used to reject misconfigured limits.
 * These values mirror the version 1 ceilings declared in the protocol
 * documentation and must never be lowered or bypassed at runtime.
 */
export const HARD_CEILING_ACTIVE_ENVELOPES = MAX_ACTIVE_ENVELOPES;
export const HARD_CEILING_CONCURRENT_PREPARATIONS = MAX_CONCURRENT_PREPARATIONS;
export const HARD_CEILING_TOTAL_DERIVED_STATE_BYTES = 4 * 1024 * 1024;
export const HARD_CEILING_SERIALIZED_METADATA_BYTES = 256 * 1024;
export const HARD_CEILING_PREPARE_DEADLINE_MILLISECONDS = HARD_PREPARE_DEADLINE_MILLISECONDS;

/**
 * Configurable resource limits for the preparation lifecycle.
 *
 * Structural bounds (chunking, JSON depth, pointer limits) are fixed
 * constants above; the resource subset below may be configured at
 * composition time only, and only with values inside the hard ceilings.
 */
export interface PreparationLimits {
  readonly maxActiveEnvelopes: number;
  readonly maxTotalDerivedStateBytes: number;
  readonly maxSerializedMetadataBytes: number;
  readonly maxConcurrentPreparations: number;
  readonly prepareDeadlineMilliseconds: number;
}

export const STRICT_PREPARATION_LIMITS: PreparationLimits = Object.freeze({
  maxActiveEnvelopes: MAX_ACTIVE_ENVELOPES,
  maxTotalDerivedStateBytes: MAX_TOTAL_DERIVED_STATE_BYTES,
  maxSerializedMetadataBytes: MAX_SERIALIZED_METADATA_BYTES,
  maxConcurrentPreparations: DEFAULT_CONCURRENT_PREPARATIONS,
  prepareDeadlineMilliseconds: DEFAULT_PREPARE_DEADLINE_MILLISECONDS,
});

/**
 * Validates a limits object against the hard ceilings.
 * Throws a configuration error for every out-of-range field so that a
 * misconfigured composition fails before any state can be created.
 */
export function validatePreparationLimits(candidate: PreparationLimits): PreparationLimits {
  const checks: readonly [number, number][] = [
    [candidate.maxActiveEnvelopes, HARD_CEILING_ACTIVE_ENVELOPES],
    [candidate.maxTotalDerivedStateBytes, HARD_CEILING_TOTAL_DERIVED_STATE_BYTES],
    [candidate.maxSerializedMetadataBytes, HARD_CEILING_SERIALIZED_METADATA_BYTES],
    [candidate.maxConcurrentPreparations, HARD_CEILING_CONCURRENT_PREPARATIONS],
    [candidate.prepareDeadlineMilliseconds, HARD_CEILING_PREPARE_DEADLINE_MILLISECONDS],
  ];

  for (const [value, ceiling] of checks) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new ContextVaultError({
        code: 'CV_CONFIGURATION_INVALID',
        message: 'A preparation resource limit is outside its hard ceiling.',
      });
    }
  }

  return Object.freeze({ ...candidate });
}

/**
 * Validates the requested envelope time-to-live in seconds.
 * The default TTL applies when the caller omits the field entirely.
 */
export function validateTtlSeconds(candidate: unknown): number {
  if (candidate === undefined) {
    return DEFAULT_TTL_SECONDS;
  }
  if (
    typeof candidate !== 'number' ||
    !Number.isSafeInteger(candidate) ||
    candidate < MIN_TTL_SECONDS ||
    candidate > MAX_TTL_SECONDS
  ) {
    throw new ContextVaultError({
      code: 'CV_INPUT_INVALID',
      message: 'The requested retention period is outside the supported bounds.',
    });
  }
  return candidate;
}

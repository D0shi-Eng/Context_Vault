/**
 * Pure validation rules for retrieval selectors and output budgets.
 *
 * Selectors address already-prepared structure by opaque identifier or
 * bounded line range. Byte budgets are narrowed to the strictest of the
 * request, the grant, and the server ceiling. UTF-8 boundary rules keep
 * truncation outside of multi-byte code points.
 */

import { ContextVaultError } from '../errors/context-vault-error.js';
import type { RetrievalSelector, RetrievalSelectorKind } from './retrieval-types.js';
import { ALL_RETRIEVAL_SELECTOR_KINDS } from './retrieval-types.js';

const MAX_SELECTOR_LINES = 1_000_000;
const MAX_LOCATOR_ID_CHARACTERS = 128;

const CHUNK_ID_PREFIX = 'cv_chunk_';
const NODE_ID_PREFIX = 'cv_node_';
/**
 * Minimum opaque-identifier length. The JSON scanner emits six-digit
 * node identities (`cv_node_000001`) and twelve-digit chunk identities,
 * so the floor must accept the shorter node shape.
 */
const LOCATOR_IDENTITY_MINIMUM = 6;

/**
 * Validates an untrusted retrieval selector value.
 * Unknown kinds and malformed identifiers fail closed.
 */
export function validateRetrievalSelector(candidate: unknown): RetrievalSelector {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw selectorInvalid();
  }
  const record = candidate as Record<string, unknown>;
  const kind = record.kind;
  if (
    typeof kind !== 'string' ||
    !ALL_RETRIEVAL_SELECTOR_KINDS.includes(kind as RetrievalSelectorKind)
  ) {
    throw selectorInvalid();
  }

  if (kind === 'chunk') {
    assertOnlyKeys(record, ['kind', 'chunkId']);
    return Object.freeze({
      kind: 'chunk',
      chunkId: assertLocatorId(record.chunkId, CHUNK_ID_PREFIX),
    });
  }
  if (kind === 'json_node') {
    assertOnlyKeys(record, ['kind', 'nodeId']);
    return Object.freeze({
      kind: 'json_node',
      nodeId: assertLocatorId(record.nodeId, NODE_ID_PREFIX),
    });
  }
  assertOnlyKeys(record, ['kind', 'startLine', 'endLine']);
  const startLine = record.startLine;
  const endLine = record.endLine;
  if (
    typeof startLine !== 'number' ||
    typeof endLine !== 'number' ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > MAX_SELECTOR_LINES
  ) {
    throw selectorInvalid();
  }
  return Object.freeze({ kind: 'line_range', startLine, endLine });
}

/** Validates an optional requested output byte budget. */
export function validateRequestedOutputBytes(candidate: unknown): number | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) {
    throw selectorInvalid();
  }
  return candidate;
}

/**
 * Narrows the output budget to the strictest applicable limit.
 * The request limit always wins over the grant when both exist; the
 * grant and the server ceiling bound everything else.
 */
export function narrowOutputByteLimit(
  requestedBytes: number | undefined,
  grantMaxBytes: number,
  serverLimitBytes: number,
): number {
  if (requestedBytes !== undefined) {
    return Math.min(requestedBytes, grantMaxBytes, serverLimitBytes);
  }
  return Math.min(grantMaxBytes, serverLimitBytes);
}

/**
 * Returns the length of the longest prefix of `bytes` that ends exactly
 * on a UTF-8 code-point boundary, so truncation can never cut inside a
 * multi-byte character.
 *
 * The input is expected to be valid UTF-8: every retrieval buffer is
 * fatal-decoded before it reaches this function. Malformed tails fail
 * closed to the last known-good boundary instead of being guessed.
 */
export function completeUtf8PrefixLength(bytes: Uint8Array): number {
  let boundary = 0;
  let remaining = 0;
  for (const [index, byte] of bytes.entries()) {
    if (remaining === 0) {
      if (byte < 0x80) {
        boundary = index + 1;
      } else if (byte < 0xc0) {
        return boundary;
      } else if (byte < 0xe0) {
        remaining = 1;
      } else if (byte < 0xf0) {
        remaining = 2;
      } else if (byte < 0xf8) {
        remaining = 3;
      } else {
        return boundary;
      }
    } else if (byte < 0x80 || byte >= 0xc0) {
      return boundary;
    } else {
      remaining -= 1;
      if (remaining === 0) {
        boundary = index + 1;
      }
    }
  }
  return boundary;
}

/** Validates an opaque chunk or node identifier shape without a compound regex. */
export function isWellFormedLocatorId(candidate: string, prefix: string): boolean {
  if (!candidate.startsWith(prefix)) {
    return false;
  }
  const identity = candidate.slice(prefix.length);
  if (identity.length < LOCATOR_IDENTITY_MINIMUM || identity.length > MAX_LOCATOR_ID_CHARACTERS) {
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

export function selectorInvalid(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_INPUT_INVALID',
    message: 'The retrieval selector is invalid.',
  });
}

export function selectorUnsupported(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_SELECTOR_UNSUPPORTED',
    message: 'The requested selector is not available for this retrieval.',
  });
}

function assertWellFormedLocatorId(candidate: unknown, prefix: string): void {
  if (typeof candidate !== 'string' || !isWellFormedLocatorId(candidate, prefix)) {
    throw selectorInvalid();
  }
}

/** Validates and returns a well-formed chunk or node identifier. */
function assertLocatorId(candidate: unknown, prefix: string): string {
  assertWellFormedLocatorId(candidate, prefix);
  return candidate as string;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (!Object.keys(record).every((key) => allowed.includes(key))) {
    throw selectorInvalid();
  }
}

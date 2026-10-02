/**
 * Exact excerpt extraction for bounded retrieval.
 *
 * Every excerpt is carved from the freshly reread source bytes at
 * prepared, digest-verified spans - never re-serialized or re-encoded
 * from derived state. Truncation respects UTF-8 code-point boundaries
 * and is always reported explicitly, so a caller can distinguish an
 * exact complete excerpt from a truncated one.
 */

import { ContextVaultError } from '../../domain/errors/context-vault-error.js';
import type { RetrievalSelector } from '../../domain/retrieval/retrieval-types.js';
import type {
  ScannedJsonNode,
  TextChunkDescriptor,
} from '../../domain/preparation/preparation-types.js';
import { collectLineSpans } from '../../domain/preparation/line-spans.js';
import { scanJsonStructure } from '../../domain/preparation/json-structure-scanner.js';
import { jsonScanLimits } from '../../domain/preparation/json-disclosure-policy.js';
import { completeUtf8PrefixLength } from '../../domain/retrieval/retrieval-selector-policy.js';

export interface PreparedSourceDescriptor {
  readonly preparationKind: 'text_chunks' | 'json_structure' | 'minimal';
  readonly chunks: readonly TextChunkDescriptor[];
  readonly jsonNodes: readonly ScannedJsonNode[];
  readonly bytes: Uint8Array;
}

export interface ExtractedExcerpt {
  /** Exact, freshly copied source bytes backing the excerpt. */
  readonly contentBytes: Uint8Array;
  readonly locator: { readonly kind: string; readonly value: string };
  readonly truncated: boolean;
  readonly hasMore: boolean;
}

/** Extracts the bounded excerpt bytes for one selector. */
export function extractExcerptBytes(
  descriptor: PreparedSourceDescriptor,
  selector: RetrievalSelector,
  byteLimit: number,
): ExtractedExcerpt {
  const span = resolveExcerptSpan(descriptor, selector);
  return applyByteLimit(descriptor.bytes, span, selector, byteLimit);
}

interface ByteSpan {
  readonly startByte: number;
  readonly endByte: number;
}

function resolveExcerptSpan(
  descriptor: PreparedSourceDescriptor,
  selector: RetrievalSelector,
): ByteSpan {
  const sourceLength = descriptor.bytes.byteLength;
  if (selector.kind === 'chunk') {
    const chunk = descriptor.chunks.find((candidate) => candidate.chunkId === selector.chunkId);
    if (chunk === undefined) {
      throw selectorUnavailable();
    }
    assertSpanWithinSource(chunk.byteStart, chunk.byteEndExclusive, sourceLength);
    return { startByte: chunk.byteStart, endByte: chunk.byteEndExclusive };
  }
  if (selector.kind === 'line_range') {
    const spans = collectLineSpans(descriptor.bytes);
    const startSpan = spans[selector.startLine - 1];
    const endSpan = spans[Math.min(selector.endLine, spans.length) - 1];
    if (startSpan === undefined || endSpan === undefined) {
      throw selectorUnavailable();
    }
    return { startByte: startSpan.byteStart, endByte: endSpan.byteEndExclusive };
  }
  return resolveJsonNodeSpan(descriptor, selector.nodeId, sourceLength);
}

/**
 * Resolves the exact original source span for one prepared JSON node.
 *
 * The document is rescanned from the freshly reread bytes with the same
 * bounded limits; because the full-source digest already matched, the
 * rescan is byte-identical to the prepared scan, so the span describes
 * the original source exactly. `JSON.stringify` is never used, and node
 * ids beyond the emission cap are rejected instead of guessed.
 */
function resolveJsonNodeSpan(
  descriptor: PreparedSourceDescriptor,
  nodeId: string,
  sourceLength: number,
): ByteSpan {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(descriptor.bytes);
  const scan = scanJsonStructure(text, jsonScanLimits());
  const node = scan.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) {
    throw selectorUnavailable();
  }
  const startByte = textOffsetToByteOffset(text, node.startPosition);
  const endByte = textOffsetToByteOffset(text, node.endPosition);
  assertSpanWithinSource(startByte, endByte, sourceLength);
  return { startByte, endByte };
}

/**
 * Maps one character offset in the decoded text to its exact byte offset.
 * Iterating code points (never code units) keeps astral characters exact.
 */
function textOffsetToByteOffset(text: string, textOffset: number): number {
  let byteOffset = 0;
  let index = 0;
  for (const character of text) {
    if (index >= textOffset) {
      break;
    }
    byteOffset += utf8ByteLengthOfCodePoint(character.charCodeAt(0));
    index += character.length;
  }
  return byteOffset;
}

/**
 * UTF-8 byte length from the first code unit of one code point.
 * `charCodeAt` returns a plain number (never undefined), and lone
 * surrogates cannot occur because every retrieval buffer is
 * fatal-decoded before it reaches this function.
 */
function utf8ByteLengthOfCodePoint(firstUnit: number): number {
  if (firstUnit < 0x80) {
    return 1;
  }
  if (firstUnit < 0x800) {
    return 2;
  }
  if (firstUnit >= 0xd800 && firstUnit <= 0xdbff) {
    return 4;
  }
  return 3;
}

function applyByteLimit(
  bytes: Uint8Array,
  span: ByteSpan,
  selector: RetrievalSelector,
  byteLimit: number,
): ExtractedExcerpt {
  const fullLength = span.endByte - span.startByte;
  if (fullLength <= byteLimit) {
    return {
      contentBytes: bytes.slice(span.startByte, span.endByte),
      locator: buildLocator(selector),
      truncated: false,
      hasMore: false,
    };
  }

  const limitedView = bytes.subarray(span.startByte, span.startByte + byteLimit);
  const boundaryLength = completeUtf8PrefixLength(limitedView);
  const contentBytes = bytes.slice(span.startByte, span.startByte + boundaryLength);
  return {
    contentBytes,
    locator: buildLocator(selector),
    truncated: true,
    hasMore: span.startByte + boundaryLength < span.endByte,
  };
}

function buildLocator(selector: RetrievalSelector): {
  readonly kind: string;
  readonly value: string;
} {
  switch (selector.kind) {
    case 'chunk':
      return Object.freeze({ kind: 'chunk', value: selector.chunkId });
    case 'line_range':
      return Object.freeze({
        kind: 'line_range',
        value: `${String(selector.startLine)}-${String(selector.endLine)}`,
      });
    default:
      return Object.freeze({ kind: 'json_node', value: selector.nodeId });
  }
}

function assertSpanWithinSource(startByte: number, endByte: number, sourceLength: number): void {
  if (startByte < 0 || endByte <= startByte || endByte > sourceLength) {
    throw new ContextVaultError({
      code: 'CV_SOURCE_CHANGED',
      message: 'The prepared source span is no longer available.',
    });
  }
}

function selectorUnavailable(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_SELECTOR_UNSUPPORTED',
    message: 'The requested selector is not available for this retrieval.',
  });
}

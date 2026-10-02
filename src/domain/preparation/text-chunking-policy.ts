/**
 * Deterministic, bounded chunking policy for plain text and Markdown.
 *
 * Chunk boundaries depend only on the source bytes and the configured
 * limits, never on wall-clock time, randomness, or the environment.
 * Descriptors carry structural metadata only; no line content is ever
 * produced and the source bytes are never copied into the result.
 */

import { ContextVaultError } from '../errors/context-vault-error.js';
import { collectLineSpans } from './line-spans.js';
import type {
  OmissionRecord,
  StructuralLocator,
  TextChunkDescriptor,
} from './preparation-types.js';

export interface TextChunkingRequest {
  readonly bytes: Uint8Array;
  readonly maxChunkBytes: number;
  readonly maxChunks: number;
  readonly digest: (chunkBytes: Uint8Array) => string;
}

export interface TextChunkingOutcome {
  readonly lineCount: number;
  readonly chunks: readonly TextChunkDescriptor[];
  readonly omissions: readonly OmissionRecord[];
}

/**
 * Splits the source bytes into deterministic chunks along line boundaries.
 *
 * Chunk `byteStart` is inclusive, `byteEndExclusive` is exclusive, and
 * line numbers are one-based with an exclusive end so ranges are
 * unambiguous. A single line longer than `maxChunkBytes` becomes its own
 * complete chunk rather than being split mid-line.
 */
export function chunkTextLines(request: TextChunkingRequest): TextChunkingOutcome {
  assertPositiveInteger(request.maxChunkBytes, 'maxChunkBytes');
  assertPositiveInteger(request.maxChunks, 'maxChunks');

  const lines = collectLineSpans(request.bytes);

  const chunks: TextChunkDescriptor[] = [];
  const omissions: OmissionRecord[] = [];

  let chunkStartByte = 0;
  let chunkLineStart = 1;
  let chunkLineCount = 0;
  let chunkBytes = 0;
  let chunkCounter = 0;

  for (const line of lines) {
    const lineBytes = line.byteEndExclusive - line.byteStart;
    const mustFlush = chunkLineCount > 0 && chunkBytes + lineBytes > request.maxChunkBytes;

    if (mustFlush) {
      chunks.push(
        buildChunk(
          request,
          chunkCounter,
          chunkStartByte,
          line.byteStart,
          chunkLineStart,
          line.lineNumber,
          chunkBytes,
        ),
      );
      chunkCounter += 1;
      chunkStartByte = line.byteStart;
      chunkLineStart = line.lineNumber;
      chunkLineCount = 0;
      chunkBytes = 0;

      if (chunks.length === request.maxChunks) {
        omissions.push(
          buildBudgetOmission(
            line.byteStart,
            request.bytes.byteLength,
            lines.length - line.lineNumber + 1,
          ),
        );
        return Object.freeze({ lineCount: lines.length, chunks, omissions });
      }
    }

    chunkLineCount += 1;
    chunkBytes += lineBytes;
  }

  if (chunkLineCount > 0) {
    chunks.push(
      buildChunk(
        request,
        chunkCounter,
        chunkStartByte,
        request.bytes.byteLength,
        chunkLineStart,
        chunkLineStart + chunkLineCount,
        chunkBytes,
      ),
    );
  }

  return Object.freeze({ lineCount: lines.length, chunks, omissions });
}

function buildChunk(
  request: TextChunkingRequest,
  chunkCounter: number,
  byteStart: number,
  byteEndExclusive: number,
  lineStart: number,
  lineEndExclusive: number,
  byteLength: number,
): TextChunkDescriptor {
  return Object.freeze({
    chunkId: `cv_chunk_${(chunkCounter + 1).toString().padStart(12, '0')}`,
    byteStart,
    byteEndExclusive,
    lineStart,
    lineEndExclusive,
    byteLength,
    chunkDigest: request.digest(request.bytes.subarray(byteStart, byteEndExclusive)),
    truncated: false,
  });
}

function buildBudgetOmission(
  byteStart: number,
  byteEnd: number,
  remainingLines: number,
): OmissionRecord {
  const locator: StructuralLocator = {
    kind: 'byte_range',
    value: `${String(byteStart)}-${String(byteEnd)}`,
  };
  return Object.freeze({
    omissionId: 'cv_omit_000000000001',
    locator,
    reason: 'budget',
    itemCount: remainingLines,
    retrievable: false,
  });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContextVaultError({
      code: 'CV_CONFIGURATION_INVALID',
      message: `Text chunking limit '${name}' is invalid.`,
    });
  }
}

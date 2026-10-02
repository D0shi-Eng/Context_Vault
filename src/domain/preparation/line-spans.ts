/**
 * Deterministic line-span collection over raw source bytes.
 *
 * Line numbers are one-based and spans are half-open so ranges stay
 * unambiguous. The byte order of the source is authoritative: line
 * boundaries are located in the bytes, never in decoded text, so spans
 * stay exact for any UTF-8 content and for CRLF and LF line endings.
 */

import { ContextVaultError } from '../errors/context-vault-error.js';
import { MAX_TEXT_LINES } from './preparation-limits.js';

const LINE_FEED = 0x0a;

export interface LineSpan {
  readonly byteStart: number;
  readonly byteEndExclusive: number;
  readonly lineNumber: number;
}

/**
 * Collects every line span in the source bytes.
 * A final line without a trailing line feed is still a complete line.
 * Throws when the source exceeds the supported line count.
 */
export function collectLineSpans(bytes: Uint8Array): readonly LineSpan[] {
  const spans: LineSpan[] = [];
  let lineStart = 0;
  let lineNumber = 0;

  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === LINE_FEED) {
      lineNumber += 1;
      if (lineNumber > MAX_TEXT_LINES) {
        throw lineLimitError();
      }
      spans.push({ byteStart: lineStart, byteEndExclusive: index + 1, lineNumber });
      lineStart = index + 1;
    }
  }

  if (lineStart < bytes.byteLength) {
    lineNumber += 1;
    if (lineNumber > MAX_TEXT_LINES) {
      throw lineLimitError();
    }
    spans.push({ byteStart: lineStart, byteEndExclusive: bytes.byteLength, lineNumber });
  }

  return spans;
}

function lineLimitError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_PARSE_LINE_LIMIT_EXCEEDED',
    message: 'The source exceeds the supported line count.',
  });
}

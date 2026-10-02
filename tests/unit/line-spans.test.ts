import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { collectLineSpans } from '../../src/domain/preparation/line-spans.js';

describe('collectLineSpans', () => {
  it('maps an empty source to zero lines', () => {
    expect(collectLineSpans(new Uint8Array(0))).toEqual([]);
  });

  it('accepts exactly the maximum supported line count without failing', () => {
    const bytes = new TextEncoder().encode('a\n'.repeat(1_000_000));

    const spans = collectLineSpans(bytes);

    expect(spans).toHaveLength(1_000_000);
    expect(spans[999_999]).toEqual({
      byteStart: 1_999_998,
      byteEndExclusive: 2_000_000,
      lineNumber: 1_000_000,
    });
  });

  it('accepts exactly the maximum supported line count for an unterminated tail', () => {
    const bytes = new TextEncoder().encode(`${'a\n'.repeat(999_999)}a`);

    const spans = collectLineSpans(bytes);

    expect(spans).toHaveLength(1_000_000);
    expect(spans[999_999]).toEqual({
      byteStart: 1_999_998,
      byteEndExclusive: 1_999_999,
      lineNumber: 1_000_000,
    });
  });

  it('collects exact half-open byte spans for LF lines', () => {
    const bytes = new TextEncoder().encode('alpha\nbeta\n');
    expect(collectLineSpans(bytes)).toEqual([
      { byteStart: 0, byteEndExclusive: 6, lineNumber: 1 },
      { byteStart: 6, byteEndExclusive: 11, lineNumber: 2 },
    ]);
  });

  it('treats a final line without a trailing feed as complete', () => {
    const bytes = new TextEncoder().encode('one\ntwo');
    const spans = collectLineSpans(bytes);
    expect(spans).toHaveLength(2);
    expect(spans[1]).toEqual({ byteStart: 4, byteEndExclusive: 7, lineNumber: 2 });
  });

  it('keeps carriage returns inside CRLF spans without splitting them', () => {
    const bytes = new TextEncoder().encode('a\r\nb\r\n');
    expect(collectLineSpans(bytes)).toEqual([
      { byteStart: 0, byteEndExclusive: 3, lineNumber: 1 },
      { byteStart: 3, byteEndExclusive: 6, lineNumber: 2 },
    ]);
  });

  it('covers multibyte characters with exact byte offsets', () => {
    const bytes = new TextEncoder().encode('héllo\nwörld\n');
    const spans = collectLineSpans(bytes);
    expect(spans).toHaveLength(2);
    expect(bytes.subarray(spans[0]?.byteStart, spans[0]?.byteEndExclusive)).toEqual(
      new TextEncoder().encode('héllo\n'),
    );
    expect(bytes.subarray(spans[1]?.byteStart, spans[1]?.byteEndExclusive)).toEqual(
      new TextEncoder().encode('wörld\n'),
    );
  });

  it('partitions the source exactly for arbitrary content', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (text) => {
        const bytes = new TextEncoder().encode(text);
        const spans = collectLineSpans(bytes);
        // Spans are contiguous, ordered, and cover the source exactly.
        let cursor = 0;
        let lineNumber = 1;
        for (const span of spans) {
          expect(span.byteStart).toBe(cursor);
          expect(span.lineNumber).toBe(lineNumber);
          expect(span.byteEndExclusive).toBeGreaterThan(span.byteStart);
          cursor = span.byteEndExclusive;
          lineNumber += 1;
        }
        // Reassembling every slice reproduces the source byte-for-byte.
        const rebuilt = new Uint8Array(bytes.byteLength);
        for (const span of spans) {
          rebuilt.set(bytes.subarray(span.byteStart, span.byteEndExclusive), span.byteStart);
        }
        expect(rebuilt).toEqual(bytes);
      }),
      { numRuns: 500 },
    );
  });
});

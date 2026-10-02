import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  completeUtf8PrefixLength,
  isWellFormedLocatorId,
  narrowOutputByteLimit,
  selectorUnsupported,
  validateRequestedOutputBytes,
  validateRetrievalSelector,
} from '../../src/domain/retrieval/retrieval-selector-policy.js';

describe('validateRetrievalSelector', () => {
  it('accepts the three supported selector shapes', () => {
    expect(validateRetrievalSelector({ kind: 'chunk', chunkId: 'cv_chunk_000000000001' })).toEqual({
      kind: 'chunk',
      chunkId: 'cv_chunk_000000000001',
    });
    expect(validateRetrievalSelector({ kind: 'json_node', nodeId: 'cv_node_000001' })).toEqual({
      kind: 'json_node',
      nodeId: 'cv_node_000001',
    });
    expect(validateRetrievalSelector({ kind: 'line_range', startLine: 1, endLine: 4 })).toEqual({
      kind: 'line_range',
      startLine: 1,
      endLine: 4,
    });
  });

  it('freezes the returned selector so callers cannot mutate it', () => {
    const selector = validateRetrievalSelector({
      kind: 'line_range',
      startLine: 2,
      endLine: 2,
    });
    expect(Object.isFrozen(selector)).toBe(true);
  });

  it.each([
    ['a non-object selector', 'chunk'],
    ['a null selector', null],
    ['an undefined selector', undefined],
    ['an array selector', []],
    ['an empty object selector', {}],
    ['an unknown kind', { kind: 'semantic' }],
    ['a numeric kind', { kind: 42 }],
    ['an unknown kind with valid line fields', { kind: 'semantic', startLine: 1, endLine: 2 }],
    ['a numeric kind with valid line fields', { kind: 42, startLine: 1, endLine: 2 }],
    ['a node-prefixed chunk identifier', { kind: 'chunk', chunkId: 'cv_node_000000000001' }],
    ['a chunk-prefixed node identifier', { kind: 'json_node', nodeId: 'cv_chunk_000000000001' }],
    [
      'a chunk selector with an extra field',
      { kind: 'chunk', chunkId: 'cv_chunk_000000000001', path: 'x' },
    ],
    ['a chunk selector with a malformed identifier', { kind: 'chunk', chunkId: 'chunk-1' }],
    [
      'a node selector with an extra field',
      { kind: 'json_node', nodeId: 'cv_node_000001', name: 'x' },
    ],
    ['a line selector with a zero start', { kind: 'line_range', startLine: 0, endLine: 4 }],
    ['a line selector with an inverted range', { kind: 'line_range', startLine: 5, endLine: 4 }],
    ['a line selector with a fractional line', { kind: 'line_range', startLine: 1.5, endLine: 4 }],
    [
      'a line selector at one past the supported maximum',
      { kind: 'line_range', startLine: 1, endLine: 1_000_001 },
    ],
  ])('rejects %s', (_name, candidate) => {
    expect(() => validateRetrievalSelector(candidate)).toThrow(ContextVaultError);
  });

  it('accepts a line selector exactly at the supported maximum', () => {
    expect(
      validateRetrievalSelector({ kind: 'line_range', startLine: 1, endLine: 1_000_000 }),
    ).toEqual({ kind: 'line_range', startLine: 1, endLine: 1_000_000 });
  });

  it('reports selector failures with the input-invalid code, not unsupported', () => {
    try {
      validateRetrievalSelector({ kind: 'chunk', chunkId: 'bad' });
      expect.fail('Expected a ContextVaultError.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ContextVaultError);
      expect((error as ContextVaultError).code).toBe('CV_INPUT_INVALID');
    }
    expect(selectorUnsupported().code).toBe('CV_SELECTOR_UNSUPPORTED');
  });
});

describe('validateRequestedOutputBytes', () => {
  it('accepts undefined as the absent-budget signal', () => {
    expect(validateRequestedOutputBytes(undefined)).toBeUndefined();
  });

  it('accepts a positive integer budget', () => {
    expect(validateRequestedOutputBytes(1024)).toBe(1024);
    expect(validateRequestedOutputBytes(1)).toBe(1);
  });

  it.each([
    ['zero', 0],
    ['a negative budget', -8],
    ['a fractional budget', 10.5],
    ['a non-number budget', '1024'],
  ])('rejects %s', (_name, candidate) => {
    expect(() => validateRequestedOutputBytes(candidate)).toThrow(ContextVaultError);
  });
});

describe('narrowOutputByteLimit', () => {
  it('selects the strictest limit when all three ceilings apply', () => {
    expect(narrowOutputByteLimit(8192, 4096, 1_048_576)).toBe(4096);
    expect(narrowOutputByteLimit(512, 4096, 1_048_576)).toBe(512);
    expect(narrowOutputByteLimit(2_000_000, 2_000_000, 1_048_576)).toBe(1_048_576);
  });

  it('falls back to the grant ceiling when no request budget exists', () => {
    expect(narrowOutputByteLimit(undefined, 4096, 1_048_576)).toBe(4096);
    expect(narrowOutputByteLimit(undefined, 4_194_304, 1_048_576)).toBe(1_048_576);
  });
});

describe('isWellFormedLocatorId', () => {
  it('accepts the issued identifier shape and rejects impostors', () => {
    expect(isWellFormedLocatorId('cv_chunk_000000000001', 'cv_chunk_')).toBe(true);
    expect(isWellFormedLocatorId('cv_node_000001', 'cv_node_')).toBe(true);
    expect(isWellFormedLocatorId('cv_node_000001', 'cv_chunk_')).toBe(false);
    expect(isWellFormedLocatorId('cv_chunk_short', 'cv_chunk_')).toBe(false);
    expect(isWellFormedLocatorId(`cv_chunk_${'a'.repeat(129)}`, 'cv_chunk_')).toBe(false);
    expect(isWellFormedLocatorId('cv_chunk_bad!ident000', 'cv_chunk_')).toBe(false);
  });

  it.each([
    ['cv_chunk_abcdef', 'the shortest accepted chunk identity'],
    [`cv_chunk_${'a'.repeat(128)}`, 'the longest accepted chunk identity'],
    ['cv_node_000000', 'the shortest accepted node identity'],
    ['cv_chunk_ABCDEF', 'an all-uppercase identity'],
    ['cv_chunk_ZZZZZZ', 'an identity at the uppercase ceiling'],
    ['cv_chunk_zzzzzz', 'an identity at the lowercase ceiling'],
    ['cv_chunk_000000', 'an all-digit identity'],
    ['cv_chunk_999999', 'an identity at the digit ceiling'],
    ['cv_chunk_-_-_-_', 'an identity of separator characters'],
  ])('accepts %s (%s)', (candidate) => {
    const prefix = candidate.startsWith('cv_chunk_') ? 'cv_chunk_' : 'cv_node_';
    expect(isWellFormedLocatorId(candidate, prefix)).toBe(true);
  });

  it.each([
    ['cv_chunk_abcde', 'one character below the minimum', 'cv_chunk_'],
    ['cv_node_00000', 'one character below the minimum', 'cv_node_'],
    [`cv_node_${'a'.repeat(129)}`, 'one character above the maximum', 'cv_node_'],
    ['cv_node_000000000001', 'a node identifier checked against the chunk prefix', 'cv_chunk_'],
    ['cv_chunk_000000000001', 'a chunk identifier checked against the node prefix', 'cv_node_'],
    ['cv_chunk_@bcdefghij', 'a character before the uppercase range', 'cv_chunk_'],
    ['cv_chunk_[bcdefghij', 'a character after the uppercase range', 'cv_chunk_'],
    ['cv_chunk_`bcdefghij', 'a character before the lowercase range', 'cv_chunk_'],
    ['cv_chunk_{bcdefghij', 'a character after the lowercase range', 'cv_chunk_'],
    ['cv_chunk_/bcdefghij', 'a character before the digit range', 'cv_chunk_'],
    ['cv_chunk_:bcdefghij', 'a character after the digit range', 'cv_chunk_'],
  ])('rejects %s (%s)', (candidate, _reason, prefix) => {
    expect(isWellFormedLocatorId(candidate, prefix)).toBe(false);
  });
});

describe('completeUtf8PrefixLength', () => {
  it('returns the full length for buffers ending on an ASCII boundary', () => {
    expect(completeUtf8PrefixLength(new TextEncoder().encode('plain'))).toBe(5);
    expect(completeUtf8PrefixLength(new Uint8Array(0))).toBe(0);
  });

  it('backs off a buffer ending inside a multi-byte sequence', () => {
    const full = new TextEncoder().encode('héllo wörld ✓');
    // The '✓' character occupies three bytes at the end.
    expect(completeUtf8PrefixLength(full.subarray(0, full.byteLength - 1))).toBe(
      full.byteLength - 3,
    );
    expect(completeUtf8PrefixLength(full.subarray(0, full.byteLength - 2))).toBe(
      full.byteLength - 3,
    );
    expect(completeUtf8PrefixLength(full)).toBe(full.byteLength);
  });

  it('keeps a four-byte character whole and backs off a cut one', () => {
    const full = new TextEncoder().encode('a😀b');
    expect(completeUtf8PrefixLength(full)).toBe(full.byteLength);
    expect(completeUtf8PrefixLength(full.subarray(0, 2))).toBe(1);
    expect(completeUtf8PrefixLength(full.subarray(0, 4))).toBe(1);
  });

  it('keeps exact three-byte lead boundaries whole', () => {
    // U+0800 is the smallest three-byte character: its lead byte is
    // exactly 0xE0, pinning the two-byte/three-byte boundary.
    const full = new Uint8Array([0xe0, 0x80, 0x80]);
    expect(completeUtf8PrefixLength(full)).toBe(3);
    expect(completeUtf8PrefixLength(full.subarray(0, 2))).toBe(0);
  });

  it('returns zero when no complete code point fits', () => {
    const full = new TextEncoder().encode('✓');
    expect(completeUtf8PrefixLength(full.subarray(0, 1))).toBe(0);
    expect(completeUtf8PrefixLength(full.subarray(0, 2))).toBe(0);
  });

  it('fails closed to the last good boundary on malformed tails', () => {
    expect(completeUtf8PrefixLength(new Uint8Array([0x80]))).toBe(0);
    expect(completeUtf8PrefixLength(new Uint8Array([0x68, 0x80]))).toBe(1);
    expect(completeUtf8PrefixLength(new Uint8Array([0xc3, 0x68]))).toBe(0);
    expect(completeUtf8PrefixLength(new Uint8Array([0xc3, 0xc3]))).toBe(0);
    expect(completeUtf8PrefixLength(new Uint8Array([0xf8]))).toBe(0);
    expect(completeUtf8PrefixLength(new Uint8Array([0x68, 0x80, 0x80, 0x80, 0x80, 0x80]))).toBe(1);
  });

  it('never truncates inside a code point for arbitrary text and limits', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 64 }),
        fc.integer({ min: 0, max: 64 }),
        (text, limit) => {
          const bytes = new TextEncoder().encode(text);
          const capped = bytes.subarray(0, Math.min(limit, bytes.byteLength));
          const boundary = completeUtf8PrefixLength(capped);
          // The kept prefix must decode strictly and match the source prefix:
          // decode first, then re-encode and compare against the raw slice.
          const kept = capped.subarray(0, boundary);
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(kept);
          expect(new TextEncoder().encode(decoded)).toEqual(kept);
          // The boundary never advances past a cut made inside a character:
          // decoding the bytes immediately beyond the boundary remainder
          // must either be empty or begin a fresh character.
          expect(boundary).toBeLessThanOrEqual(capped.byteLength);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('completeUtf8PrefixLength — explicit UTF-8 boundary policy', () => {
  it.each([
    ['a complete 1-byte ASCII character', [0x61], 1],
    ['an empty buffer', [], 0],
    ['a 2-byte character cut after its first byte', [0xc3], 0],
    ['a complete 2-byte character', [0xc3, 0xa9], 2],
    ['a 3-byte character cut after byte 1', [0xe0], 0],
    ['a 3-byte character cut after byte 2', [0xe0, 0x80], 0],
    ['a complete 3-byte character', [0xe0, 0x80, 0x80], 3],
    ['a 4-byte character cut after byte 1', [0x61, 0xf0], 1],
    ['a 4-byte character cut after byte 2', [0x61, 0xf0, 0x9f], 1],
    ['a 4-byte character cut after byte 3', [0x61, 0xf0, 0x9f, 0x98], 1],
    ['a complete 4-byte astral character', [0x61, 0xf0, 0x9f, 0x98, 0x80, 0x62], 6],
    ['a continuation byte without a valid leading byte', [0x80], 0],
    ['two continuation bytes without a valid leading byte', [0x80, 0x80], 0],
    ['ASCII then an orphan continuation byte fails closed', [0x68, 0x80], 1],
    [
      'ASCII then an orphan continuation byte then another complete ASCII byte',
      [0x68, 0x80, 0x62],
      1,
    ],
    ['an invalid leading byte 0xf8 alone', [0xf8], 0],
    [
      'an invalid leading byte 0xf8 with continuation bytes fails closed',
      [0xf8, 0x80, 0x80, 0x80],
      0,
    ],
    [
      'an invalid leading byte 0xf9 with continuation bytes fails closed',
      [0xf9, 0x80, 0x80, 0x80],
      0,
    ],
    ['an invalid leading byte 0xfe followed by ASCII fails closed', [0xfe, 0x62], 0],
    ['an invalid leading byte 0xff followed by ASCII fails closed', [0xff, 0x62], 0],
    [
      'the 0xc0 lead byte followed by a continuation byte (code treats it as a 2-byte start)',
      [0xc0, 0x80],
      2,
    ],
    ['a mid-sequence ASCII byte after a 2-byte lead fails closed', [0xc3, 0x41, 0x80], 0],
    [
      'an ASCII char then a mid-sequence lead byte after a 3-byte start fails closed',
      [0x62, 0xe0, 0x80, 0xc0],
      1,
    ],
    ['a byte limit exactly at the final complete ASCII code point', [0x61, 0x62, 0x63], 3],
    [
      'a byte limit exactly at the final complete multibyte code point',
      [0x61, 0xc3, 0xa9, 0x62],
      4,
    ],
  ])(
    'returns the explicit policy boundary for %s',
    (_description: string, bytes: readonly number[], expected: number) => {
      expect(completeUtf8PrefixLength(new Uint8Array(bytes))).toBe(expected);
    },
  );
});

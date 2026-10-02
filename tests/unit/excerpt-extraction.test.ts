import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  extractExcerptBytes,
  type PreparedSourceDescriptor,
} from '../../src/application/retrieval/excerpt-extraction.js';
import { scanJsonStructure } from '../../src/domain/preparation/json-structure-scanner.js';
import { jsonScanLimits } from '../../src/domain/preparation/json-disclosure-policy.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);

function textChunkDescriptor(
  bytes: Uint8Array,
  startByte: number,
  endByteExclusive: number,
  chunkId = 'cv_chunk_000000000001',
): PreparedSourceDescriptor {
  return {
    preparationKind: 'text_chunks',
    chunks: [
      {
        chunkId,
        byteStart: startByte,
        byteEndExclusive: endByteExclusive,
        lineStart: 1,
        lineEndExclusive: 2,
        byteLength: endByteExclusive - startByte,
        chunkDigest: 'd',
        truncated: false,
      },
    ],
    jsonNodes: [],
    bytes,
  };
}

function extractWithChunk(
  bytes: Uint8Array,
  startByte: number,
  endByteExclusive: number,
  byteLimit: number,
  chunkId = 'cv_chunk_000000000001',
): ReturnType<typeof extractExcerptBytes> {
  const d = textChunkDescriptor(bytes, startByte, endByteExclusive, chunkId);
  return extractExcerptBytes(d, { kind: 'chunk', chunkId }, byteLimit);
}

describe('extractExcerptBytes — byte-limit boundaries', () => {
  const src = enc('héllo');

  it('returns the whole span when the byte limit is exactly the span', () => {
    const e = extractWithChunk(src, 0, src.byteLength, src.byteLength);
    expect(decode(e.contentBytes)).toBe('héllo');
    expect(e.contentBytes.byteLength).toBe(6);
    expect(e.truncated).toBe(false);
    expect(e.hasMore).toBe(false);
  });

  it('returns the whole span when the byte limit is larger than the span', () => {
    const e = extractWithChunk(src, 0, src.byteLength, 64);
    expect(decode(e.contentBytes)).toBe('héllo');
    expect(e.contentBytes.byteLength).toBe(6);
    expect(e.truncated).toBe(false);
    expect(e.hasMore).toBe(false);
  });

  it('truncates after a complete multibyte character and reports hasMore', () => {
    const e = extractWithChunk(src, 0, src.byteLength, 3);
    expect(decode(e.contentBytes)).toBe('hé');
    expect(e.contentBytes.byteLength).toBe(3);
    expect(e.truncated).toBe(true);
    expect(e.hasMore).toBe(true);
  });

  it('backs off a byte limit that lands in the middle of a multibyte character', () => {
    const e = extractWithChunk(src, 0, src.byteLength, 2);
    expect(decode(e.contentBytes)).toBe('h');
    expect(e.contentBytes.byteLength).toBe(1);
    expect(e.truncated).toBe(true);
    expect(e.hasMore).toBe(true);
  });

  it('clips exactly after an ASCII character immediately before a multibyte character', () => {
    const e = extractWithChunk(src, 0, src.byteLength, 1);
    expect(decode(e.contentBytes)).toBe('h');
    expect(e.contentBytes.byteLength).toBe(1);
    expect(e.truncated).toBe(true);
    expect(e.hasMore).toBe(true);
  });

  it('keeps the span intact when the byte limit is larger than a small span', () => {
    const e = extractWithChunk(src, 0, 3, 16);
    expect(decode(e.contentBytes)).toBe('hé');
    expect(e.contentBytes.byteLength).toBe(3);
    expect(e.truncated).toBe(false);
    expect(e.hasMore).toBe(false);
  });

  it('truncates from a non-zero startByte with exact content and byte count', () => {
    const bytes = enc('ab' + decode(src));
    const e = extractWithChunk(bytes, 2, bytes.byteLength, 3);
    expect(decode(e.contentBytes)).toBe('hé');
    expect(e.contentBytes.byteLength).toBe(3);
    expect(e.truncated).toBe(true);
    expect(e.hasMore).toBe(true);
  });

  it('throws CV_SOURCE_CHANGED for an empty span', () => {
    const bytes = enc('abc');
    expect(() => extractWithChunk(bytes, 3, 3, 6)).toThrow(ContextVaultError);
  });

  it('keeps the final byte of the source when the span reaches the end', () => {
    const e = extractWithChunk(src, 0, src.byteLength, src.byteLength);
    expect(decode(e.contentBytes)).toBe('héllo');
    expect(e.contentBytes).toEqual(src);
    expect(e.truncated).toBe(false);
    expect(e.hasMore).toBe(false);
  });

  it('backs off a trailing multibyte character that is cut by the limit', () => {
    const bytes = enc('abé');
    const e = extractWithChunk(bytes, 0, bytes.byteLength, 3);
    expect(decode(e.contentBytes)).toBe('ab');
    expect(e.contentBytes.byteLength).toBe(2);
    expect(e.truncated).toBe(true);
    expect(e.hasMore).toBe(true);
  });

  it('reports hasMore false when the clip consumes the entire span at an exact fit', () => {
    const bytes = enc('abc');
    const e = extractWithChunk(bytes, 0, bytes.byteLength, 3);
    expect(decode(e.contentBytes)).toBe('abc');
    expect(e.truncated).toBe(false);
    expect(e.hasMore).toBe(false);
  });
});

describe('extractExcerptBytes — JSON node byte offsets across multibyte characters', () => {
  it('resolves a node positioned after a 3-byte character with exact byte offsets', () => {
    const text = '{"a": "✓", "n": 2}';
    const scan = scanJsonStructure(text, jsonScanLimits());
    const numNode = scan.nodes.find((n) => n.nodeType === 'number');
    if (!numNode) {
      throw new Error('Expected a number node.');
    }
    const d: PreparedSourceDescriptor = {
      preparationKind: 'json_structure',
      chunks: [],
      jsonNodes: scan.nodes,
      bytes: enc(text),
    };
    const e = extractExcerptBytes(
      d,
      { kind: 'json_node', nodeId: numNode.nodeId },
      d.bytes.byteLength,
    );
    expect(decode(e.contentBytes)).toBe('2');
    expect(e.contentBytes.byteLength).toBe(1);
    expect(e.truncated).toBe(false);
    expect(e.hasMore).toBe(false);
  });

  it('keeps a node span exact when the byte walk crosses a 4-byte astral character', () => {
    const text = '{"p": "😀", "v": "x"}';
    const scan = scanJsonStructure(text, jsonScanLimits());
    const stringNodes = scan.nodes.filter((n) => n.nodeType === 'string');
    const valueNode = stringNodes[stringNodes.length - 1];
    if (!valueNode) {
      throw new Error('Expected a value node.');
    }
    const d: PreparedSourceDescriptor = {
      preparationKind: 'json_structure',
      chunks: [],
      jsonNodes: scan.nodes,
      bytes: enc(text),
    };
    const e = extractExcerptBytes(
      d,
      { kind: 'json_node', nodeId: valueNode.nodeId },
      d.bytes.byteLength,
    );
    expect(decode(e.contentBytes)).toBe('"x"');
    expect(e.contentBytes.byteLength).toBe(3);
    expect(e.truncated).toBe(false);
    expect(e.hasMore).toBe(false);
  });
});

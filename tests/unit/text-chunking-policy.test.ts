import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  MAX_CHUNK_BYTES,
  MAX_CHUNKS_PER_ENVELOPE,
} from '../../src/domain/preparation/preparation-limits.js';
import { chunkTextLines } from '../../src/domain/preparation/text-chunking-policy.js';
import type { TextChunkDescriptor } from '../../src/domain/preparation/preparation-types.js';
import { NodeInspectionCryptography } from '../../src/infrastructure/inspection/node-inspection-cryptography.js';

const cryptography = new NodeInspectionCryptography();

function chunk(
  bytes: Uint8Array,
  overrides: Partial<Parameters<typeof chunkTextLines>[0]> = {},
): ReturnType<typeof chunkTextLines> {
  return chunkTextLines({
    bytes,
    maxChunkBytes: MAX_CHUNK_BYTES,
    maxChunks: MAX_CHUNKS_PER_ENVELOPE,
    digest: (chunkBytes) => cryptography.sha256(chunkBytes),
    ...overrides,
  });
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function chunkAt(
  outcome: { readonly chunks: readonly TextChunkDescriptor[] },
  index: number,
): TextChunkDescriptor {
  const found = outcome.chunks[index];
  if (!found) {
    throw new Error(`Expected a chunk at index ${String(index)}.`);
  }
  return found;
}

function omissionAt(
  outcome: { readonly omissions: readonly unknown[] },
  index: number,
): {
  readonly omissionId: string;
  readonly reason: string;
  readonly retrievable: boolean;
  readonly itemCount: number;
  readonly locator: unknown;
} {
  const found = outcome.omissions[index];
  if (typeof found !== 'object' || found === null) {
    throw new Error(`Expected an omission record at index ${String(index)}.`);
  }
  return found as {
    readonly omissionId: string;
    readonly reason: string;
    readonly retrievable: boolean;
    readonly itemCount: number;
    readonly locator: unknown;
  };
}

describe('text chunking policy', () => {
  it('chunks small multi-line sources into one deterministic chunk', () => {
    const outcome = chunk(encode('alpha\nbeta\n'));

    expect(outcome.lineCount).toBe(2);
    expect(outcome.omissions).toEqual([]);
    expect(outcome.chunks).toHaveLength(1);
    const only = chunkAt(outcome, 0);
    expect(only.chunkId).toBe('cv_chunk_000000000001');
    expect(only.byteStart).toBe(0);
    expect(only.byteEndExclusive).toBe(11);
    expect(only.lineStart).toBe(1);
    expect(only.lineEndExclusive).toBe(3);
    expect(only.byteLength).toBe(11);
    expect(only.truncated).toBe(false);
    expect(only.chunkDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(only.chunkDigest).toBe(cryptography.sha256(encode('alpha\nbeta\n')));
  });

  it('splits deterministic chunks along line boundaries at the byte budget', () => {
    const line = 'x'.repeat(100) + '\n';
    const bytes = encode(line.repeat(100));
    const outcome = chunk(bytes, { maxChunkBytes: 350 });

    expect(outcome.lineCount).toBe(100);
    expect(outcome.omissions).toEqual([]);
    // Three 101-byte lines fit within 350 bytes; a fourth would exceed it.
    expect(outcome.chunks).toHaveLength(34);

    const first = chunkAt(outcome, 0);
    expect(first.byteStart).toBe(0);
    expect(first.lineStart).toBe(1);
    expect(first.byteLength).toBe(303);
    expect(first.byteEndExclusive).toBe(first.byteLength);
    expect(first.lineEndExclusive).toBe(first.lineStart + 3);

    const last = chunkAt(outcome, outcome.chunks.length - 1);
    expect(last.byteEndExclusive).toBe(bytes.byteLength);
    expect(last.lineEndExclusive).toBe(101);

    for (let index = 0; index < outcome.chunks.length - 1; index += 1) {
      const previous = chunkAt(outcome, index);
      const next = chunkAt(outcome, index + 1);
      expect(next.byteStart).toBe(previous.byteEndExclusive);
      expect(next.lineStart).toBe(previous.lineEndExclusive);
    }
  });

  it('keeps a single oversized line as its own complete chunk without splitting it', () => {
    const bytes = encode('a\n' + 'y'.repeat(6000) + '\n');
    const outcome = chunk(bytes, { maxChunkBytes: 100 });

    expect(outcome.lineCount).toBe(2);
    expect(outline(outcome.chunks)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: bytes.byteLength },
    ]);
    expect(chunkAt(outcome, 1).byteLength).toBe(6001);
    expect(outcome.omissions).toEqual([]);
  });

  it('covers multibyte UTF-8 characters without ever splitting a code point', () => {
    const bytes = encode('héllo wörld\n'.repeat(40));
    const outcome = chunk(bytes, { maxChunkBytes: 20 });

    let covered = 0;
    for (const descriptor of outcome.chunks) {
      expect(descriptor.byteStart).toBe(covered);
      covered = descriptor.byteEndExclusive;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(descriptor.byteStart, descriptor.byteEndExclusive),
      );
      expect(text.startsWith('héllo wörld\n') || text.endsWith('héllo wörld\n')).toBe(true);
    }
    expect(covered).toBe(bytes.byteLength);
  });

  it('records a machine-readable omission when the chunk budget is exhausted', () => {
    const bytes = encode('line\n'.repeat(60));
    const outcome = chunk(bytes, { maxChunkBytes: 20, maxChunks: 3 });

    // Four 5-byte lines fit within 20 bytes, so three chunks cover 12 lines.
    expect(outcome.chunks).toHaveLength(3);
    expect(outcome.omissions).toHaveLength(1);
    const omission = omissionAt(outcome, 0);
    expect(omission.omissionId).toBe('cv_omit_000000000001');
    expect(omission.reason).toBe('budget');
    expect(omission.retrievable).toBe(false);
    expect(omission.itemCount).toBe(48);
    expect(omission.locator).toEqual({
      kind: 'byte_range',
      value: `${String(chunkAt(outcome, outcome.chunks.length - 1).byteEndExclusive)}-${String(bytes.byteLength)}`,
    });
    expect(chunkAt(outcome, outcome.chunks.length - 1).byteEndExclusive).toBe(60);
  });

  it('handles an empty source without emitting chunks or omissions', () => {
    const outcome = chunk(new Uint8Array(0));
    expect(outcome.lineCount).toBe(0);
    expect(outcome.chunks).toEqual([]);
    expect(outcome.omissions).toEqual([]);
  });

  it('treats a final line without a newline as a complete line', () => {
    const outcome = chunk(encode('one\ntwo'));
    expect(outcome.lineCount).toBe(2);
    // Both short lines fit within one budgeted chunk that spans both lines.
    expect(outline(outcome.chunks)).toEqual([{ start: 0, end: 7 }]);
    expect(chunkAt(outcome, 0).lineStart).toBe(1);
    expect(chunkAt(outcome, 0).lineEndExclusive).toBe(3);
  });

  it('produces identical boundaries and digests for identical bytes and limits', () => {
    const bytes = encode('alpha\nbeta\ngamma\n');
    const first = chunk(bytes);
    const second = chunk(bytes);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('rejects sources beyond the supported line count', () => {
    const bytes = encode('a\n'.repeat(1_000_001));
    expectChunkError(() => chunk(bytes), 'CV_PARSE_LINE_LIMIT_EXCEEDED');
  });

  it('rejects a final partial line that exceeds the supported line count', () => {
    const bytes = encode(`a\n`.repeat(1_000_000) + 'a');
    expectChunkError(() => chunk(bytes), 'CV_PARSE_LINE_LIMIT_EXCEEDED');
  });

  it('accepts a source exactly at the supported line count', () => {
    const bytes = encode('a\n'.repeat(1_000_000));
    const outcome = chunk(bytes);
    expect(outcome.lineCount).toBe(1_000_000);
    // Two-byte lines group 2048 per chunk within the 4096-byte budget.
    expect(outcome.chunks).toHaveLength(489);
    expect(outcome.omissions).toEqual([]);
    expect(chunkAt(outcome, outcome.chunks.length - 1).byteEndExclusive).toBe(bytes.byteLength);
  });

  it('accepts the smallest and largest valid chunk budgets', () => {
    const bytes = encode('one\ntwo\n');
    const minimal = chunk(bytes, { maxChunkBytes: 1 });
    expect(minimal.chunks).toHaveLength(2);
    expect(minimal.omissions).toEqual([]);

    const maximal = chunk(bytes, { maxChunkBytes: Number.MAX_SAFE_INTEGER });
    expect(maximal.chunks).toHaveLength(1);
  });

  it('produces distinct chunk identifiers across a budgeted split', () => {
    const bytes = encode('x\n'.repeat(30));
    const outcome = chunk(bytes, { maxChunkBytes: 20 });
    const identifiers = outcome.chunks.map((descriptor) => descriptor.chunkId);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(identifiers[0]).toBe('cv_chunk_000000000001');
    expect(identifiers.at(-1)).toBe(`cv_chunk_${String(identifiers.length).padStart(12, '0')}`);
  });

  it.each([
    ['zero maxChunkBytes', { maxChunkBytes: 0 }, 'maxChunkBytes'],
    ['negative maxChunks', { maxChunks: -1 }, 'maxChunks'],
    ['fractional maxChunks', { maxChunks: 1.5 }, 'maxChunks'],
  ])('rejects %s as a configuration failure', (_name, overrides, limitName) => {
    expectChunkConfigurationError(() => chunk(encode('a\n'), overrides), limitName);
  });
});

function outline(
  chunks: readonly { readonly byteStart: number; readonly byteEndExclusive: number }[],
): {
  start: number;
  end: number;
}[] {
  return chunks.map((descriptor) => ({
    start: descriptor.byteStart,
    end: descriptor.byteEndExclusive,
  }));
}

function expectChunkError(execute: () => unknown, code: string): void {
  try {
    execute();
    expect.fail(`Expected a ContextVaultError with code ${code}.`);
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
}

function expectChunkConfigurationError(execute: () => unknown, limitName: string): void {
  try {
    execute();
    expect.fail(`Expected a configuration failure naming ${limitName}.`);
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      expect(error.code).toBe('CV_CONFIGURATION_INVALID');
      expect(error.message).toContain(limitName);
      return;
    }
    throw error;
  }
}

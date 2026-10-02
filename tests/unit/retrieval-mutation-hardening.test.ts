import { describe, expect, it, vi, type Mock } from 'vitest';

import type { AuthorizedFileReader } from '../../src/application/ports/authorized-file-reader.js';
import type { InspectionClock } from '../../src/application/ports/inspection-services.js';
import { RetrieveSource } from '../../src/application/retrieval/retrieve-source.js';
import { extractExcerptBytes } from '../../src/application/retrieval/excerpt-extraction.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  selectorInvalid,
  selectorUnsupported,
  validateRetrievalSelector,
} from '../../src/domain/retrieval/retrieval-selector-policy.js';
import {
  validateCapabilityRequest,
  validateGrantRequest,
} from '../../src/domain/retrieval/retrieval-grant-policy.js';
import { NodeCapabilityTokens } from '../../src/infrastructure/crypto/node-capability-tokens.js';
import { NodeInspectionCryptography } from '../../src/infrastructure/inspection/node-inspection-cryptography.js';
import { InMemoryVault } from '../../src/infrastructure/vault/in-memory-vault.js';
import {
  STRICT_PREPARATION_LIMITS,
  validatePreparationLimits,
} from '../../src/domain/preparation/preparation-limits.js';

/**
 * Hardening tests that close mutation survivors in the retrieval surface.
 *
 * - Error factories are asserted for exact code plus non-empty message, so
 *   a "" replacement breaks the output-schema minimum-length contract.
 * - Capability precedence pins that an ill-formed capability fails before
 *   selector validation, killing removal of the pre-filter call.
 * - The Euro-sign case pins the 3-byte BMP path in
 *   utf8ByteLengthOfCodePoint, killing the high-surrogate-only weakening.
 */
describe('retrieval mutation hardening', () => {
  it('pins selector error codes with non-empty messages', () => {
    const invalid = selectorInvalid();
    expect(invalid).toBeInstanceOf(ContextVaultError);
    expect(invalid.code).toBe('CV_INPUT_INVALID');
    expect(invalid.message.length).toBeGreaterThan(0);

    const unsupported = selectorUnsupported();
    expect(unsupported.code).toBe('CV_SELECTOR_UNSUPPORTED');
    expect(unsupported.message.length).toBeGreaterThan(0);
  });

  it('rejects an unknown kind even when line fields look valid', () => {
    let thrown: unknown;
    try {
      validateRetrievalSelector({ kind: 'semantic', startLine: 1, endLine: 2 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContextVaultError);
    expect((thrown as ContextVaultError).code).toBe('CV_INPUT_INVALID');
    expect((thrown as ContextVaultError).message.length).toBeGreaterThan(0);
  });

  it('rejects non-object grant requests with the safe input-invalid code', () => {
    for (const candidate of ['grant', null, ['chunk'], 42]) {
      let thrown: unknown;
      try {
        validateGrantRequest(candidate);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ContextVaultError);
      expect((thrown as ContextVaultError).code).toBe('CV_INPUT_INVALID');
      expect((thrown as ContextVaultError).message.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-object capability requests with the safe input-invalid code', () => {
    for (const candidate of ['nope', null, undefined, 42]) {
      let thrown: unknown;
      try {
        validateCapabilityRequest(candidate);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ContextVaultError);
      expect((thrown as ContextVaultError).code).toBe('CV_INPUT_INVALID');
      expect((thrown as ContextVaultError).message.length).toBeGreaterThan(0);
    }
  });

  it('pins excerpt span and selector error envelopes with non-empty messages', () => {
    const bytes = new TextEncoder().encode('abc');
    const descriptor = {
      preparationKind: 'text_chunks' as const,
      chunks: [
        {
          chunkId: 'cv_chunk_000000000001',
          byteStart: 3,
          byteEndExclusive: 3,
          lineStart: 1,
          lineEndExclusive: 2,
          byteLength: 0,
          chunkDigest: 'sha256:' + 'a'.repeat(64),
          truncated: false,
        },
      ],
      jsonNodes: [],
      bytes,
    };
    let spanThrown: unknown;
    try {
      extractExcerptBytes(descriptor, { kind: 'chunk', chunkId: 'cv_chunk_000000000001' }, 6);
    } catch (error) {
      spanThrown = error;
    }
    expect(spanThrown).toBeInstanceOf(ContextVaultError);
    expect((spanThrown as ContextVaultError).code).toBe('CV_SOURCE_CHANGED');
    expect((spanThrown as ContextVaultError).message.length).toBeGreaterThan(0);

    const validBytes = new TextEncoder().encode('alpha\n');
    const missingDescriptor = {
      preparationKind: 'text_chunks' as const,
      chunks: [],
      jsonNodes: [],
      bytes: validBytes,
    };
    let selectorThrown: unknown;
    try {
      extractExcerptBytes(
        missingDescriptor,
        { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        64,
      );
    } catch (error) {
      selectorThrown = error;
    }
    expect(selectorThrown).toBeInstanceOf(ContextVaultError);
    expect((selectorThrown as ContextVaultError).code).toBe('CV_SELECTOR_UNSUPPORTED');
    expect((selectorThrown as ContextVaultError).message.length).toBeGreaterThan(0);
  });

  it('keeps a 3-byte BMP character exact through json-node byte mapping', () => {
    // U+FFFD is a 3-byte BMP character at 0xFFFD (>= 0xD800 but not a high
    // surrogate). The original returns 3 bytes; a high-surrogate-only
    // weakening (<= 0xDBFF -> true) miscounts it as 4 bytes.
    const text = '{"k":"\uFFFD"}';
    const bytes = new TextEncoder().encode(text);
    expect(new TextEncoder().encode('\uFFFD').byteLength).toBe(3);
    const descriptor = {
      preparationKind: 'json_structure' as const,
      chunks: [],
      jsonNodes: [],
      bytes,
    };
    // cv_node_000002 is the string value '"�"' at characters [5,8).
    // Its exact byte span is [5,10): quote (1) + U+FFFD (3) + quote (1).
    // The weakened mutant returns '"�"}' (6 bytes) instead.
    const excerpt = extractExcerptBytes(
      descriptor,
      {
        kind: 'json_node',
        nodeId: 'cv_node_000002',
      },
      1_048_576,
    );
    expect(new TextDecoder('utf-8', { fatal: true }).decode(excerpt.contentBytes)).toBe('"\uFFFD"');
    expect(excerpt.contentBytes.byteLength).toBe(5);
    expect(excerpt.truncated).toBe(false);
    expect(excerpt.hasMore).toBe(false);
  });

  it('prefers the capability error when both capability and selector are invalid', async () => {
    const harness = createHarness();
    let thrown: unknown;
    try {
      await harness.retrieve.execute({
        capability: 'not-a-capability',
        selector: { kind: 'semantic', query: 'alpha' } as unknown as {
          readonly kind: 'chunk';
          readonly chunkId: string;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContextVaultError);
    expect((thrown as ContextVaultError).code).toBe('CV_CAPABILITY_INVALID');
    expect((thrown as ContextVaultError).message.length).toBeGreaterThan(0);
    expect(harness.read).not.toHaveBeenCalled();
  });

  it('reports truncated excerpts with explicit flags at an exact code-point edge', () => {
    const bytes = new TextEncoder().encode('ab\u20ACcd');
    const descriptor = {
      preparationKind: 'text_chunks' as const,
      chunks: [
        {
          chunkId: 'cv_chunk_000000000001',
          byteStart: 0,
          byteEndExclusive: bytes.byteLength,
          lineStart: 1,
          lineEndExclusive: 2,
          byteLength: bytes.byteLength,
          chunkDigest: 'sha256:' + 'a'.repeat(64),
          truncated: false,
        },
      ],
      jsonNodes: [],
      bytes,
    };
    const full = extractExcerptBytes(
      descriptor,
      { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      bytes.byteLength,
    );
    expect(full.truncated).toBe(false);
    expect(full.hasMore).toBe(false);

    const clipped = extractExcerptBytes(
      descriptor,
      { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      2,
    );
    expect(clipped.truncated).toBe(true);
    expect(clipped.hasMore).toBe(true);
  });

  function createHarness(): {
    readonly retrieve: RetrieveSource;
    readonly read: Mock<AuthorizedFileReader['read']>;
  } {
    const currentMilliseconds = new Date('2026-09-10T12:00:00.000Z').getTime();
    const clock: InspectionClock = { now: (): Date => new Date(currentMilliseconds) };
    const sourceBytes = new TextEncoder().encode('alpha\nbeta\ngamma\n');
    const read = vi.fn<AuthorizedFileReader['read']>(() =>
      Promise.resolve({ bytes: sourceBytes, normalizedRelativePath: 'notes/guide.txt' }),
    );
    const fileReader: AuthorizedFileReader = { read, authorizedRootCount: 1 };
    const cryptography = new NodeInspectionCryptography();
    const capabilityTokens = new NodeCapabilityTokens();
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault('cv_ses_abcdefghijklmnop', limits);
    const retrieve = new RetrieveSource({
      clock,
      cryptography,
      fileReader,
      vault,
      retrievalVault: vault,
      tokenDigester: capabilityTokens,
      digestComparator: capabilityTokens,
    });
    return { retrieve, read };
  }
});

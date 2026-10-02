import { describe, expect, it, vi, type Mock } from 'vitest';

import type { AuthorizedFileReader } from '../../src/application/ports/authorized-file-reader.js';
import type { InspectionClock } from '../../src/application/ports/inspection-services.js';
import type { PreparationVault } from '../../src/application/ports/preparation-services.js';
import type { RetrievalVault } from '../../src/application/ports/retrieval-services.js';
import { PrepareSource } from '../../src/application/preparation/prepare-source.js';
import { PreparationGate } from '../../src/application/preparation/preparation-gate.js';
import { RetrieveSource } from '../../src/application/retrieval/retrieve-source.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  STRICT_PREPARATION_LIMITS,
  validatePreparationLimits,
} from '../../src/domain/preparation/preparation-limits.js';
import type { PreparedEnvelopeRecord } from '../../src/domain/preparation/preparation-types.js';
import { NodeCapabilityTokens } from '../../src/infrastructure/crypto/node-capability-tokens.js';
import { NodeInspectionCryptography } from '../../src/infrastructure/inspection/node-inspection-cryptography.js';
import { NodeOpaqueIdentifiers } from '../../src/infrastructure/preparation/node-opaque-identifiers.js';
import { InMemoryVault } from '../../src/infrastructure/vault/in-memory-vault.js';

const SESSION_ID = 'cv_ses_abcdefghijklmnop';
const OTHER_SESSION_ID = 'cv_ses_other00000000001';
const BASE_MILLISECONDS = new Date('2026-09-10T12:00:00.000Z').getTime();
const PATH = 'notes/guide.txt';

interface Harness {
  readonly prepare: PrepareSource;
  readonly retrieve: RetrieveSource;
  readonly vault: InMemoryVault;
  readonly read: Mock<AuthorizedFileReader['read']>;
  readonly fileReader: AuthorizedFileReader;
  readonly clock: InspectionClock & { advance: (milliseconds: number) => void };
  readonly setSourceBytes: (bytes: Uint8Array) => void;
  readonly setSourcePath: (path: string) => void;
}

function createHarness(sessionId: string = SESSION_ID): Harness {
  let currentMilliseconds = BASE_MILLISECONDS;
  const clock = {
    now: (): Date => new Date(currentMilliseconds),
    advance: (milliseconds: number): void => {
      currentMilliseconds += milliseconds;
    },
  };
  let sourceBytes: Uint8Array = new TextEncoder().encode('alpha\nbeta\ngamma\n');
  let sourcePath = PATH;
  const read = vi.fn<AuthorizedFileReader['read']>(() =>
    Promise.resolve({
      bytes: sourceBytes,
      normalizedRelativePath: sourcePath,
    }),
  );
  const fileReader: AuthorizedFileReader = { read, authorizedRootCount: 1 };
  const cryptography = new NodeInspectionCryptography();
  const capabilityTokens = new NodeCapabilityTokens();
  const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
  const vault = new InMemoryVault(sessionId, limits);
  const prepare = new PrepareSource(
    {
      clock,
      cryptography,
      fileReader,
      vault,
      identifiers: new NodeOpaqueIdentifiers(),
      limits,
      tokens: capabilityTokens,
      tokenDigester: capabilityTokens,
    },
    new PreparationGate(limits.maxConcurrentPreparations),
  );
  const retrieve = new RetrieveSource({
    clock,
    cryptography,
    fileReader,
    vault,
    retrievalVault: vault,
    tokenDigester: capabilityTokens,
    digestComparator: capabilityTokens,
  });
  return {
    prepare,
    retrieve,
    vault,
    read,
    fileReader,
    clock,
    setSourceBytes: (bytes: Uint8Array): void => {
      sourceBytes = bytes;
    },
    setSourcePath: (path: string): void => {
      sourcePath = path;
    },
  };
}

async function prepareWithGrant(
  harness: Harness,
  overrides: Record<string, unknown> = {},
): Promise<{ envelopeId: string; capability: string; sourceDigest: string }> {
  const prepared = await harness.prepare.execute({
    source: { kind: 'workspace_file', rootId: 'repo', path: PATH },
    retrieval: {
      allowedSelectorTypes: ['chunk', 'line_range'],
      maxBytes: 4096,
      ttlSeconds: 600,
      ...overrides,
    },
  });
  const retrieval = prepared.envelope.retrieval;
  if (!retrieval) {
    throw new Error('Expected a retrieval grant to be issued.');
  }
  return {
    envelopeId: prepared.envelope.envelopeId,
    capability: retrieval.capability,
    sourceDigest: prepared.envelope.sourceDigest,
  };
}

async function expectRetrieveError(
  execute: () => Promise<unknown>,
  code: string,
): Promise<ContextVaultError> {
  try {
    await execute();
    expect.fail(`Expected a ContextVaultError with code ${code}.`);
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
}

describe('RetrieveSource happy paths', () => {
  it('returns the exact chunk bytes with provenance metadata', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    const result = await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });

    const expectedBytes = new TextEncoder().encode('alpha\nbeta\ngamma\n');
    expect(result.schemaVersion).toBe('1.0');
    expect(result.ok).toBe(true);
    expect(result.envelopeId).toBe(grant.envelopeId);
    expect(result.sourceDigest).toBe(grant.sourceDigest);
    expect(result.sourceId).toMatch(/^cv_src_/u);
    expect(result.content).toBe('alpha\nbeta\ngamma\n');
    expect(result.byteCount).toBe(expectedBytes.byteLength);
    expect(result.excerptDigest).toBe(new NodeInspectionCryptography().sha256(expectedBytes));
    expect(result.truncated).toBe(false);
    expect(result.hasMore).toBe(false);
    expect(result.locator).toEqual({ kind: 'chunk', value: 'cv_chunk_000000000001' });

    const provenance = harness.vault.listProvenanceForEnvelope(grant.envelopeId);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({
      envelopeId: grant.envelopeId,
      sourceDigest: grant.sourceDigest,
      selectorKind: 'chunk',
      excerptDigest: result.excerptDigest,
      byteCount: expectedBytes.byteLength,
      truncated: false,
    });
  });

  it('returns an exact bounded line range with the echoed selector', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    const result = await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 2, endLine: 3 },
    });

    expect(result.content).toBe('beta\ngamma\n');
    expect(result.selector).toEqual({ kind: 'line_range', startLine: 2, endLine: 3 });
    expect(result.locator).toEqual({ kind: 'line_range', value: '2-3' });
    expect(result.truncated).toBe(false);
    expect(result.hasMore).toBe(false);
  });

  it('returns the exact bytes of a later chunk with a nonzero start', async () => {
    const harness = createHarness();
    // Two chunks: the second chunk starts past byte zero, so a start/end
    // confusion in span arithmetic would surface here.
    const firstHalf = 'alpha\nbeta\n';
    const secondHalf = 'gamma delta\n'.repeat(400);
    const sourceBytes = new TextEncoder().encode(`${firstHalf}${secondHalf}`);
    harness.setSourceBytes(sourceBytes);
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: PATH },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    const secondChunk = prepared.envelope.chunks[1];
    if (!capability || !secondChunk) {
      throw new Error('Expected a grant and a second chunk descriptor.');
    }
    expect(secondChunk.byteStart).toBeGreaterThan(0);

    const result = await harness.retrieve.execute({
      capability,
      selector: { kind: 'chunk', chunkId: secondChunk.chunkId },
    });

    // The excerpt must match the prepared descriptor span byte-for-byte.
    const expectedBytes = sourceBytes.slice(secondChunk.byteStart, secondChunk.byteEndExclusive);
    expect(result.content).toBe(new TextDecoder().decode(expectedBytes));
    expect(result.byteCount).toBe(expectedBytes.byteLength);
    expect(result.truncated).toBe(false);
    expect(result.hasMore).toBe(false);
  });

  it('returns exact bytes for a JSON node span without re-serialization', async () => {
    const jsonSource = '{"a": 1, "b": [true, "x"]}\n';
    const harness = createHarness();
    harness.setSourceBytes(new TextEncoder().encode(jsonSource));
    harness.setSourcePath('data.json');
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'data.json' },
      retrieval: {
        allowedSelectorTypes: ['json_node', 'line_range'],
        maxBytes: 4096,
        ttlSeconds: 600,
      },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant for the JSON source.');
    }
    // Node 1 is the root object, node 2 the value of "a", node 3 the
    // array under "b", node 4 the `true` element, node 5 the "x" element.
    const result = await harness.retrieve.execute({
      capability,
      selector: { kind: 'json_node', nodeId: 'cv_node_000003' },
    });

    expect(result.content).toBe('[true, "x"]');
    expect(result.selector).toEqual({ kind: 'json_node', nodeId: 'cv_node_000003' });
    expect(result.locator).toEqual({ kind: 'json_node', value: 'cv_node_000003' });
    expect(new TextEncoder().encode(result.content)).toEqual(
      new TextEncoder().encode('[true, "x"]'),
    );
    // Exactness means the bytes occur verbatim in the original source.
    expect(jsonSource).toContain(result.content);
  });

  it('handles multibyte JSON node spans with exact byte offsets', async () => {
    const jsonSource = '{"emoji": "héllo ✓ 😀", "n": 2}\n';
    const harness = createHarness();
    harness.setSourceBytes(new TextEncoder().encode(jsonSource));
    harness.setSourcePath('emoji.json');
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'emoji.json' },
      retrieval: { allowedSelectorTypes: ['json_node'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant for the JSON source.');
    }
    // Node 2 is the string value holding the multibyte text.
    const result = await harness.retrieve.execute({
      capability,
      selector: { kind: 'json_node', nodeId: 'cv_node_000002' },
    });

    expect(result.content).toBe('"héllo ✓ 😀"');
    expect(result.byteCount).toBe(new TextEncoder().encode('"héllo ✓ 😀"').byteLength);
    expect(jsonSource).toContain(result.content);
  });

  it('maps node spans exactly at UTF-8 length boundaries', async () => {
    // Characters exactly on the 1/2/3/4-byte boundaries pin the byte
    // walker: U+0080, U+0800, U+10000 (lead 0xD800), U+10FC00 (lead 0xDBFF).
    // Escapes keep the exact code points visible and reviewable.
    const boundaryText = 'ࠀ'.concat(String.fromCodePoint(0x10000, 0x10fc00), '€');
    expect(boundaryText.codePointAt(0)).toBe(0x80);
    expect(boundaryText.codePointAt(1)).toBe(0x800);
    expect(boundaryText.codePointAt(2)).toBe(0x10000);
    expect(boundaryText.codePointAt(4)).toBe(0x10fc00);
    expect(boundaryText.codePointAt(6)).toBe(0x20ac);
    const jsonSource = `{"bounds": "${boundaryText}"}`;
    const harness = createHarness();
    harness.setSourceBytes(new TextEncoder().encode(jsonSource));
    harness.setSourcePath('bounds.json');
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'bounds.json' },
      retrieval: { allowedSelectorTypes: ['json_node'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant for the JSON source.');
    }
    const result = await harness.retrieve.execute({
      capability,
      selector: { kind: 'json_node', nodeId: 'cv_node_000002' },
    });

    expect(result.content).toBe(`"${boundaryText}"`);
    expect(result.byteCount).toBe(new TextEncoder().encode(`"${boundaryText}"`).byteLength);
    expect(jsonSource).toContain(result.content);
  });

  it('maps node spans with only three-byte characters exactly', async () => {
    // No astral character is present to cancel a lead-classification
    // error: every miscount accumulates in the same direction.
    const jsonSource = '{"marks": "✓€✓"}';
    const harness = createHarness();
    harness.setSourceBytes(new TextEncoder().encode(jsonSource));
    harness.setSourcePath('marks.json');
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'marks.json' },
      retrieval: { allowedSelectorTypes: ['json_node'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant for the JSON source.');
    }
    const result = await harness.retrieve.execute({
      capability,
      selector: { kind: 'json_node', nodeId: 'cv_node_000002' },
    });

    expect(result.content).toBe('"✓€✓"');
    expect(result.byteCount).toBe(new TextEncoder().encode('"✓€✓"').byteLength);
    expect(jsonSource).toContain(result.content);
  });

  it('truncates to the strictest byte budget on a UTF-8 boundary', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness, { maxBytes: 11 });

    const result = await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 1, endLine: 3 },
    });

    expect(result.content).toBe('alpha\nbeta\n');
    expect(result.byteCount).toBe(11);
    expect(result.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
  });

  it('asserts the digest and source binding when the budget clips at a code-point boundary', async () => {
    const harness = createHarness();
    harness.setSourceBytes(new TextEncoder().encode('héllo wörld\n'));
    const grant = await prepareWithGrant(harness, { maxBytes: 3 });

    const result = await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 1, endLine: 1 },
    });

    expect(result.content).toBe('hé');
    expect(result.byteCount).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
    // The excerpt digest is the digest of the exact returned bytes.
    expect(result.excerptDigest).toBe(
      new NodeInspectionCryptography().sha256(new TextEncoder().encode('hé')),
    );
    // The disclosed source digest is the prepared source's digest, pinned by the binding.
    expect(result.sourceDigest).toBe(grant.sourceDigest);
  });

  it('asserts an exact, untruncated digest when the budget consumes the whole span', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness, { maxBytes: 6 });

    const result = await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 1, endLine: 1 },
    });

    expect(result.content).toBe('alpha\n');
    expect(result.byteCount).toBe(6);
    expect(result.truncated).toBe(false);
    expect(result.hasMore).toBe(false);
    expect(result.excerptDigest).toBe(
      new NodeInspectionCryptography().sha256(new TextEncoder().encode('alpha\n')),
    );
  });

  it('backs off a byte budget that lands inside a multi-byte character', async () => {
    const harness = createHarness();
    harness.setSourceBytes(new TextEncoder().encode('héllo wörld\n'));
    const grant = await prepareWithGrant(harness, { maxBytes: 2 });

    const result = await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 1, endLine: 1 },
    });

    // 'h' is one byte and 'é' needs two: a budget of 2 would cut 'é' in
    // half, so the excerpt ends after 'h' and reports truncation.
    expect(result.content).toBe('h');
    expect(result.byteCount).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(result.content)),
    ).not.toThrow();
  });

  it('keeps a budget that ends exactly on a multi-byte boundary whole', async () => {
    const harness = createHarness();
    harness.setSourceBytes(new TextEncoder().encode('héllo wörld\n'));
    const grant = await prepareWithGrant(harness, { maxBytes: 3 });

    const result = await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 1, endLine: 1 },
    });

    // 'h' plus 'é' is exactly three bytes: nothing is cut.
    expect(result.content).toBe('hé');
    expect(result.byteCount).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
  });

  it('reports an exact excerpt when the content matches the budget precisely', async () => {
    const harness = createHarness();
    // 'alpha\n' is exactly six bytes: the budget boundary coincides with
    // the content end, so nothing is truncated and nothing remains.
    const grant = await prepareWithGrant(harness, { maxBytes: 6 });

    const result = await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 1, endLine: 1 },
    });

    expect(result.content).toBe('alpha\n');
    expect(result.byteCount).toBe(6);
    expect(result.truncated).toBe(false);
    expect(result.hasMore).toBe(false);
  });

  it('a smaller request budget wins over a larger grant budget', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness, { maxBytes: 4096 });

    const result = await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 1, endLine: 3 },
      maxBytes: 6,
    });

    expect(result.content).toBe('alpha\n');
    expect(result.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
  });

  it('leaves the source buffers out of server state after the operation', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });

    const serialized = JSON.stringify(harness.vault.list());
    expect(serialized).not.toContain('alpha');
    expect(serialized).not.toContain('beta');
  });
});

describe('RetrieveSource capability failures', () => {
  it('rejects retrieval without any grant through the generic capability error', async () => {
    const harness = createHarness();
    await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: PATH },
    });

    const error = await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: `cv1_${'a'.repeat(43)}`,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_CAPABILITY_INVALID',
    );
    expect(JSON.stringify(error)).not.toContain(PATH);
  });

  it.each([
    ['a tampered character', 'tampered'],
    ['a foreign well-formed token', `cv1_${'b'.repeat(43)}`],
    ['a wrong prefix', `cv2_${'a'.repeat(43)}`],
    ['a truncated token', 'cv1_short'],
  ])('rejects %s with no distinguishing detail', async (_name, variant) => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);
    const tampered =
      variant === 'tampered'
        ? `${grant.capability.slice(0, -1)}${grant.capability.endsWith('a') ? 'b' : 'a'}`
        : variant;

    const error = await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: tampered,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_CAPABILITY_INVALID',
    );
    expect(JSON.stringify(error)).not.toContain(grant.envelopeId);
  });

  it('rejects an expired grant with the same generic error', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness, { ttlSeconds: 60 });

    harness.clock.advance(60 * 1000);

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: grant.capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_CAPABILITY_INVALID',
    );
  });

  it('rejects a grant replayed in a different private session', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    const other = createHarness(OTHER_SESSION_ID);
    await expectRetrieveError(
      () =>
        other.retrieve.execute({
          capability: grant.capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_CAPABILITY_INVALID',
    );
  });

  it('rejects retrieval after the purge removed the envelope and its grant', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);
    const envelopeId = harness.vault.list()[0]?.envelopeId;
    if (envelopeId === undefined) {
      throw new Error('Expected a prepared envelope.');
    }
    harness.vault.removeEnvelopeWithDerived(envelopeId);

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: grant.capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_CAPABILITY_INVALID',
    );
  });

  it('rejects a selector outside the grant allowlist', async () => {
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: PATH },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant.');
    }

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability,
          selector: { kind: 'line_range', startLine: 1, endLine: 1 },
        }),
      'CV_CAPABILITY_INVALID',
    );
  });
});

describe('RetrieveSource freshness and binding failures', () => {
  it('rejects a replaced source whose digest no longer matches', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    harness.setSourceBytes(new TextEncoder().encode('alpha\nbeta\nZZ-REPLACED-zz\n'));

    const error = await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: grant.capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_SOURCE_CHANGED',
    );
    expect(JSON.stringify(error)).not.toContain('ZZ-REPLACED-zz');
  });

  it('rejects a source that grew after preparation', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    harness.setSourceBytes(new TextEncoder().encode('alpha\nbeta\ngamma\ndelta\n'));

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: grant.capability,
          selector: { kind: 'line_range', startLine: 1, endLine: 4 },
        }),
      'CV_SOURCE_CHANGED',
    );
  });

  it('rejects an unknown chunk identifier for the envelope', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: grant.capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000999' },
        }),
      'CV_SELECTOR_UNSUPPORTED',
    );
  });

  it('rejects a line range that starts beyond the prepared lines', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: grant.capability,
          selector: { kind: 'line_range', startLine: 99, endLine: 100 },
        }),
      'CV_SELECTOR_UNSUPPORTED',
    );
  });

  it('returns an exact line range from a JSON envelope', async () => {
    const jsonSource = '{"a": 1,\n"b": 2}\n';
    const harness = createHarness();
    harness.setSourceBytes(new TextEncoder().encode(jsonSource));
    harness.setSourcePath('data.json');
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'data.json' },
      retrieval: { allowedSelectorTypes: ['line_range'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant.');
    }

    const result = await harness.retrieve.execute({
      capability,
      selector: { kind: 'line_range', startLine: 2, endLine: 2 },
    });

    expect(result.content).toBe('"b": 2}\n');
    expect(result.truncated).toBe(false);
    expect(result.hasMore).toBe(false);
  });

  it('rejects a malformed retrieval request before any state access', async () => {
    const harness = createHarness();
    await prepareWithGrant(harness);

    await expectRetrieveError(
      () => harness.retrieve.execute('not-an-object' as never),
      'CV_INPUT_INVALID',
    );
    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: `cv1_${'a'.repeat(43)}`,
        } as never),
      'CV_INPUT_INVALID',
    );
  });

  it('forwards the caller signal to the authorized file reader', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    harness.read.mockImplementationOnce((request) => {
      observedSignal = request.signal;
      return Promise.resolve({
        bytes: new TextEncoder().encode('alpha\nbeta\ngamma\n'),
        normalizedRelativePath: PATH,
      });
    });

    await harness.retrieve.execute(
      {
        capability: grant.capability,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
      controller.signal,
    );

    expect(observedSignal).toBe(controller.signal);
  });

  it('rejects a cancellation that lands while the read is in flight', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);
    const controller = new AbortController();
    let releaseRead: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const parkedRead: AuthorizedFileReader['read'] = () =>
      gate.then(() => ({
        bytes: new TextEncoder().encode('alpha\nbeta\ngamma\n'),
        normalizedRelativePath: PATH,
      }));
    harness.read.mockImplementationOnce(parkedRead);

    const pending = harness.retrieve.execute(
      {
        capability: grant.capability,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      },
      controller.signal,
    );
    controller.abort();
    releaseRead?.();

    const error = await expectRetrieveError(() => pending, 'CV_OPERATION_CANCELLED');
    expect(error.retryable).toBe(true);
    expect(harness.vault.listProvenanceForEnvelope(grant.envelopeId)).toHaveLength(0);
  });

  it('denies retrieval from an expired envelope even with a live grant', async () => {
    // The vault permits committing a grant that outlives its envelope;
    // the use case must still refuse to disclose from expired state.
    const harness = createHarness();
    const sourceBytes = new TextEncoder().encode('alpha\n');
    const cryptography = new NodeInspectionCryptography();
    const digest = cryptography.sha256(sourceBytes);
    const record: PreparedEnvelopeRecord = Object.freeze({
      envelopeId: 'cv_env_shortlived00001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 60 * 1000),
      rootId: 'repo',
      normalizedRelativePath: PATH,
      sourceId: cryptography.sourceId('repo', PATH, digest),
      sourceDigest: digest,
      mediaType: 'text/plain',
      bytes: sourceBytes.byteLength,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks',
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
      retrievalAllowed: true,
      lineCount: 1,
      structuralFingerprint: digest,
      derivedBytes: 64,
      chunks: [
        Object.freeze({
          chunkId: 'cv_chunk_000000000001',
          byteStart: 0,
          byteEndExclusive: sourceBytes.byteLength,
          lineStart: 1,
          lineEndExclusive: 2,
          byteLength: sourceBytes.byteLength,
          chunkDigest: digest,
          truncated: false,
        }),
      ],
      jsonNodes: [],
      omissions: [],
    });
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();
    harness.setSourceBytes(sourceBytes);
    harness.vault.commitEnvelope(record, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      allowedSelectorTypes: ['chunk'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });
    harness.clock.advance(61 * 1000);

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_ENVELOPE_NOT_FOUND',
    );
  });

  it('fails closed exactly at the retrieval deadline instant', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);
    const parkedBytes: Uint8Array = new TextEncoder().encode('alpha\nbeta\ngamma\n');
    const advancingRead: AuthorizedFileReader['read'] = () => {
      harness.clock.advance(30_000);
      return Promise.resolve({ bytes: parkedBytes, normalizedRelativePath: PATH });
    };
    harness.read.mockImplementationOnce(advancingRead);

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: grant.capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_DEADLINE_EXCEEDED',
    );
  });

  it('rejects a JSON node identifier beyond the emission cap', async () => {
    const harness = createHarness();
    harness.setSourceBytes(new TextEncoder().encode('{"a": 1}\n'));
    harness.setSourcePath('data.json');
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'data.json' },
      retrieval: { allowedSelectorTypes: ['json_node'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const capability = prepared.envelope.retrieval?.capability;
    if (!capability) {
      throw new Error('Expected a retrieval grant.');
    }

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability,
          selector: { kind: 'json_node', nodeId: 'cv_node_009999' },
        }),
      'CV_SELECTOR_UNSUPPORTED',
    );
  });

  it('rejects a prepared span that no longer fits the source', async () => {
    // A hand-committed record simulates a mislabeled envelope whose chunk
    // bounds exceed the digest-verified source: the span check fails
    // closed instead of slicing out of bounds.
    const harness = createHarness();
    const sourceBytes = new TextEncoder().encode('alpha\n');
    const cryptography = new NodeInspectionCryptography();
    const digest = cryptography.sha256(sourceBytes);
    const record: PreparedEnvelopeRecord = Object.freeze({
      envelopeId: 'cv_env_mislabeled000001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      rootId: 'repo',
      normalizedRelativePath: PATH,
      sourceId: cryptography.sourceId('repo', PATH, digest),
      sourceDigest: digest,
      mediaType: 'text/plain',
      bytes: sourceBytes.byteLength,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks',
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
      retrievalAllowed: true,
      lineCount: 1,
      structuralFingerprint: digest,
      derivedBytes: 64,
      chunks: [
        Object.freeze({
          chunkId: 'cv_chunk_000000000001',
          byteStart: 0,
          byteEndExclusive: sourceBytes.byteLength + 64,
          lineStart: 1,
          lineEndExclusive: 2,
          byteLength: sourceBytes.byteLength + 64,
          chunkDigest: digest,
          truncated: false,
        }),
      ],
      jsonNodes: [],
      omissions: [],
    });
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();
    harness.setSourceBytes(sourceBytes);
    harness.vault.commitEnvelope(record, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      allowedSelectorTypes: ['chunk'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_SOURCE_CHANGED',
    );
  });

  it('rejects a zero-length prepared span without slicing', async () => {
    // A hand-committed record simulates a mislabeled envelope whose chunk
    // span is empty: the span check fails closed instead of returning an
    // empty excerpt as if it were exact.
    const harness = createHarness();
    const sourceBytes = new TextEncoder().encode('alpha\n');
    const cryptography = new NodeInspectionCryptography();
    const digest = cryptography.sha256(sourceBytes);
    const record: PreparedEnvelopeRecord = Object.freeze({
      envelopeId: 'cv_env_zerospan00000001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      rootId: 'repo',
      normalizedRelativePath: PATH,
      sourceId: cryptography.sourceId('repo', PATH, digest),
      sourceDigest: digest,
      mediaType: 'text/plain',
      bytes: sourceBytes.byteLength,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks',
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
      retrievalAllowed: true,
      lineCount: 1,
      structuralFingerprint: digest,
      derivedBytes: 64,
      chunks: [
        Object.freeze({
          chunkId: 'cv_chunk_000000000001',
          byteStart: 3,
          byteEndExclusive: 3,
          lineStart: 1,
          lineEndExclusive: 2,
          byteLength: 0,
          chunkDigest: digest,
          truncated: false,
        }),
      ],
      jsonNodes: [],
      omissions: [],
    });
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();
    harness.setSourceBytes(sourceBytes);
    harness.vault.commitEnvelope(record, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      allowedSelectorTypes: ['chunk'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_SOURCE_CHANGED',
    );
  });

  it('rejects a negative prepared span start without clamping', async () => {
    // A hand-committed record simulates a mislabeled envelope whose chunk
    // starts before byte zero: slicing would clamp and disclose the wrong
    // span, so the span check must fail closed instead.
    const harness = createHarness();
    const sourceBytes = new TextEncoder().encode('alpha\n');
    const cryptography = new NodeInspectionCryptography();
    const digest = cryptography.sha256(sourceBytes);
    const record: PreparedEnvelopeRecord = Object.freeze({
      envelopeId: 'cv_env_negspan00000001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      rootId: 'repo',
      normalizedRelativePath: PATH,
      sourceId: cryptography.sourceId('repo', PATH, digest),
      sourceDigest: digest,
      mediaType: 'text/plain',
      bytes: sourceBytes.byteLength,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks',
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
      retrievalAllowed: true,
      lineCount: 1,
      structuralFingerprint: digest,
      derivedBytes: 64,
      chunks: [
        Object.freeze({
          chunkId: 'cv_chunk_000000000001',
          byteStart: -5,
          byteEndExclusive: sourceBytes.byteLength,
          lineStart: 1,
          lineEndExclusive: 2,
          byteLength: sourceBytes.byteLength + 5,
          chunkDigest: digest,
          truncated: false,
        }),
      ],
      jsonNodes: [],
      omissions: [],
    });
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();
    harness.setSourceBytes(sourceBytes);
    harness.vault.commitEnvelope(record, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      allowedSelectorTypes: ['chunk'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_SOURCE_CHANGED',
    );
  });

  it('rejects a chunk selector against a JSON envelope', async () => {
    // A grant never authorizes a chunk selector for a JSON envelope
    // through honest preparation (narrowing filters it), so the
    // envelope-kind check is exercised with a hand-committed record that
    // simulates a mislabeled envelope: the grant allows `chunk`, the
    // envelope claims `json_structure`, yet carries a well-formed chunk
    // descriptor, so only the kind check can deny the request.
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: PATH },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const record = harness.vault.list()[0];
    const capability = prepared.envelope.retrieval?.capability;
    if (!record || !capability) {
      throw new Error('Expected a prepared envelope with a grant.');
    }
    const mislabeled: PreparedEnvelopeRecord = Object.freeze({
      ...record,
      envelopeId: 'cv_env_mislabeled000001',
      preparationKind: 'json_structure',
    });
    const tokens = new NodeCapabilityTokens();
    const secondCapability = tokens.createCapabilityToken();
    harness.vault.commitEnvelope(mislabeled, {
      tokenDigest: tokens.digestCapabilityToken(secondCapability),
      allowedSelectorTypes: ['chunk'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: secondCapability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_SELECTOR_UNSUPPORTED',
    );
  });

  it('rejects a node selector against a text envelope before any rescan', async () => {
    // Only the envelope-kind check can deny this request with
    // CV_SELECTOR_UNSUPPORTED: without it the use case would rescan the
    // non-JSON source and fail with CV_JSON_MALFORMED instead.
    const harness = createHarness();
    const prepared = await harness.prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: PATH },
      retrieval: { allowedSelectorTypes: ['chunk'], maxBytes: 4096, ttlSeconds: 600 },
    });
    const record = harness.vault.list()[0];
    if (!record || !prepared.envelope.retrieval) {
      throw new Error('Expected a prepared envelope with a grant.');
    }
    const widened: PreparedEnvelopeRecord = Object.freeze({
      ...record,
      envelopeId: 'cv_env_widened00000001',
    });
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();
    harness.vault.commitEnvelope(widened, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      allowedSelectorTypes: ['json_node'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability,
          selector: { kind: 'json_node', nodeId: 'cv_node_000001' },
        }),
      'CV_SELECTOR_UNSUPPORTED',
    );
  });

  it('rejects a line selector against a minimal envelope', async () => {
    // Only the envelope-kind check can deny this request: without it the
    // use case would slice lines from a minimal envelope and disclose
    // content the preparation deliberately withheld.
    const harness = createHarness();
    const sourceBytes = new TextEncoder().encode('alpha\n');
    const cryptography = new NodeInspectionCryptography();
    const digest = cryptography.sha256(sourceBytes);
    const record: PreparedEnvelopeRecord = Object.freeze({
      envelopeId: 'cv_env_minimal00000001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      rootId: 'repo',
      normalizedRelativePath: PATH,
      sourceId: cryptography.sourceId('repo', PATH, digest),
      sourceDigest: digest,
      mediaType: 'text/plain',
      bytes: sourceBytes.byteLength,
      sensitivity: 'internal',
      secretRisk: 'suspected',
      preparationKind: 'minimal',
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
      retrievalAllowed: true,
      lineCount: 0,
      structuralFingerprint: digest,
      derivedBytes: 64,
      chunks: [],
      jsonNodes: [],
      omissions: [],
    });
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();
    harness.setSourceBytes(sourceBytes);
    harness.vault.commitEnvelope(record, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      allowedSelectorTypes: ['line_range'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });

    await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability,
          selector: { kind: 'line_range', startLine: 1, endLine: 1 },
        }),
      'CV_SELECTOR_UNSUPPORTED',
    );
  });

  it('denies a confirmed-secret excerpt through the second policy barrier', async () => {
    const harness = createHarness();
    const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const secretBytes = new TextEncoder().encode(`${marker}\nline two\n`);
    const cryptography = new NodeInspectionCryptography();
    const digest = cryptography.sha256(secretBytes);
    const sourceId = cryptography.sourceId('repo', PATH, digest);
    const envelopeRecord: PreparedEnvelopeRecord = Object.freeze({
      envelopeId: 'cv_env_secret0000000001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      rootId: 'repo',
      normalizedRelativePath: PATH,
      sourceId,
      sourceDigest: digest,
      mediaType: 'text/plain',
      bytes: secretBytes.byteLength,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks',
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
      retrievalAllowed: true,
      lineCount: 2,
      structuralFingerprint: digest,
      derivedBytes: 64,
      chunks: [
        Object.freeze({
          chunkId: 'cv_chunk_000000000001',
          byteStart: 0,
          byteEndExclusive: secretBytes.byteLength,
          lineStart: 1,
          lineEndExclusive: 3,
          byteLength: secretBytes.byteLength,
          chunkDigest: digest,
          truncated: false,
        }),
      ],
      jsonNodes: [],
      omissions: [],
    });
    const capability = `cv1_${'s'.repeat(43)}`;
    const tokenDigest = new NodeCapabilityTokens().digestCapabilityToken(capability);
    harness.setSourceBytes(secretBytes);
    harness.vault.commitEnvelope(envelopeRecord, {
      tokenDigest,
      allowedSelectorTypes: ['chunk'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });

    const error = await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_RETRIEVAL_POLICY_DENIED',
    );
    expect(error.safeDetails).toEqual({ reason: 'secret_policy' });
    expect(JSON.stringify(error)).not.toContain('PRIVATE KEY');
  });
});

describe('RetrieveSource lifecycle', () => {
  it('rejects a cancelled retrieval before any disclosure', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);
    const controller = new AbortController();
    controller.abort();

    const error = await expectRetrieveError(
      () =>
        harness.retrieve.execute(
          {
            capability: grant.capability,
            selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
          },
          controller.signal,
        ),
      'CV_OPERATION_CANCELLED',
    );
    expect(error.retryable).toBe(true);
    expect(harness.vault.listProvenanceForEnvelope(grant.envelopeId)).toHaveLength(0);
  });

  it('rejects an already-aborted signal before the authorized reader is invoked', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);
    const controller = new AbortController();
    controller.abort();

    // Preparation already read the source; zero the counter so only the
    // retrieval's own read is observed.
    harness.read.mockClear();

    await expectRetrieveError(
      () =>
        harness.retrieve.execute(
          {
            capability: grant.capability,
            selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
          },
          controller.signal,
        ),
      'CV_OPERATION_CANCELLED',
    );
    // The pre-work cancel check must throw before the use case's only await
    // (the authorized read) is reached; a removed first check would invoke the
    // reader and only be rejected after that read returned.
    expect(harness.read).not.toHaveBeenCalled();
    expect(harness.vault.listProvenanceForEnvelope(grant.envelopeId)).toHaveLength(0);
  });

  it('fails retrieval racing a purge to the generic capability error', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    // The read parks until the purge runs; the post-read binding checks
    // then observe the revoked grant instead of the removed envelope.
    let releaseRead: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const parkedBytes: Uint8Array = new TextEncoder().encode('alpha\nbeta\ngamma\n');
    const parkedRead: AuthorizedFileReader['read'] = () =>
      gate.then(() => ({ bytes: parkedBytes, normalizedRelativePath: PATH }));
    harness.read.mockImplementationOnce(parkedRead);

    const pending = harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });
    harness.vault.removeEnvelopeWithDerived(grant.envelopeId);
    releaseRead?.();

    await expectRetrieveError(() => pending, 'CV_CAPABILITY_INVALID');
    expect(harness.vault.listProvenanceForEnvelope(grant.envelopeId)).toHaveLength(0);
  });

  it('records one bounded provenance entry per successful retrieval', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);

    await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 1, endLine: 1 },
    });
    await harness.retrieve.execute({
      capability: grant.capability,
      selector: { kind: 'line_range', startLine: 2, endLine: 2 },
    });

    expect(harness.vault.listProvenanceForEnvelope(grant.envelopeId)).toHaveLength(2);
  });
});

describe('RetrieveSource live-state revalidation', () => {
  function retrieveWithFabricatedGrant(
    harness: Harness,
    grant: {
      tokenDigest: string;
      sessionId: string;
      envelopeId: string;
      sourceId: string;
      sourceDigest: string;
    },
  ): { retrieve: RetrieveSource; tokens: NodeCapabilityTokens } {
    const tokens = new NodeCapabilityTokens();
    const retrievalVault: RetrievalVault = {
      findGrantByTokenDigest: (digest: string) =>
        digest === grant.tokenDigest
          ? {
              tokenDigest: grant.tokenDigest,
              sessionId: grant.sessionId,
              envelopeId: grant.envelopeId,
              sourceId: grant.sourceId,
              sourceDigest: grant.sourceDigest,
              allowedSelectorTypes: ['chunk'],
              maxBytes: 4096,
              expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
              revoked: false,
            }
          : undefined,
      countActiveGrants: () => 1,
      appendProvenance: (): void => {
        // Provenance writes are irrelevant to binding revalidation.
      },
      listProvenanceForEnvelope: () => [],
    };
    const vault: PreparationVault = harness.vault;
    const retrieve = new RetrieveSource({
      clock: harness.clock,
      cryptography: new NodeInspectionCryptography(),
      fileReader: harness.fileReader,
      vault,
      retrievalVault,
      tokenDigester: tokens,
      digestComparator: tokens,
    });
    return { retrieve, tokens };
  }

  it.each([
    ['a mismatched source digest', 'sourceDigest'],
    ['a mismatched source identity', 'sourceId'],
    ['a mismatched envelope binding', 'envelopeId'],
  ])('rejects a grant with %s against the live envelope', async (_name, field) => {
    const harness = createHarness();
    await prepareWithGrant(harness);
    const envelope = harness.vault.list()[0];
    if (!envelope) {
      throw new Error('Expected a prepared envelope.');
    }
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();
    // Only the named binding field diverges; every other grant check
    // passes, so only the binding comparison can deny the request.
    // A divergent envelope binding points at a missing envelope.
    const bindings = {
      envelopeId: envelope.envelopeId,
      sourceId: envelope.sourceId,
      sourceDigest: envelope.sourceDigest,
    };
    const divergent =
      field === 'envelopeId'
        ? 'cv_env_divergent0000001'
        : field === 'sourceId'
          ? 'cv_src_divergent0000001'
          : `sha256:${'f'.repeat(64)}`;
    const { retrieve } = retrieveWithFabricatedGrant(harness, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      sessionId: SESSION_ID,
      ...bindings,
      [field]: divergent,
    });

    const expected = field === 'envelopeId' ? 'CV_ENVELOPE_NOT_FOUND' : 'CV_CAPABILITY_INVALID';
    const error = await expectRetrieveError(
      () =>
        retrieve.execute({
          capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      expected,
    );
    expect(JSON.stringify(error)).not.toContain(envelope.envelopeId);
  });

  it('rejects a grant bound to a foreign private session', async () => {
    const harness = createHarness();
    await prepareWithGrant(harness);
    const envelope = harness.vault.list()[0];
    if (!envelope) {
      throw new Error('Expected a prepared envelope.');
    }
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();
    const { retrieve } = retrieveWithFabricatedGrant(harness, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      sessionId: OTHER_SESSION_ID,
      envelopeId: envelope.envelopeId,
      sourceId: envelope.sourceId,
      sourceDigest: envelope.sourceDigest,
    });

    await expectRetrieveError(
      () =>
        retrieve.execute({
          capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_CAPABILITY_INVALID',
    );
  });

  it('reports a missing envelope when the grant outlives its state', async () => {
    const harness = createHarness();
    await prepareWithGrant(harness);
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();
    const { retrieve } = retrieveWithFabricatedGrant(harness, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      sessionId: SESSION_ID,
      envelopeId: 'cv_env_vanished00000001',
      sourceId: 'cv_src_abcdefghijklmnop',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
    });

    await expectRetrieveError(
      () =>
        retrieve.execute({
          capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_ENVELOPE_NOT_FOUND',
    );
  });

  it('fails closed when the retrieval deadline passes during the read', async () => {
    const harness = createHarness();
    const grant = await prepareWithGrant(harness);
    // The clock jumps past the retrieve deadline while the read is in
    // flight, so the post-read deadline check fails before disclosure.
    const parkedBytes: Uint8Array = new TextEncoder().encode('alpha\nbeta\ngamma\n');
    const advancingRead: AuthorizedFileReader['read'] = () => {
      harness.clock.advance(30_000 + 1);
      return Promise.resolve({ bytes: parkedBytes, normalizedRelativePath: PATH });
    };
    harness.read.mockImplementationOnce(advancingRead);

    const error = await expectRetrieveError(
      () =>
        harness.retrieve.execute({
          capability: grant.capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      'CV_DEADLINE_EXCEEDED',
    );
    expect(error.retryable).toBe(true);
    expect(harness.vault.listProvenanceForEnvelope(grant.envelopeId)).toHaveLength(0);
  });
});

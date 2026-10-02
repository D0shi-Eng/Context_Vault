import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  MAX_VERIFICATION_CHECKS,
  validateVerifyRequest,
} from '../../src/domain/verification/verification-policy.js';

const ENVELOPE_ID = 'cv_env_abcdefghijklmnop';
const CHUNK_ID = 'cv_chunk_000000000001';

function expectInvalid(candidate: unknown): void {
  expect(() => validateVerifyRequest(candidate)).toThrow('The verification request is invalid.');
}

describe('validateVerifyRequest', () => {
  it('accepts every supported check shape and freezes the result', () => {
    const request = validateVerifyRequest({
      envelopeId: ENVELOPE_ID,
      checks: [
        { kind: 'source_freshness' },
        { kind: 'chunk_integrity', chunkId: CHUNK_ID },
        { kind: 'provenance_consistency' },
      ],
    });

    expect(request).toEqual({
      envelopeId: ENVELOPE_ID,
      checks: [
        { kind: 'source_freshness' },
        { kind: 'chunk_integrity', chunkId: CHUNK_ID },
        { kind: 'provenance_consistency' },
      ],
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.checks)).toBe(true);
  });

  it.each([
    ['a non-object request', 'verify'],
    ['an array request', []],
    ['a null request', null],
    ['an undefined request', undefined],
    [
      'an unexpected top-level field',
      {
        envelopeId: ENVELOPE_ID,
        checks: [{ kind: 'source_freshness' }],
        intent: 'x',
      },
    ],
    ['a missing envelope identifier', { checks: [{ kind: 'source_freshness' }] }],
    [
      'an envelope identifier without its prefix',
      { envelopeId: 'z'.repeat(27), checks: [{ kind: 'source_freshness' }] },
    ],
    [
      'a malformed envelope identifier',
      { envelopeId: 'env-1', checks: [{ kind: 'source_freshness' }] },
    ],
    [
      'a short envelope identity',
      { envelopeId: 'cv_env_short', checks: [{ kind: 'source_freshness' }] },
    ],
    [
      'an envelope identifier with an unsafe character',
      { envelopeId: `cv_env_${'a'.repeat(16)}!`, checks: [{ kind: 'source_freshness' }] },
    ],
    ['a missing check list', { envelopeId: ENVELOPE_ID }],
    ['an empty check list', { envelopeId: ENVELOPE_ID, checks: [] }],
    [
      'an oversized check list',
      {
        envelopeId: ENVELOPE_ID,
        checks: Array.from({ length: MAX_VERIFICATION_CHECKS + 1 }, () => ({
          kind: 'source_freshness',
        })),
      },
    ],
    ['a non-object check', { envelopeId: ENVELOPE_ID, checks: ['source_freshness'] }],
    ['a null check', { envelopeId: ENVELOPE_ID, checks: [null] }],
    ['an undefined check', { envelopeId: ENVELOPE_ID, checks: [undefined] }],
    [
      'a check with too many fields',
      {
        envelopeId: ENVELOPE_ID,
        checks: [{ kind: 'source_freshness', chunkId: CHUNK_ID, extra: true }],
      },
    ],
    [
      'a check with extra fields but no identifier',
      {
        envelopeId: ENVELOPE_ID,
        checks: [{ kind: 'source_freshness', extra: true, another: 1 }],
      },
    ],
    ['an unknown check kind', { envelopeId: ENVELOPE_ID, checks: [{ kind: 'semantic_truth' }] }],
    ['a missing check kind', { envelopeId: ENVELOPE_ID, checks: [{ chunkId: CHUNK_ID }] }],
    [
      'a chunk check without an identifier',
      { envelopeId: ENVELOPE_ID, checks: [{ kind: 'chunk_integrity' }] },
    ],
    [
      'a chunk check with a malformed identifier',
      { envelopeId: ENVELOPE_ID, checks: [{ kind: 'chunk_integrity', chunkId: 'chunk-1' }] },
    ],
    [
      'a chunk check with a short identifier',
      { envelopeId: ENVELOPE_ID, checks: [{ kind: 'chunk_integrity', chunkId: 'cv_chunk_abc' }] },
    ],
    [
      'a chunk check with an unsafe character',
      {
        envelopeId: ENVELOPE_ID,
        checks: [{ kind: 'chunk_integrity', chunkId: `cv_chunk_${'a'.repeat(8)}!` }],
      },
    ],
    [
      'a chunk check with a node-prefixed identifier',
      {
        envelopeId: ENVELOPE_ID,
        checks: [{ kind: 'chunk_integrity', chunkId: 'cv_node_00000001' }],
      },
    ],
    [
      'a chunk check with an over-length identifier',
      {
        envelopeId: ENVELOPE_ID,
        checks: [{ kind: 'chunk_integrity', chunkId: `cv_chunk_${'a'.repeat(129)}` }],
      },
    ],
    [
      'an identifier on a freshness check',
      { envelopeId: ENVELOPE_ID, checks: [{ kind: 'source_freshness', chunkId: CHUNK_ID }] },
    ],
    [
      'an identifier on a provenance check',
      {
        envelopeId: ENVELOPE_ID,
        checks: [{ kind: 'provenance_consistency', chunkId: CHUNK_ID }],
      },
    ],
  ])('rejects %s', (_name, candidate) => {
    expectInvalid(candidate);
  });

  it('accepts a chunk identifier built from separator characters', () => {
    const request = validateVerifyRequest({
      envelopeId: ENVELOPE_ID,
      checks: [{ kind: 'chunk_integrity', chunkId: 'cv_chunk_--_--_--' }],
    });
    expect(request.checks).toHaveLength(1);
  });

  it('accepts a check list exactly at the supported bound', () => {
    const request = validateVerifyRequest({
      envelopeId: ENVELOPE_ID,
      checks: Array.from({ length: MAX_VERIFICATION_CHECKS }, () => ({
        kind: 'source_freshness',
      })),
    });
    expect(request.checks).toHaveLength(MAX_VERIFICATION_CHECKS);
  });

  it('accepts identifiers exactly at the supported length bounds', () => {
    const request = validateVerifyRequest({
      envelopeId: ENVELOPE_ID,
      checks: [
        { kind: 'chunk_integrity', chunkId: `cv_chunk_${'a'.repeat(8)}` },
        { kind: 'chunk_integrity', chunkId: `cv_chunk_${'a'.repeat(128)}` },
      ],
    });
    expect(request.checks).toHaveLength(2);
  });

  it.each([
    ['an all-uppercase identity', 'cv_chunk_AAAAAAAA'],
    ['an identity at the uppercase ceiling', 'cv_chunk_ZZZZZZZZ'],
    ['an all-digit identity', 'cv_chunk_00000000'],
  ])('accepts a chunk identifier with %s', (_name, chunkId) => {
    expect(() =>
      validateVerifyRequest({
        envelopeId: ENVELOPE_ID,
        checks: [{ kind: 'chunk_integrity', chunkId }],
      }),
    ).not.toThrow();
  });

  it.each([
    ['a character before the uppercase range', 'cv_chunk_@@@@@@@@'],
    ['a character after the uppercase range', 'cv_chunk_[[[[[[[['],
    ['a character before the lowercase range', 'cv_chunk_````````'],
    ['a character after the lowercase range', 'cv_chunk_{{{{{{{{'],
    ['a character before the digit range', 'cv_chunk_////////'],
    ['a character after the digit range', 'cv_chunk_::::::::'],
  ])('rejects a chunk identifier with %s', (_name, chunkId) => {
    expect(() =>
      validateVerifyRequest({
        envelopeId: ENVELOPE_ID,
        checks: [{ kind: 'chunk_integrity', chunkId }],
      }),
    ).toThrow(ContextVaultError);
  });

  it('reports malformed requests with the input-invalid code', () => {
    try {
      validateVerifyRequest('nope');
      expect.fail('Expected a validation error.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ContextVaultError);
      expect((error as ContextVaultError).code).toBe('CV_INPUT_INVALID');
    }
  });
});

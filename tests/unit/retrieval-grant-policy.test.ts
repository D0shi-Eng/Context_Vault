import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  DEFAULT_GRANT_MAX_BYTES,
  DEFAULT_GRANT_TTL_SECONDS,
  MAX_GRANT_MAX_BYTES,
  MAX_GRANT_TTL_SECONDS,
  MIN_GRANT_TTL_SECONDS,
  isWellFormedCapability,
  narrowGrantRequest,
  supportedSelectorTypes,
  validateCapabilityRequest,
  validateGrantRequest,
} from '../../src/domain/retrieval/retrieval-grant-policy.js';

describe('validateGrantRequest', () => {
  it('returns undefined when the caller did not ask for retrieval', () => {
    expect(validateGrantRequest(undefined)).toBeUndefined();
  });

  it('applies the documented defaults for omitted optional fields', () => {
    const request = validateGrantRequest({ allowedSelectorTypes: ['chunk'] });
    expect(request).toEqual({
      allowedSelectorTypes: ['chunk'],
      maxBytes: DEFAULT_GRANT_MAX_BYTES,
      ttlSeconds: DEFAULT_GRANT_TTL_SECONDS,
    });
  });

  it.each([
    ['a non-object request', 'grant'],
    ['a null request', null],
    ['an array request', ['chunk']],
    ['an empty selector list', { allowedSelectorTypes: [], maxBytes: 1024, ttlSeconds: 60 }],
    [
      'a non-string selector entry',
      { allowedSelectorTypes: ['chunk', 42], maxBytes: 1024, ttlSeconds: 600 },
    ],
    [
      'a selector list beyond the supported kinds',
      {
        allowedSelectorTypes: ['chunk', 'json_node', 'line_range', 'chunk'],
        maxBytes: 1024,
        ttlSeconds: 60,
      },
    ],
    [
      'a duplicated selector type',
      { allowedSelectorTypes: ['chunk', 'chunk'], maxBytes: 1024, ttlSeconds: 600 },
    ],
    [
      'an unknown selector type',
      { allowedSelectorTypes: ['semantic'], maxBytes: 1024, ttlSeconds: 600 },
    ],
    ['a zero byte budget', { allowedSelectorTypes: ['chunk'], maxBytes: 0, ttlSeconds: 600 }],
    [
      'an over-ceiling byte budget',
      { allowedSelectorTypes: ['chunk'], maxBytes: MAX_GRANT_MAX_BYTES + 1, ttlSeconds: 600 },
    ],
    [
      'a fractional byte budget',
      { allowedSelectorTypes: ['chunk'], maxBytes: 10.5, ttlSeconds: 600 },
    ],
    [
      'a ttl below the minimum',
      { allowedSelectorTypes: ['chunk'], maxBytes: 1024, ttlSeconds: MIN_GRANT_TTL_SECONDS - 1 },
    ],
    [
      'a ttl above the maximum',
      { allowedSelectorTypes: ['chunk'], maxBytes: 1024, ttlSeconds: MAX_GRANT_TTL_SECONDS + 1 },
    ],
    [
      'an unknown field',
      { allowedSelectorTypes: ['chunk'], maxBytes: 1024, ttlSeconds: 600, override: true },
    ],
  ])('rejects %s', (_name, candidate) => {
    expect(() => validateGrantRequest(candidate)).toThrow(ContextVaultError);
  });

  it('rejects a mixed allowlist pairing a valid type with an unknown one', () => {
    expect(() =>
      validateGrantRequest({
        allowedSelectorTypes: ['chunk', 'semantic'],
        maxBytes: 1024,
        ttlSeconds: 600,
      }),
    ).toThrow(ContextVaultError);
  });

  it.each([
    ['an all-non-string array', [42, 43, 44]],
    ['all-null entries', [null, null, null]],
    ['non-strings at multiple positions', [null, 'chunk', 42, true, undefined, 9.5]],
    ['a non-string beside an unknown selector', [42, 'semantic']],
  ])('rejects %s with the safe input-invalid classification', (_name, candidate): void => {
    let thrown: unknown = undefined;
    try {
      validateGrantRequest({
        allowedSelectorTypes: candidate,
        maxBytes: 1024,
        ttlSeconds: 600,
      });
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) {
      expect.fail('Expected a ContextVaultError to be thrown.');
    }
    expect(thrown).toBeInstanceOf(ContextVaultError);
    expect((thrown as ContextVaultError).code).toBe('CV_INPUT_INVALID');
  });

  it('classifies non-string selectors with the safe generic error and leaks no raw input', () => {
    const rawString = `leak-me-42${'x'.repeat(56)}`;
    const rawObject = { nested: { not: 'a string' } };
    let thrown: unknown;
    try {
      validateGrantRequest({
        allowedSelectorTypes: [rawString, 42, rawObject, null],
        maxBytes: 1024,
        ttlSeconds: 600,
      });
      thrown = new Error('Did not throw.');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContextVaultError);
    const error = thrown as ContextVaultError;
    expect(error.code).toBe('CV_INPUT_INVALID');
    expect(error.message).toBe('The retrieval grant request is invalid.');
    // The raw candidate values must never surface in any disclosed field.
    expect(error.message).not.toContain(rawString);
    // No raw candidate may surface in any disclosed field.
    expect(error.safeDetails).toBeUndefined();
    expect(String(error)).not.toContain(rawString);
    expect(JSON.stringify({ code: error.code, message: error.message })).not.toContain(rawString);
  });

  it('accepts a request exactly at every supported bound', () => {
    const request = validateGrantRequest({
      allowedSelectorTypes: ['chunk', 'json_node', 'line_range'],
      maxBytes: MAX_GRANT_MAX_BYTES,
      ttlSeconds: MAX_GRANT_TTL_SECONDS,
    });
    expect(request?.maxBytes).toBe(MAX_GRANT_MAX_BYTES);
    expect(request?.ttlSeconds).toBe(MAX_GRANT_TTL_SECONDS);
    expect(request?.allowedSelectorTypes).toHaveLength(3);
  });
});

describe('narrowGrantRequest', () => {
  it('narrows the ttl to the envelope expiry and keeps the byte budget', () => {
    const decision = narrowGrantRequest(
      { allowedSelectorTypes: ['chunk', 'line_range'], maxBytes: 8192, ttlSeconds: 600 },
      { preparationKind: 'text_chunks', secretRisk: 'none', envelopeTtlSeconds: 120 },
    );
    expect(decision).toEqual({
      ok: true,
      narrowed: {
        allowedSelectorTypes: ['chunk', 'line_range'],
        maxBytes: 8192,
        ttlSeconds: 120,
      },
    });
  });

  it('narrows the selector list to the supported subset for the preparation kind', () => {
    const decision = narrowGrantRequest(
      { allowedSelectorTypes: ['chunk', 'json_node'], maxBytes: 1024, ttlSeconds: 600 },
      { preparationKind: 'json_structure', secretRisk: 'none', envelopeTtlSeconds: 600 },
    );
    expect(decision).toEqual({
      ok: true,
      narrowed: { allowedSelectorTypes: ['json_node'], maxBytes: 1024, ttlSeconds: 600 },
    });
  });

  it('denies every grant for confirmed-secret material without narrowing', () => {
    const decision = narrowGrantRequest(
      { allowedSelectorTypes: ['chunk'], maxBytes: 1024, ttlSeconds: 600 },
      { preparationKind: 'minimal', secretRisk: 'confirmed', envelopeTtlSeconds: 600 },
    );
    expect(decision).toEqual({ ok: false, reason: 'confirmed_secret' });
  });

  it('denies a grant whose selectors cannot be honored for the preparation kind', () => {
    const decision = narrowGrantRequest(
      { allowedSelectorTypes: ['chunk'], maxBytes: 1024, ttlSeconds: 600 },
      { preparationKind: 'json_structure', secretRisk: 'none', envelopeTtlSeconds: 600 },
    );
    expect(decision).toEqual({ ok: false, reason: 'policy' });
  });

  it('denies a grant for a minimal envelope', () => {
    const decision = narrowGrantRequest(
      { allowedSelectorTypes: ['chunk'], maxBytes: 1024, ttlSeconds: 600 },
      { preparationKind: 'minimal', secretRisk: 'suspected', envelopeTtlSeconds: 600 },
    );
    expect(decision).toEqual({ ok: false, reason: 'unsupported_preparation' });
  });

  it('denies an empty allowlist before any policy evaluation', () => {
    const decision = narrowGrantRequest(
      { allowedSelectorTypes: [], maxBytes: 1024, ttlSeconds: 600 },
      { preparationKind: 'text_chunks', secretRisk: 'none', envelopeTtlSeconds: 600 },
    );
    expect(decision).toEqual({ ok: false, reason: 'policy' });
  });

  it('denies an empty allowlist before the unsupported-preparation check for minimal', () => {
    // The empty-allowlist denial precedes the preparation-kind denial; a minimal
    // context must still collapse to the policy reason rather than fall through to
    // the unsupported-preparation reason.
    const decision = narrowGrantRequest(
      { allowedSelectorTypes: [], maxBytes: 1024, ttlSeconds: 600 },
      { preparationKind: 'minimal', secretRisk: 'suspected', envelopeTtlSeconds: 600 },
    );
    expect(decision).toEqual({ ok: false, reason: 'policy' });
  });
});

describe('supportedSelectorTypes', () => {
  it('maps preparation kinds to the selector types retrieval can honor exactly', () => {
    expect(supportedSelectorTypes('text_chunks')).toEqual(['chunk', 'line_range']);
    expect(supportedSelectorTypes('json_structure')).toEqual(['json_node', 'line_range']);
    expect(supportedSelectorTypes('minimal')).toEqual([]);
  });
});

describe('validateCapabilityRequest', () => {
  it('accepts the minimal strict request shape', () => {
    const request = validateCapabilityRequest({
      capability: `cv1_${'a'.repeat(43)}`,
      selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
    });
    expect(request.capability).toBe(`cv1_${'a'.repeat(43)}`);
    expect(request.maxBytes).toBeUndefined();
  });

  it('preserves an optional byte budget without interpreting it', () => {
    const request = validateCapabilityRequest({
      capability: `cv1_${'a'.repeat(43)}`,
      selector: { kind: 'line_range', startLine: 1, endLine: 2 },
      maxBytes: 128,
    });
    expect(request.maxBytes).toBe(128);
  });

  it.each([
    ['a non-object request', 'nope'],
    ['a null request', null],
    ['an undefined request', undefined],
    ['a missing capability', { selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' } }],
    ['a missing selector', { capability: `cv1_${'a'.repeat(43)}` }],
    [
      'an unexpected field',
      {
        capability: `cv1_${'a'.repeat(43)}`,
        selector: { kind: 'chunk' },
        sourcePath: '/etc/passwd',
      },
    ],
  ])('rejects %s', (_name, candidate) => {
    expect(() => validateCapabilityRequest(candidate)).toThrow(ContextVaultError);
  });
});

describe('isWellFormedCapability', () => {
  it('accepts the exact issued shape of 256 bits of base64url identity', () => {
    expect(isWellFormedCapability(`cv1_${'a'.repeat(43)}`)).toBe(true);
  });

  it('accepts an identity exactly at the supported maximum', () => {
    expect(isWellFormedCapability(`cv1_${'a'.repeat(512)}`)).toBe(true);
  });

  it.each([
    ['a missing prefix', `cv2_${'a'.repeat(43)}`],
    ['a truncated identity', `cv1_${'a'.repeat(42)}`],
    ['an over-length identity', `cv1_${'a'.repeat(513)}`],
    ['an unsafe character', `cv1_${'a'.repeat(42)}+`],
    ['an empty token', ''],
    ['a character before the base64url ranges', `cv1_${'@'.repeat(43)}`],
    ['a character after the base64url ranges', `cv1_${'{'.repeat(43)}`],
  ])('rejects %s', (_name, candidate) => {
    expect(isWellFormedCapability(candidate)).toBe(false);
  });
});

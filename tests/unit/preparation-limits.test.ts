import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  DEFAULT_CONCURRENT_PREPARATIONS,
  DEFAULT_PREPARE_DEADLINE_MILLISECONDS,
  DEFAULT_TTL_SECONDS,
  HARD_CEILING_ACTIVE_ENVELOPES,
  HARD_CEILING_CONCURRENT_PREPARATIONS,
  HARD_CEILING_PREPARE_DEADLINE_MILLISECONDS,
  HARD_CEILING_SERIALIZED_METADATA_BYTES,
  HARD_CEILING_TOTAL_DERIVED_STATE_BYTES,
  MAX_ACTIVE_ENVELOPES,
  MAX_CHUNKS_PER_ENVELOPE,
  MAX_CHUNK_BYTES,
  MAX_CONCURRENT_PREPARATIONS,
  MAX_EMITTED_JSON_NODES,
  MAX_JSON_KEY_CHARACTERS,
  MAX_JSON_PARSE_DEPTH,
  MAX_JSON_PARSE_NODES,
  MAX_JSON_POINTER_LENGTH,
  MAX_JSON_POINTER_SEGMENTS,
  MAX_RETAINED_JSON_LOCATOR_CHARACTERS,
  MAX_SERIALIZED_METADATA_BYTES,
  MAX_TEXT_LINES,
  MAX_TTL_SECONDS,
  MAX_TOTAL_DERIVED_STATE_BYTES,
  MIN_TTL_SECONDS,
  STRICT_PREPARATION_LIMITS,
  validatePreparationLimits,
  validateTtlSeconds,
} from '../../src/domain/preparation/preparation-limits.js';

describe('preparation resource limits', () => {
  it('accepts the strict defaults unchanged', () => {
    expect(validatePreparationLimits(STRICT_PREPARATION_LIMITS)).toEqual({
      maxActiveEnvelopes: MAX_ACTIVE_ENVELOPES,
      maxTotalDerivedStateBytes: MAX_TOTAL_DERIVED_STATE_BYTES,
      maxSerializedMetadataBytes: MAX_SERIALIZED_METADATA_BYTES,
      maxConcurrentPreparations: DEFAULT_CONCURRENT_PREPARATIONS,
      prepareDeadlineMilliseconds: DEFAULT_PREPARE_DEADLINE_MILLISECONDS,
    });
  });

  it('freezes the returned limits object', () => {
    expect(Object.isFrozen(validatePreparationLimits(STRICT_PREPARATION_LIMITS))).toBe(true);
  });

  it.each([
    ['maxActiveEnvelopes', { ...STRICT_PREPARATION_LIMITS, maxActiveEnvelopes: 0 }],
    [
      'maxActiveEnvelopes over ceiling',
      { ...STRICT_PREPARATION_LIMITS, maxActiveEnvelopes: HARD_CEILING_ACTIVE_ENVELOPES + 1 },
    ],
    [
      'maxTotalDerivedStateBytes zero',
      { ...STRICT_PREPARATION_LIMITS, maxTotalDerivedStateBytes: 0 },
    ],
    [
      'maxTotalDerivedStateBytes over ceiling',
      {
        ...STRICT_PREPARATION_LIMITS,
        maxTotalDerivedStateBytes: HARD_CEILING_TOTAL_DERIVED_STATE_BYTES + 1,
      },
    ],
    [
      'maxSerializedMetadataBytes zero',
      { ...STRICT_PREPARATION_LIMITS, maxSerializedMetadataBytes: 0 },
    ],
    [
      'maxSerializedMetadataBytes over ceiling',
      {
        ...STRICT_PREPARATION_LIMITS,
        maxSerializedMetadataBytes: HARD_CEILING_SERIALIZED_METADATA_BYTES + 1,
      },
    ],
    [
      'maxConcurrentPreparations zero',
      { ...STRICT_PREPARATION_LIMITS, maxConcurrentPreparations: 0 },
    ],
    [
      'maxConcurrentPreparations over ceiling',
      {
        ...STRICT_PREPARATION_LIMITS,
        maxConcurrentPreparations: HARD_CEILING_CONCURRENT_PREPARATIONS + 1,
      },
    ],
    [
      'prepareDeadlineMilliseconds zero',
      { ...STRICT_PREPARATION_LIMITS, prepareDeadlineMilliseconds: 0 },
    ],
    [
      'prepareDeadlineMilliseconds over ceiling',
      {
        ...STRICT_PREPARATION_LIMITS,
        prepareDeadlineMilliseconds: HARD_CEILING_PREPARE_DEADLINE_MILLISECONDS + 1,
      },
    ],
    ['fractional limit', { ...STRICT_PREPARATION_LIMITS, maxActiveEnvelopes: 1.5 }],
    ['NaN limit', { ...STRICT_PREPARATION_LIMITS, maxConcurrentPreparations: Number.NaN }],
  ])('rejects %s', (_name, candidate) => {
    expectError(() => validatePreparationLimits(candidate), 'CV_CONFIGURATION_INVALID');
  });

  it('keeps the declared slice bounds consistent with their documented ceilings', () => {
    expect(MAX_ACTIVE_ENVELOPES).toBe(64);
    expect(MAX_TOTAL_DERIVED_STATE_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_SERIALIZED_METADATA_BYTES).toBe(256 * 1024);
    expect(MAX_CHUNKS_PER_ENVELOPE).toBe(1024);
    expect(MAX_JSON_PARSE_DEPTH).toBe(64);
    expect(MAX_JSON_PARSE_NODES).toBe(50_000);
    expect(MAX_JSON_POINTER_LENGTH).toBe(2048);
    expect(MAX_JSON_POINTER_SEGMENTS).toBe(128);
    expect(MAX_EMITTED_JSON_NODES).toBe(1024);
    expect(MAX_JSON_KEY_CHARACTERS).toBe(256);
    expect(MAX_RETAINED_JSON_LOCATOR_CHARACTERS).toBe(131_072);
    expect(MAX_TEXT_LINES).toBe(1_000_000);
    expect(MAX_CHUNK_BYTES).toBe(4096);
    expect(MIN_TTL_SECONDS).toBe(60);
    expect(DEFAULT_TTL_SECONDS).toBe(1800);
    expect(MAX_TTL_SECONDS).toBe(7200);
    expect(DEFAULT_CONCURRENT_PREPARATIONS).toBe(2);
    expect(MAX_CONCURRENT_PREPARATIONS).toBe(4);
  });
});

describe('validateTtlSeconds', () => {
  it('returns the default retention when the field is omitted', () => {
    expect(validateTtlSeconds(undefined)).toBe(DEFAULT_TTL_SECONDS);
  });

  it('accepts the minimum and maximum supported retention values', () => {
    expect(validateTtlSeconds(MIN_TTL_SECONDS)).toBe(MIN_TTL_SECONDS);
    expect(validateTtlSeconds(MAX_TTL_SECONDS)).toBe(MAX_TTL_SECONDS);
  });

  it.each([59, 7201, 0, -60, 1.5, Number.NaN, '600', null])(
    'rejects retention candidate %s',
    (candidate) => {
      expectError(() => validateTtlSeconds(candidate), 'CV_INPUT_INVALID');
    },
  );
});

function expectError(execute: () => unknown, code: string): void {
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

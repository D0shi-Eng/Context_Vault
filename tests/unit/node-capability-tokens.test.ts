import { describe, expect, it } from 'vitest';

import {
  ABSENT_CAPABILITY_DIGEST,
  NodeCapabilityTokens,
} from '../../src/infrastructure/crypto/node-capability-tokens.js';

describe('NodeCapabilityTokens', () => {
  it('issues 256-bit base64url tokens with the documented prefix', () => {
    const tokens = new NodeCapabilityTokens();
    const first = tokens.createCapabilityToken();
    const second = tokens.createCapabilityToken();

    expect(first).toMatch(/^cv1_[A-Za-z0-9_-]{43}$/u);
    expect(second).toMatch(/^cv1_[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toBe(second);
  });

  it('derives a deterministic 64-character hex digest per token', () => {
    const tokens = new NodeCapabilityTokens();
    const capability = tokens.createCapabilityToken();

    const digest = tokens.digestCapabilityToken(capability);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(tokens.digestCapabilityToken(capability)).toBe(digest);
    expect(tokens.digestCapabilityToken(tokens.createCapabilityToken())).not.toBe(digest);
  });

  it('compares digests with the platform constant-time primitive', () => {
    const tokens = new NodeCapabilityTokens();
    const digest = tokens.digestCapabilityToken(tokens.createCapabilityToken());

    expect(tokens.compareCapabilityDigests(digest, digest)).toBe(true);
    expect(tokens.compareCapabilityDigests(digest, '0'.repeat(64))).toBe(false);
    // Unequal digest encodings fail closed without reaching the primitive.
    expect(tokens.compareCapabilityDigests(digest, 'abcd')).toBe(false);
    expect(tokens.compareCapabilityDigests('not-hex!!', digest)).toBe(false);
  });

  it('exposes a well-formed fixed digest for the miss path', () => {
    expect(ABSENT_CAPABILITY_DIGEST).toMatch(/^[0-9a-f]{64}$/u);
    const tokens = new NodeCapabilityTokens();
    expect(tokens.absentCapabilityDigest).toBe(ABSENT_CAPABILITY_DIGEST);
  });
});

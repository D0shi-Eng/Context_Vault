import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseNodeMajorVersion } from '../../src/domain/runtime-version.js';

describe('parseNodeMajorVersion', () => {
  it('extracts every non-negative safe integer major version', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (major) => {
        expect(parseNodeMajorVersion(`${String(major)}.12.3`)).toBe(major);
        expect(parseNodeMajorVersion(`v${String(major)}.0.0`)).toBe(major);
        expect(parseNodeMajorVersion(String(major))).toBe(major);
      }),
    );
  });

  it.each(['', 'version-24', '-1.0.0', 'v.1.0', 'Infinity.0.0'])(
    'rejects malformed value %j',
    (value) => {
      expect(parseNodeMajorVersion(value)).toBeUndefined();
    },
  );

  it('rejects a numeric major outside the safe integer range', () => {
    expect(parseNodeMajorVersion(`${'9'.repeat(400)}.0.0`)).toBeUndefined();
  });
});

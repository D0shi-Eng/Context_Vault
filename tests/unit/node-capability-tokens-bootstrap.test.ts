import { createHash } from 'node:crypto';

import { expect, it, vi } from 'vitest';

// The miss-path digest is computed while the module initializes, which is the
// same top-level execution the stdio server bootstrap performs. This file must
// not statically import the module: a corrupted bootstrap would then surface
// as a file-level load error ("no tests"), which the mutation runner's perTest
// attribution cannot charge to any test. A dynamic import inside the test body
// keeps the failure inside a test, so the corrupted initialization is
// observable and attributable.
it('initializes the miss-path digest to the pinned SHA-256 constant at module bootstrap', async () => {
  vi.resetModules();

  const { ABSENT_CAPABILITY_DIGEST } =
    await import('../../src/infrastructure/crypto/node-capability-tokens.js');

  const expected = createHash('sha256').update('contextvault-absent-capability').digest('hex');
  expect(ABSENT_CAPABILITY_DIGEST).toBe(expected);
});

import { describe, expect, it } from 'vitest';

import { NodeInspectionCryptography } from '../../src/infrastructure/inspection/node-inspection-cryptography.js';

describe('NodeInspectionCryptography', () => {
  const cryptography = new NodeInspectionCryptography();

  it('computes the expected SHA-256 digest', () => {
    expect(cryptography.sha256(new TextEncoder().encode('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('derives a deterministic opaque source identifier bound to every input', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const sourceId = cryptography.sourceId('repo', 'src/main.ts', digest);

    expect(sourceId).toMatch(/^cv_src_[A-Za-z0-9_-]{43}$/u);
    expect(cryptography.sourceId('repo', 'src/main.ts', digest)).toBe(sourceId);
    expect(cryptography.sourceId('other', 'src/main.ts', digest)).not.toBe(sourceId);
    expect(cryptography.sourceId('repo', 'src/other.ts', digest)).not.toBe(sourceId);
    expect(cryptography.sourceId('repo', 'src/main.ts', `sha256:${'b'.repeat(64)}`)).not.toBe(
      sourceId,
    );
  });

  it('does not collide when input boundaries are ambiguous', () => {
    const digest = `sha256:${'a'.repeat(64)}`;

    // Concatenating the inputs without a separator would let these two pairs
    // produce the same identifier, so the encoding must keep them distinct.
    expect(cryptography.sourceId('reporoot', 'a.ts', digest)).not.toBe(
      cryptography.sourceId('repo', 'roota.ts', digest),
    );
  });

  it('keeps the path and digest boundary unambiguous', () => {
    // The same reasoning applies at the path-to-digest boundary: dropping that
    // separator would let a path that ends with the digest label collide with a
    // different path paired with a different digest.
    expect(cryptography.sourceId('repo', 'x', 'sha256:aa')).not.toBe(
      cryptography.sourceId('repo', 'xsha256:', 'aa'),
    );
  });

  it('never emits the raw digest or path in the identifier', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const sourceId = cryptography.sourceId('repo', 'src/main.ts', digest);
    const opaquePart = sourceId.slice('cv_src_'.length);

    expect(opaquePart).not.toContain('a'.repeat(64));
    expect(opaquePart).not.toContain('main');
    expect(opaquePart).not.toContain('repo');
    expect(sourceId).not.toContain(digest);
  });

  it('creates opaque correlation identifiers with sufficient entropy', () => {
    const first = cryptography.create();
    const second = cryptography.create();

    expect(first).toMatch(/^cv_corr_[A-Za-z0-9_-]{24}$/u);
    expect(second).not.toBe(first);
  });

  it('prefixes the digest with the sha256 algorithm label', () => {
    expect(cryptography.sha256(new TextEncoder().encode('abc'))).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('prefixes source and correlation identifiers with their documented markers', () => {
    expect(cryptography.sourceId('repo', 'file.txt', 'sha256:0')).toMatch(/^cv_src_/u);
    expect(cryptography.create()).toMatch(/^cv_corr_/u);
  });
});

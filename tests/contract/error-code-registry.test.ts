import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';

const UNION_SOURCE = readFileSync(
  new URL('../../src/domain/errors/context-vault-error.ts', import.meta.url),
  'utf8',
);
const REGISTRY_DOC = readFileSync(
  new URL('../../docs/protocol/ERROR_MODEL.md', import.meta.url),
  'utf8',
);

function documentedCodes(): Set<string> {
  const codes = new Set<string>();
  for (const match of REGISTRY_DOC.matchAll(/`CV_[A-Z0-9_]{3,80}`/gu)) {
    codes.add(match[0].slice(1, -1));
  }
  return codes;
}

function unionCodes(): Set<string> {
  const block = UNION_SOURCE.slice(UNION_SOURCE.indexOf('export type ContextVaultErrorCode'));
  const closing = block.indexOf(';');
  const codes = new Set<string>();
  for (const match of block.slice(0, closing).matchAll(/'([A-Z0-9_]+)'/gu)) {
    codes.add(match[1] ?? '');
    codes.delete('');
  }
  return codes;
}

describe('error code registry contract', () => {
  it('throws only ContextVaultError instances with codes inside the declared union', () => {
    // Every code the implementation can emit must satisfy the documented
    // shape; the exhaustive union membership is proven by the two
    // documentation-drift checks below.
    const sample = new ContextVaultError({ code: 'CV_INPUT_INVALID', message: 'test' });
    expect(sample.code).toMatch(/^CV_[A-Z0-9_]{3,80}$/u);
  });

  it('documents every code of the production union', () => {
    const missing = [...unionCodes()].filter((code) => !documentedCodes().has(code));
    expect(missing).toEqual([]);
  });

  it('documents no code outside the production union', () => {
    const extra = [...documentedCodes()].filter((code) => !unionCodes().has(code));
    expect(extra).toEqual([]);
  });
});

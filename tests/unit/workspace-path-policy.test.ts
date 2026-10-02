import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  MAX_RELATIVE_PATH_CHARACTERS,
  assertValidRootId,
  isValidRootId,
  normalizeRelativePath,
} from '../../src/domain/workspace/workspace-path-policy.js';

describe('workspace path policy', () => {
  it.each([
    ['src/index.ts', 'src/index.ts'],
    ['docs\\guide.md', 'docs/guide.md'],
    ['العربية/ملف.md', 'العربية/ملف.md'],
  ])('accepts an unambiguous relative path %s', (candidate, expected) => {
    expect(normalizeRelativePath(candidate)).toBe(expected);
  });

  it.each([
    ['C:\\private.txt', 'CV_PATH_ABSOLUTE_DENIED'],
    ['C:private.txt', 'CV_PATH_ABSOLUTE_DENIED'],
    ['\\\\server\\share\\file.txt', 'CV_PATH_ABSOLUTE_DENIED'],
    ['/etc/passwd', 'CV_PATH_ABSOLUTE_DENIED'],
    ['../private.txt', 'CV_PATH_OUTSIDE_WORKSPACE'],
    ['safe/../private.txt', 'CV_PATH_OUTSIDE_WORKSPACE'],
    ['./file.txt', 'CV_PATH_INVALID'],
    ['safe//file.txt', 'CV_PATH_INVALID'],
    ['safe/%2e%2e/file.txt', 'CV_PATH_INVALID'],
    ['safe/file.txt:stream', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['safe/CON.txt', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['safe/file.txt.', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['safe/file.txt ', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['safe/\u202efile.txt', 'CV_PATH_INVALID'],
    ['safe/\u0001file.txt', 'CV_PATH_INVALID'],
    ['cafe\u0301.txt', 'CV_PATH_INVALID'],
    ['a'.repeat(4097), 'CV_PATH_INVALID'],
    ['', 'CV_PATH_INVALID'],
  ])('rejects hostile or ambiguous path %s', (candidate, expectedCode) => {
    expectErrorCode(() => normalizeRelativePath(candidate), expectedCode);
  });

  it('accepts a path at the maximum length and rejects one character more', () => {
    const nearLimit = `a${'b'.repeat(MAX_RELATIVE_PATH_CHARACTERS - 2)}`;

    expect(normalizeRelativePath(nearLimit)).toBe(nearLimit);
    expect(nearLimit.length).toBe(MAX_RELATIVE_PATH_CHARACTERS - 1);
  });

  it('accepts a path exactly at the maximum length and rejects one character more', () => {
    const atLimit = 'a'.repeat(MAX_RELATIVE_PATH_CHARACTERS);

    expect(normalizeRelativePath(atLimit)).toBe(atLimit);
    expectErrorCode(
      () => normalizeRelativePath('a'.repeat(MAX_RELATIVE_PATH_CHARACTERS + 1)),
      'CV_PATH_INVALID',
    );
  });

  it('rejects a path that exceeds the total length ceiling across valid segments', () => {
    // Every segment is a short, valid component, so the only reason to reject
    // this path is the total-character ceiling rather than a segment rule.
    const overLimit = `${'a/'.repeat(2048)}a`;

    expect(overLimit.length).toBe(MAX_RELATIVE_PATH_CHARACTERS + 1);
    expect(overLimit.length).toBe(4097);
    expect(normalizeRelativePath(`${'a/'.repeat(2047)}a`)).toBe(`${'a/'.repeat(2047)}a`);
    expectErrorCode(() => normalizeRelativePath(overLimit), 'CV_PATH_INVALID');
  });

  it('accepts a segment that merely ends with a reserved device name', () => {
    // The reserved-name rule is anchored to the start of a segment, so a longer
    // word that ends with a device name is an ordinary file name.
    expect(normalizeRelativePath('xaux')).toBe('xaux');
    expect(normalizeRelativePath('recon')).toBe('recon');
  });

  it.each([
    ['COM1', 'a reserved name at the start of a segment'],
    ['CON', 'the console device name'],
    ['PRN', 'the printer device name in uppercase'],
    ['NUL.log', 'a device name with an extension'],
  ])('rejects %s anywhere in a nested path (%s)', (segment) => {
    expectErrorCode(
      () => normalizeRelativePath(`nested/deeper/${segment}/file.txt`),
      'CV_PATH_SPECIAL_FILE_DENIED',
    );
  });

  it('rejects a path whose only segment is a reserved device name', () => {
    expectErrorCode(() => normalizeRelativePath('con'), 'CV_PATH_SPECIAL_FILE_DENIED');
    expectErrorCode(() => normalizeRelativePath('lpt1'), 'CV_PATH_SPECIAL_FILE_DENIED');
  });

  it('accepts ordinary segments that merely contain a device name substring', () => {
    expect(normalizeRelativePath('console/file.txt')).toBe('console/file.txt');
    expect(normalizeRelativePath('components/file.txt')).toBe('components/file.txt');
  });

  it.each([
    ['aux', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['AUX', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['nul.txt', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['com1', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['com9.log', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['lpt1', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['lpt9.tmp', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['prn', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['clock$', 'CV_PATH_SPECIAL_FILE_DENIED'],
  ])('rejects reserved Windows device name %s', (candidate, expectedCode) => {
    expectErrorCode(() => normalizeRelativePath(candidate), expectedCode);
  });

  it.each([
    ['com0', 'a device name outside the 1-9 range is an ordinary file'],
    ['lpt0', 'a device name outside the 1-9 range is an ordinary file'],
    ['com10', 'a two-digit device suffix is an ordinary file'],
    ['auxiliary', 'a longer word that merely starts with a device name is ordinary'],
    ['nullify.txt', 'a longer word that merely starts with a device name is ordinary'],
  ])('accepts %s because %s', (candidate) => {
    expect(normalizeRelativePath(candidate)).toBe(candidate);
  });

  it.each([
    ['\u0000', 'a NUL character'],
    ['\u001f', 'a low C0 control character'],
    ['\u007f', 'the DEL control character'],
    ['\u0085', 'a C1 control character'],
    ['\u009f', 'the last C1 control character'],
  ])('rejects %s in a path', (candidate) => {
    expectErrorCode(() => normalizeRelativePath(`safe/${candidate}file.txt`), 'CV_PATH_INVALID');
  });

  it('accepts a printable character adjacent to the control-character range', () => {
    expect(normalizeRelativePath('safe/file.txt')).toBe('safe/file.txt');
    expect(normalizeRelativePath('safe/\u0020file.txt')).toBe('safe/\u0020file.txt');
  });

  it.each([['safe/file.txt/', 'a trailing separator']])('rejects %s with %s', (candidate) => {
    expectErrorCode(() => normalizeRelativePath(candidate), 'CV_PATH_INVALID');
  });

  it.each([
    ['safe/~file.txt', '0x7e'],
    ['safe/\u00a0file.txt', '0xa0'],
    ['safe/😀file.txt', 'an astral code point'],
  ])('accepts %s containing %s', (candidate) => {
    expect(normalizeRelativePath(candidate)).toBe(candidate);
  });

  it.each([
    ['\u061c', 'Arabic letter mark'],
    ['\u200e', 'left-to-right mark'],
    ['\u200f', 'right-to-left mark'],
    ['\u202a', 'left-to-right embedding'],
    ['\u202e', 'right-to-left override'],
    ['\u2066', 'left-to-right isolate'],
    ['\u2069', 'pop directional isolate'],
  ])('rejects the %s bidirectional control in a path', (candidate) => {
    expectErrorCode(() => normalizeRelativePath(`safe/${candidate}file.txt`), 'CV_PATH_INVALID');
  });

  it('rejects every generated traversal path', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u), {
          minLength: 0,
          maxLength: 5,
        }),
        fc.array(fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u), {
          minLength: 0,
          maxLength: 5,
        }),
        fc.constantFrom('/', '\\'),
        (prefix, suffix, separator) => {
          const path = [...prefix, '..', ...suffix].join(separator);
          expectErrorCode(() => normalizeRelativePath(path), 'CV_PATH_OUTSIDE_WORKSPACE');
        },
      ),
    );
  });

  it.each(['workspace', 'workspace_1', 'a-b'])('accepts root identifier %s', (rootId) => {
    expect(isValidRootId(rootId)).toBe(true);
    expect(() => {
      assertValidRootId(rootId);
    }).not.toThrow();
  });

  it.each(['', '1root', 'Root', 'with space', `a${'b'.repeat(64)}`])(
    'rejects root identifier %s',
    (rootId) => {
      expect(isValidRootId(rootId)).toBe(false);
      expectErrorCode(() => {
        assertValidRootId(rootId);
      }, 'CV_INPUT_INVALID');
    },
  );
});

function expectErrorCode(action: () => unknown, expectedCode: string): void {
  try {
    action();
    expect.fail('Expected a ContextVaultError.');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ContextVaultError);
    expect((error as ContextVaultError).code).toBe(expectedCode);
  }
}

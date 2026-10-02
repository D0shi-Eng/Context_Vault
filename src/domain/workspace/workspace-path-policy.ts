import { ContextVaultError } from '../errors/context-vault-error.js';

const ROOT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const DRIVE_PATH_PATTERN = /^[A-Za-z]:/u;
const ENCODED_PATH_SYNTAX_PATTERN = /%(?:2e|2f|5c)/iu;
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const RESERVED_WINDOWS_NAME_PATTERN = /^(?:aux|clock\$|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export const MAX_RELATIVE_PATH_CHARACTERS = 4096;

export function isValidRootId(rootId: string): boolean {
  return ROOT_ID_PATTERN.test(rootId);
}

export function assertValidRootId(rootId: string): void {
  if (!isValidRootId(rootId)) {
    throw new ContextVaultError({
      code: 'CV_INPUT_INVALID',
      message: 'The workspace root identifier is invalid.',
    });
  }
}

export function normalizeRelativePath(candidate: string): string {
  if (candidate.length > MAX_RELATIVE_PATH_CHARACTERS) {
    throw invalidPath();
  }

  if (
    candidate.startsWith('/') ||
    candidate.startsWith('\\') ||
    DRIVE_PATH_PATTERN.test(candidate)
  ) {
    throw new ContextVaultError({
      code: 'CV_PATH_ABSOLUTE_DENIED',
      message: 'Absolute source paths are not allowed.',
    });
  }

  if (
    hasControlCharacter(candidate) ||
    BIDI_CONTROL_PATTERN.test(candidate) ||
    ENCODED_PATH_SYNTAX_PATTERN.test(candidate) ||
    candidate.normalize('NFC') !== candidate
  ) {
    throw invalidPath();
  }

  const normalizedSeparators = candidate.replaceAll('\\', '/');
  const segments = normalizedSeparators.split('/');

  if (segments.some((segment) => segment.length === 0 || segment === '.')) {
    throw invalidPath();
  }

  if (segments.includes('..')) {
    throw new ContextVaultError({
      code: 'CV_PATH_OUTSIDE_WORKSPACE',
      message: 'The requested source is not authorized.',
    });
  }

  for (const segment of segments) {
    if (
      segment.includes(':') ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      RESERVED_WINDOWS_NAME_PATTERN.test(segment)
    ) {
      throw new ContextVaultError({
        code: 'CV_PATH_SPECIAL_FILE_DENIED',
        message: 'The requested source type is not allowed.',
      });
    }
  }

  return segments.join('/');
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function invalidPath(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_PATH_INVALID',
    message: 'The source path is invalid.',
  });
}

/**
 * Low-level, value-free JSON token scanning primitives.
 *
 * Every function here advances a shared cursor over the document text
 * and throws a fail-closed malformed-JSON error on any syntax problem.
 * No token content is retained or returned; only the cursor position
 * moves, so values never accumulate in memory.
 */

import { malformedJsonError } from './json-scan-errors.js';

export interface JsonScanCursor {
  readonly text: string;
  position: number;
}

/** Consumes JSON whitespace without validating it. */
export function skipWhitespace(cursor: JsonScanCursor): void {
  while (cursor.position < cursor.text.length) {
    const character = cursor.text[cursor.position];
    if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
      return;
    }
    cursor.position += 1;
  }
}

/** Validates a JSON string body starting after the opening quote. */
export function scanString(cursor: JsonScanCursor): void {
  for (;;) {
    const character = cursor.text[cursor.position];
    if (character === undefined) {
      throw malformedJsonError();
    }
    if (character === '"') {
      cursor.position += 1;
      return;
    }
    if (character === '\\') {
      cursor.position += 1;
      scanEscape(cursor);
      continue;
    }
    if (character.charCodeAt(0) < 0x20) {
      throw malformedJsonError();
    }
    cursor.position += 1;
  }
}

export function scanEscape(cursor: JsonScanCursor): void {
  const character = cursor.text[cursor.position];
  cursor.position += 1;
  switch (character) {
    case '"':
    case '\\':
    case '/':
    case 'b':
    case 'f':
    case 'n':
    case 'r':
    case 't':
      return;
    case 'u':
      for (let index = 0; index < 4; index += 1) {
        if (!isHexDigit(cursor.text[cursor.position + index])) {
          throw malformedJsonError();
        }
      }
      cursor.position += 4;
      return;
    default:
      throw malformedJsonError();
  }
}

export function scanLiteral(cursor: JsonScanCursor, expected: 'true' | 'false' | 'null'): void {
  if (cursor.text.startsWith(expected, cursor.position)) {
    cursor.position += expected.length;
    return;
  }
  throw malformedJsonError();
}

/** Consumes and strictly validates a JSON number token. */
export function scanNumber(cursor: JsonScanCursor): void {
  const start = cursor.position;
  while (cursor.position < cursor.text.length) {
    const character = cursor.text.charAt(cursor.position);
    if (
      (character >= '0' && character <= '9') ||
      character === '-' ||
      character === '+' ||
      character === '.' ||
      character === 'e' ||
      character === 'E'
    ) {
      cursor.position += 1;
      continue;
    }
    break;
  }
  if (!isValidJsonNumber(cursor.text.slice(start, cursor.position))) {
    throw malformedJsonError();
  }
}

export function isValidJsonNumber(token: string): boolean {
  let index = 0;
  if (token.charAt(index) === '-') {
    index += 1;
  }
  const firstDigit = token.charAt(index);
  if (firstDigit === '0') {
    index += 1;
  } else if (firstDigit >= '1' && firstDigit <= '9') {
    index += 1;
    while (isAsciiDigit(token[index])) {
      index += 1;
    }
  } else {
    return false;
  }

  if (token[index] === '.') {
    index += 1;
    if (!isAsciiDigit(token[index])) {
      return false;
    }
    while (isAsciiDigit(token[index])) {
      index += 1;
    }
  }

  if (token[index] === 'e' || token[index] === 'E') {
    index += 1;
    if (token[index] === '+' || token[index] === '-') {
      index += 1;
    }
    if (!isAsciiDigit(token[index])) {
      return false;
    }
    while (isAsciiDigit(token[index])) {
      index += 1;
    }
  }

  return index === token.length;
}

export function hexValue(character: string | undefined): number | undefined {
  if (character === undefined) {
    return undefined;
  }
  if (character >= '0' && character <= '9') {
    return character.charCodeAt(0) - 0x30;
  }
  if (character >= 'a' && character <= 'f') {
    return character.charCodeAt(0) - 0x61 + 10;
  }
  if (character >= 'A' && character <= 'F') {
    return character.charCodeAt(0) - 0x41 + 10;
  }
  return undefined;
}

export function isHexDigit(character: string | undefined): boolean {
  return hexValue(character) !== undefined;
}

export function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

/**
 * Bounded, value-free structural scanner for JSON sources.
 *
 * The scanner never retains scalar values, string contents, numbers, or
 * any other source text. It validates the document strictly, enforces
 * depth, node, key, and locator retention limits, detects duplicate keys
 * where tracking capacity allows, and emits a bounded list of structural
 * nodes whose locators can be redacted safely at disclosure time.
 *
 * Each emitted node also carries its exact character span in the
 * decoded document text. Spans are server-side lifecycle metadata and
 * are never disclosed; disclosure always goes through the redaction
 * policy, which copies only the safe descriptor fields.
 */

import { malformedJsonError, depthExceededError, itemLimitError } from './json-scan-errors.js';
import {
  type JsonScanCursor,
  scanLiteral,
  scanNumber,
  scanString,
  skipWhitespace,
  hexValue,
} from './json-scan-tokens.js';
import type { JsonNodeType, ScannedJsonNode } from './preparation-types.js';

export interface JsonScanLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxEmittedNodes: number;
  readonly maxPointerSegments: number;
  readonly maxKeyCharacters: number;
  readonly maxTrackedKeysPerObject: number;
  readonly maxRetainedLocatorCharacters: number;
}

export interface JsonScanOutcome {
  readonly nodes: readonly ScannedJsonNode[];
  readonly totalNodeCount: number;
  readonly duplicateKeyCount: number;
}

interface ScanFrame {
  readonly nodeType: 'object' | 'array';
  readonly depth: number;
  childCount: number;
  keys: Set<string> | null;
  /** The emitted mutable node for this container, or null at the emission cap. */
  node: MutableScannedNode | null;
  readonly segments: readonly (string | null)[];
}

interface ScanState extends JsonScanCursor {
  readonly limits: JsonScanLimits;
  readonly nodes: MutableScannedNode[];
  totalNodes: number;
  duplicateKeyCount: number;
  retainedLocatorCharacters: number;
}

interface MutableScannedNode {
  nodeId: string;
  nodeType: JsonNodeType;
  depth: number;
  childCount: number;
  /** Inclusive start and exclusive end character offsets in the document. */
  startPosition: number;
  endPosition: number;
  pathSegments: readonly (string | null)[] | null;
}

interface ScannedKey {
  readonly key: string;
  readonly oversize: boolean;
}

const NODE_ID_PADDING = 6;

/**
 * Scans a JSON document and returns bounded structural nodes.
 * Throws a fail-closed error for malformed syntax or any exceeded limit.
 */
export function scanJsonStructure(text: string, limits: JsonScanLimits): JsonScanOutcome {
  const state: ScanState = {
    text,
    limits,
    position: 0,
    nodes: [],
    totalNodes: 0,
    duplicateKeyCount: 0,
    retainedLocatorCharacters: 0,
  };

  parseValue(state, null, null, 0);
  skipWhitespace(state);
  if (state.position !== state.text.length) {
    throw malformedJsonError();
  }

  const frozenNodes = state.nodes.map((node) => Object.freeze(node));
  return Object.freeze({
    nodes: Object.freeze(frozenNodes),
    totalNodeCount: state.totalNodes,
    duplicateKeyCount: state.duplicateKeyCount,
  });
}

function parseValue(
  state: ScanState,
  frame: ScanFrame | null,
  segment: string | null,
  depth: number,
): void {
  skipWhitespace(state);
  const character = state.text[state.position];
  const tokenStart = state.position;

  switch (character) {
    case '{':
      parseObject(state, frame, segment, depth);
      return;
    case '[':
      parseArray(state, frame, segment, depth);
      return;
    case '"':
      state.position += 1;
      scanString(state);
      emitLeafNode(state, frame, segment, 'string', tokenStart);
      return;
    case 't':
      scanLiteral(state, 'true');
      emitLeafNode(state, frame, segment, 'boolean', tokenStart);
      return;
    case 'f':
      scanLiteral(state, 'false');
      emitLeafNode(state, frame, segment, 'boolean', tokenStart);
      return;
    case 'n':
      scanLiteral(state, 'null');
      emitLeafNode(state, frame, segment, 'null', tokenStart);
      return;
    case '-':
    case '0':
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7':
    case '8':
    case '9':
      scanNumber(state);
      emitLeafNode(state, frame, segment, 'number', tokenStart);
      return;
    default:
      throw malformedJsonError();
  }
}

function parseObject(
  state: ScanState,
  frame: ScanFrame | null,
  segment: string | null,
  depth: number,
): void {
  if (depth > state.limits.maxDepth) {
    throw depthExceededError();
  }
  const objectFrame: ScanFrame = {
    nodeType: 'object',
    depth,
    childCount: 0,
    keys: new Set<string>(),
    node: null,
    segments: buildSegments(frame, segment),
  };
  const start = state.position;
  state.position += 1;

  objectFrame.node = emitContainerNode(state, objectFrame, start);
  skipWhitespace(state);

  if (state.text[state.position] === '}') {
    state.position += 1;
    closeContainerNode(objectFrame, state.position);
    return;
  }

  for (;;) {
    const scannedKey = scanKey(state);
    trackObjectKey(state, objectFrame, scannedKey.key);
    skipWhitespace(state);
    if (state.text[state.position] !== ':') {
      throw malformedJsonError();
    }
    state.position += 1;
    parseValue(state, objectFrame, scannedKey.oversize ? null : scannedKey.key, depth + 1);
    objectFrame.childCount += 1;
    skipWhitespace(state);

    const separator = state.text[state.position];
    if (separator === ',') {
      state.position += 1;
      skipWhitespace(state);
      continue;
    }
    if (separator === '}') {
      state.position += 1;
      closeContainerNode(objectFrame, state.position);
      return;
    }
    throw malformedJsonError();
  }
}

function parseArray(
  state: ScanState,
  frame: ScanFrame | null,
  segment: string | null,
  depth: number,
): void {
  if (depth > state.limits.maxDepth) {
    throw depthExceededError();
  }
  const arrayFrame: ScanFrame = {
    nodeType: 'array',
    depth,
    childCount: 0,
    keys: null,
    node: null,
    segments: buildSegments(frame, segment),
  };
  const start = state.position;
  state.position += 1;

  arrayFrame.node = emitContainerNode(state, arrayFrame, start);
  skipWhitespace(state);

  if (state.text[state.position] === ']') {
    state.position += 1;
    closeContainerNode(arrayFrame, state.position);
    return;
  }

  for (;;) {
    parseValue(state, arrayFrame, String(arrayFrame.childCount), depth + 1);
    arrayFrame.childCount += 1;
    skipWhitespace(state);

    const separator = state.text[state.position];
    if (separator === ',') {
      state.position += 1;
      skipWhitespace(state);
      continue;
    }
    if (separator === ']') {
      state.position += 1;
      closeContainerNode(arrayFrame, state.position);
      return;
    }
    throw malformedJsonError();
  }
}

/**
 * Records one structural node when the emission budget still has room.
 * Containers are patched with their final child count and end offset
 * when they close.
 */
function emitLeafNode(
  state: ScanState,
  frame: ScanFrame | null,
  segment: string | null,
  nodeType: JsonNodeType,
  startPosition: number,
): void {
  recordNodeVisit(state);
  if (state.nodes.length >= state.limits.maxEmittedNodes) {
    return;
  }
  pushNode(state, nodeType, frame === null ? 0 : frame.depth, 0, buildSegments(frame, segment), {
    startPosition,
    endPosition: state.position,
  });
}

function emitContainerNode(
  state: ScanState,
  frame: ScanFrame,
  startPosition: number,
): MutableScannedNode | null {
  recordNodeVisit(state);
  if (state.nodes.length >= state.limits.maxEmittedNodes) {
    return null;
  }
  return pushNode(state, frame.nodeType, frame.depth, 0, frame.segments, {
    startPosition,
    endPosition: startPosition + 1,
  });
}

function closeContainerNode(frame: ScanFrame, endPosition: number): void {
  const node = frame.node;
  if (node) {
    node.childCount = frame.childCount;
    node.endPosition = endPosition;
  }
}

function recordNodeVisit(state: ScanState): void {
  state.totalNodes += 1;
  if (state.totalNodes > state.limits.maxNodes) {
    throw itemLimitError();
  }
}

function trackObjectKey(state: ScanState, frame: ScanFrame, key: string): void {
  if (frame.keys === null) {
    return;
  }
  if (frame.keys.has(key)) {
    state.duplicateKeyCount += 1;
    return;
  }
  if (frame.keys.size >= state.limits.maxTrackedKeysPerObject) {
    frame.keys = null;
    return;
  }
  frame.keys.add(key);
}

function pushNode(
  state: ScanState,
  nodeType: JsonNodeType,
  depth: number,
  childCount: number,
  segments: readonly (string | null)[],
  span: { readonly startPosition: number; readonly endPosition: number },
): MutableScannedNode {
  const node: MutableScannedNode = {
    nodeId: `cv_node_${(state.nodes.length + 1).toString().padStart(NODE_ID_PADDING, '0')}`,
    nodeType,
    depth,
    childCount,
    startPosition: span.startPosition,
    endPosition: span.endPosition,
    pathSegments: retainSegments(state, segments),
  };
  state.nodes.push(node);
  return node;
}

function buildSegments(
  frame: ScanFrame | null,
  segment: string | null,
): readonly (string | null)[] {
  return frame === null ? [] : [...frame.segments, segment];
}

/**
 * Retains real path segments only inside the bounded locator budget so
 * that server-side state can never grow with an adversarial document.
 */
function retainSegments(
  state: ScanState,
  segments: readonly (string | null)[],
): readonly (string | null)[] | null {
  if (segments.length > state.limits.maxPointerSegments) {
    return null;
  }
  const characterCount = segments.reduce(
    (total, segment) => total + (segment === null ? 0 : segment.length),
    0,
  );
  if (
    state.retainedLocatorCharacters + characterCount >
    state.limits.maxRetainedLocatorCharacters
  ) {
    return null;
  }
  state.retainedLocatorCharacters += characterCount;
  return segments;
}

/** Captures a bounded object key, decoding escapes, without retaining excess. */
function scanKey(state: ScanState): ScannedKey {
  skipWhitespace(state);
  if (state.text[state.position] !== '"') {
    throw malformedJsonError();
  }
  state.position += 1;

  let key = '';
  let oversize = false;

  for (;;) {
    const character = state.text[state.position];
    if (character === undefined) {
      throw malformedJsonError();
    }
    if (character === '"') {
      state.position += 1;
      return { key, oversize };
    }
    if (character === '\\') {
      state.position += 1;
      key = appendKeyCharacter(key, decodeKeyEscape(state), state, () => {
        oversize = true;
      });
      continue;
    }
    if (character.charCodeAt(0) < 0x20) {
      throw malformedJsonError();
    }
    state.position += 1;
    key = appendKeyCharacter(key, character, state, () => {
      oversize = true;
    });
  }
}

function appendKeyCharacter(
  key: string,
  addition: string,
  state: ScanState,
  markOversize: () => void,
): string {
  if (key.length >= state.limits.maxKeyCharacters) {
    markOversize();
    return key;
  }
  // Escapes decode one code unit at a time, so the combined length can
  // never exceed the cap by more than one and only the cap branch above
  // can flag oversize keys.
  return key + addition;
}

function decodeKeyEscape(state: ScanState): string {
  const character = state.text[state.position];
  state.position += 1;
  switch (character) {
    case '"':
      return '"';
    case '\\':
      return '\\';
    case '/':
      return '/';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'u': {
      let code = 0;
      for (let index = 0; index < 4; index += 1) {
        const value = hexValue(state.text[state.position + index]);
        if (value === undefined) {
          throw malformedJsonError();
        }
        code = code * 16 + value;
      }
      state.position += 4;
      return String.fromCharCode(code);
    }
    default:
      throw malformedJsonError();
  }
}

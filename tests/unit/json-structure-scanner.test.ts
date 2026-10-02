import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  MAX_JSON_KEY_CHARACTERS,
  MAX_JSON_PARSE_DEPTH,
  MAX_JSON_PARSE_NODES,
  MAX_TRACKED_JSON_KEYS_PER_OBJECT,
} from '../../src/domain/preparation/preparation-limits.js';
import { jsonScanLimits } from '../../src/domain/preparation/json-disclosure-policy.js';
import {
  scanJsonStructure,
  type JsonScanOutcome,
} from '../../src/domain/preparation/json-structure-scanner.js';
import type { ScannedJsonNode } from '../../src/domain/preparation/preparation-types.js';

function scan(
  text: string,
  overrides: Partial<Parameters<typeof scanJsonStructure>[1]> = {},
): ReturnType<typeof scanJsonStructure> {
  return scanJsonStructure(text, { ...jsonScanLimits(), ...overrides });
}

function nodeAt(outcome: JsonScanOutcome, index: number): ScannedJsonNode {
  const node = outcome.nodes[index];
  if (!node) {
    throw new Error(`Expected a scanned node at index ${String(index)}.`);
  }
  return node;
}

describe('json structure scanner', () => {
  it('emits nodes in deterministic pre-order with patched child counts', () => {
    const outcome = scan('{"a":1,"b":[true,null]}');

    expect(outcome.totalNodeCount).toBe(5);
    expect(outcome.duplicateKeyCount).toBe(0);

    const nodes = outcome.nodes;
    expect(nodes.map((node) => [node.nodeType, node.depth, node.childCount])).toEqual([
      ['object', 0, 2],
      ['number', 0, 0],
      ['array', 1, 2],
      ['boolean', 1, 0],
      ['null', 1, 0],
    ]);
    expect(nodes.map((node) => node.pathSegments)).toEqual([
      [],
      ['a'],
      ['b'],
      ['b', '0'],
      ['b', '1'],
    ]);
    expect(nodes.map((node) => node.nodeId)).toEqual([
      'cv_node_000001',
      'cv_node_000002',
      'cv_node_000003',
      'cv_node_000004',
      'cv_node_000005',
    ]);
  });

  it('handles a scalar document as a single root node', () => {
    const outcome = scan('-0.5e10');
    expect(outcome.nodes).toHaveLength(1);
    expect(nodeAt(outcome, 0)).toMatchObject({ nodeType: 'number', depth: 0, childCount: 0 });
  });

  it('handles empty containers', () => {
    const outcome = scan('{"empty":{},"list":[]}');
    expect(outcome.totalNodeCount).toBe(3);
    expect(outcome.nodes.map((node) => node.childCount)).toEqual([2, 0, 0]);
  });

  it('accepts whitespace-only containers as empty', () => {
    const objectOutcome = scan('{ }');
    expect(objectOutcome.totalNodeCount).toBe(1);
    expect(nodeAt(objectOutcome, 0)).toMatchObject({
      nodeType: 'object',
      childCount: 0,
      startPosition: 0,
      endPosition: 3,
    });

    const arrayOutcome = scan('[ \n\t]');
    expect(arrayOutcome.totalNodeCount).toBe(1);
    expect(nodeAt(arrayOutcome, 0)).toMatchObject({
      nodeType: 'array',
      childCount: 0,
      startPosition: 0,
      endPosition: 5,
    });
  });

  it('accepts whitespace around separators and values', () => {
    const outcome = scan('{ "a" : [ 1 , 2 ] }');
    expect(outcome.totalNodeCount).toBe(4);
    expect(nodeAt(outcome, 0)).toMatchObject({ nodeType: 'object', childCount: 1 });
  });

  it('accepts whitespace after member separators', () => {
    const outcome = scan('{"a": 1, "b": 2}');
    expect(outcome.totalNodeCount).toBe(3);
    expect(nodeAt(outcome, 0)).toMatchObject({ nodeType: 'object', childCount: 2 });
  });

  it('decodes escaped key characters for the retained segment', () => {
    const outcome = scan('{"h\\u00e9llo wörld":1}');
    expect(nodeAt(outcome, 1).pathSegments).toEqual(['héllo wörld']);
  });

  it('decodes every supported escape inside keys', () => {
    const outcome = scan('{"\\u00AB\\"\\\\\\/\\b\\f\\n\\r\\tz":1}');
    expect(nodeAt(outcome, 1).pathSegments).toEqual(['«"\\/\b\f\n\r\tz']);
  });

  it('decodes lowercase and uppercase hex digit boundaries inside keys', () => {
    const lowerBoundOutcome = scan('{"\\u00af":1}');
    expect(nodeAt(lowerBoundOutcome, 1).pathSegments).toEqual(['¯']);

    const upperBoundOutcome = scan('{"\\u00F0":1}');
    expect(nodeAt(upperBoundOutcome, 1).pathSegments).toEqual(['ð']);
  });

  it.each([
    ['an invalid unicode escape in a key', '{"\\u00zz":1}'],
    ['an invalid escape in a key', '{"bad\\qkey":1}'],
    ['an unterminated key', '{"key'],
    ['an eof during a key unicode escape', '{"key\\u00'],
    ['a raw control character in a key', '{"a\u0001b":1}'],
  ])('rejects %s', (_name, text) => {
    expectScanError(() => scan(text), 'CV_JSON_MALFORMED');
  });

  it('flags oversize keys reached through an escape after the cap', () => {
    const outcome = scan(`{"${'a'.repeat(MAX_JSON_KEY_CHARACTERS)}\\nb":1,"ok":2}`);
    expect(nodeAt(outcome, 1).pathSegments).toEqual([null]);
    expect(nodeAt(outcome, 2).pathSegments).toEqual(['ok']);
  });

  it('flags an oversize key terminated by the escape itself', () => {
    // No plain character follows the escape, so only the escape-branch
    // oversize callback can withhold the locator.
    const outcome = scan(`{"${'a'.repeat(MAX_JSON_KEY_CHARACTERS)}\\n":1}`);
    expect(nodeAt(outcome, 1).pathSegments).toEqual([null]);
  });

  it('rejects value strings with invalid escapes', () => {
    expectScanError(() => scan('{"a":"\\u00zz"}'), 'CV_JSON_MALFORMED');
  });

  it('decodes simple and unicode escapes inside value strings', () => {
    expect(() => scan('{"a":"\\u00e9 \\"\\\\\\/\\b\\f\\n\\r\\t"}')).not.toThrow();
  });

  it.each([
    ['a signed positive exponent', '1e+10'],
    ['an uppercase exponent', '1E5'],
  ])('scans a valid number with %s', (_name, text) => {
    const outcome = scan(`[${text}]`);
    expect(outcome.totalNodeCount).toBe(2);
    expect(nodeAt(outcome, 1).nodeType).toBe('number');
  });

  it('counts multi-digit integers through the numeric scanner', () => {
    const outcome = scan('[123456789]');
    expect(outcome.totalNodeCount).toBe(2);
    expect(nodeAt(outcome, 1).nodeType).toBe('number');
  });

  it.each([4, 5, 6, 7, 8])('scans a number starting with digit %i', (digit) => {
    const outcome = scan(`[${String(digit)}${'0'.repeat(9)}]`);
    expect(outcome.totalNodeCount).toBe(2);
    expect(nodeAt(outcome, 1)).toMatchObject({ nodeType: 'number', depth: 0, childCount: 0 });
  });

  it('detects duplicate object keys where tracking capacity allows', () => {
    const outcome = scan('{"a":1,"a":2,"b":3}');
    expect(outcome.duplicateKeyCount).toBe(1);
    expect(outcome.totalNodeCount).toBe(4);
  });

  it('keeps duplicate detection disabled beyond the tracking cap without failing', () => {
    const pairs = Array.from(
      { length: MAX_TRACKED_JSON_KEYS_PER_OBJECT + 1 },
      (_value, index) => `"k${String(index)}":0`,
    );
    const text = `{"k0":1,${pairs.slice(1).join(',')},"k0":9}`;
    const outcome = scan(text);
    expect(outcome.duplicateKeyCount).toBe(0);
    expect(outcome.totalNodeCount).toBe(MAX_TRACKED_JSON_KEYS_PER_OBJECT + 3);
  });

  it('marks oversized keys as withheld segments while continuing to scan', () => {
    const longKey = 'k'.repeat(MAX_JSON_KEY_CHARACTERS + 1);
    const outcome = scan(`{"${longKey}":1,"ok":2}`);
    expect(nodeAt(outcome, 1).pathSegments).toEqual([null]);
    expect(nodeAt(outcome, 2).pathSegments).toEqual(['ok']);
  });

  it('withholds locators beyond the segment cap without failing', () => {
    const outcome = scan('{"a":{"b":{"c":1}}}', { maxPointerSegments: 2 });
    expect(nodeAt(outcome, 3).pathSegments).toBeNull();
    expect(nodeAt(outcome, 2).pathSegments).toEqual(['a', 'b']);
  });

  it('withholds locators once the retained locator budget is exhausted', () => {
    const outcome = scan('{"first":1,"second":2}', { maxRetainedLocatorCharacters: 5 });
    expect(nodeAt(outcome, 0).pathSegments).toEqual([]);
    expect(nodeAt(outcome, 1).pathSegments).toEqual(['first']);
    expect(nodeAt(outcome, 2).pathSegments).toBeNull();
  });

  it('stops emitting nodes at the emission cap while still counting totals', () => {
    const outcome = scan('{"a":1,"b":2,"c":3}', { maxEmittedNodes: 3 });
    expect(outcome.nodes).toHaveLength(3);
    expect(outcome.totalNodeCount).toBe(4);
    expect(outcome.nodes.map((node) => node.nodeId)).toEqual([
      'cv_node_000001',
      'cv_node_000002',
      'cv_node_000003',
    ]);
    expect(nodeAt(outcome, 2).childCount).toBe(0);
  });

  it('accepts nesting up to and including the maximum supported depth', () => {
    const maxDepthText = `${'['.repeat(MAX_JSON_PARSE_DEPTH)}${']'.repeat(MAX_JSON_PARSE_DEPTH)}`;
    const atLimit = scan(maxDepthText);
    expect(atLimit.totalNodeCount).toBe(MAX_JSON_PARSE_DEPTH);
    expect(nodeAt(atLimit, atLimit.nodes.length - 1).depth).toBe(MAX_JSON_PARSE_DEPTH - 1);

    // The deepest accepted object chain reaches the limit exactly.
    const objectLimitText = `{"a":${'{"b":'.repeat(MAX_JSON_PARSE_DEPTH)}1${'}'.repeat(MAX_JSON_PARSE_DEPTH)}}`;
    expect(() => scan(objectLimitText)).not.toThrow();

    // Exactly one more nesting level reaches a depth equal to the limit:
    // strictly greater-than still accepts it, greater-or-equal would not.
    const exactLimitText = `${'['.repeat(MAX_JSON_PARSE_DEPTH + 1)}${']'.repeat(MAX_JSON_PARSE_DEPTH + 1)}`;
    const exactLimit = scan(exactLimitText);
    expect(exactLimit.totalNodeCount).toBe(MAX_JSON_PARSE_DEPTH + 1);

    const beyondLimit = `${'['.repeat(MAX_JSON_PARSE_DEPTH + 2)}${']'.repeat(MAX_JSON_PARSE_DEPTH + 2)}`;
    expectScanError(() => scan(beyondLimit), 'CV_PARSE_DEPTH_EXCEEDED');
    expectScanError(
      () =>
        scan(
          `{"a":${'{"b":'.repeat(MAX_JSON_PARSE_DEPTH + 2)}1${'}'.repeat(MAX_JSON_PARSE_DEPTH + 2)}}`,
        ),
      'CV_PARSE_DEPTH_EXCEEDED',
    );
  });

  it('rejects an invalid array separator without failing open', () => {
    expectScanError(() => scan('[1 2]'), 'CV_JSON_MALFORMED');
  });

  it.each([
    ['a missing colon', '{"a" 1}'],
    ['a missing colon before a longer value', '{"a" 12}'],
    ['an unquoted key start', '{a"b": 1}'],
    ['a stray character before the key quote', '{a": 1}'],
  ])('rejects an invalid object member %s without failing open', (_name, text) => {
    expectScanError(() => scan(text), 'CV_JSON_MALFORMED');
  });

  it.each([
    ['trailing garbage after a member', '{"a":1q'],
    ['trailing garbage after an element', '[1q'],
  ])('rejects %s without failing open', (_name, text) => {
    expectScanError(() => scan(text), 'CV_JSON_MALFORMED');
  });

  it('stops emitting nodes when a container would exceed the emission cap', () => {
    const outcome = scan('{"a":1,"b":2,"c":{"d":3}}', { maxEmittedNodes: 3 });
    expect(outcome.nodes).toHaveLength(3);
    expect(outcome.totalNodeCount).toBe(5);
    expect(nodeAt(outcome, 0).childCount).toBe(3);
  });

  it('rejects documents beyond the supported node count', () => {
    const text = `[${Array.from({ length: MAX_JSON_PARSE_NODES }, () => 'null').join(',')}]`;
    expectScanError(() => scan(text), 'CV_PARSE_ITEM_LIMIT_EXCEEDED');
  });

  it('accepts a document exactly at the supported node count', () => {
    const text = `[${Array.from({ length: MAX_JSON_PARSE_NODES - 1 }, () => 'null').join(',')}]`;
    expect(() => scan(text)).not.toThrow();
  });

  it.each([
    'empty string',
    '  ',
    '{"a"}',
    '{"a":}',
    '{"a":1,}',
    '[1,]',
    '{"a" 1}',
    '{"a":1 "b":2}',
    '{} trailing',
    '{"a":tru}',
    '{"a":undefined}',
    '"unterminated',
    '{"a":"unfinished',
    '{"a":"bad \\q escape"}',
    '{"a":"short \\u00 escape"}',
    '{"a":"raw \n control"}',
    '{"a"::1}',
    '[,]',
    '{"a":1,,}',
    '--1',
    '01',
    '1.',
    '1e',
    '1e+',
    '1.2.3',
    '.5',
    '+1',
    '{"a":1}{"b":2}',
    'nul',
    'truX',
  ])('rejects malformed JSON: %s', (text) => {
    expectScanError(() => scan(text), 'CV_JSON_MALFORMED');
  });

  it('accepts valid literal, number, and whitespace variants', () => {
    expect(() => scan('\t{\n "a" : [ 1 , 2 ] ,\r\n "b": -0.5e-10 }\n')).not.toThrow();
    expect(() => scan('[true,false,null]')).not.toThrow();
  });

  it('freezes the returned nodes and outcome', () => {
    const outcome = scan('{"a":1}');
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.nodes)).toBe(true);
    for (const node of outcome.nodes) {
      expect(Object.isFrozen(node)).toBe(true);
    }
  });
});

describe('whitespace container acceptance', () => {
  // Each padding is proven valid JSON with JSON.parse so the scanner
  // contract is pinned against the platform grammar, not just re-asserted.
  it.each([
    ['a single space', ' '],
    ['a tab', '\t'],
    ['a CRLF pair', '\r\n'],
    ['a mixed whitespace run', ' \t\r\n '],
  ] as const)('accepts an empty object padded with %s', (_name, padding) => {
    const text = `{${padding}}`;
    expect(JSON.parse(text)).toEqual({});

    const outcome = scan(text);
    expect(outcome.totalNodeCount).toBe(1);
    expect(outcome.duplicateKeyCount).toBe(0);
    expect(nodeAt(outcome, 0)).toMatchObject({
      nodeType: 'object',
      depth: 0,
      childCount: 0,
      startPosition: 0,
      endPosition: 1 + padding.length + 1,
    });
  });

  it.each([
    ['a single space', ' '],
    ['a tab', '\t'],
    ['a CRLF pair', '\r\n'],
    ['a mixed whitespace run', ' \t\r\n '],
  ] as const)('accepts an empty array padded with %s', (_name, padding) => {
    const text = `[${padding}]`;
    expect(JSON.parse(text)).toEqual([]);

    const outcome = scan(text);
    expect(outcome.totalNodeCount).toBe(1);
    expect(nodeAt(outcome, 0)).toMatchObject({
      nodeType: 'array',
      depth: 0,
      childCount: 0,
      startPosition: 0,
      endPosition: 1 + padding.length + 1,
    });
  });

  it('accepts whitespace-empty containers nested inside containers', () => {
    expect(JSON.parse('{"a": [ ]}')).toEqual({ a: [] });
    const objectWithEmptyArray = scan('{"a": [ ]}');
    expect(objectWithEmptyArray.totalNodeCount).toBe(2);
    expect(nodeAt(objectWithEmptyArray, 0)).toMatchObject({ nodeType: 'object', childCount: 1 });
    expect(nodeAt(objectWithEmptyArray, 1)).toMatchObject({
      nodeType: 'array',
      depth: 1,
      childCount: 0,
      pathSegments: ['a'],
    });

    expect(JSON.parse('[{ }]')).toEqual([{}]);
    const arrayWithEmptyObject = scan('[{ }]');
    expect(arrayWithEmptyObject.totalNodeCount).toBe(2);
    expect(nodeAt(arrayWithEmptyObject, 0)).toMatchObject({ nodeType: 'array', childCount: 1 });
    expect(nodeAt(arrayWithEmptyObject, 1)).toMatchObject({
      nodeType: 'object',
      depth: 1,
      childCount: 0,
      pathSegments: ['0'],
    });

    const mixed = scan('{"a":[{ },[ ]],"b":{ }}');
    expect(mixed.totalNodeCount).toBe(5);
    expect(mixed.nodes.map((node) => [node.nodeType, node.depth, node.childCount])).toEqual([
      ['object', 0, 2],
      ['array', 1, 2],
      ['object', 2, 0],
      ['array', 2, 0],
      ['object', 1, 0],
    ]);
  });

  it('accepts whitespace runs after member and element separators', () => {
    const objectOutcome = scan('{"a": 1 , \t "b" : 2 ,\r\n "c": 3 }');
    expect(objectOutcome.totalNodeCount).toBe(4);
    expect(nodeAt(objectOutcome, 0)).toMatchObject({ nodeType: 'object', childCount: 3 });

    const arrayText = '[1 , \t 2 ,\r\n 3 ]';
    expect(JSON.parse(arrayText)).toEqual([1, 2, 3]);
    const arrayOutcome = scan(arrayText);
    expect(arrayOutcome.totalNodeCount).toBe(4);
    expect(nodeAt(arrayOutcome, 0)).toMatchObject({ nodeType: 'array', childCount: 3 });
    // A value span starts at its first token, never at the padding.
    expect(nodeAt(arrayOutcome, 2)).toMatchObject({ startPosition: 7, endPosition: 8 });
  });

  it.each([
    ['a doubled array separator', '[1,,2]'],
    ['a doubled member separator', '{"a":1,,}'],
    ['a comma-only array', '[,]'],
    ['a comma-only object', '{,}'],
    ['a trailing member separator after whitespace', '{"a":1 , }'],
    ['a trailing element separator after whitespace', '[1 , ]'],
    ['a second bracket after a closed array', '[ ]  ]'],
    ['two root values separated by whitespace', '{ } { }'],
  ] as const)('rejects %s as malformed', (_name, text) => {
    expectScanError(() => scan(text), 'CV_JSON_MALFORMED');
  });
});

function expectScanError(execute: () => unknown, code: string): void {
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

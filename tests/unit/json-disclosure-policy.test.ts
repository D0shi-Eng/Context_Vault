import { describe, expect, it } from 'vitest';

import {
  discloseJsonPointer,
  discloseJsonStructure,
  escapeJsonPointerSegment,
  isSafeJsonKeySegment,
  isSensitiveJsonKey,
} from '../../src/domain/preparation/json-disclosure-policy.js';
import type { ScannedJsonNode } from '../../src/domain/preparation/preparation-types.js';

describe('sensitive JSON key classification', () => {
  it.each([
    'password',
    'PASSWORD',
    'passwd',
    'pwd',
    'secret',
    'api_key',
    'apiKey',
    'api-key',
    'API-TOKEN',
    'authorization',
    'access_token',
    'refreshToken',
    'credential',
    'privatekey',
    'private',
    'bearer',
    '__proto__',
    'constructor',
    'prototype',
    'client_secret',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveJsonKey(key)).toBe(true);
  });

  it.each(['name', 'value', 'configuration', 'tokenCount', 'mysecretvalue', 'protocol', ''])(
    'keeps %s disclosable',
    (key) => {
      expect(isSensitiveJsonKey(key)).toBe(false);
    },
  );
});

describe('safe JSON key segment checks', () => {
  it('accepts printable ASCII and Unicode segments', () => {
    expect(isSafeJsonKeySegment('settings')).toBe(true);
    expect(isSafeJsonKeySegment('héllo')).toBe(true);
  });

  it.each([
    ['space\u0020boundary', 'the highest control character plus one'],
    ['tilde\u007echar', 'the highest ASCII graphic'],
    ['c1\u00a0after', 'the character after the C1 range'],
    ['surrogate\uD7FFbefore', 'the code point before the surrogate range'],
    ['noncharacter\uFDEFinside', 'a noncharacter below the special range'],
    ['max\uFFEFchar', 'the code point before the specials block'],
  ])('accepts boundary-safe segment %s (%s)', (segment) => {
    expect(isSafeJsonKeySegment(segment)).toBe(true);
  });

  it.each([
    'line\nbreak',
    'tab\there',
    'carriage\rreturn',
    'nul\u0000byte',
    'unit\u001fseparator',
    'del\u007fchar',
    'c1\u0080start',
    'c1\u009fcontrol',
    'separator\u2028here',
    'paragraph\u2029here',
    'surrogate\uD800lead',
    'surrogate\uD83D',
    'surrogate\uDFFFtrail',
    'special\uFFF0start',
    'noncharacter\uFFFFtail',
  ])('rejects unsafe segment %s', (segment) => {
    expect(isSafeJsonKeySegment(segment)).toBe(false);
  });
});

describe('json pointer escaping and redaction', () => {
  it('escapes JSON Pointer special characters', () => {
    expect(escapeJsonPointerSegment('a~b/c')).toBe('a~0b~1c');
  });

  it('discloses safe segments verbatim with pointer escaping', () => {
    const pointer = discloseJsonPointer(['users', 'a/b'], 'cv_node_000009');
    expect(pointer).toEqual({ pointer: '/users/a~1b', redacted: false });
  });

  it('keeps the root document pointer empty', () => {
    expect(discloseJsonPointer([], 'cv_node_000001')).toEqual({ pointer: '', redacted: false });
  });

  it('replaces sensitive and unsafe segments with the opaque node identifier', () => {
    expect(discloseJsonPointer(['nested', 'password'], 'cv_node_000004')).toEqual({
      pointer: '/nested/cv_node_000004',
      redacted: true,
    });
    expect(discloseJsonPointer(['line\nbreak', 'value'], 'cv_node_000005')).toEqual({
      pointer: '/cv_node_000005/value',
      redacted: true,
    });
    expect(discloseJsonPointer(['normal', null], 'cv_node_000006')).toEqual({
      pointer: '/normal/cv_node_000006',
      redacted: true,
    });
  });

  it('withholds the whole pointer when the redacted form exceeds the length bound', () => {
    const longSegment = 'k'.repeat(2100);
    const pointer = discloseJsonPointer([longSegment], 'cv_node_000001');
    expect(pointer).toEqual({ pointer: null, redacted: true });
  });
});

describe('json structural disclosure', () => {
  function scannedNode(overrides: Partial<ScannedJsonNode>): ScannedJsonNode {
    return Object.freeze({
      nodeId: 'cv_node_000001',
      nodeType: 'object',
      depth: 0,
      childCount: 0,
      startPosition: 0,
      endPosition: 1,
      pathSegments: [],
      ...overrides,
    });
  }

  it('discloses bounded nodes and omits the remainder with a budget record', () => {
    const nodes = [
      scannedNode({ nodeId: 'cv_node_000001', nodeType: 'object', pathSegments: [] }),
      scannedNode({ nodeId: 'cv_node_000002', nodeType: 'number', pathSegments: ['a'] }),
    ];
    const disclosed = discloseJsonStructure(
      nodes,
      { totalNodeCount: 3, duplicateKeyCount: 0 },
      128,
    );

    expect(disclosed.descriptors).toHaveLength(2);
    expect(disclosed.omissions).toEqual([
      {
        omissionId: 'cv_omit_000000000001',
        locator: { kind: 'json_pointer', value: '/a' },
        reason: 'budget',
        itemCount: 1,
        retrievable: false,
      },
    ]);
  });

  it('rejects unsafe segment exactly at every control boundary', () => {
    expect(isSafeJsonKeySegment('unit\u001fseparator')).toBe(false);
    expect(isSafeJsonKeySegment('del\u007fseparator')).toBe(false);
    expect(isSafeJsonKeySegment('c1\u009fseparator')).toBe(false);
    expect(isSafeJsonKeySegment('high\uD83Dsurrogate')).toBe(false);
    expect(isSafeJsonKeySegment('low\uDEADsurrogate')).toBe(false);
    expect(isSafeJsonKeySegment('line\u2028separator')).toBe(false);
    expect(isSafeJsonKeySegment('paragraph\u2029separator')).toBe(false);
    expect(isSafeJsonKeySegment('reserved\uFFF0marker')).toBe(false);
    expect(isSafeJsonKeySegment('reserved\uFFFEmarker')).toBe(false);
    expect(isSafeJsonKeySegment('space boundary\u00A0ok')).toBe(true);
    expect(isSafeJsonKeySegment('printable\u20ACok')).toBe(true);
  });

  it('accepts a pointer exactly at the supported length and rejects one character more', () => {
    const boundarySegment = 'a'.repeat(2047);
    expect(discloseJsonPointer([boundarySegment], 'cv_node_000001')).toEqual({
      pointer: `/${boundarySegment}`,
      redacted: false,
    });
    const overSegment = 'a'.repeat(2048);
    const overPointer = discloseJsonPointer([overSegment], 'cv_node_000001');
    expect(overPointer.pointer).toBeNull();
    expect(overPointer.redacted).toBe(true);
  });

  it('records duplicate-key ambiguity transparently', () => {
    const disclosed = discloseJsonStructure(
      [scannedNode({ nodeId: 'cv_node_000001', nodeType: 'object', pathSegments: [] })],
      { totalNodeCount: 1, duplicateKeyCount: 2 },
      64,
    );
    expect(disclosed.omissions).toEqual([
      {
        omissionId: 'cv_omit_000000000001',
        locator: { kind: 'json_pointer', value: '/cv_node_000001' },
        reason: 'duplicate',
        itemCount: 2,
        retrievable: false,
      },
    ]);
  });

  it('numbers sequential omissions in emission order', () => {
    // Budget, duplicate, and policy omissions together pin the shared
    // omission counter: each omission id must advance exactly once.
    const disclosed = discloseJsonStructure(
      [
        scannedNode({ nodeId: 'cv_node_000001', nodeType: 'object', pathSegments: [] }),
        scannedNode({ nodeId: 'cv_node_000002', nodeType: 'number', pathSegments: ['secret'] }),
      ],
      { totalNodeCount: 3, duplicateKeyCount: 2 },
      64,
    );
    expect(disclosed.omissions.map((omission) => omission.omissionId)).toEqual([
      'cv_omit_000000000001',
      'cv_omit_000000000002',
      'cv_omit_000000000003',
    ]);
    expect(disclosed.omissions.map((omission) => omission.reason)).toEqual([
      'budget',
      'duplicate',
      'policy',
    ]);
  });

  it('bounds omission locators to the supported locator length', () => {
    const disclosed = discloseJsonStructure(
      [
        scannedNode({
          nodeId: 'cv_node_000001',
          nodeType: 'string',
          pathSegments: ['a'.repeat(256), 'b'.repeat(256)],
        }),
      ],
      { totalNodeCount: 2, duplicateKeyCount: 0 },
      1024,
    );
    const omission = disclosed.omissions[0];
    if (!omission) {
      throw new Error('Expected a budget omission for the withheld node.');
    }
    expect(omission.reason).toBe('budget');
    expect(omission.locator.value.length).toBeLessThanOrEqual(512);
  });

  it('records policy redactions for redacted pointers and withheld locators', () => {
    const nodes = [
      scannedNode({ nodeId: 'cv_node_000001', nodeType: 'number', pathSegments: ['secret'] }),
      scannedNode({ nodeId: 'cv_node_000002', nodeType: 'number', pathSegments: null }),
    ];
    const disclosed = discloseJsonStructure(nodes, { totalNodeCount: 2, duplicateKeyCount: 0 }, 64);

    expect(disclosed.descriptors[0]).toMatchObject({
      pointer: '/cv_node_000001',
      pointerRedacted: true,
    });
    expect(disclosed.descriptors[1]).toMatchObject({
      pointer: null,
      pointerRedacted: true,
    });
    expect(disclosed.omissions).toEqual([
      {
        omissionId: 'cv_omit_000000000001',
        locator: { kind: 'json_pointer', value: 'cv_node_000002' },
        reason: 'policy',
        itemCount: 2,
        retrievable: false,
      },
    ]);
  });

  it('falls back to a byte-range locator when no descriptor exists', () => {
    const disclosed = discloseJsonStructure([], { totalNodeCount: 1, duplicateKeyCount: 0 }, 16);
    expect(disclosed.descriptors).toEqual([]);
    expect(disclosed.omissions).toEqual([
      {
        omissionId: 'cv_omit_000000000001',
        locator: { kind: 'byte_range', value: '0-16' },
        reason: 'budget',
        itemCount: 1,
        retrievable: false,
      },
    ]);
  });

  it('emits no omissions for a clean bounded document', () => {
    const disclosed = discloseJsonStructure(
      [scannedNode({ nodeId: 'cv_node_000001', nodeType: 'number', pathSegments: ['a'] })],
      { totalNodeCount: 1, duplicateKeyCount: 0 },
      16,
    );
    expect(disclosed.omissions).toEqual([]);
    expect(disclosed.descriptors[0]).toMatchObject({
      pointer: '/a',
      pointerRedacted: false,
    });
  });
});

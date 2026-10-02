/**
 * Pure disclosure rules for JSON structural metadata.
 *
 * The policy decides how scanned structural nodes are disclosed: it
 * escapes JSON Pointer segments, replaces sensitive-looking key segments
 * and oversized keys with opaque node identifiers, enforces strict
 * pointer length and segment limits, and records machine-readable
 * omission reasons. It never sees and never returns JSON values.
 */

import {
  MAX_EMITTED_JSON_NODES,
  MAX_JSON_KEY_CHARACTERS,
  MAX_JSON_PARSE_DEPTH,
  MAX_JSON_PARSE_NODES,
  MAX_JSON_POINTER_LENGTH,
  MAX_JSON_POINTER_SEGMENTS,
  MAX_TRACKED_JSON_KEYS_PER_OBJECT,
  MAX_RETAINED_JSON_LOCATOR_CHARACTERS,
} from './preparation-limits.js';
import type {
  JsonNodeDescriptor,
  OmissionRecord,
  ScannedJsonNode,
  StructuralLocator,
} from './preparation-types.js';
import type { JsonScanLimits } from './json-structure-scanner.js';

const SENSITIVE_JSON_KEY_NAMES: ReadonlySet<string> = new Set([
  'accesskey',
  'accesstoken',
  'apikey',
  'apitoken',
  'authkey',
  'authorization',
  'authtoken',
  'bearer',
  'clientsecret',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'constructor',
  'idtoken',
  'passwd',
  'password',
  'private',
  'privatekey',
  'proto',
  'prototype',
  'pwd',
  'refreshtoken',
  'secret',
  'secretkey',
  'secrets',
  'session',
  'sessionid',
  'sessionkey',
  'sessiontoken',
  'token',
  'tokens',
]);

/** Single composition point for the fixed JSON scanning bounds. */
export function jsonScanLimits(): JsonScanLimits {
  return Object.freeze({
    maxDepth: MAX_JSON_PARSE_DEPTH,
    maxNodes: MAX_JSON_PARSE_NODES,
    maxEmittedNodes: MAX_EMITTED_JSON_NODES,
    maxPointerSegments: MAX_JSON_POINTER_SEGMENTS,
    maxKeyCharacters: MAX_JSON_KEY_CHARACTERS,
    maxTrackedKeysPerObject: MAX_TRACKED_JSON_KEYS_PER_OBJECT,
    maxRetainedLocatorCharacters: MAX_RETAINED_JSON_LOCATOR_CHARACTERS,
  });
}

/**
 * Recognizes key names whose disclosure would expose sensitive structure.
 * Matching is exact after case folding and separator removal so ordinary
 * document keys stay untouched while credential-shaped keys are redacted.
 */
export function isSensitiveJsonKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_. ]/gu, '');
  return SENSITIVE_JSON_KEY_NAMES.has(normalized);
}

/**
 * Decides whether a key segment is safe to disclose verbatim.
 * Control characters, surrogates, and line separators are always replaced.
 */
export function isSafeJsonKeySegment(segment: string): boolean {
  for (const character of segment) {
    const codeUnit = character.charCodeAt(0);
    if (
      codeUnit <= 0x1f ||
      (codeUnit >= 0x7f && codeUnit <= 0x9f) ||
      (codeUnit >= 0xd800 && codeUnit <= 0xdfff) ||
      codeUnit === 0x2028 ||
      codeUnit === 0x2029 ||
      codeUnit >= 0xfff0
    ) {
      return false;
    }
  }
  return true;
}

export function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Builds the disclosed JSON Pointer for one scanned node.
 * Sensitive, unsafe, and oversized key segments are replaced with the
 * opaque node identifier, and overlong pointers are fully withheld.
 */
export function discloseJsonPointer(
  segments: readonly (string | null)[],
  nodeId: string,
): { readonly pointer: string | null; readonly redacted: boolean } {
  let redacted = false;
  let pointer = '';

  for (const segment of segments) {
    if (segment === null || !isSafeJsonKeySegment(segment) || isSensitiveJsonKey(segment)) {
      pointer += `/${nodeId}`;
      redacted = true;
      continue;
    }
    pointer += `/${escapeJsonPointerSegment(segment)}`;
  }

  if (pointer.length > MAX_JSON_POINTER_LENGTH) {
    return Object.freeze({ pointer: null, redacted: true });
  }
  return Object.freeze({ pointer, redacted });
}

/**
 * Maps bounded scanned nodes into the disclosed descriptor shape and
 * produces omission records for withheld nodes and detected duplicate-key
 * ambiguity. Redacted pointers and withheld locators are covered by the
 * per-node `pointerRedacted` state and one policy omission record.
 */
export function discloseJsonStructure(
  nodes: readonly ScannedJsonNode[],
  totals: {
    readonly totalNodeCount: number;
    readonly duplicateKeyCount: number;
  },
  sourceBytes: number,
): {
  readonly descriptors: readonly JsonNodeDescriptor[];
  readonly omissions: readonly OmissionRecord[];
} {
  const descriptors: JsonNodeDescriptor[] = nodes.map((node) => {
    if (node.pathSegments === null) {
      return Object.freeze({
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        depth: node.depth,
        childCount: node.childCount,
        pointer: null,
        pointerRedacted: true,
      });
    }
    const pointer = discloseJsonPointer(node.pathSegments, node.nodeId);
    return Object.freeze({
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      depth: node.depth,
      childCount: node.childCount,
      pointer: pointer.pointer,
      pointerRedacted: pointer.redacted,
    });
  });

  const omissions: OmissionRecord[] = [];
  let omissionCounter = 0;
  const omittedNodeCount = Math.max(0, totals.totalNodeCount - descriptors.length);
  if (omittedNodeCount > 0) {
    omissions.push(
      buildOmission(
        omissionCounter,
        omittedNodeCount,
        'budget',
        descriptorLocator(descriptors, sourceBytes),
      ),
    );
    omissionCounter += 1;
  }
  if (totals.duplicateKeyCount > 0) {
    omissions.push(
      buildOmission(
        omissionCounter,
        totals.duplicateKeyCount,
        'duplicate',
        descriptorLocator(descriptors, sourceBytes),
      ),
    );
    omissionCounter += 1;
  }
  const policyRedactionCount = countPolicyRedactions(descriptors);
  if (policyRedactionCount > 0) {
    omissions.push(
      buildOmission(
        omissionCounter,
        policyRedactionCount,
        'policy',
        descriptorLocator(descriptors, sourceBytes),
      ),
    );
  }

  return Object.freeze({
    descriptors: Object.freeze(descriptors),
    omissions: Object.freeze(omissions),
  });
}

function countPolicyRedactions(descriptors: readonly JsonNodeDescriptor[]): number {
  return descriptors.filter((descriptor) => descriptor.pointerRedacted).length;
}

function descriptorLocator(
  descriptors: readonly JsonNodeDescriptor[],
  sourceBytes: number,
): StructuralLocator {
  const last = descriptors.at(-1);
  if (!last) {
    return { kind: 'byte_range', value: `0-${String(sourceBytes)}` };
  }
  const value = (last.pointer ?? last.nodeId).slice(0, 512);
  return { kind: 'json_pointer', value: value.length === 0 ? `/${last.nodeId}` : value };
}

function buildOmission(
  counter: number,
  itemCount: number,
  reason: OmissionRecord['reason'],
  locator: StructuralLocator,
): OmissionRecord {
  return Object.freeze({
    omissionId: `cv_omit_${(counter + 1).toString().padStart(12, '0')}`,
    locator,
    reason,
    itemCount,
    retrievable: false,
  });
}

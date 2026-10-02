/**
 * Immutable types and pure rules for the structural preparation lifecycle.
 *
 * The disclosure classification is deliberately precise: preparation never
 * returns raw source content, but it does return bounded structural
 * metadata such as byte ranges, line ranges, digests, and opaque
 * identifiers. Callers must not describe the result as content-free in
 * general, only as raw-content-free.
 */

import type { IssuedRetrievalGrant } from '../retrieval/retrieval-types.js';

export const PREPARE_DISCLOSURE_CLASSIFICATION =
  'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const;

export type PreparationKind = 'text_chunks' | 'json_structure' | 'minimal';

/** Bounded structural locators that never contain source content. */
export type StructuralLocator =
  | { readonly kind: 'byte_range'; readonly value: string }
  | { readonly kind: 'line_range'; readonly value: string }
  | { readonly kind: 'json_pointer'; readonly value: string };

/** Machine-readable reason explaining why derived detail was omitted. */
export type OmissionReason = 'budget' | 'duplicate' | 'policy' | 'unsupported';

export interface OmissionRecord {
  readonly omissionId: string;
  readonly locator: StructuralLocator;
  readonly reason: OmissionReason;
  readonly itemCount: number;
  readonly retrievable: false;
}

export interface TextChunkDescriptor {
  readonly chunkId: string;
  readonly byteStart: number;
  readonly byteEndExclusive: number;
  readonly lineStart: number;
  readonly lineEndExclusive: number;
  readonly byteLength: number;
  readonly chunkDigest: string;
  readonly truncated: boolean;
}

export type JsonNodeType = 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string';

/**
 * Server-side scanned JSON node with the real path segments retained for
 * bounded in-memory lifecycle continuity. Segments may contain source key
 * names and must never be disclosed directly; disclosure always goes
 * through the redaction policy.
 */
export interface ScannedJsonNode {
  readonly nodeId: string;
  readonly nodeType: JsonNodeType;
  readonly depth: number;
  readonly childCount: number;
  /** Exact character span in the decoded document; server-side only. */
  readonly startPosition: number;
  readonly endPosition: number;
  /** Path segments from the document root; `null` marks an oversized key. */
  readonly pathSegments: readonly (string | null)[] | null;
}

/**
 * Disclosed JSON structural descriptor. The pointer is a redacted,
 * bounded JSON Pointer; `null` marks a fully withheld locator.
 */
export interface JsonNodeDescriptor {
  readonly nodeId: string;
  readonly nodeType: JsonNodeType;
  readonly depth: number;
  readonly childCount: number;
  readonly pointer: string | null;
  readonly pointerRedacted: boolean;
}

/**
 * Server-side, memory-only record for one prepared source.
 *
 * The record never retains the source bytes or any decoded source text;
 * it holds only bounded derived metadata, real locators for future
 * lifecycle continuity, its computed serialized size, and the
 * deterministic structural fingerprint. Real locators and the
 * authorized root/path binding are server-side only and are never
 * disclosed.
 */
export interface PreparedEnvelopeRecord {
  readonly envelopeId: string;
  readonly sessionId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** Authorized root identifier bound at preparation time; server-side only. */
  readonly rootId: string;
  /** Normalized relative path bound at preparation time; server-side only. */
  readonly normalizedRelativePath: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sensitivity: string;
  readonly secretRisk: string;
  readonly preparationKind: PreparationKind;
  readonly disclosureClass: typeof PREPARE_DISCLOSURE_CLASSIFICATION;
  readonly retrievalAllowed: boolean;
  readonly lineCount: number;
  readonly structuralFingerprint: string;
  readonly derivedBytes: number;
  readonly chunks: readonly TextChunkDescriptor[];
  readonly jsonNodes: readonly ScannedJsonNode[];
  readonly omissions: readonly OmissionRecord[];
}

/**
 * Disclosed envelope returned to the MCP client after preparation.
 * `retrievalAllowed` stays false unless an explicit, valid retrieval
 * grant was requested and narrowed in the same call; grant metadata is
 * attached only at issuance time and never contains raw source content.
 */
export interface PrepareSuccessEnvelope {
  readonly envelopeId: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sensitivity: string;
  readonly secretRisk: string;
  readonly preparationKind: PreparationKind;
  readonly disclosureClass: typeof PREPARE_DISCLOSURE_CLASSIFICATION;
  readonly retrievalAllowed: boolean;
  readonly lineCount: number;
  readonly chunks: readonly TextChunkDescriptor[];
  readonly jsonNodes: readonly JsonNodeDescriptor[];
  readonly omissions: readonly OmissionRecord[];
  readonly structuralFingerprint: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly retrieval?: IssuedRetrievalGrant;
}

export interface PrepareSuccess {
  readonly schemaVersion: '1.0';
  readonly ok: true;
  readonly envelope: PrepareSuccessEnvelope;
}

/**
 * Builds a deterministic canonical payload over the fields that must stay
 * stable across repeated preparations of the same bytes and limits.
 *
 * Random identifiers, timestamps, and derived-state bookkeeping fields are
 * intentionally excluded so the payload can be hashed into the structural
 * fingerprint without depending on volatility.
 */
export function canonicalStructuralPayload(
  record: Pick<
    PrepareSuccessEnvelope,
    | 'sourceDigest'
    | 'mediaType'
    | 'bytes'
    | 'sensitivity'
    | 'secretRisk'
    | 'preparationKind'
    | 'lineCount'
    | 'chunks'
    | 'jsonNodes'
    | 'omissions'
  >,
): string {
  const payload = {
    sourceDigest: record.sourceDigest,
    mediaType: record.mediaType,
    bytes: record.bytes,
    sensitivity: record.sensitivity,
    secretRisk: record.secretRisk,
    preparationKind: record.preparationKind,
    lineCount: record.lineCount,
    chunks: record.chunks,
    jsonNodes: record.jsonNodes,
    omissions: record.omissions,
  };
  return JSON.stringify(payload);
}

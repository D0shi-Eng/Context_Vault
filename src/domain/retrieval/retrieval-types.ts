/**
 * Pure types and records for the scoped opaque retrieval grant lifecycle.
 *
 * A capability token is an opaque bearer value issued exactly once, at
 * grant-issuance time. The server stores only a cryptographic digest of
 * the token as the lookup key; the raw token is never retained and never
 * logged. Grants are bound to the private process session, one envelope,
 * one authorized root, one source identity, one source digest, a bounded
 * selector-type allowlist, a maximum output byte count, an expiry, and a
 * revocation state.
 *
 * All responses to a failed capability check use one generic error code;
 * no distinction between tampered, expired, revoked, or wrong-binding
 * capabilities is ever disclosed, so the tool cannot be used as a public
 * capability-validation oracle.
 */

export type RetrievalSelectorKind = 'chunk' | 'json_node' | 'line_range';

export const ALL_RETRIEVAL_SELECTOR_KINDS: readonly RetrievalSelectorKind[] = Object.freeze([
  'chunk',
  'json_node',
  'line_range',
]);

/** Exactly one of the three supported exact-retrieval selectors. */
export type RetrievalSelector =
  | { readonly kind: 'chunk'; readonly chunkId: string }
  | { readonly kind: 'json_node'; readonly nodeId: string }
  | { readonly kind: 'line_range'; readonly startLine: number; readonly endLine: number };

export interface RetrievalGrantRequest {
  readonly allowedSelectorTypes: readonly RetrievalSelectorKind[];
  readonly maxBytes: number;
  readonly ttlSeconds: number;
}

/** Server-side, memory-only record for one retrieval grant. */
export interface RetrievalGrantRecord {
  readonly tokenDigest: string;
  readonly sessionId: string;
  readonly envelopeId: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly allowedSelectorTypes: readonly RetrievalSelectorKind[];
  readonly maxBytes: number;
  readonly expiresAt: Date;
  revoked: boolean;
}

/**
 * Disclosed grant metadata returned exactly once with the prepare
 * response. `capability` is the raw bearer token; every later operation
 * references the envelope or the digest, never the raw token.
 */
export interface IssuedRetrievalGrant {
  readonly capability: string;
  readonly expiresAt: string;
  readonly allowedSelectorTypes: readonly RetrievalSelectorKind[];
  readonly maxBytes: number;
}

/** One confirmed retrieval operation, retained in a bounded provenance ring. */
export interface RetrievalProvenanceRecord {
  readonly envelopeId: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly selectorKind: RetrievalSelectorKind;
  readonly excerptDigest: string;
  readonly byteCount: number;
  readonly truncated: boolean;
  readonly recordedAt: string;
}

export type RetrievalGrantDecision =
  | { readonly ok: true; readonly narrowed: RetrievalGrantRequest }
  | {
      readonly ok: false;
      readonly reason: 'confirmed_secret' | 'unsupported_preparation' | 'policy';
    };

/** Untrusted retrieve request exactly as it arrives from an MCP client. */
export interface RetrieveRequestInput {
  readonly capability: string;
  readonly selector: RetrievalSelector;
  readonly maxBytes?: number;
}

/**
 * Exact, bounded retrieval result for one selector.
 * `byteCount` counts the exact source bytes backing `content` before any
 * UTF-8 boundary back-off, and `excerptDigest` is the digest of those
 * exact returned bytes, so completeness is machine-checkable.
 */
export interface RetrieveSuccess {
  readonly schemaVersion: '1.0';
  readonly ok: true;
  readonly envelopeId: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly selector: RetrievalSelector;
  readonly locator: { readonly kind: string; readonly value: string };
  readonly byteCount: number;
  readonly excerptDigest: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly hasMore: boolean;
}

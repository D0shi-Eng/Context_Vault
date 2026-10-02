import type {
  RetrievalGrantRecord,
  RetrievalProvenanceRecord,
  RetrievalSelectorKind,
} from '../../domain/retrieval/retrieval-types.js';

/**
 * Generates cryptographically secure opaque capability tokens.
 * Implementations live in infrastructure and must use platform
 * randomness; tokens are returned exactly once at issuance time.
 */
export interface CapabilityTokenFactory {
  createCapabilityToken(): string;
}

/** Derives the stored lookup digest for one capability token. */
export interface CapabilityTokenDigester {
  digestCapabilityToken(token: string): string;
}

/**
 * Compares two capability-token digests with the platform constant-time
 * primitive where an actual byte-level comparison is required.
 *
 * The digest-keyed grant lookup itself is a hash-map access and is NOT a
 * constant-time comparison; no code may claim otherwise.
 */
export interface CapabilityDigestComparator {
  compareCapabilityDigests(left: string, right: string): boolean;
  /**
   * A fixed digest compared against when no grant matches, so the miss
   * path performs the same comparison work as the hit path.
   */
  readonly absentCapabilityDigest: string;
}

/**
 * Narrow, retrieval-only view of the session store.
 *
 * Implementations must never return or log raw capability tokens; only
 * digest-keyed records are exposed.
 */
export interface RetrievalVault {
  findGrantByTokenDigest(tokenDigest: string): RetrievalGrantRecord | undefined;
  /** Counts unrevoked, unexpired grants at the given instant. */
  countActiveGrants(now: Date): number;
  /** Retains one bounded provenance record, evicting the oldest when full. */
  appendProvenance(record: RetrievalProvenanceRecord): void;
  listProvenanceForEnvelope(envelopeId: string): readonly RetrievalProvenanceRecord[];
}

/** The exact values one successful retrieval contributes to provenance. */
export interface RetrievalProvenanceInput {
  readonly envelopeId: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly selectorKind: RetrievalSelectorKind;
  readonly excerptDigest: string;
  readonly byteCount: number;
  readonly truncated: boolean;
  readonly recordedAt: string;
}

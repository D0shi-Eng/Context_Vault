import type { RetrievalSelectorKind } from '../retrieval/retrieval-types.js';

export const SCHEMA_VERSION = '1.0' as const;

export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted' | 'prohibited';

export type SecretRisk = 'none' | 'suspected' | 'confirmed' | 'unknown';

/**
 * Selector kinds announced for a source. This is the retrieval-side
 * selector vocabulary: the announcement and the grants that honor it
 * share one type, so the two can never drift apart.
 */
export type SelectorKind = RetrievalSelectorKind;

/**
 * Trusted source reference used inside the application and domain layers.
 *
 * Instances are only produced after the untrusted `SourceReferenceInput` has
 * passed the use-case input boundary, so `kind` is already narrowed to the
 * single supported source class.
 */
export interface SourceReference {
  readonly kind: 'workspace_file';
  readonly rootId: string;
  readonly path: string;
}

/**
 * Untrusted source reference exactly as it arrives from an MCP client.
 *
 * `kind` is intentionally widened to `string`: the MCP adapter schema is one
 * control, but the use case must independently validate the discriminator
 * rather than trusting the transport. This keeps authorization fail-closed if a
 * request bypasses or defeats the adapter validation.
 */
export interface SourceReferenceInput {
  readonly kind: string;
  readonly rootId: string;
  readonly path: string;
}

export interface SourceInspection {
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sensitivity: Sensitivity;
  readonly secretRisk: SecretRisk;
  readonly supportedSelectors: readonly SelectorKind[];
  readonly inspectedAt: string;
}

export interface InspectSuccess {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly ok: true;
  readonly source: SourceInspection;
}

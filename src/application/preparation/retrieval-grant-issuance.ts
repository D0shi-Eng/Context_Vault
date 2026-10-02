import type {
  CapabilityTokenDigester,
  CapabilityTokenFactory,
} from '../ports/retrieval-services.js';
import type { PreparedGrantCommit } from '../ports/preparation-services.js';
import type {
  IssuedRetrievalGrant,
  RetrievalGrantRequest,
} from '../../domain/retrieval/retrieval-types.js';

export interface GrantIssuanceOutcome {
  /** The single disclosure of the raw capability token. */
  readonly metadata: IssuedRetrievalGrant;
  /** The digest-bound commit handed to the vault, never the raw token. */
  readonly commit: PreparedGrantCommit;
}

/**
 * Issues one opaque retrieval grant from platform randomness.
 *
 * The raw token is embedded in the disclosed metadata exactly once and
 * is immediately reduced to a digest for the server-side record; no raw
 * token is retained anywhere in server state.
 */
export class RetrievalGrantIssuer {
  readonly #tokens: CapabilityTokenFactory;
  readonly #digester: CapabilityTokenDigester;

  constructor(dependencies: {
    readonly tokens: CapabilityTokenFactory;
    readonly digester: CapabilityTokenDigester;
  }) {
    this.#tokens = dependencies.tokens;
    this.#digester = dependencies.digester;
  }

  issue(narrowed: RetrievalGrantRequest, issuedAt: Date): GrantIssuanceOutcome {
    const capability = this.#tokens.createCapabilityToken();
    const tokenDigest = this.#digester.digestCapabilityToken(capability);
    const expiresAt = new Date(issuedAt.getTime() + narrowed.ttlSeconds * 1000);

    return Object.freeze({
      metadata: Object.freeze({
        capability,
        expiresAt: expiresAt.toISOString(),
        allowedSelectorTypes: narrowed.allowedSelectorTypes,
        maxBytes: narrowed.maxBytes,
      }),
      commit: Object.freeze({
        tokenDigest,
        allowedSelectorTypes: narrowed.allowedSelectorTypes,
        maxBytes: narrowed.maxBytes,
        expiresAt,
      }),
    });
  }
}

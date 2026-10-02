import type {
  CapabilityDigestComparator,
  CapabilityTokenDigester,
  RetrievalVault,
} from '../ports/retrieval-services.js';
import type { AuthorizedFileReader } from '../ports/authorized-file-reader.js';
import type { InspectionClock, InspectionCryptography } from '../ports/inspection-services.js';
import type { PreparationVault } from '../ports/preparation-services.js';
import type { PreparedEnvelopeRecord } from '../../domain/preparation/preparation-types.js';
import { ContextVaultError } from '../../domain/errors/context-vault-error.js';
import type {
  RetrievalGrantRecord,
  RetrievalProvenanceRecord,
  RetrievalSelector,
  RetrieveRequestInput,
  RetrieveSuccess,
} from '../../domain/retrieval/retrieval-types.js';
import {
  isWellFormedCapability,
  validateCapabilityRequest,
} from '../../domain/retrieval/retrieval-grant-policy.js';
import {
  narrowOutputByteLimit,
  validateRequestedOutputBytes,
  validateRetrievalSelector,
} from '../../domain/retrieval/retrieval-selector-policy.js';
import {
  MAX_RETRIEVAL_OUTPUT_BYTES,
  RETRIEVE_DEADLINE_MILLISECONDS,
} from '../../domain/preparation/preparation-limits.js';
import { DEFAULT_SOURCE_BYTE_LIMIT } from '../inspection/inspect-source.js';
import { classifyContent } from '../../domain/inspection/content-classification.js';
import type { PreparedSourceDescriptor } from './excerpt-extraction.js';
import { extractExcerptBytes } from './excerpt-extraction.js';

export interface RetrieveSourceDependencies {
  readonly clock: InspectionClock;
  readonly cryptography: InspectionCryptography;
  readonly fileReader: AuthorizedFileReader;
  readonly vault: PreparationVault;
  readonly retrievalVault: RetrievalVault;
  readonly tokenDigester: CapabilityTokenDigester;
  readonly digestComparator: CapabilityDigestComparator;
}

export class RetrieveSource {
  readonly #clock: InspectionClock;
  readonly #cryptography: InspectionCryptography;
  readonly #fileReader: AuthorizedFileReader;
  readonly #vault: PreparationVault;
  readonly #retrievalVault: RetrievalVault;
  readonly #tokenDigester: CapabilityTokenDigester;
  readonly #digestComparator: CapabilityDigestComparator;

  constructor(dependencies: RetrieveSourceDependencies) {
    this.#clock = dependencies.clock;
    this.#cryptography = dependencies.cryptography;
    this.#fileReader = dependencies.fileReader;
    this.#vault = dependencies.vault;
    this.#retrievalVault = dependencies.retrievalVault;
    this.#tokenDigester = dependencies.tokenDigester;
    this.#digestComparator = dependencies.digestComparator;
  }

  async execute(request: RetrieveRequestInput, signal?: AbortSignal): Promise<RetrieveSuccess> {
    const capabilityRequest = validateCapabilityRequest(request);
    validateWellFormedCapability(capabilityRequest.capability);
    const selector = validateRetrievalSelector(capabilityRequest.selector);
    const requestedBytes = validateRequestedOutputBytes(capabilityRequest.maxBytes);

    const deadline = this.#clock.now().getTime() + RETRIEVE_DEADLINE_MILLISECONDS;
    assertNotCancelled(signal);

    // Grant validation happens before any expensive work. Every failure
    // in this block collapses to one generic capability error so the
    // tool never reveals why a capability failed to validate.
    let grant = this.#resolveGrant(capabilityRequest.capability, selector);

    // Sweeping expired envelopes keeps state and grants consistent, and
    // every post-sweep step below is synchronous, so no purge can race
    // between validation and result assembly.
    this.#vault.sweepExpired(this.#clock.now());

    let envelope = this.#loadLiveEnvelope(grant, selector);

    const byteLimit = narrowOutputByteLimit(
      requestedBytes,
      grant.maxBytes,
      MAX_RETRIEVAL_OUTPUT_BYTES,
    );

    // The file read is the only await in this use case; authorization,
    // identity, and digest checks are revalidated after it completes.
    const file = await this.#fileReader.read({
      rootId: envelope.rootId,
      normalizedRelativePath: envelope.normalizedRelativePath,
      maximumBytes: DEFAULT_SOURCE_BYTE_LIMIT,
      ...(signal ? { signal } : {}),
    });
    assertNotCancelled(signal);
    assertDeadline(this.#clock, deadline);

    const sourceDigest = this.#cryptography.sha256(file.bytes);
    if (sourceDigest !== envelope.sourceDigest) {
      throw new ContextVaultError({
        code: 'CV_SOURCE_CHANGED',
        message: 'The source no longer matches its prepared digest.',
      });
    }

    // A purge - or an expiry sweep triggered by a concurrent operation -
    // may have run while the read was in flight. The grant and the
    // envelope are re-resolved here so revoked state can never back a
    // disclosure; everything after this point is synchronous and cannot
    // interleave with a purge.
    grant = this.#resolveGrant(capabilityRequest.capability, selector);
    envelope = this.#loadLiveEnvelope(grant, selector);

    const descriptor: PreparedSourceDescriptor = {
      preparationKind: envelope.preparationKind,
      chunks: envelope.chunks,
      jsonNodes: envelope.jsonNodes,
      bytes: file.bytes,
    };
    const excerpt = extractExcerptBytes(descriptor, selector, byteLimit);

    // The secret-risk policy runs on the exact bytes about to be
    // disclosed; matches are never quoted in the error. A confirmed
    // excerpt implies a confirmed source, so an honestly prepared grant
    // can never reach this denial — it is a fail-closed second barrier
    // against a mislabeled record, not the primary enforcement point.
    const excerptClassification = classifyContent(
      envelope.normalizedRelativePath,
      excerpt.contentBytes,
    );
    if (excerptClassification.secretRisk === 'confirmed') {
      throw new ContextVaultError({
        code: 'CV_RETRIEVAL_POLICY_DENIED',
        message: 'The requested excerpt was denied by the secret-risk policy.',
        safeDetails: { reason: 'secret_policy' },
      });
    }

    const content = new TextDecoder('utf-8', { fatal: true }).decode(excerpt.contentBytes);
    const excerptDigest = this.#cryptography.sha256(excerpt.contentBytes);

    this.#recordProvenance(envelope, selector, excerptDigest, excerpt);

    return Object.freeze({
      schemaVersion: '1.0' as const,
      ok: true as const,
      envelopeId: envelope.envelopeId,
      sourceId: envelope.sourceId,
      sourceDigest: envelope.sourceDigest,
      selector,
      locator: excerpt.locator,
      byteCount: excerpt.contentBytes.byteLength,
      excerptDigest,
      content,
      truncated: excerpt.truncated,
      hasMore: excerpt.hasMore,
    });
  }

  /**
   * Resolves the stored grant for one presented capability token.
   *
   * The digest-keyed lookup is a hash-map access, which is not a
   * constant-time comparison; the one real byte-level check below uses
   * the platform constant-time primitive. The miss path compares against
   * a fixed digest so hit and miss perform the same work.
   */
  #resolveGrant(capability: string, selector: RetrievalSelector): RetrievalGrantRecord {
    const presentedDigest = this.#tokenDigester.digestCapabilityToken(capability);
    const grant = this.#retrievalVault.findGrantByTokenDigest(presentedDigest);
    const expectedDigest = grant?.tokenDigest ?? this.#digestComparator.absentCapabilityDigest;
    const digestMatches = this.#digestComparator.compareCapabilityDigests(
      presentedDigest,
      expectedDigest,
    );

    const now = this.#clock.now();
    if (
      grant === undefined ||
      !digestMatches ||
      grant.revoked ||
      grant.expiresAt.getTime() <= now.getTime() ||
      grant.sessionId !== this.#vault.sessionId ||
      !grant.allowedSelectorTypes.includes(selector.kind)
    ) {
      throw new ContextVaultError({
        code: 'CV_CAPABILITY_INVALID',
        message: 'The retrieval capability is invalid for this request.',
      });
    }
    return grant;
  }

  /**
   * Loads the live envelope for a validated grant and re-checks the
   * grant-to-envelope binding and the selector scope.
   */
  #loadLiveEnvelope(
    grant: RetrievalGrantRecord,
    selector: RetrievalSelector,
  ): PreparedEnvelopeRecord {
    const envelope = this.#vault.find(grant.envelopeId);
    if (envelope === undefined) {
      throw new ContextVaultError({
        code: 'CV_ENVELOPE_NOT_FOUND',
        message: 'The retrieval envelope is not available.',
      });
    }
    assertGrantBinding(grant, envelope);
    assertSelectorAllowed(selector, envelope);
    return envelope;
  }

  #recordProvenance(
    envelope: PreparedEnvelopeRecord,
    selector: RetrievalSelector,
    excerptDigest: string,
    excerpt: ReturnType<typeof extractExcerptBytes>,
  ): void {
    const record: RetrievalProvenanceRecord = Object.freeze({
      envelopeId: envelope.envelopeId,
      sourceId: envelope.sourceId,
      sourceDigest: envelope.sourceDigest,
      selectorKind: selector.kind,
      excerptDigest,
      byteCount: excerpt.contentBytes.byteLength,
      truncated: excerpt.truncated,
      recordedAt: this.#clock.now().toISOString(),
    });
    this.#retrievalVault.appendProvenance(record);
  }
}

function validateWellFormedCapability(candidate: string): void {
  if (!isWellFormedCapability(candidate)) {
    throw new ContextVaultError({
      code: 'CV_CAPABILITY_INVALID',
      message: 'The retrieval capability is invalid for this request.',
    });
  }
}

function assertGrantBinding(grant: RetrievalGrantRecord, envelope: PreparedEnvelopeRecord): void {
  if (
    grant.envelopeId !== envelope.envelopeId ||
    grant.sourceId !== envelope.sourceId ||
    grant.sourceDigest !== envelope.sourceDigest
  ) {
    throw new ContextVaultError({
      code: 'CV_CAPABILITY_INVALID',
      message: 'The retrieval capability is invalid for this request.',
    });
  }
}

function assertSelectorAllowed(
  selector: RetrievalSelector,
  envelope: PreparedEnvelopeRecord,
): void {
  // The grant allowlist itself is enforced by the capability check that
  // always runs before this function; only the envelope-kind support is
  // decided here, so a mislabeled envelope fails closed instead of
  // disclosing through a selector its kind cannot honor exactly.
  const kindSupportedByEnvelope =
    (selector.kind === 'chunk' && envelope.preparationKind === 'text_chunks') ||
    (selector.kind === 'json_node' && envelope.preparationKind === 'json_structure') ||
    (selector.kind === 'line_range' &&
      (envelope.preparationKind === 'text_chunks' ||
        envelope.preparationKind === 'json_structure'));
  if (!kindSupportedByEnvelope) {
    throw new ContextVaultError({
      code: 'CV_SELECTOR_UNSUPPORTED',
      message: 'The requested selector is not available for this retrieval.',
    });
  }
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ContextVaultError({
      code: 'CV_OPERATION_CANCELLED',
      message: 'The operation was cancelled.',
      retryable: true,
    });
  }
}

function assertDeadline(clock: InspectionClock, deadline: number): void {
  if (clock.now().getTime() >= deadline) {
    throw new ContextVaultError({
      code: 'CV_DEADLINE_EXCEEDED',
      message: 'The retrieval deadline was exceeded.',
      retryable: true,
    });
  }
}

import type { AuthorizedFileReader } from '../ports/authorized-file-reader.js';
import type { InspectionClock, InspectionCryptography } from '../ports/inspection-services.js';
import type { PreparationVault } from '../ports/preparation-services.js';
import type { RetrievalVault } from '../ports/retrieval-services.js';
import type { PreparedEnvelopeRecord } from '../../domain/preparation/preparation-types.js';
import { isContextVaultError } from '../../domain/errors/context-vault-error.js';
import { DEFAULT_SOURCE_BYTE_LIMIT } from '../inspection/inspect-source.js';
import type {
  VerifyRequestInput,
  VerificationCheckRequest,
  VerificationCheckResult,
  VerifySuccess,
} from '../../domain/verification/verification-policy.js';
import { validateVerifyRequest } from '../../domain/verification/verification-policy.js';

/**
 * Reader failure codes that mean the source could not be read for this
 * verification attempt. They become the per-check `unavailable` /
 * `source_unreadable` outcome instead of a tool failure. Cancellation,
 * deadline, configuration, and internal errors are not readability
 * states and keep propagating.
 */
const SOURCE_READ_FAILURE_CODES: ReadonlySet<string> = new Set([
  'CV_AUTHORIZATION_DENIED',
  'CV_PATH_OUTSIDE_WORKSPACE',
  'CV_PATH_REPARSE_POINT_DENIED',
  'CV_PATH_SPECIAL_FILE_DENIED',
  'CV_RESOURCE_SOURCE_TOO_LARGE',
  'CV_SOURCE_CHANGED',
  'CV_SOURCE_NOT_FOUND',
]);

function isSourceReadFailure(error: unknown): boolean {
  return isContextVaultError(error) && SOURCE_READ_FAILURE_CODES.has(error.code);
}

export interface VerifyEnvelopeDependencies {
  readonly clock: InspectionClock;
  readonly cryptography: InspectionCryptography;
  readonly fileReader: AuthorizedFileReader;
  readonly vault: PreparationVault;
  readonly retrievalVault: RetrievalVault;
}

/**
 * Deterministic integrity verification for one prepared envelope.
 *
 * Supported checks:
 * - `source_freshness`: the authorized source still matches the full
 *   digest recorded at preparation time.
 * - `chunk_integrity`: one prepared chunk descriptor still matches the
 *   digest of the exact bytes at its recorded span.
 * - `provenance_consistency`: every retained retrieval provenance record
 *   still binds to this envelope's identity and digest.
 *
 * When the source cannot be read at all (deleted, unauthorized, or
 * otherwise unreadable), source-dependent checks report the per-check
 * `unavailable` / `source_unreadable` state while envelope-local checks
 * still evaluate; the failure detail itself is never disclosed.
 *
 * The check never accepts natural-language claims, never judges
 * semantics, and never returns source content, paths, or capability
 * state. An integrity chain inside one process proves internal
 * consistency only - never independent authenticity or truth.
 */
export class VerifyEnvelope {
  readonly #clock: InspectionClock;
  readonly #cryptography: InspectionCryptography;
  readonly #fileReader: AuthorizedFileReader;
  readonly #vault: PreparationVault;
  readonly #retrievalVault: RetrievalVault;

  constructor(dependencies: VerifyEnvelopeDependencies) {
    this.#clock = dependencies.clock;
    this.#cryptography = dependencies.cryptography;
    this.#fileReader = dependencies.fileReader;
    this.#vault = dependencies.vault;
    this.#retrievalVault = dependencies.retrievalVault;
  }

  async execute(request: VerifyRequestInput, signal?: AbortSignal): Promise<VerifySuccess> {
    const validated = validateVerifyRequest(request);
    this.#vault.sweepExpired(this.#clock.now());

    const envelope = this.#vault.find(validated.envelopeId);
    if (envelope === undefined) {
      return buildUnavailable(validated.envelopeId, validated.checks, this.#clock.now());
    }

    let sourceBytes: Uint8Array | undefined;
    let sourceIsFresh = false;
    try {
      const source = await this.#fileReader.read({
        rootId: envelope.rootId,
        normalizedRelativePath: envelope.normalizedRelativePath,
        maximumBytes: DEFAULT_SOURCE_BYTE_LIMIT,
        ...(signal ? { signal } : {}),
      });
      sourceBytes = source.bytes;
      sourceIsFresh = this.#cryptography.sha256(source.bytes) === envelope.sourceDigest;
    } catch (error: unknown) {
      // An unreadable source is a verification outcome, not a tool
      // failure: source-dependent checks report `source_unreadable`
      // below. Nothing about the failure - code detail, path, or system
      // message - is disclosed; other error classes keep propagating.
      if (!isSourceReadFailure(error)) {
        throw error;
      }
    }

    const results = validated.checks.map((check) =>
      this.#evaluateCheck(check, envelope, sourceBytes, sourceIsFresh),
    );

    return Object.freeze({
      schemaVersion: '1.0' as const,
      ok: true as const,
      envelopeId: envelope.envelopeId,
      results: Object.freeze(results),
      verifiedAt: this.#clock.now().toISOString(),
    });
  }

  #evaluateCheck(
    check: VerificationCheckRequest,
    envelope: PreparedEnvelopeRecord,
    sourceBytes: Uint8Array | undefined,
    sourceIsFresh: boolean,
  ): VerificationCheckResult {
    if (check.kind === 'source_freshness') {
      if (sourceBytes === undefined) {
        return sourceUnreadableResult(check);
      }
      return Object.freeze({
        kind: check.kind,
        chunkId: undefined,
        status: sourceIsFresh ? 'valid' : 'stale',
        reasonCode: sourceIsFresh ? 'digest_matches_prepared_state' : 'source_digest_mismatch',
      });
    }

    if (check.kind === 'chunk_integrity') {
      const chunk = envelope.chunks.find((candidate) => candidate.chunkId === check.chunkId);
      if (chunk === undefined) {
        return Object.freeze({
          kind: check.kind,
          chunkId: check.chunkId,
          status: 'invalid',
          reasonCode: 'chunk_descriptor_unknown',
        });
      }
      if (sourceBytes === undefined) {
        return sourceUnreadableResult(check);
      }
      if (!sourceIsFresh) {
        return Object.freeze({
          kind: check.kind,
          chunkId: check.chunkId,
          status: 'stale',
          reasonCode: 'source_digest_mismatch',
        });
      }
      const chunkBytes = sourceBytes.slice(chunk.byteStart, chunk.byteEndExclusive);
      const chunkDigest = this.#cryptography.sha256(chunkBytes);
      const intact = chunkDigest === chunk.chunkDigest;
      return Object.freeze({
        kind: check.kind,
        chunkId: check.chunkId,
        status: intact ? 'valid' : 'invalid',
        reasonCode: intact ? 'digest_matches_prepared_state' : 'chunk_digest_mismatch',
      });
    }

    return this.#evaluateProvenanceConsistency(envelope);
  }

  #evaluateProvenanceConsistency(envelope: PreparedEnvelopeRecord): VerificationCheckResult {
    const records = this.#retrievalVault.listProvenanceForEnvelope(envelope.envelopeId);
    if (records.length === 0) {
      return Object.freeze({
        kind: 'provenance_consistency',
        chunkId: undefined,
        status: 'unavailable',
        reasonCode: 'provenance_chain_empty',
      });
    }
    const foreign = records.find(
      (record) =>
        record.envelopeId !== envelope.envelopeId ||
        record.sourceId !== envelope.sourceId ||
        record.sourceDigest !== envelope.sourceDigest,
    );
    if (foreign !== undefined) {
      return Object.freeze({
        kind: 'provenance_consistency',
        chunkId: undefined,
        status: 'invalid',
        reasonCode: 'provenance_record_foreign',
      });
    }
    return Object.freeze({
      kind: 'provenance_consistency',
      chunkId: undefined,
      status: 'valid',
      reasonCode: 'provenance_chain_consistent',
    });
  }
}

function sourceUnreadableResult(check: VerificationCheckRequest): VerificationCheckResult {
  return Object.freeze({
    kind: check.kind,
    chunkId: check.kind === 'chunk_integrity' ? check.chunkId : undefined,
    status: 'unavailable' as const,
    reasonCode: 'source_unreadable' as const,
  });
}

function buildUnavailable(
  envelopeId: string,
  checks: readonly VerificationCheckRequest[],
  now: Date,
): VerifySuccess {
  return Object.freeze({
    schemaVersion: '1.0' as const,
    ok: true as const,
    envelopeId,
    results: Object.freeze(
      checks.map((check) =>
        Object.freeze({
          kind: check.kind,
          chunkId: check.kind === 'chunk_integrity' ? check.chunkId : undefined,
          status: 'unavailable' as const,
          reasonCode: 'envelope_absent' as const,
        }),
      ),
    ),
    verifiedAt: now.toISOString(),
  });
}

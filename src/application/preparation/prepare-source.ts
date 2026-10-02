import type { AuthorizedFileReader } from '../ports/authorized-file-reader.js';
import type { InspectionClock, InspectionCryptography } from '../ports/inspection-services.js';
import type { OpaqueIdentifierFactory, PreparationVault } from '../ports/preparation-services.js';
import type {
  CapabilityTokenDigester,
  CapabilityTokenFactory,
} from '../ports/retrieval-services.js';
import { ContextVaultError } from '../../domain/errors/context-vault-error.js';
import { chunkTextLines } from '../../domain/preparation/text-chunking-policy.js';
import { scanJsonStructure } from '../../domain/preparation/json-structure-scanner.js';
import {
  discloseJsonStructure,
  jsonScanLimits,
} from '../../domain/preparation/json-disclosure-policy.js';
import {
  MAX_CHUNK_BYTES,
  MAX_CHUNKS_PER_ENVELOPE,
  validateTtlSeconds,
  type PreparationLimits,
} from '../../domain/preparation/preparation-limits.js';
import type {
  PrepareSuccess,
  ScannedJsonNode,
  StructuralLocator,
  OmissionRecord,
} from '../../domain/preparation/preparation-types.js';
import { classifyContent } from '../../domain/inspection/content-classification.js';
import {
  detectMediaPolicy,
  preparationKindForMediaType,
} from '../../domain/inspection/media-policy.js';
import {
  assertValidRootId,
  normalizeRelativePath,
} from '../../domain/workspace/workspace-path-policy.js';
import {
  narrowGrantRequest,
  validateGrantRequest,
} from '../../domain/retrieval/retrieval-grant-policy.js';
import { DEFAULT_SOURCE_BYTE_LIMIT } from '../inspection/inspect-source.js';
import type { PreparationGate } from './preparation-gate.js';
import type { AssembledEnvelope } from './envelope-assembly.js';
import { EnvelopeAssembler } from './envelope-assembly.js';
import { RetrievalGrantIssuer } from './retrieval-grant-issuance.js';

/**
 * Media types whose sources may be structurally prepared in version 1
 * are resolved through `preparationKindForMediaType`, the shared
 * media-to-kind authority. Everything else fails safely with an
 * explicit unsupported-media error.
 */

export interface PrepareSourceDependencies {
  readonly clock: InspectionClock;
  readonly cryptography: InspectionCryptography;
  readonly fileReader: AuthorizedFileReader;
  readonly vault: PreparationVault;
  readonly identifiers: OpaqueIdentifierFactory;
  readonly limits: PreparationLimits;
  readonly tokens: CapabilityTokenFactory;
  readonly tokenDigester: CapabilityTokenDigester;
}

export interface PrepareRequest {
  readonly source: {
    readonly kind: string;
    readonly rootId: string;
    readonly path: string;
  };
  readonly ttlSeconds?: number;
  readonly retrieval?: unknown;
}

export class PrepareSource {
  readonly #clock: InspectionClock;
  readonly #cryptography: InspectionCryptography;
  readonly #fileReader: AuthorizedFileReader;
  readonly #vault: PreparationVault;
  readonly #limits: PreparationLimits;
  readonly #gate: PreparationGate;
  readonly #assembler: EnvelopeAssembler;
  readonly #issuer: RetrievalGrantIssuer;

  constructor(dependencies: PrepareSourceDependencies, gate: PreparationGate) {
    this.#clock = dependencies.clock;
    this.#cryptography = dependencies.cryptography;
    this.#fileReader = dependencies.fileReader;
    this.#vault = dependencies.vault;
    this.#limits = dependencies.limits;
    this.#gate = gate;
    this.#assembler = new EnvelopeAssembler({
      clock: dependencies.clock,
      cryptography: dependencies.cryptography,
      identifiers: dependencies.identifiers,
    });
    this.#issuer = new RetrievalGrantIssuer({
      tokens: dependencies.tokens,
      digester: dependencies.tokenDigester,
    });
  }

  async execute(request: PrepareRequest, signal?: AbortSignal): Promise<PrepareSuccess> {
    const trustedSource = validatePrepareSource(request.source);
    const ttlSeconds = validateTtlSeconds(request.ttlSeconds);
    const grantRequest = validateGrantRequest(request.retrieval);
    const startedAt = this.#clock.now();
    const deadline = startedAt.getTime() + this.#limits.prepareDeadlineMilliseconds;

    this.#gate.acquire();
    try {
      this.#assertNotCancelled(signal);
      this.#assertDeadline(deadline);

      // Expired envelopes release their derived state before the
      // active-envelope cap is enforced, so a full store of expired
      // records can never wedge preparation. The sweep is synchronous
      // and uses the same clock as the TTL it enforces.
      this.#vault.sweepExpired(this.#clock.now());

      const file = await this.#fileReader.read({
        rootId: trustedSource.rootId,
        normalizedRelativePath: normalizeRelativePath(trustedSource.path),
        maximumBytes: DEFAULT_SOURCE_BYTE_LIMIT,
        ...(signal ? { signal } : {}),
      });
      this.#assertNotCancelled(signal);
      this.#assertDeadline(deadline);

      const sourceDigest = this.#cryptography.sha256(file.bytes);
      const classification = classifyContent(file.normalizedRelativePath, file.bytes);
      // Text-family detection is requested unconditionally so that an
      // authorized extension carrying non-text bytes reaches the explicit
      // UTF-8 failure below instead of the generic unsupported-media path.
      const mediaPolicy = detectMediaPolicy(file.normalizedRelativePath, true);
      const sourceId = this.#cryptography.sourceId(
        trustedSource.rootId,
        file.normalizedRelativePath,
        sourceDigest,
      );

      const mediaPreparationKind = preparationKindForMediaType(mediaPolicy.mediaType);
      if (mediaPreparationKind === null) {
        throw new ContextVaultError({
          code: 'CV_PREPARE_MEDIA_UNSUPPORTED',
          message: 'The source media type is not supported for preparation.',
        });
      }
      if (!classification.isText) {
        throw new ContextVaultError({
          code: 'CV_INPUT_UTF8_INVALID',
          message: 'The source is not valid UTF-8 text.',
        });
      }
      this.#assertDeadline(deadline);

      const preparationKind =
        classification.secretRisk === 'confirmed' ? 'minimal' : mediaPreparationKind;
      const grant = resolveGrantOutcome(grantRequest, {
        preparationKind,
        secretRisk: classification.secretRisk,
        envelopeTtlSeconds: ttlSeconds,
      });

      const assembled = this.#assembleEnvelope({
        ttlSeconds,
        rootId: trustedSource.rootId,
        normalizedRelativePath: file.normalizedRelativePath,
        sourceId,
        sourceDigest,
        mediaType: mediaPolicy.mediaType,
        sensitivity: classification.sensitivity,
        secretRisk: classification.secretRisk,
        bytes: file.bytes.byteLength,
        fileBytes: file.bytes,
        preparationKind,
        grant,
      });
      this.#assertDeadline(deadline);
      return assembled;
    } finally {
      this.#gate.release();
    }
  }

  #assembleEnvelope(input: AssembleEnvelopeInput): PrepareSuccess {
    if (input.preparationKind === 'minimal') {
      return this.#commitEnvelope(input, [], [buildPolicyOmission(input.bytes)], 0, [], []);
    }
    if (input.mediaType === 'application/json') {
      return this.#buildJsonEnvelope(input);
    }
    return this.#buildTextEnvelope(input);
  }

  #buildTextEnvelope(input: AssembleEnvelopeInput): PrepareSuccess {
    const chunking = chunkTextLines({
      bytes: input.fileBytes,
      maxChunkBytes: MAX_CHUNK_BYTES,
      maxChunks: MAX_CHUNKS_PER_ENVELOPE,
      digest: (chunkBytes) => this.#cryptography.sha256(chunkBytes),
    });
    return this.#commitEnvelope(
      input,
      chunking.chunks,
      chunking.omissions,
      chunking.lineCount,
      [],
      [],
    );
  }

  #buildJsonEnvelope(input: AssembleEnvelopeInput): PrepareSuccess {
    // Classification has already established strict UTF-8 validity for the
    // same bytes, so this decode cannot fail for a preparable source.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input.fileBytes);

    const scan = scanJsonStructure(text, jsonScanLimits());
    const disclosed = discloseJsonStructure(
      scan.nodes,
      {
        totalNodeCount: scan.totalNodeCount,
        duplicateKeyCount: scan.duplicateKeyCount,
      },
      input.bytes,
    );
    return this.#commitEnvelope(
      input,
      [],
      disclosed.omissions,
      0,
      disclosed.descriptors,
      scan.nodes,
    );
  }

  #commitEnvelope(
    input: AssembleEnvelopeInput,
    chunks: ReturnType<typeof chunkTextLines>['chunks'],
    omissions: readonly OmissionRecord[],
    lineCount: number,
    disclosedJsonNodes: ReturnType<typeof discloseJsonStructure>['descriptors'],
    realJsonNodes: readonly ScannedJsonNode[],
  ): PrepareSuccess {
    const grantIssuance = input.grant ? this.#issuer.issue(input.grant, this.#clock.now()) : null;

    const assembled: AssembledEnvelope = this.#assembler.assemble({
      sessionId: this.#vault.sessionId,
      rootId: input.rootId,
      normalizedRelativePath: input.normalizedRelativePath,
      sourceId: input.sourceId,
      sourceDigest: input.sourceDigest,
      mediaType: input.mediaType,
      sensitivity: input.sensitivity,
      secretRisk: input.secretRisk,
      bytes: input.bytes,
      ttlSeconds: input.ttlSeconds,
      preparationKind: input.preparationKind,
      lineCount,
      chunks,
      disclosedJsonNodes,
      realJsonNodes,
      omissions,
      grant: grantIssuance?.metadata ?? null,
    });

    // The envelope and its grant are committed atomically: a grant is
    // never stored without its envelope and never without narrowing.
    this.#vault.commitEnvelope(assembled.record, grantIssuance?.commit ?? null);

    return Object.freeze({
      schemaVersion: '1.0' as const,
      ok: true as const,
      envelope: assembled.envelope,
    });
  }

  #assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new ContextVaultError({
        code: 'CV_OPERATION_CANCELLED',
        message: 'The operation was cancelled.',
        retryable: true,
      });
    }
  }

  #assertDeadline(deadline: number): void {
    if (this.#clock.now().getTime() >= deadline) {
      throw new ContextVaultError({
        code: 'CV_DEADLINE_EXCEEDED',
        message: 'The preparation deadline was exceeded.',
        retryable: true,
      });
    }
  }
}

interface AssembleEnvelopeInput {
  readonly ttlSeconds: number;
  readonly rootId: string;
  readonly normalizedRelativePath: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly mediaType: string;
  readonly sensitivity: string;
  readonly secretRisk: string;
  readonly bytes: number;
  readonly fileBytes: Uint8Array;
  readonly preparationKind: 'text_chunks' | 'json_structure' | 'minimal';
  readonly grant: NarrowedRetrievalGrant | null;
}

/** The narrowed grant shape produced by the domain narrowing policy. */
type NarrowedRetrievalGrant = Extract<
  ReturnType<typeof narrowGrantRequest>,
  { ok: true }
>['narrowed'];

/**
 * Narrows the optional grant request against server policy.
 * Confirmed-secret material never receives a content-retrieval grant,
 * and a minimal envelope cannot support any exact selector.
 */
function resolveGrantOutcome(
  grantRequest: ReturnType<typeof validateGrantRequest>,
  context: {
    readonly preparationKind: 'text_chunks' | 'json_structure' | 'minimal';
    readonly secretRisk: string;
    readonly envelopeTtlSeconds: number;
  },
): NarrowedRetrievalGrant | null {
  if (grantRequest === undefined) {
    return null;
  }
  const decision = narrowGrantRequest(grantRequest, context);
  if (!decision.ok) {
    throw new ContextVaultError({
      code: 'CV_RETRIEVAL_POLICY_DENIED',
      message: 'A retrieval grant was requested but denied by policy.',
      safeDetails: { reason: decision.reason },
    });
  }
  return decision.narrowed;
}

/**
 * Builds the machine-readable omission record for a source whose
 * confirmed secret classification forbids structural disclosure.
 */
function buildPolicyOmission(sourceBytes: number): OmissionRecord {
  const locator: StructuralLocator = { kind: 'byte_range', value: `0-${String(sourceBytes)}` };
  return Object.freeze({
    omissionId: 'cv_omit_000000000001',
    locator,
    reason: 'policy',
    itemCount: 1,
    retrievable: false,
  });
}

/**
 * Converts an untrusted request into a trusted source reference.
 * Deliberately independent of MCP schema validation so a request reaching
 * the use case through any other path is still rejected fail-closed.
 */
function validatePrepareSource(source: PrepareRequest['source']): {
  readonly rootId: string;
  readonly path: string;
} {
  if (source.kind !== 'workspace_file') {
    throw new ContextVaultError({
      code: 'CV_INPUT_INVALID',
      message: 'The source reference is invalid.',
    });
  }
  assertValidRootId(source.rootId);
  return Object.freeze({ rootId: source.rootId, path: source.path });
}

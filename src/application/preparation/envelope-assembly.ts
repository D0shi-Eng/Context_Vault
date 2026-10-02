import type { InspectionClock, InspectionCryptography } from '../ports/inspection-services.js';
import type { OpaqueIdentifierFactory } from '../ports/preparation-services.js';
import {
  PREPARE_DISCLOSURE_CLASSIFICATION,
  canonicalStructuralPayload,
  type JsonNodeDescriptor,
  type OmissionRecord,
  type PrepareSuccessEnvelope,
  type PreparedEnvelopeRecord,
  type PreparationKind,
  type ScannedJsonNode,
  type TextChunkDescriptor,
} from '../../domain/preparation/preparation-types.js';
import type { IssuedRetrievalGrant } from '../../domain/retrieval/retrieval-types.js';

export interface EnvelopeAssemblyInput {
  readonly sessionId: string;
  readonly rootId: string;
  readonly normalizedRelativePath: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly mediaType: string;
  readonly sensitivity: string;
  readonly secretRisk: string;
  readonly bytes: number;
  readonly ttlSeconds: number;
  readonly preparationKind: PreparationKind;
  readonly lineCount: number;
  readonly chunks: readonly TextChunkDescriptor[];
  readonly disclosedJsonNodes: readonly JsonNodeDescriptor[];
  readonly realJsonNodes: readonly ScannedJsonNode[];
  readonly omissions: readonly OmissionRecord[];
  readonly grant: IssuedRetrievalGrant | null;
}

export interface AssembledEnvelope {
  readonly envelope: PrepareSuccessEnvelope;
  readonly record: PreparedEnvelopeRecord;
}

/**
 * Builds the disclosed envelope and the server-side record for one
 * prepared source, including the serialized-size bookkeeping and the
 * deterministic structural fingerprint.
 *
 * Random identifiers and timestamps are excluded from the fingerprint
 * payload so repeated preparations of the same bytes stay deterministic.
 * The disclosed envelope and the server-side record are built from the
 * same timestamps and identifier, so lifecycle state and disclosure
 * never disagree.
 */
export class EnvelopeAssembler {
  readonly #clock: InspectionClock;
  readonly #cryptography: InspectionCryptography;
  readonly #identifiers: OpaqueIdentifierFactory;

  constructor(dependencies: {
    readonly clock: InspectionClock;
    readonly cryptography: InspectionCryptography;
    readonly identifiers: OpaqueIdentifierFactory;
  }) {
    this.#clock = dependencies.clock;
    this.#cryptography = dependencies.cryptography;
    this.#identifiers = dependencies.identifiers;
  }

  assemble(input: EnvelopeAssemblyInput): AssembledEnvelope {
    const createdAt = this.#clock.now();
    const expiresAt = new Date(createdAt.getTime() + input.ttlSeconds * 1000);
    const envelopeId = this.#identifiers.createEnvelopeId();
    const encoder = new TextEncoder();

    const envelope: PrepareSuccessEnvelope = Object.freeze({
      envelopeId,
      sourceId: input.sourceId,
      sourceDigest: input.sourceDigest,
      mediaType: input.mediaType,
      bytes: input.bytes,
      sensitivity: input.sensitivity,
      secretRisk: input.secretRisk,
      preparationKind: input.preparationKind,
      disclosureClass: PREPARE_DISCLOSURE_CLASSIFICATION,
      retrievalAllowed: input.grant !== null,
      lineCount: input.lineCount,
      chunks: input.chunks,
      jsonNodes: input.disclosedJsonNodes,
      omissions: input.omissions,
      structuralFingerprint: this.#structuralFingerprint(input),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ...(input.grant !== null ? { retrieval: input.grant } : {}),
    });

    const record: PreparedEnvelopeRecord = Object.freeze({
      envelopeId,
      sessionId: input.sessionId,
      createdAt,
      expiresAt,
      rootId: input.rootId,
      normalizedRelativePath: input.normalizedRelativePath,
      sourceId: input.sourceId,
      sourceDigest: input.sourceDigest,
      mediaType: input.mediaType,
      bytes: input.bytes,
      sensitivity: input.sensitivity,
      secretRisk: input.secretRisk,
      preparationKind: input.preparationKind,
      disclosureClass: PREPARE_DISCLOSURE_CLASSIFICATION,
      retrievalAllowed: input.grant !== null,
      lineCount: input.lineCount,
      structuralFingerprint: envelope.structuralFingerprint,
      derivedBytes: encoder.encode(JSON.stringify(envelope)).length,
      chunks: input.chunks,
      jsonNodes: input.realJsonNodes,
      omissions: input.omissions,
    });

    return Object.freeze({ envelope, record });
  }

  #structuralFingerprint(input: EnvelopeAssemblyInput): string {
    return this.#cryptography.sha256(
      new TextEncoder().encode(
        canonicalStructuralPayload({
          sourceDigest: input.sourceDigest,
          mediaType: input.mediaType,
          bytes: input.bytes,
          sensitivity: input.sensitivity,
          secretRisk: input.secretRisk,
          preparationKind: input.preparationKind,
          lineCount: input.lineCount,
          chunks: input.chunks,
          jsonNodes: input.disclosedJsonNodes,
          omissions: input.omissions,
        }),
      ),
    );
  }
}

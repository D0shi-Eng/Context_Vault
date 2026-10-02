import type { AuthorizedFileReader } from '../ports/authorized-file-reader.js';
import type { InspectionClock, InspectionCryptography } from '../ports/inspection-services.js';
import { ContextVaultError } from '../../domain/errors/context-vault-error.js';
import { classifyContent } from '../../domain/inspection/content-classification.js';
import { detectMediaPolicy } from '../../domain/inspection/media-policy.js';
import {
  SCHEMA_VERSION,
  type InspectSuccess,
  type SourceReference,
  type SourceReferenceInput,
} from '../../domain/inspection/source-inspection.js';
import {
  assertValidRootId,
  normalizeRelativePath,
} from '../../domain/workspace/workspace-path-policy.js';

export const DEFAULT_SOURCE_BYTE_LIMIT = 32 * 1024 * 1024;
export const HARD_SOURCE_BYTE_LIMIT = 64 * 1024 * 1024;

export interface InspectSourceDependencies {
  readonly clock: InspectionClock;
  readonly cryptography: InspectionCryptography;
  readonly fileReader: AuthorizedFileReader;
  readonly maximumSourceBytes?: number;
}

export class InspectSource {
  readonly #clock: InspectionClock;
  readonly #cryptography: InspectionCryptography;
  readonly #fileReader: AuthorizedFileReader;
  readonly #maximumSourceBytes: number;

  constructor(dependencies: InspectSourceDependencies) {
    this.#clock = dependencies.clock;
    this.#cryptography = dependencies.cryptography;
    this.#fileReader = dependencies.fileReader;
    this.#maximumSourceBytes = dependencies.maximumSourceBytes ?? DEFAULT_SOURCE_BYTE_LIMIT;

    if (
      !Number.isSafeInteger(this.#maximumSourceBytes) ||
      this.#maximumSourceBytes < 1 ||
      this.#maximumSourceBytes > HARD_SOURCE_BYTE_LIMIT
    ) {
      throw new ContextVaultError({
        code: 'CV_CONFIGURATION_INVALID',
        message: 'The source byte limit is invalid.',
      });
    }
  }

  async execute(source: SourceReferenceInput, signal?: AbortSignal): Promise<InspectSuccess> {
    const trustedSource = validateSourceReference(source);
    assertValidRootId(trustedSource.rootId);
    const normalizedRelativePath = normalizeRelativePath(trustedSource.path);
    const file = await this.#fileReader.read({
      rootId: trustedSource.rootId,
      normalizedRelativePath,
      maximumBytes: this.#maximumSourceBytes,
      ...(signal ? { signal } : {}),
    });
    const sourceDigest = this.#cryptography.sha256(file.bytes);
    const classification = classifyContent(file.normalizedRelativePath, file.bytes);
    const mediaPolicy = detectMediaPolicy(file.normalizedRelativePath, classification.isText);

    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      ok: true,
      source: Object.freeze({
        sourceId: this.#cryptography.sourceId(
          trustedSource.rootId,
          file.normalizedRelativePath,
          sourceDigest,
        ),
        sourceDigest,
        mediaType: mediaPolicy.mediaType,
        bytes: file.bytes.byteLength,
        sensitivity: classification.sensitivity,
        secretRisk: classification.secretRisk,
        supportedSelectors: mediaPolicy.supportedSelectors,
        inspectedAt: this.#clock.now().toISOString(),
      }),
    });
  }
}

/**
 * Converts an untrusted request into a trusted source reference.
 *
 * This boundary is the only place allowed to narrow the source discriminator.
 * It is deliberately independent of MCP schema validation so that a request
 * reaching the use case through any other path is still rejected fail-closed.
 */
function validateSourceReference(source: SourceReferenceInput): SourceReference {
  if (source.kind !== 'workspace_file') {
    throw new ContextVaultError({
      code: 'CV_INPUT_INVALID',
      message: 'The source reference is invalid.',
    });
  }
  return Object.freeze({
    kind: 'workspace_file',
    rootId: source.rootId,
    path: source.path,
  });
}

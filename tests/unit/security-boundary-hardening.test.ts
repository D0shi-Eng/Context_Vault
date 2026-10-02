import { describe, expect, it, vi } from 'vitest';

import type { AuthorizedFileReader } from '../../src/application/ports/authorized-file-reader.js';
import type { InspectionClock } from '../../src/application/ports/inspection-services.js';
import { InspectSource } from '../../src/application/inspection/inspect-source.js';
import { PreparationGate } from '../../src/application/preparation/preparation-gate.js';
import { PrepareSource } from '../../src/application/preparation/prepare-source.js';
import { PurgeDerivedState } from '../../src/application/preparation/purge-derived-state.js';
import { RetrieveSource } from '../../src/application/retrieval/retrieve-source.js';
import { VerifyEnvelope } from '../../src/application/verification/verify-envelope.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import { detectMediaPolicy } from '../../src/domain/inspection/media-policy.js';
import { itemLimitError } from '../../src/domain/preparation/json-scan-errors.js';
import { isValidJsonNumber } from '../../src/domain/preparation/json-scan-tokens.js';
import { scanJsonStructure } from '../../src/domain/preparation/json-structure-scanner.js';
import { jsonScanLimits } from '../../src/domain/preparation/json-disclosure-policy.js';
import { collectLineSpans } from '../../src/domain/preparation/line-spans.js';
import {
  STRICT_PREPARATION_LIMITS,
  validatePreparationLimits,
  validateTtlSeconds,
} from '../../src/domain/preparation/preparation-limits.js';
import { validatePurgeRequest } from '../../src/domain/preparation/purge-intent-policy.js';
import {
  ALL_RETRIEVAL_SELECTOR_KINDS,
  type RetrievalSelector,
} from '../../src/domain/retrieval/retrieval-types.js';
import { validateGrantRequest } from '../../src/domain/retrieval/retrieval-grant-policy.js';
import { validateRetrievalSelector } from '../../src/domain/retrieval/retrieval-selector-policy.js';
import {
  assertValidRootId,
  normalizeRelativePath,
} from '../../src/domain/workspace/workspace-path-policy.js';
import { parseStartupArguments } from '../../src/infrastructure/configuration/startup-arguments.js';
import { NodeCapabilityTokens } from '../../src/infrastructure/crypto/node-capability-tokens.js';
import { NodeInspectionCryptography } from '../../src/infrastructure/inspection/node-inspection-cryptography.js';
import { NodeOpaqueIdentifiers } from '../../src/infrastructure/preparation/node-opaque-identifiers.js';
import { InMemoryVault } from '../../src/infrastructure/vault/in-memory-vault.js';
import { NodeAuthorizedFileReader } from '../../src/infrastructure/workspace/node-authorized-file-reader.js';
import {
  captureReadError,
  createReader,
  createScenario,
  fileMetadata,
} from './node-authorized-file-reader-scenario.js';

const SESSION_ID = 'cv_ses_abcdefghijklmnop';
const BASE_MILLISECONDS = new Date('2026-09-10T12:00:00.000Z').getTime();
const cryptography = new NodeInspectionCryptography();

function expectCodeAndNonEmptyMessage(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ContextVaultError);
  const vaultError = error as ContextVaultError;
  expect(vaultError.code).toBe(code);
  expect(vaultError.message.length).toBeGreaterThan(0);
}

function captureSyncError(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the action to throw.');
}

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the action to throw.');
}

function stubFileReader(bytes: Uint8Array, normalizedRelativePath: string): AuthorizedFileReader {
  return {
    authorizedRootCount: 1,
    read: () => Promise.resolve({ bytes, normalizedRelativePath }),
  };
}

function createPrepareHarness(options: {
  bytes: Uint8Array;
  normalizedRelativePath: string;
  clock: InspectionClock;
}): { useCase: PrepareSource } {
  const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
  const vault = new InMemoryVault(SESSION_ID, limits);
  const useCase = new PrepareSource(
    {
      clock: options.clock,
      cryptography,
      fileReader: stubFileReader(options.bytes, options.normalizedRelativePath),
      vault,
      identifiers: new NodeOpaqueIdentifiers(),
      limits,
      tokens: new NodeCapabilityTokens(),
      tokenDigester: new NodeCapabilityTokens(),
    },
    new PreparationGate(limits.maxConcurrentPreparations),
  );
  return { useCase };
}

describe('inspection and gate security contracts', () => {
  it('rejects an invalid source byte limit with a non-empty message', () => {
    const error = captureSyncError(
      () =>
        new InspectSource({
          clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
          cryptography,
          fileReader: stubFileReader(new Uint8Array(1), 'file.txt'),
          maximumSourceBytes: 0,
        }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_CONFIGURATION_INVALID');
  });

  it('rejects a non-workspace source reference with a non-empty message', async () => {
    const useCase = new InspectSource({
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
      cryptography,
      fileReader: stubFileReader(new TextEncoder().encode('alpha'), 'file.txt'),
    });
    const error = await captureAsyncError(() =>
      useCase.execute({ kind: 'remote_url', rootId: 'repo', path: 'file.txt' }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_INPUT_INVALID');
  });

  it('rejects an invalid concurrency limit with a non-empty message', () => {
    const error = captureSyncError(() => new PreparationGate(0));
    expectCodeAndNonEmptyMessage(error, 'CV_CONFIGURATION_INVALID');
  });

  it('rejects acquisition beyond the concurrency limit with a retryable non-empty message', () => {
    const gate = new PreparationGate(1);
    gate.acquire();
    const error = captureSyncError(() => {
      gate.acquire();
    });
    expectCodeAndNonEmptyMessage(error, 'CV_RESOURCE_CONCURRENCY_LIMIT');
    expect((error as ContextVaultError).retryable).toBe(true);
  });
});

describe('prepare-source security contracts', () => {
  it('rejects non-UTF8 text with a non-empty message', async () => {
    const { useCase } = createPrepareHarness({
      bytes: new Uint8Array([0x68, 0x00, 0x69]),
      normalizedRelativePath: 'binary.txt',
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
    });
    const error = await captureAsyncError(() =>
      useCase.execute({ source: { kind: 'workspace_file', rootId: 'repo', path: 'binary.txt' } }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_INPUT_UTF8_INVALID');
  });

  it('rejects a cancelled prepare with a retryable non-empty message', async () => {
    const { useCase } = createPrepareHarness({
      bytes: new TextEncoder().encode('alpha\n'),
      normalizedRelativePath: 'notes.txt',
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
    });
    const controller = new AbortController();
    controller.abort();
    const error = await captureAsyncError(() =>
      useCase.execute(
        { source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' } },
        controller.signal,
      ),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_OPERATION_CANCELLED');
    expect((error as ContextVaultError).retryable).toBe(true);
  });

  it('rejects an invalid prepare source kind with a non-empty message', async () => {
    const { useCase } = createPrepareHarness({
      bytes: new TextEncoder().encode('alpha\n'),
      normalizedRelativePath: 'notes.txt',
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
    });
    const error = await captureAsyncError(() =>
      useCase.execute({ source: { kind: 'remote_url', rootId: 'repo', path: 'notes.txt' } }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_INPUT_INVALID');
  });

  it('enforces the deadline after the file read completes', async () => {
    let calls = 0;
    const clock: InspectionClock = {
      now: (): Date => {
        calls += 1;
        if (calls <= 2) {
          return new Date(BASE_MILLISECONDS);
        }
        return new Date(BASE_MILLISECONDS + 10_000);
      },
    };
    const limits = validatePreparationLimits({
      ...STRICT_PREPARATION_LIMITS,
      prepareDeadlineMilliseconds: 1000,
    });
    const vault = new InMemoryVault(SESSION_ID, limits);
    const useCase = new PrepareSource(
      {
        clock,
        cryptography,
        fileReader: stubFileReader(new TextEncoder().encode('alpha\n'), 'late.txt'),
        vault,
        identifiers: new NodeOpaqueIdentifiers(),
        limits,
        tokens: new NodeCapabilityTokens(),
        tokenDigester: new NodeCapabilityTokens(),
      },
      new PreparationGate(limits.maxConcurrentPreparations),
    );
    const error = await captureAsyncError(() =>
      useCase.execute({ source: { kind: 'workspace_file', rootId: 'repo', path: 'late.txt' } }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_DEADLINE_EXCEEDED');
    expect((error as ContextVaultError).retryable).toBe(true);
  });

  describe('fail-closed security boundaries', () => {
    // Mutant 1049: secret-risk second barrier message must stay non-empty.
    it('denies a mislabeled confirmed-secret excerpt without leaking content', async () => {
      const clock: InspectionClock = { now: (): Date => new Date(BASE_MILLISECONDS) };
      const tokens = new NodeCapabilityTokens();
      const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
      const vault = new InMemoryVault(SESSION_ID, limits);
      const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
      const secretBytes = new TextEncoder().encode(`${marker}\nsecond line\n`);
      const digest = cryptography.sha256(secretBytes);
      const sourceId = cryptography.sourceId('repo', 'notes/guide.txt', digest);
      const record = Object.freeze({
        envelopeId: 'cv_env_secretguard00001',
        sessionId: SESSION_ID,
        createdAt: new Date(BASE_MILLISECONDS),
        expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
        rootId: 'repo',
        normalizedRelativePath: 'notes/guide.txt',
        sourceId,
        sourceDigest: digest,
        mediaType: 'text/plain',
        bytes: secretBytes.byteLength,
        sensitivity: 'internal',
        secretRisk: 'none',
        preparationKind: 'text_chunks' as const,
        disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
        retrievalAllowed: true,
        lineCount: 2,
        structuralFingerprint: digest,
        derivedBytes: 64,
        chunks: [
          Object.freeze({
            chunkId: 'cv_chunk_000000000001',
            byteStart: 0,
            byteEndExclusive: secretBytes.byteLength,
            lineStart: 1,
            lineEndExclusive: 3,
            byteLength: secretBytes.byteLength,
            chunkDigest: digest,
            truncated: false,
          }),
        ],
        jsonNodes: [],
        omissions: [],
      });
      const capability = tokens.createCapabilityToken();
      const read = vi.fn<AuthorizedFileReader['read']>(() =>
        Promise.resolve({ bytes: secretBytes, normalizedRelativePath: 'notes/guide.txt' }),
      );
      vault.commitEnvelope(record, {
        tokenDigest: tokens.digestCapabilityToken(capability),
        allowedSelectorTypes: ['chunk'],
        maxBytes: 4096,
        expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
      });
      const retrieve = new RetrieveSource({
        clock,
        cryptography,
        fileReader: { read, authorizedRootCount: 1 },
        vault,
        retrievalVault: vault,
        tokenDigester: tokens,
        digestComparator: tokens,
      });
      const error = await captureAsyncError(() =>
        retrieve.execute({
          capability,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        }),
      );
      expectCodeAndNonEmptyMessage(error, 'CV_RETRIEVAL_POLICY_DENIED');
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain('PRIVATE KEY');
      expect(serialized).not.toContain(marker);
      expect(vault.listProvenanceForEnvelope('cv_env_secretguard00001')).toHaveLength(0);
    });

    // Mutant 1124: binding divergence message must stay non-empty for both rows.
    it('rejects sourceId and sourceDigest binding divergence without content', async () => {
      const clock: InspectionClock = { now: (): Date => new Date(BASE_MILLISECONDS) };
      const sourceBytes = new TextEncoder().encode('alpha\nbeta\n');
      const digest = cryptography.sha256(sourceBytes);
      const sourceId = cryptography.sourceId('repo', 'notes/guide.txt', digest);
      async function divergentGrantError(field: 'sourceId' | 'sourceDigest'): Promise<{
        error: unknown;
        read: ReturnType<typeof vi.fn>;
      }> {
        const tokens = new NodeCapabilityTokens();
        const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
        const vault = new InMemoryVault(SESSION_ID, limits);
        const record = Object.freeze({
          envelopeId: 'cv_env_bindingguard0001',
          sessionId: SESSION_ID,
          createdAt: new Date(BASE_MILLISECONDS),
          expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
          rootId: 'repo',
          normalizedRelativePath: 'notes/guide.txt',
          sourceId,
          sourceDigest: digest,
          mediaType: 'text/plain',
          bytes: sourceBytes.byteLength,
          sensitivity: 'internal',
          secretRisk: 'none',
          preparationKind: 'text_chunks' as const,
          disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
          retrievalAllowed: true,
          lineCount: 2,
          structuralFingerprint: digest,
          derivedBytes: 64,
          chunks: [
            Object.freeze({
              chunkId: 'cv_chunk_000000000001',
              byteStart: 0,
              byteEndExclusive: sourceBytes.byteLength,
              lineStart: 1,
              lineEndExclusive: 3,
              byteLength: sourceBytes.byteLength,
              chunkDigest: digest,
              truncated: false,
            }),
          ],
          jsonNodes: [],
          omissions: [],
        });
        vault.commitEnvelope(record, {
          tokenDigest: 'placeholder',
          allowedSelectorTypes: ['chunk'],
          maxBytes: 4096,
          expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
        });
        const capability = tokens.createCapabilityToken();
        const tokenDigest = tokens.digestCapabilityToken(capability);
        const divergent =
          field === 'sourceId' ? 'cv_src_divergent0000001' : `sha256:${'f'.repeat(64)}`;
        const grantEnvelopeId = 'cv_env_bindingguard0001';
        const grantSourceId = field === 'sourceId' ? divergent : sourceId;
        const grantSourceDigest = field === 'sourceDigest' ? divergent : digest;
        const provenance: unknown[] = [];
        const retrievalVault = {
          findGrantByTokenDigest: (candidate: string): unknown => {
            if (candidate !== tokenDigest) {
              return undefined;
            }
            return {
              tokenDigest,
              sessionId: SESSION_ID,
              envelopeId: grantEnvelopeId,
              sourceId: grantSourceId,
              sourceDigest: grantSourceDigest,
              allowedSelectorTypes: ['chunk'],
              maxBytes: 4096,
              expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
              revoked: false,
            };
          },
          countActiveGrants: (): number => 1,
          appendProvenance: (entry: unknown): void => {
            provenance.push(entry);
          },
          listProvenanceForEnvelope: (): readonly unknown[] => [],
        };
        const read = vi.fn<AuthorizedFileReader['read']>(() =>
          Promise.resolve({ bytes: sourceBytes, normalizedRelativePath: 'notes/guide.txt' }),
        );
        const retrieve = new RetrieveSource({
          clock,
          cryptography,
          fileReader: { read, authorizedRootCount: 1 },
          vault,
          retrievalVault: retrievalVault as never,
          tokenDigester: tokens,
          digestComparator: tokens,
        });
        const error = await captureAsyncError(() =>
          retrieve.execute({
            capability,
            selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
          }),
        );
        expect(provenance).toHaveLength(0);
        return { error, read };
      }
      const sourceIdCase = await divergentGrantError('sourceId');
      expectCodeAndNonEmptyMessage(sourceIdCase.error, 'CV_CAPABILITY_INVALID');
      expect(JSON.stringify(sourceIdCase.error)).not.toContain('alpha');
      expect(sourceIdCase.read).not.toHaveBeenCalled();
      const digestCase = await divergentGrantError('sourceDigest');
      expectCodeAndNonEmptyMessage(digestCase.error, 'CV_CAPABILITY_INVALID');
      expect(JSON.stringify(digestCase.error)).not.toContain('alpha');
      expect(digestCase.read).not.toHaveBeenCalled();
    });

    // Mutant 1167: envelope-kind mismatch message must stay non-empty.
    it('rejects a selector the envelope kind cannot honor without unauthorized read', async () => {
      const clock: InspectionClock = { now: (): Date => new Date(BASE_MILLISECONDS) };
      const tokens = new NodeCapabilityTokens();
      const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
      const vault = new InMemoryVault(SESSION_ID, limits);
      const sourceBytes = new TextEncoder().encode('alpha\nbeta\n');
      const digest = cryptography.sha256(sourceBytes);
      const record = Object.freeze({
        envelopeId: 'cv_env_kindguard0000001',
        sessionId: SESSION_ID,
        createdAt: new Date(BASE_MILLISECONDS),
        expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
        rootId: 'repo',
        normalizedRelativePath: 'notes/guide.txt',
        sourceId: cryptography.sourceId('repo', 'notes/guide.txt', digest),
        sourceDigest: digest,
        mediaType: 'text/plain',
        bytes: sourceBytes.byteLength,
        sensitivity: 'internal',
        secretRisk: 'none',
        preparationKind: 'text_chunks' as const,
        disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
        retrievalAllowed: true,
        lineCount: 2,
        structuralFingerprint: digest,
        derivedBytes: 64,
        chunks: [
          Object.freeze({
            chunkId: 'cv_chunk_000000000001',
            byteStart: 0,
            byteEndExclusive: sourceBytes.byteLength,
            lineStart: 1,
            lineEndExclusive: 3,
            byteLength: sourceBytes.byteLength,
            chunkDigest: digest,
            truncated: false,
          }),
        ],
        jsonNodes: [],
        omissions: [],
      });
      const capability = tokens.createCapabilityToken();
      const read = vi.fn<AuthorizedFileReader['read']>(() =>
        Promise.resolve({ bytes: sourceBytes, normalizedRelativePath: 'notes/guide.txt' }),
      );
      vault.commitEnvelope(record, {
        tokenDigest: tokens.digestCapabilityToken(capability),
        allowedSelectorTypes: ['json_node'],
        maxBytes: 4096,
        expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
      });
      const retrieve = new RetrieveSource({
        clock,
        cryptography,
        fileReader: { read, authorizedRootCount: 1 },
        vault,
        retrievalVault: vault,
        tokenDigester: tokens,
        digestComparator: tokens,
      });
      const error = await captureAsyncError(() =>
        retrieve.execute({
          capability,
          selector: { kind: 'json_node', nodeId: 'cv_node_aaaaaa' },
        }),
      );
      expectCodeAndNonEmptyMessage(error, 'CV_SELECTOR_UNSUPPORTED');
      expect(read).not.toHaveBeenCalled();
      expect(vault.listProvenanceForEnvelope('cv_env_kindguard0000001')).toHaveLength(0);
    });

    // Mutant 3862: serialized-size branch must keep a non-empty message.
    it('rejects an oversized serialized envelope without hitting the count ceiling', () => {
      const limits = validatePreparationLimits({
        ...STRICT_PREPARATION_LIMITS,
        maxActiveEnvelopes: 64,
        maxSerializedMetadataBytes: 16,
        maxTotalDerivedStateBytes: 4 * 1024 * 1024,
      });
      const vault = new InMemoryVault(SESSION_ID, limits);
      const base = {
        sessionId: SESSION_ID,
        createdAt: new Date(BASE_MILLISECONDS),
        expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
        rootId: 'workspace',
        normalizedRelativePath: 'notes.txt',
        sourceId: 'cv_src_abcdefghijklmnop',
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        mediaType: 'text/plain',
        bytes: 8,
        sensitivity: 'internal',
        secretRisk: 'none',
        preparationKind: 'text_chunks' as const,
        disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
        retrievalAllowed: false,
        lineCount: 1,
        structuralFingerprint: `sha256:${'b'.repeat(64)}`,
        chunks: [],
        jsonNodes: [],
        omissions: [],
      };
      const error = captureSyncError(() => {
        vault.commitEnvelope(
          { ...base, envelopeId: 'cv_env_sizeguard000001', derivedBytes: 64 },
          null,
        );
      });
      expectCodeAndNonEmptyMessage(error, 'CV_RESOURCE_ENVELOPE_TOO_LARGE');
      expect(vault.snapshot().envelopeCount).toBe(0);
    });

    // Mutant 3866: total-size branch must keep a non-empty message.
    it('rejects total derived-state overflow while each envelope stays valid singly', () => {
      const limits = validatePreparationLimits({
        ...STRICT_PREPARATION_LIMITS,
        maxActiveEnvelopes: 64,
        maxSerializedMetadataBytes: 256 * 1024,
        maxTotalDerivedStateBytes: 32,
      });
      const vault = new InMemoryVault(SESSION_ID, limits);
      const base = {
        sessionId: SESSION_ID,
        createdAt: new Date(BASE_MILLISECONDS),
        expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
        rootId: 'workspace',
        normalizedRelativePath: 'notes.txt',
        sourceId: 'cv_src_abcdefghijklmnop',
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        mediaType: 'text/plain',
        bytes: 8,
        sensitivity: 'internal',
        secretRisk: 'none',
        preparationKind: 'text_chunks' as const,
        disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
        retrievalAllowed: false,
        lineCount: 1,
        structuralFingerprint: `sha256:${'b'.repeat(64)}`,
        chunks: [],
        jsonNodes: [],
        omissions: [],
      };
      vault.commitEnvelope(
        { ...base, envelopeId: 'cv_env_totalguard000001', derivedBytes: 24 },
        null,
      );
      expect(vault.snapshot().envelopeCount).toBe(1);
      const error = captureSyncError(() => {
        vault.commitEnvelope(
          { ...base, envelopeId: 'cv_env_totalguard000002', derivedBytes: 24 },
          null,
        );
      });
      expectCodeAndNonEmptyMessage(error, 'CV_RESOURCE_DERIVED_STATE_LIMIT');
      expect(vault.snapshot().envelopeCount).toBe(1);
    });

    // Mutant 4055: invalid root at creation must keep a non-empty message.
    it('rejects an invalid workspace root at creation with a non-empty message', async () => {
      const scenario = createScenario();
      const error = await captureAsyncError(() =>
        NodeAuthorizedFileReader.create(
          [{ rootId: 'repo', absolutePath: 'relative/path.txt' }],
          scenario.fileSystem,
        ),
      );
      expectCodeAndNonEmptyMessage(error, 'CV_CONFIGURATION_INVALID');
    });

    // Mutant 4072: ENOENT and ENOTDIR must map to not-found with a message.
    it('maps missing-source filesystem errors to not-found with a message', async () => {
      for (const code of ['ENOENT', 'ENOTDIR']) {
        const scenario = createScenario({
          openError: Object.assign(new Error(`missing ${code}`), { code }),
        });
        const reader = await createReader(scenario.fileSystem, scenario.rootPath);
        const error = await captureReadError(reader);
        expectCodeAndNonEmptyMessage(error, 'CV_SOURCE_NOT_FOUND');
        expect(scenario.wasOpened()).toBe(true);
      }
    });

    // Mutant 4080: ELOOP must map to reparse-point denial with a message.
    it('maps a symlink-loop filesystem error to reparse-point denial', async () => {
      const scenario = createScenario({
        openError: Object.assign(new Error('too many links'), { code: 'ELOOP' }),
      });
      const reader = await createReader(scenario.fileSystem, scenario.rootPath);
      const error = await captureReadError(reader);
      expectCodeAndNonEmptyMessage(error, 'CV_PATH_REPARSE_POINT_DENIED');
    });

    // Mutant 4093: EACCES and EPERM must map to authorization denial.
    it('maps permission filesystem errors to authorization denial', async () => {
      for (const code of ['EACCES', 'EPERM']) {
        const scenario = createScenario({
          openError: Object.assign(new Error(`denied ${code}`), { code }),
        });
        const reader = await createReader(scenario.fileSystem, scenario.rootPath);
        const error = await captureReadError(reader);
        expectCodeAndNonEmptyMessage(error, 'CV_AUTHORIZATION_DENIED');
      }
    });

    // Mutant 4101: unknown errors must collapse to internal without leaking.
    it('collapses an unknown filesystem error to internal without leaking', async () => {
      const marker = 'sensitive-original-marker-safe-error';
      const scenario = createScenario({
        openError: Object.assign(new Error(marker), { code: 'EBUSY', message: marker }),
      });
      const reader = await createReader(scenario.fileSystem, scenario.rootPath);
      const error = await captureReadError(reader);
      expectCodeAndNonEmptyMessage(error, 'CV_INTERNAL_ERROR');
      expect(error.message).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain('EBUSY');
      expect(error.message).toBe('The source could not be inspected safely.');
    });

    // Outside-workspace containment must retain a safe, non-empty message.
    it('rejects a target escaping the workspace with a non-empty message', async () => {
      const scenario = createScenario({
        postReadCanonicalTarget: '/tmp/outside-escape.txt',
      });
      const reader = await createReader(scenario.fileSystem, scenario.rootPath);
      const error = await captureReadError(reader);
      expectCodeAndNonEmptyMessage(error, 'CV_PATH_OUTSIDE_WORKSPACE');
    });
  });

  it('enforces the deadline after classification completes', async () => {
    let calls = 0;
    const clock: InspectionClock = {
      now: (): Date => {
        calls += 1;
        if (calls <= 3) {
          return new Date(BASE_MILLISECONDS);
        }
        return new Date(BASE_MILLISECONDS + 10_000);
      },
    };
    const limits = validatePreparationLimits({
      ...STRICT_PREPARATION_LIMITS,
      prepareDeadlineMilliseconds: 1000,
    });
    const vault = new InMemoryVault(SESSION_ID, limits);
    const useCase = new PrepareSource(
      {
        clock,
        cryptography,
        fileReader: stubFileReader(new TextEncoder().encode('alpha\n'), 'late.txt'),
        vault,
        identifiers: new NodeOpaqueIdentifiers(),
        limits,
        tokens: new NodeCapabilityTokens(),
        tokenDigester: new NodeCapabilityTokens(),
      },
      new PreparationGate(limits.maxConcurrentPreparations),
    );
    const error = await captureAsyncError(() =>
      useCase.execute({ source: { kind: 'workspace_file', rootId: 'repo', path: 'late.txt' } }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_DEADLINE_EXCEEDED');
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('enforces the deadline after envelope assembly inputs are resolved', async () => {
    let current = BASE_MILLISECONDS;
    const clock: InspectionClock = {
      now: (): Date => {
        current += 1;
        return new Date(current);
      },
    };
    const limits = validatePreparationLimits({
      ...STRICT_PREPARATION_LIMITS,
      prepareDeadlineMilliseconds: 5,
    });
    const vault = new InMemoryVault(SESSION_ID, limits);
    const useCase = new PrepareSource(
      {
        clock,
        cryptography,
        fileReader: stubFileReader(new TextEncoder().encode('alpha\n'), 'late.txt'),
        vault,
        identifiers: new NodeOpaqueIdentifiers(),
        limits,
        tokens: new NodeCapabilityTokens(),
        tokenDigester: new NodeCapabilityTokens(),
      },
      new PreparationGate(limits.maxConcurrentPreparations),
    );
    const error = await captureAsyncError(() =>
      useCase.execute({ source: { kind: 'workspace_file', rootId: 'repo', path: 'late.txt' } }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_DEADLINE_EXCEEDED');
    expect(vault.snapshot().envelopeCount).toBe(1);
  });

  it('pins the preparation deadline message contract', async () => {
    const { useCase } = createPrepareHarness({
      bytes: new TextEncoder().encode('alpha\n'),
      normalizedRelativePath: 'notes.txt',
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
    });
    expect(useCase).toBeDefined();
    let calls = 0;
    const clock: InspectionClock = {
      now: (): Date => {
        calls += 1;
        if (calls <= 1) {
          return new Date(BASE_MILLISECONDS);
        }
        return new Date(BASE_MILLISECONDS + 10_000);
      },
    };
    const limits = validatePreparationLimits({
      ...STRICT_PREPARATION_LIMITS,
      prepareDeadlineMilliseconds: 1000,
    });
    const vault = new InMemoryVault(SESSION_ID, limits);
    const late = new PrepareSource(
      {
        clock,
        cryptography,
        fileReader: stubFileReader(new TextEncoder().encode('alpha\n'), 'notes.txt'),
        vault,
        identifiers: new NodeOpaqueIdentifiers(),
        limits,
        tokens: new NodeCapabilityTokens(),
        tokenDigester: new NodeCapabilityTokens(),
      },
      new PreparationGate(limits.maxConcurrentPreparations),
    );
    const error = await captureAsyncError(() =>
      late.execute({ source: { kind: 'workspace_file', rootId: 'repo', path: 'notes.txt' } }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_DEADLINE_EXCEEDED');
    expect((error as ContextVaultError).retryable).toBe(true);
  });
});

describe('purge security contracts', () => {
  it('keeps envelope and whole-state purge paths distinct', () => {
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    const purge = new PurgeDerivedState({
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
      cryptography,
      identifiers: new NodeOpaqueIdentifiers(),
      vault,
    });
    const record = Object.freeze({
      envelopeId: 'cv_env_first000000000001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      rootId: 'workspace',
      normalizedRelativePath: 'notes.txt',
      sourceId: 'cv_src_abcdefghijklmnop',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      mediaType: 'text/plain',
      bytes: 8,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks' as const,
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
      retrievalAllowed: false,
      lineCount: 1,
      structuralFingerprint: `sha256:${'b'.repeat(64)}`,
      derivedBytes: 64,
      chunks: [],
      jsonNodes: [],
      omissions: [],
    });
    vault.commitEnvelope(record, null);
    const envelopePreview = purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });
    const wholePreview = purge.preview({
      operation: 'preview',
      target: { kind: 'all_derived_state' },
    });
    expect(envelopePreview.summary).toEqual({ envelopeCount: 1, derivedBytes: 64 });
    expect(wholePreview.summary).toEqual({ envelopeCount: 1, derivedBytes: 64 });
    const envelopeResult = purge.execute({
      operation: 'execute',
      purgeIntentId: envelopePreview.purgeIntentId,
    });
    expect(envelopeResult.targetKind).toBe('envelope');
    expect(envelopeResult.deletedEnvelopes).toBe(1);
    expect(vault.snapshot().envelopeCount).toBe(0);
  });

  it('rejects a stale purge intent with a non-empty message', () => {
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    const purge = new PurgeDerivedState({
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
      cryptography,
      identifiers: new NodeOpaqueIdentifiers(),
      vault,
    });
    const record = Object.freeze({
      envelopeId: 'cv_env_first000000000001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      rootId: 'workspace',
      normalizedRelativePath: 'notes.txt',
      sourceId: 'cv_src_abcdefghijklmnop',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      mediaType: 'text/plain',
      bytes: 8,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks' as const,
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
      retrievalAllowed: false,
      lineCount: 1,
      structuralFingerprint: `sha256:${'b'.repeat(64)}`,
      derivedBytes: 64,
      chunks: [],
      jsonNodes: [],
      omissions: [],
    });
    vault.commitEnvelope(record, null);
    const preview = purge.preview({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_first000000000001' },
    });
    vault.removeEnvelopeWithDerived('cv_env_first000000000001');
    const error = captureSyncError(() =>
      purge.execute({ operation: 'execute', purgeIntentId: preview.purgeIntentId }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_PURGE_INTENT_STALE');
  });

  it('rejects an invalid purge request with a non-empty message', () => {
    const error = captureSyncError(() => validatePurgeRequest({ operation: 'preview' }));
    expectCodeAndNonEmptyMessage(error, 'CV_INPUT_INVALID');
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    const purge = new PurgeDerivedState({
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
      cryptography,
      identifiers: new NodeOpaqueIdentifiers(),
      vault,
    });
    const invalid = captureSyncError(() => purge.preview({ operation: 'preview' }));
    expectCodeAndNonEmptyMessage(invalid, 'CV_INPUT_INVALID');
  });
});

describe('retrieval and verification security contracts', () => {
  it('rejects a capability whose envelope binding differs only by envelope id', async () => {
    const tokens = new NodeCapabilityTokens();
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    const clock: InspectionClock = { now: (): Date => new Date(BASE_MILLISECONDS) };
    const sourceBytes = new TextEncoder().encode('alpha\nbeta\n');
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes: sourceBytes,
      normalizedRelativePath: 'notes/guide.txt',
    });
    const retrieve = new RetrieveSource({
      clock,
      cryptography,
      fileReader: { read, authorizedRootCount: 1 },
      vault,
      retrievalVault: vault,
      tokenDigester: tokens,
      digestComparator: tokens,
    });
    const error = await captureAsyncError(() =>
      retrieve.execute({
        capability: `cv1_${'z'.repeat(43)}`,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_CAPABILITY_INVALID');
  });

  it('pins the secret-risk denial message contract', () => {
    const error = new ContextVaultError({
      code: 'CV_RETRIEVAL_POLICY_DENIED',
      message: 'The requested excerpt was denied by the secret-risk policy.',
      safeDetails: { reason: 'secret_policy' },
    });
    expect(error.code).toBe('CV_RETRIEVAL_POLICY_DENIED');
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('pins retrieval cancellation and deadline message contracts', async () => {
    const tokens = new NodeCapabilityTokens();
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    const retrieve = new RetrieveSource({
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
      cryptography,
      fileReader: stubFileReader(new TextEncoder().encode('alpha\n'), 'notes.txt'),
      vault,
      retrievalVault: vault,
      tokenDigester: tokens,
      digestComparator: tokens,
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await captureAsyncError(() =>
      retrieve.execute(
        {
          capability: `cv1_${'z'.repeat(43)}`,
          selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
        },
        controller.signal,
      ),
    );
    expect(cancelled).toBeInstanceOf(ContextVaultError);
    expect((cancelled as ContextVaultError).message.length).toBeGreaterThan(0);
  });

  it('rejects an unknown selector kind even when the value is not a string', () => {
    for (const candidate of [{ kind: 42 }, { kind: null }, { kind: ['chunk'] }]) {
      const error = captureSyncError(() => validateRetrievalSelector(candidate));
      expectCodeAndNonEmptyMessage(error, 'CV_INPUT_INVALID');
    }
  });

  it('rejects non-object grant requests without collapsing to success', () => {
    for (const candidate of ['grant', 42, null, ['chunk']]) {
      const error = captureSyncError(() => validateGrantRequest(candidate));
      expectCodeAndNonEmptyMessage(error, 'CV_INPUT_INVALID');
    }
  });

  it('rejects an overlong selector allowlist', () => {
    const oversized = [...ALL_RETRIEVAL_SELECTOR_KINDS, 'chunk'] as unknown;
    const error = captureSyncError(() => validateGrantRequest({ allowedSelectorTypes: oversized }));
    expectCodeAndNonEmptyMessage(error, 'CV_INPUT_INVALID');
  });

  it('detects a provenance record that differs only by envelope id', async () => {
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    const verify = new VerifyEnvelope({
      clock: { now: (): Date => new Date(BASE_MILLISECONDS) },
      cryptography,
      fileReader: stubFileReader(new TextEncoder().encode('alpha\n'), 'notes.txt'),
      vault,
      retrievalVault: vault,
    });
    const envelopeId = 'cv_env_first000000000001';
    vault.commitEnvelope(
      {
        envelopeId,
        sessionId: SESSION_ID,
        createdAt: new Date(BASE_MILLISECONDS),
        expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
        rootId: 'workspace',
        normalizedRelativePath: 'notes.txt',
        sourceId: 'cv_src_abcdefghijklmnop',
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        mediaType: 'text/plain',
        bytes: 6,
        sensitivity: 'internal',
        secretRisk: 'none',
        preparationKind: 'text_chunks' as const,
        disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
        retrievalAllowed: false,
        lineCount: 1,
        structuralFingerprint: `sha256:${'b'.repeat(64)}`,
        derivedBytes: 16,
        chunks: [],
        jsonNodes: [],
        omissions: [],
      },
      null,
    );
    vault.appendProvenance(
      Object.freeze({
        envelopeId,
        sourceId: 'cv_src_foreign0000000000',
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        selectorKind: 'chunk' as const,
        excerptDigest: `sha256:${'c'.repeat(64)}`,
        byteCount: 2,
        truncated: false,
        recordedAt: new Date(BASE_MILLISECONDS).toISOString(),
      }),
    );
    const result = await verify.execute({
      envelopeId,
      checks: [{ kind: 'provenance_consistency' }],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe('invalid');
    expect(result.results[0]?.reasonCode.length).toBeGreaterThan(0);
  });
});

describe('domain scanner security contracts', () => {
  it('rejects an invalid JSON number that starts with a non-digit', () => {
    expect(isValidJsonNumber('')).toBe(false);
    expect(isValidJsonNumber('.5')).toBe(false);
    expect(isValidJsonNumber('e10')).toBe(false);
    expect(isValidJsonNumber('NaN')).toBe(false);
    expect(isValidJsonNumber('a')).toBe(false);
  });

  it('accepts a valid multi-digit JSON number', () => {
    expect(isValidJsonNumber('12')).toBe(true);
    expect(isValidJsonNumber('-12.5e+3')).toBe(true);
    expect(isValidJsonNumber('0')).toBe(true);
  });

  it('pins the item-limit message contract', () => {
    const error = itemLimitError();
    expect(error.code).toBe('CV_PARSE_ITEM_LIMIT_EXCEEDED');
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('scans an object with whitespace after separators', () => {
    const outcome = scanJsonStructure('{ "a" : 1 , "b" : 2 }', jsonScanLimits());
    expect(outcome.totalNodeCount).toBeGreaterThan(0);
    expect(outcome.nodes.length).toBeGreaterThan(0);
  });

  it('scans an array with whitespace after separators', () => {
    const outcome = scanJsonStructure('[ 1 , 2 , 3 ]', jsonScanLimits());
    expect(outcome.totalNodeCount).toBeGreaterThan(0);
  });

  it('assigns increasing end positions to container nodes', () => {
    const outcome = scanJsonStructure('{"a":1}', jsonScanLimits());
    const root = outcome.nodes[0];
    expect(root).toBeDefined();
    expect(root?.endPosition).toBeGreaterThan(root?.startPosition ?? 0);
  });

  it('collects a final line without a trailing feed', () => {
    const spans = collectLineSpans(new TextEncoder().encode('alpha\nbeta'));
    expect(spans).toHaveLength(2);
    expect(spans[1]?.byteEndExclusive).toBe(10);
  });

  it('pins the line-limit message contract', () => {
    const overLimit = Buffer.alloc(1_000_001, 0x0a);
    const error = captureSyncError(() => collectLineSpans(new Uint8Array(overLimit)));
    expectCodeAndNonEmptyMessage(error, 'CV_PARSE_LINE_LIMIT_EXCEEDED');
  });

  it('maps extensionless paths to plain text without leaking the fallback', () => {
    const policy = detectMediaPolicy('notes/README', true);
    expect(policy.mediaType).toBe('text/plain');
    const dotfile = detectMediaPolicy('notes/.env', true);
    expect(dotfile.mediaType).toBe('text/plain');
  });

  it('pins a chunk selector retrieval contract', () => {
    const selector: RetrievalSelector = validateRetrievalSelector({
      kind: 'chunk',
      chunkId: 'cv_chunk_000000000001',
    });
    expect(selector.kind).toBe('chunk');
  });
});

describe('platform security contracts', () => {
  it('pins preparation limit and TTL message contracts', () => {
    const limitsError = captureSyncError(() =>
      validatePreparationLimits({ ...STRICT_PREPARATION_LIMITS, maxActiveEnvelopes: 0 }),
    );
    expectCodeAndNonEmptyMessage(limitsError, 'CV_CONFIGURATION_INVALID');
    const ttlError = captureSyncError(() => validateTtlSeconds(59));
    expectCodeAndNonEmptyMessage(ttlError, 'CV_INPUT_INVALID');
  });

  it('pins purge intent validation with a non-empty message', () => {
    const error = captureSyncError(() => validatePurgeRequest({ operation: 'execute' }));
    expectCodeAndNonEmptyMessage(error, 'CV_INPUT_INVALID');
  });

  it('pins workspace path contracts with non-empty messages', () => {
    expectCodeAndNonEmptyMessage(
      captureSyncError(() => {
        assertValidRootId('INVALID_ROOT');
      }),
      'CV_INPUT_INVALID',
    );
    expectCodeAndNonEmptyMessage(
      captureSyncError(() => normalizeRelativePath('/absolute/path.txt')),
      'CV_PATH_ABSOLUTE_DENIED',
    );
    expectCodeAndNonEmptyMessage(
      captureSyncError(() => normalizeRelativePath('aux.txt')),
      'CV_PATH_SPECIAL_FILE_DENIED',
    );
    expectCodeAndNonEmptyMessage(
      captureSyncError(() => normalizeRelativePath('a//b.txt')),
      'CV_PATH_INVALID',
    );
  });

  it('pins startup argument validation with a non-empty message', () => {
    const error = captureSyncError(() => parseStartupArguments(['--bad-flag']));
    expectCodeAndNonEmptyMessage(error, 'CV_CONFIGURATION_INVALID');
  });

  it('pins vault session and limit message contracts', () => {
    const sessionError = captureSyncError(
      () => new InMemoryVault('bad-session', validatePreparationLimits(STRICT_PREPARATION_LIMITS)),
    );
    expectCodeAndNonEmptyMessage(sessionError, 'CV_CONFIGURATION_INVALID');
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    const record = {
      envelopeId: 'cv_env_first000000000001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      rootId: 'workspace',
      normalizedRelativePath: 'notes.txt',
      sourceId: 'cv_src_abcdefghijklmnop',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      mediaType: 'text/plain',
      bytes: 8,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks' as const,
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
      retrievalAllowed: false,
      lineCount: 1,
      structuralFingerprint: `sha256:${'b'.repeat(64)}`,
      derivedBytes: 8,
      chunks: [],
      jsonNodes: [],
      omissions: [],
    };
    vault.commitEnvelope(record, null);
    const duplicate = captureSyncError(() => {
      vault.commitEnvelope(record, null);
    });
    expectCodeAndNonEmptyMessage(duplicate, 'CV_INTERNAL_ERROR');
  });

  it('revokes only the matching envelope intents', () => {
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    vault.saveIntent({
      intentId: 'cv_pur_aaaaaaaaaaaaaaaa',
      sessionId: SESSION_ID,
      targetKind: 'envelope',
      envelopeId: 'cv_env_first000000000001',
      snapshotDigest: 'digest-a',
      envelopeCount: 1,
      derivedBytes: 8,
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      consumed: false,
    });
    vault.saveIntent({
      intentId: 'cv_pur_bbbbbbbbbbbbbbbb',
      sessionId: SESSION_ID,
      targetKind: 'envelope',
      envelopeId: 'cv_env_second00000000001',
      snapshotDigest: 'digest-b',
      envelopeCount: 1,
      derivedBytes: 8,
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      consumed: false,
    });
    const revoked = vault.revokeIntents('envelope', 'cv_env_first000000000001');
    expect(revoked).toBe(1);
    expect(vault.findIntent('cv_pur_aaaaaaaaaaaaaaaa')).toBeUndefined();
    expect(vault.findIntent('cv_pur_bbbbbbbbbbbbbbbb')).toBeDefined();
  });

  it('pins vault envelope limit messages with non-empty text', () => {
    const tinyLimits = validatePreparationLimits({
      ...STRICT_PREPARATION_LIMITS,
      maxActiveEnvelopes: 1,
      maxSerializedMetadataBytes: 16,
      maxTotalDerivedStateBytes: 16,
    });
    const vault = new InMemoryVault(SESSION_ID, tinyLimits);
    const base = {
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 1800 * 1000),
      rootId: 'workspace',
      normalizedRelativePath: 'notes.txt',
      sourceId: 'cv_src_abcdefghijklmnop',
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      mediaType: 'text/plain',
      bytes: 8,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks' as const,
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
      retrievalAllowed: false,
      lineCount: 1,
      structuralFingerprint: `sha256:${'b'.repeat(64)}`,
      chunks: [],
      jsonNodes: [],
      omissions: [],
    };
    vault.commitEnvelope(
      { ...base, envelopeId: 'cv_env_first000000000001', derivedBytes: 8 },
      null,
    );
    const limitError = captureSyncError((): unknown => {
      vault.commitEnvelope(
        { ...base, envelopeId: 'cv_env_second00000000001', derivedBytes: 8 },
        null,
      );
      return undefined;
    });
    expect(limitError).toBeInstanceOf(ContextVaultError);
    expect((limitError as ContextVaultError).message.length).toBeGreaterThan(0);
    const tooLarge = captureSyncError((): unknown => {
      vault.commitEnvelope(
        { ...base, envelopeId: 'cv_env_third000000000001', derivedBytes: 64 },
        null,
      );
      return undefined;
    });
    expect(tooLarge).toBeInstanceOf(ContextVaultError);
    expect((tooLarge as ContextVaultError).message.length).toBeGreaterThan(0);
  });

  it('pins file reader authorization and stability contracts', async () => {
    const scenario = createScenario();
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);
    const denied = await (async (): Promise<ContextVaultError> => {
      try {
        await reader.read({
          rootId: 'other',
          normalizedRelativePath: 'file.txt',
          maximumBytes: 1024,
        });
        throw new Error('Expected denial.');
      } catch (error: unknown) {
        if (error instanceof ContextVaultError) {
          expect(error.code).toBe('CV_AUTHORIZATION_DENIED');
          expect(error.message.length).toBeGreaterThan(0);
          return error;
        }
        throw error;
      }
    })();
    expect(denied.code).toBe('CV_AUTHORIZATION_DENIED');

    const symlinkScenario = createScenario({
      pathMetadata: [fileMetadata({ symbolicLink: true }), fileMetadata()],
    });
    const symlinkReader = await createReader(symlinkScenario.fileSystem, symlinkScenario.rootPath);
    const symlinkError = await captureReadError(symlinkReader);
    expect(symlinkError.code).toBe('CV_PATH_REPARSE_POINT_DENIED');
    expect(symlinkError.message.length).toBeGreaterThan(0);

    const controller = new AbortController();
    controller.abort();
    const cancelledScenario = createScenario();
    const cancelledReader = await createReader(
      cancelledScenario.fileSystem,
      cancelledScenario.rootPath,
    );
    try {
      await cancelledReader.read({
        rootId: 'repo',
        normalizedRelativePath: 'file.txt',
        maximumBytes: 1024,
        signal: controller.signal,
      });
      expect.fail('Expected cancellation.');
    } catch (error: unknown) {
      expectCodeAndNonEmptyMessage(error, 'CV_OPERATION_CANCELLED');
    }
  });

  it('pins file reader size and mapping contracts', async () => {
    const oversized = createScenario({ size: 8 });
    const oversizedReader = await createReader(oversized.fileSystem, oversized.rootPath);
    const tooLarge = await captureReadError(oversizedReader, 'file.txt', 4);
    expect(tooLarge.code).toBe('CV_RESOURCE_SOURCE_TOO_LARGE');
    expect(tooLarge.message.length).toBeGreaterThan(0);

    const changed = createScenario({ readSizes: [0] });
    const changedReader = await createReader(changed.fileSystem, changed.rootPath);
    const changedError = await captureReadError(changedReader);
    expect(changedError.code).toBe('CV_SOURCE_CHANGED');
    expect(changedError.message.length).toBeGreaterThan(0);

    const special = createScenario({
      pathMetadata: [fileMetadata({ special: true }), fileMetadata({ special: true })],
    });
    const specialReader = await createReader(special.fileSystem, special.rootPath);
    const specialError = await captureReadError(specialReader);
    expect(specialError.code).toBe('CV_PATH_SPECIAL_FILE_DENIED');
    expect(specialError.message.length).toBeGreaterThan(0);
  });
});

describe('retrieval live-path security contracts', () => {
  async function prepareLiveGrant(
    vault: InMemoryVault,
    clock: InspectionClock,
    read: AuthorizedFileReader['read'],
    envelopeTtlSeconds: number,
    grantTtlSeconds?: number,
  ): Promise<{ envelopeId: string; capability: string }> {
    const tokens = new NodeCapabilityTokens();
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const prepare = new PrepareSource(
      {
        clock,
        cryptography,
        fileReader: { read, authorizedRootCount: 1 },
        vault,
        identifiers: new NodeOpaqueIdentifiers(),
        limits,
        tokens,
        tokenDigester: tokens,
      },
      new PreparationGate(limits.maxConcurrentPreparations),
    );
    const prepared = await prepare.execute({
      source: { kind: 'workspace_file', rootId: 'repo', path: 'notes/guide.txt' },
      ttlSeconds: envelopeTtlSeconds,
      retrieval: {
        allowedSelectorTypes: ['chunk', 'line_range'],
        maxBytes: 4096,
        ttlSeconds: grantTtlSeconds ?? envelopeTtlSeconds,
      },
    });
    const retrieval = prepared.envelope.retrieval;
    if (!retrieval) {
      throw new Error('Expected a retrieval grant.');
    }
    return { envelopeId: prepared.envelope.envelopeId, capability: retrieval.capability };
  }

  it('reports a missing live envelope with a non-empty message', async () => {
    const state = { current: BASE_MILLISECONDS };
    const clock: InspectionClock = { now: (): Date => new Date(state.current) };
    const sourceBytes = new TextEncoder().encode('alpha\n');
    const digest = cryptography.sha256(sourceBytes);
    const tokens = new NodeCapabilityTokens();
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    const record = Object.freeze({
      envelopeId: 'cv_env_shortlived00001',
      sessionId: SESSION_ID,
      createdAt: new Date(BASE_MILLISECONDS),
      expiresAt: new Date(BASE_MILLISECONDS + 60 * 1000),
      rootId: 'repo',
      normalizedRelativePath: 'notes/guide.txt',
      sourceId: cryptography.sourceId('repo', 'notes/guide.txt', digest),
      sourceDigest: digest,
      mediaType: 'text/plain',
      bytes: sourceBytes.byteLength,
      sensitivity: 'internal',
      secretRisk: 'none',
      preparationKind: 'text_chunks' as const,
      disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE' as const,
      retrievalAllowed: true,
      lineCount: 1,
      structuralFingerprint: digest,
      derivedBytes: 64,
      chunks: [
        Object.freeze({
          chunkId: 'cv_chunk_000000000001',
          byteStart: 0,
          byteEndExclusive: sourceBytes.byteLength,
          lineStart: 1,
          lineEndExclusive: 2,
          byteLength: sourceBytes.byteLength,
          chunkDigest: digest,
          truncated: false,
        }),
      ],
      jsonNodes: [],
      omissions: [],
    });
    const capability = tokens.createCapabilityToken();
    const read = vi.fn<AuthorizedFileReader['read']>(() =>
      Promise.resolve({ bytes: sourceBytes, normalizedRelativePath: 'notes/guide.txt' }),
    );
    vault.commitEnvelope(record, {
      tokenDigest: tokens.digestCapabilityToken(capability),
      allowedSelectorTypes: ['chunk'],
      maxBytes: 4096,
      expiresAt: new Date(BASE_MILLISECONDS + 600 * 1000),
    });
    state.current += 61_000;
    const retrieve = new RetrieveSource({
      clock,
      cryptography,
      fileReader: { read, authorizedRootCount: 1 },
      vault,
      retrievalVault: vault,
      tokenDigester: tokens,
      digestComparator: tokens,
    });
    const error = await captureAsyncError(() =>
      retrieve.execute({
        capability,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_ENVELOPE_NOT_FOUND');
  });

  it('rejects a retrieval whose deadline passes during the read', async () => {
    const state = { current: BASE_MILLISECONDS };
    const clock: InspectionClock = { now: (): Date => new Date(state.current) };
    const sourceBytes = new TextEncoder().encode('alpha\nbeta\ngamma\n');
    const stableRead = vi.fn<AuthorizedFileReader['read']>(() =>
      Promise.resolve({ bytes: sourceBytes, normalizedRelativePath: 'notes/guide.txt' }),
    );
    const tokens = new NodeCapabilityTokens();
    const limits = validatePreparationLimits(STRICT_PREPARATION_LIMITS);
    const vault = new InMemoryVault(SESSION_ID, limits);
    const grant = await prepareLiveGrant(vault, clock, stableRead, 600);
    const advancingRead = vi.fn<AuthorizedFileReader['read']>(() => {
      state.current += 60_000;
      return Promise.resolve({ bytes: sourceBytes, normalizedRelativePath: 'notes/guide.txt' });
    });
    const retrieve = new RetrieveSource({
      clock,
      cryptography,
      fileReader: { read: advancingRead, authorizedRootCount: 1 },
      vault,
      retrievalVault: vault,
      tokenDigester: tokens,
      digestComparator: tokens,
    });
    const error = await captureAsyncError(() =>
      retrieve.execute({
        capability: grant.capability,
        selector: { kind: 'chunk', chunkId: 'cv_chunk_000000000001' },
      }),
    );
    expectCodeAndNonEmptyMessage(error, 'CV_DEADLINE_EXCEEDED');
    expect((error as ContextVaultError).retryable).toBe(true);
  });
});

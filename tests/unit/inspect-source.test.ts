import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SOURCE_BYTE_LIMIT,
  HARD_SOURCE_BYTE_LIMIT,
  InspectSource,
} from '../../src/application/inspection/inspect-source.js';
import type { AuthorizedFileReader } from '../../src/application/ports/authorized-file-reader.js';
import type {
  InspectionClock,
  InspectionCryptography,
} from '../../src/application/ports/inspection-services.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';

const bytes = new TextEncoder().encode('{"status":"ok"}');
const clock: InspectionClock = {
  now: () => new Date('2026-09-10T12:00:00.000Z'),
};
const cryptography: InspectionCryptography = {
  sha256: () => `sha256:${'a'.repeat(64)}`,
  sourceId: () => `cv_src_${'b'.repeat(24)}`,
};

describe('InspectSource', () => {
  it('returns content-free deterministic inspection metadata', async () => {
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'data/status.json',
    });
    const useCase = new InspectSource({
      clock,
      cryptography,
      fileReader: { read, authorizedRootCount: 1 },
    });

    const result = await useCase.execute({
      kind: 'workspace_file',
      rootId: 'repo',
      path: 'data\\status.json',
    });

    expect(read).toHaveBeenCalledWith({
      rootId: 'repo',
      normalizedRelativePath: 'data/status.json',
      maximumBytes: DEFAULT_SOURCE_BYTE_LIMIT,
    });
    expect(result).toEqual({
      schemaVersion: '1.0',
      ok: true,
      source: {
        sourceId: `cv_src_${'b'.repeat(24)}`,
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        mediaType: 'application/json',
        bytes: bytes.byteLength,
        sensitivity: 'internal',
        secretRisk: 'none',
        supportedSelectors: ['json_node', 'line_range'],
        inspectedAt: '2026-09-10T12:00:00.000Z',
      },
    });
    expect(JSON.stringify(result)).not.toContain('{"status":"ok"}');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
  });

  it('passes cancellation through the reader port', async () => {
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'file.txt',
    });
    const useCase = new InspectSource({
      clock,
      cryptography,
      fileReader: { read, authorizedRootCount: 1 },
    });
    const controller = new AbortController();

    await useCase.execute(
      { kind: 'workspace_file', rootId: 'repo', path: 'file.txt' },
      controller.signal,
    );

    expect(read).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it.each([0, -1, 1.5, Number.NaN, HARD_SOURCE_BYTE_LIMIT + 1])(
    'rejects invalid source byte limit %s',
    (maximumSourceBytes) => {
      expectErrorCode(
        () =>
          new InspectSource({
            clock,
            cryptography,
            fileReader: { read: vi.fn(), authorizedRootCount: 1 },
            maximumSourceBytes,
          }),
        'CV_CONFIGURATION_INVALID',
      );
    },
  );

  it('accepts the hard source byte ceiling', () => {
    expect(
      () =>
        new InspectSource({
          clock,
          cryptography,
          fileReader: { read: vi.fn(), authorizedRootCount: 1 },
          maximumSourceBytes: HARD_SOURCE_BYTE_LIMIT,
        }),
    ).not.toThrow();
  });

  it('accepts a one-byte ceiling and rejects a zero ceiling', () => {
    expect(
      () =>
        new InspectSource({
          clock,
          cryptography,
          fileReader: { read: vi.fn(), authorizedRootCount: 1 },
          maximumSourceBytes: 1,
        }),
    ).not.toThrow();
    expectErrorCode(
      () =>
        new InspectSource({
          clock,
          cryptography,
          fileReader: { read: vi.fn(), authorizedRootCount: 1 },
          maximumSourceBytes: 0,
        }),
      'CV_CONFIGURATION_INVALID',
    );
  });

  it('defaults to the documented source byte limit', () => {
    const read = vi.fn<AuthorizedFileReader['read']>().mockResolvedValue({
      bytes,
      normalizedRelativePath: 'file.txt',
    });
    const useCase = new InspectSource({
      clock,
      cryptography,
      fileReader: { read, authorizedRootCount: 1 },
    });

    void useCase.execute({ kind: 'workspace_file', rootId: 'repo', path: 'file.txt' });

    expect(DEFAULT_SOURCE_BYTE_LIMIT).toBe(32 * 1024 * 1024);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ maximumBytes: DEFAULT_SOURCE_BYTE_LIMIT }),
    );
  });

  it('rejects an invalid root identifier before invoking the file reader', async () => {
    const read = vi.fn<AuthorizedFileReader['read']>();
    const useCase = new InspectSource({
      clock,
      cryptography,
      fileReader: { read, authorizedRootCount: 1 },
    });

    await expect(
      useCase.execute({ kind: 'workspace_file', rootId: 'Invalid', path: 'file.txt' }),
    ).rejects.toMatchObject({ code: 'CV_INPUT_INVALID' });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects the path before invoking the file reader', async () => {
    const read = vi.fn<AuthorizedFileReader['read']>();
    const useCase = new InspectSource({
      clock,
      cryptography,
      fileReader: { read, authorizedRootCount: 1 },
    });

    await expect(
      useCase.execute({ kind: 'workspace_file', rootId: 'repo', path: '../outside.txt' }),
    ).rejects.toMatchObject({ code: 'CV_PATH_OUTSIDE_WORKSPACE' });
    expect(read).not.toHaveBeenCalled();
  });

  it('independently rejects a non-workspace source kind', async () => {
    const read = vi.fn<AuthorizedFileReader['read']>();
    const useCase = new InspectSource({
      clock,
      cryptography,
      fileReader: { read, authorizedRootCount: 1 },
    });
    const invalidSource = {
      kind: 'remote_url',
      rootId: 'repo',
      path: 'file.txt',
    } as unknown as Parameters<InspectSource['execute']>[0];

    await expect(useCase.execute(invalidSource)).rejects.toMatchObject({
      code: 'CV_INPUT_INVALID',
    });
    expect(read).not.toHaveBeenCalled();
  });
});

function expectErrorCode(action: () => unknown, expectedCode: string): void {
  try {
    action();
    expect.fail('Expected a ContextVaultError.');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ContextVaultError);
    expect((error as ContextVaultError).code).toBe(expectedCode);
  }
}

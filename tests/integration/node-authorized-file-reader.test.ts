import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import { NodeAuthorizedFileReader } from '../../src/infrastructure/workspace/node-authorized-file-reader.js';

describe('NodeAuthorizedFileReader', () => {
  let sandboxPath: string;
  let workspacePath: string;
  let outsidePath: string;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(tmpdir(), 'contextvault-reader-'));
    workspacePath = path.join(sandboxPath, 'workspace');
    outsidePath = path.join(sandboxPath, 'outside');
    await Promise.all([
      mkdir(path.join(workspacePath, 'docs'), { recursive: true }),
      mkdir(outsidePath, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    await rm(sandboxPath, { force: true, recursive: true });
  });

  it('reads a stable regular file beneath an authorized canonical root', async () => {
    await writeFile(path.join(workspacePath, 'docs', 'guide.md'), 'Approved content.');
    const reader = await createReader(workspacePath);

    const result = await reader.read({
      rootId: 'repo',
      normalizedRelativePath: 'docs/guide.md',
      maximumBytes: 1024,
    });

    expect(new TextDecoder().decode(result.bytes)).toBe('Approved content.');
    expect(result.normalizedRelativePath).toBe('docs/guide.md');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('supports an empty regular file', async () => {
    await writeFile(path.join(workspacePath, 'empty.txt'), '');
    const reader = await createReader(workspacePath);

    const result = await reader.read({
      rootId: 'repo',
      normalizedRelativePath: 'empty.txt',
      maximumBytes: 1,
    });

    expect(result.bytes.byteLength).toBe(0);
  });

  it('denies a request for an unknown root without disclosing a path', async () => {
    const reader = await createReader(workspacePath);

    await expectErrorCode(
      reader.read({
        rootId: 'unknown',
        normalizedRelativePath: 'private.txt',
        maximumBytes: 1024,
      }),
      'CV_AUTHORIZATION_DENIED',
      [workspacePath, outsidePath, 'private.txt'],
    );
  });

  it('maps a missing source to a stable content-free error', async () => {
    const reader = await createReader(workspacePath);

    await expectErrorCode(
      reader.read({
        rootId: 'repo',
        normalizedRelativePath: 'missing.txt',
        maximumBytes: 1024,
      }),
      'CV_SOURCE_NOT_FOUND',
      [workspacePath, 'missing.txt'],
    );
  });

  it('denies directories and a file used as an intermediate directory', async () => {
    await writeFile(path.join(workspacePath, 'ordinary.txt'), 'value');
    const reader = await createReader(workspacePath);

    await expectErrorCode(
      reader.read({
        rootId: 'repo',
        normalizedRelativePath: 'docs',
        maximumBytes: 1024,
      }),
      'CV_PATH_SPECIAL_FILE_DENIED',
      [],
    );
    await expectErrorCode(
      reader.read({
        rootId: 'repo',
        normalizedRelativePath: 'ordinary.txt/child',
        maximumBytes: 1024,
      }),
      'CV_PATH_SPECIAL_FILE_DENIED',
      [],
    );
  });

  it('rejects a source larger than the caller byte ceiling', async () => {
    await writeFile(path.join(workspacePath, 'large.txt'), '12345');
    const reader = await createReader(workspacePath);

    await expectErrorCode(
      reader.read({
        rootId: 'repo',
        normalizedRelativePath: 'large.txt',
        maximumBytes: 4,
      }),
      'CV_RESOURCE_SOURCE_TOO_LARGE',
      ['12345', workspacePath],
    );
  });

  it('denies a junction or symbolic-link component before reading outside content', async () => {
    const outsideValue = 'outside-only-value';
    await writeFile(path.join(outsidePath, 'private.txt'), outsideValue);
    await symlink(outsidePath, path.join(workspacePath, 'linked'), 'junction');
    const reader = await createReader(workspacePath);

    await expectErrorCode(
      reader.read({
        rootId: 'repo',
        normalizedRelativePath: 'linked/private.txt',
        maximumBytes: 1024,
      }),
      'CV_PATH_REPARSE_POINT_DENIED',
      [outsideValue, workspacePath, outsidePath],
    );
  });

  it('stops before reading when cancellation is already requested', async () => {
    await writeFile(path.join(workspacePath, 'cancelled.txt'), 'not returned');
    const reader = await createReader(workspacePath);
    const controller = new AbortController();
    controller.abort();

    await expectErrorCode(
      reader.read({
        rootId: 'repo',
        normalizedRelativePath: 'cancelled.txt',
        maximumBytes: 1024,
        signal: controller.signal,
      }),
      'CV_OPERATION_CANCELLED',
      ['not returned', workspacePath],
    );
  });

  it('rejects duplicate canonical roots and invalid root targets', async () => {
    await expectErrorCode(
      NodeAuthorizedFileReader.create([
        { rootId: 'first', absolutePath: workspacePath },
        { rootId: 'second', absolutePath: workspacePath },
      ]),
      'CV_CONFIGURATION_INVALID',
      [workspacePath],
    );

    const secondRoot = path.join(sandboxPath, 'second-root');
    await mkdir(secondRoot);
    await expectErrorCode(
      NodeAuthorizedFileReader.create([
        { rootId: 'same', absolutePath: workspacePath },
        { rootId: 'same', absolutePath: secondRoot },
      ]),
      'CV_CONFIGURATION_INVALID',
      [workspacePath, secondRoot],
    );

    const regularFile = path.join(sandboxPath, 'not-a-root.txt');
    await writeFile(regularFile, 'value');
    await expectErrorCode(
      NodeAuthorizedFileReader.create([{ rootId: 'repo', absolutePath: regularFile }]),
      'CV_CONFIGURATION_INVALID',
      [regularFile],
    );

    await expectErrorCode(
      NodeAuthorizedFileReader.create([
        { rootId: 'repo', absolutePath: path.join(sandboxPath, 'missing-root') },
      ]),
      'CV_CONFIGURATION_INVALID',
      [sandboxPath],
    );

    await expectErrorCode(
      NodeAuthorizedFileReader.create([{ rootId: 'repo', absolutePath: 'relative-root' }]),
      'CV_CONFIGURATION_INVALID',
      ['relative-root'],
    );
  });
});

async function createReader(workspacePath: string): Promise<NodeAuthorizedFileReader> {
  return NodeAuthorizedFileReader.create([{ rootId: 'repo', absolutePath: workspacePath }]);
}

async function expectErrorCode(
  promise: Promise<unknown>,
  expectedCode: string,
  prohibitedValues: readonly string[],
): Promise<void> {
  try {
    await promise;
    expect.fail('Expected a ContextVaultError.');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ContextVaultError);
    const safeError = error as ContextVaultError;
    expect(safeError.code).toBe(expectedCode);
    const serialized = JSON.stringify({
      code: safeError.code,
      message: safeError.message,
      retryable: safeError.retryable,
      safeDetails: safeError.safeDetails,
    });
    for (const prohibitedValue of prohibitedValues) {
      expect(serialized).not.toContain(prohibitedValue);
    }
  }
}

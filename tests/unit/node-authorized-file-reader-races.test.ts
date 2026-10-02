import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  NodeAuthorizedFileReader,
  type NodeFileSystem,
} from '../../src/infrastructure/workspace/node-authorized-file-reader.js';
import {
  captureDeniedRetryable,
  captureReadResolution,
  captureRetryable,
  createReader,
  createScenario,
  expectReadError,
  fileMetadata,
} from './node-authorized-file-reader-scenario.js';

describe('NodeAuthorizedFileReader deterministic race handling', () => {
  it.each([
    ['a device identifier', { dev: 9 }],
    ['an inode identifier', { ino: 9 }],
  ])('rejects a file-handle identity mismatch on %s', async (_label, override) => {
    // The pre-read and post-read handle metadata are identical, so only the
    // path-to-handle identity comparison can reject this read. A later metadata
    // stability check cannot mask the missing identity decision.
    const scenario = createScenario({
      handleMetadata: [fileMetadata(override), fileMetadata(override)],
    });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_SOURCE_CHANGED');
    expect(scenario.wasClosed()).toBe(true);
  });

  it('rejects a non-file returned by the opened handle', async () => {
    const directory = fileMetadata({ directory: true, size: 4 });
    const scenario = createScenario({
      handleMetadata: [directory, directory],
    });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_PATH_SPECIAL_FILE_DENIED');
  });

  it.each([{ mtimeMs: 2 }, { ctimeMs: 2 }, { dev: 2 }, { ino: 2 }, { size: 5 }])(
    'rejects post-read metadata change $mtimeMs$ctimeMs$dev$ino$size',
    async (change) => {
      const scenario = createScenario({
        handleMetadata: [fileMetadata(), fileMetadata(change)],
      });
      const reader = await createReader(scenario.fileSystem, scenario.rootPath);

      await expectReadError(reader, 'CV_SOURCE_CHANGED');
    },
  );

  it('rejects a target that resolves outside the root after reading', async () => {
    const outsideTarget = path.resolve('outside', 'file.txt');
    const scenario = createScenario({ postReadCanonicalTarget: outsideTarget });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_PATH_OUTSIDE_WORKSPACE');
  });

  it('rejects a target that changes to another path inside the root', async () => {
    const scenario = createScenario({
      postReadCanonicalTarget: path.resolve('virtual-root', 'other.txt'),
    });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_SOURCE_CHANGED');
  });

  it('rejects a link introduced after reading', async () => {
    const scenario = createScenario({
      pathMetadata: [fileMetadata(), fileMetadata({ symbolicLink: true })],
    });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_PATH_REPARSE_POINT_DENIED');
  });

  it.each([
    ['ELOOP', 'CV_PATH_REPARSE_POINT_DENIED'],
    ['EACCES', 'CV_AUTHORIZATION_DENIED'],
    ['EPERM', 'CV_AUTHORIZATION_DENIED'],
    ['EISDIR', 'CV_PATH_SPECIAL_FILE_DENIED'],
    ['EIO', 'CV_INTERNAL_ERROR'],
  ])('maps operating-system error %s to %s', async (nodeCode, contextCode) => {
    const error = Object.assign(new Error('sensitive operating-system detail'), { code: nodeCode });
    const scenario = createScenario({ openError: error });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, contextCode);
  });

  it.each([new Error('unknown'), null, { code: 7 }])(
    'maps an unrecognized failure to the internal safe error',
    async (openError) => {
      const scenario = createScenario({ openError });
      const reader = await createReader(scenario.fileSystem, scenario.rootPath);

      await expectReadError(reader, 'CV_INTERNAL_ERROR');
    },
  );

  it('rejects an operating-system filesystem root as a workspace', async () => {
    const systemRoot = path.parse(path.resolve('.')).root;
    const metadata = fileMetadata({ directory: true, size: 0 });
    const fileSystem: NodeFileSystem = {
      lstat: () => Promise.resolve(metadata),
      open: () => Promise.reject(new Error('not called')),
      realpath: () => Promise.resolve(systemRoot),
      stat: () => Promise.resolve(metadata),
    };

    await expect(
      NodeAuthorizedFileReader.create([{ rootId: 'repo', absolutePath: systemRoot }], fileSystem),
    ).rejects.toMatchObject({ code: 'CV_CONFIGURATION_INVALID' });
  });

  it('rejects an intermediate component that is not a directory', async () => {
    const scenario = createScenario({ pathMetadata: [fileMetadata(), fileMetadata()] });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const resolution = await captureReadResolution(reader, 'plain.txt/child.txt');

    expect(resolution).toBe('CV_PATH_SPECIAL_FILE_DENIED');
  });

  it('rejects a non-directory mid-path component before opening the target', async () => {
    // Three segments ensure the offending component is neither the first nor the
    // last, so the "is this the final component" decision itself must be correct.
    // The read must be refused before the target is opened: a later re-inspection
    // of the path would otherwise produce the same error code by accident.
    const scenario = createScenario({
      pathMetadata: [fileMetadata({ directory: true }), fileMetadata(), fileMetadata()],
    });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const resolution = await captureReadResolution(reader, 'top/middle/leaf.txt');

    expect(resolution).toBe('CV_PATH_SPECIAL_FILE_DENIED');
    expect(scenario.wasOpened()).toBe(false);
  });

  it('denies a target that resolves to the root itself', async () => {
    const scenario = createScenario({ postReadCanonicalTarget: path.resolve('virtual-root') });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const resolution = await captureReadResolution(reader);

    expect(resolution).toBe('CV_PATH_OUTSIDE_WORKSPACE');
  });

  it('denies a target that resolves to a parent of the root', async () => {
    const scenario = createScenario({ postReadCanonicalTarget: path.resolve('.') });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const resolution = await captureReadResolution(reader);

    expect(resolution).toBe('CV_PATH_OUTSIDE_WORKSPACE');
  });

  it('maps a missing source to a stable not-found error before any read', async () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const scenario = createScenario({ openError: missing });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_SOURCE_NOT_FOUND');
  });

  it('maps a non-directory path component to a stable not-found error', async () => {
    const notDirectory = Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
    const scenario = createScenario({ openError: notDirectory });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    await expectReadError(reader, 'CV_SOURCE_NOT_FOUND');
  });

  it('marks a post-read containment violation as permanent and not retryable', async () => {
    const scenario = createScenario({
      postReadCanonicalTarget: path.resolve('elsewhere', 'file.txt'),
    });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const retryable = await captureRetryable(reader);

    expect(retryable).toBe(false);
  });

  it('marks a post-read metadata instability as retryable', async () => {
    const scenario = createScenario({
      handleMetadata: [fileMetadata(), fileMetadata({ mtimeMs: 2 })],
    });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const retryable = await captureRetryable(reader);

    expect(retryable).toBe(true);
  });

  it('marks an authorization denial as permanent and not retryable', async () => {
    const scenario = createScenario();
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const retryable = await captureDeniedRetryable(reader);

    expect(retryable).toBe(false);
  });

  it('denies a final path component that is neither a regular file nor a link', async () => {
    // A FIFO, socket, or device reports neither isFile nor isSymbolicLink, so the
    // reader must reject it before opening rather than reading from a special file.
    const special = fileMetadata({ special: true });
    const scenario = createScenario({ pathMetadata: [special] });
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    const resolution = await captureReadResolution(reader);

    expect(resolution).toBe('CV_PATH_SPECIAL_FILE_DENIED');
  });

  it('refuses to authorize a root whose identifier is invalid', async () => {
    const scenario = createScenario();

    await expect(
      NodeAuthorizedFileReader.create(
        [{ rootId: 'Invalid Root', absolutePath: scenario.rootPath }],
        scenario.fileSystem,
      ),
    ).rejects.toMatchObject({ code: 'CV_INPUT_INVALID' });
  });

  it('refuses to authorize a root that is not an absolute path', async () => {
    const scenario = createScenario();

    await expect(
      NodeAuthorizedFileReader.create(
        [{ rootId: 'repo', absolutePath: path.join('relative', 'root') }],
        scenario.fileSystem,
      ),
    ).rejects.toMatchObject({ code: 'CV_CONFIGURATION_INVALID' });
  });

  it('wraps an arbitrary filesystem failure during root authorization', async () => {
    const fileSystem: NodeFileSystem = {
      lstat: () => Promise.resolve(fileMetadata({ directory: true, size: 0 })),
      open: () => Promise.reject(new Error('not called')),
      realpath: () => Promise.reject(new Error('raw operating-system detail')),
      stat: () => Promise.resolve(fileMetadata({ directory: true, size: 0 })),
    };

    const failure = await NodeAuthorizedFileReader.create(
      [{ rootId: 'repo', absolutePath: path.resolve('virtual-root') }],
      fileSystem,
    ).then(
      () => 'RESOLVED',
      (error: unknown) => (error instanceof ContextVaultError ? error.code : 'UNKNOWN'),
    );

    expect(failure).toBe('CV_CONFIGURATION_INVALID');
  });

  it('rejects a root when stat fails with a raw error', async () => {
    const scenario = createScenario();
    const fileSystem: NodeFileSystem = {
      ...scenario.fileSystem,
      stat: () => Promise.reject(new Error('raw operating-system detail')),
    };

    await expect(
      NodeAuthorizedFileReader.create(
        [{ rootId: 'repo', absolutePath: scenario.rootPath }],
        fileSystem,
      ),
    ).rejects.toMatchObject({ code: 'CV_CONFIGURATION_INVALID' });
  });

  it('does not expose raw filesystem details during root authorization', async () => {
    const scenario = createScenario();
    const fileSystem: NodeFileSystem = {
      ...scenario.fileSystem,
      realpath: () => Promise.reject(new Error('raw operating-system detail')),
    };

    const error = await NodeAuthorizedFileReader.create(
      [{ rootId: 'repo', absolutePath: scenario.rootPath }],
      fileSystem,
    ).then(
      () => {
        throw new Error('Expected root authorization to fail.');
      },
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ContextVaultError);
    const safeError = error as ContextVaultError;
    expect(safeError.code).toBe('CV_CONFIGURATION_INVALID');
    expect(safeError.message).not.toContain('raw operating-system detail');
  });

  it('rejects a root that is not a directory', async () => {
    const scenario = createScenario();
    const fileSystem: NodeFileSystem = {
      ...scenario.fileSystem,
      stat: () => Promise.resolve(fileMetadata()),
    };

    await expect(
      NodeAuthorizedFileReader.create(
        [{ rootId: 'repo', absolutePath: scenario.rootPath }],
        fileSystem,
      ),
    ).rejects.toMatchObject({ code: 'CV_CONFIGURATION_INVALID' });
  });

  it('rejects a duplicate root identifier', async () => {
    const scenario = createScenario();
    const fileSystem: NodeFileSystem = {
      ...scenario.fileSystem,
      realpath: (target: string) => Promise.resolve(target),
      stat: () => Promise.resolve(fileMetadata({ directory: true, size: 0 })),
    };

    await expect(
      NodeAuthorizedFileReader.create(
        [
          { rootId: 'repo', absolutePath: path.resolve('virtual-root-a') },
          { rootId: 'repo', absolutePath: path.resolve('virtual-root-b') },
        ],
        fileSystem,
      ),
    ).rejects.toMatchObject({ code: 'CV_CONFIGURATION_INVALID' });
  });

  it('rejects a duplicate canonical root path', async () => {
    const scenario = createScenario();
    const canonical = path.resolve('virtual-root');
    const fileSystem: NodeFileSystem = {
      ...scenario.fileSystem,
      realpath: () => Promise.resolve(canonical),
      stat: () => Promise.resolve(fileMetadata({ directory: true, size: 0 })),
    };

    await expect(
      NodeAuthorizedFileReader.create(
        [
          { rootId: 'first', absolutePath: path.resolve('virtual-root-a') },
          { rootId: 'second', absolutePath: path.resolve('virtual-root-b') },
        ],
        fileSystem,
      ),
    ).rejects.toMatchObject({ code: 'CV_CONFIGURATION_INVALID' });
  });

  it('accepts a valid root', async () => {
    const scenario = createScenario();
    const reader = await createReader(scenario.fileSystem, scenario.rootPath);

    expect(reader).toBeInstanceOf(NodeAuthorizedFileReader);
  });
});

import path from 'node:path';
import { expect } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  type FileMetadata,
  NodeAuthorizedFileReader,
  type NodeFileSystem,
  type ReadableFileHandle,
} from '../../src/infrastructure/workspace/node-authorized-file-reader.js';
import {
  hostPathSemantics,
  type PathSemantics,
} from '../../src/infrastructure/workspace/path-platform-semantics.js';

const encoder = new TextEncoder();

/** Records one call to the opened handle's read method. */
export interface ReadRequest {
  readonly length: number;
  readonly offset: number;
}

export interface ScenarioOptions {
  readonly abortAfterRead?: AbortController;
  readonly handleMetadata?: readonly FileMetadata[];
  readonly maximumBytes?: number;
  readonly openError?: unknown;
  readonly pathMetadata?: readonly FileMetadata[];
  readonly postReadCanonicalTarget?: string;
  readonly readSizes?: readonly number[];
  readonly size?: number;
  readonly targetPath?: string;
}

export interface Scenario {
  readonly fileSystem: NodeFileSystem;
  readonly rootPath: string;
  readRequests(): readonly ReadRequest[];
  wasClosed(): boolean;
  wasOpened(): boolean;
}

/**
 * Builds a fully deterministic file system double for a single read.
 *
 * Every call the reader makes is recorded so a test can assert not only the
 * resulting error code but also that no forbidden operation happened: that the
 * target was never opened, and how many reads (and of which length) were issued.
 */
export function createScenario(options: ScenarioOptions = {}): Scenario {
  const rootPath = path.resolve('virtual-root');
  const targetPath = options.targetPath ?? path.join(rootPath, 'file.txt');
  const content = encoder.encode('data');
  const realpaths = [rootPath, targetPath, options.postReadCanonicalTarget ?? targetPath];
  const pathMetadata = [...(options.pathMetadata ?? [fileMetadata(), fileMetadata()])];
  const handleMetadata = [
    ...(options.handleMetadata ??
      (options.size === undefined
        ? [fileMetadata(), fileMetadata()]
        : [fileMetadata({ size: options.size }), fileMetadata({ size: options.size })])),
  ];
  const readSizes = [...(options.readSizes ?? [content.byteLength, 0])];
  const readRequests: ReadRequest[] = [];
  let closed = false;
  let opened = false;

  const handle: ReadableFileHandle = {
    close: () => {
      closed = true;
      return Promise.resolve();
    },
    read: (buffer, offset, length) => {
      readRequests.push({ length, offset });
      const bytesRead = readSizes.shift() ?? 0;
      if (bytesRead > 0) {
        buffer.set(content.subarray(0, Math.min(bytesRead, content.byteLength)), offset);
      }
      options.abortAfterRead?.abort();
      return Promise.resolve({ bytesRead });
    },
    stat: () => Promise.resolve(handleMetadata.shift() ?? fileMetadata()),
  };

  const fileSystem: NodeFileSystem = {
    lstat: () => Promise.resolve(pathMetadata.shift() ?? fileMetadata()),
    open: () => {
      opened = true;
      if (options.openError === undefined) {
        return Promise.resolve(handle);
      }
      // Deliberately simulate a dependency that rejects with an arbitrary unknown value.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(options.openError);
    },
    realpath: () => Promise.resolve(realpaths.shift() ?? targetPath),
    stat: () => Promise.resolve(fileMetadata({ directory: true, size: 0 })),
  };

  return {
    fileSystem,
    rootPath,
    readRequests: () => [...readRequests],
    wasClosed: () => closed,
    wasOpened: () => opened,
  };
}

/** Builds regular-file metadata with the defaults shared by the reader scenarios. */
export function fileMetadata(
  overrides: {
    readonly ctimeMs?: number;
    readonly dev?: number;
    readonly directory?: boolean;
    readonly ino?: number;
    readonly mtimeMs?: number;
    readonly size?: number;
    readonly special?: boolean;
    readonly symbolicLink?: boolean;
  } = {},
): FileMetadata {
  const directory = overrides.directory ?? false;
  const symbolicLink = overrides.symbolicLink ?? false;
  const special = overrides.special ?? false;
  return {
    ctimeMs: overrides.ctimeMs ?? 1,
    dev: overrides.dev ?? 1,
    ino: overrides.ino ?? 1,
    mtimeMs: overrides.mtimeMs ?? 1,
    size: overrides.size ?? 4,
    isDirectory: () => directory,
    isFile: () => !directory && !symbolicLink && !special,
    isSymbolicLink: () => symbolicLink,
  };
}

export async function createReader(
  fileSystem: NodeFileSystem,
  rootPath: string,
  pathSemantics: PathSemantics = hostPathSemantics(),
): Promise<NodeAuthorizedFileReader> {
  return NodeAuthorizedFileReader.create(
    [{ rootId: 'repo', absolutePath: rootPath }],
    fileSystem,
    pathSemantics,
  );
}

export async function expectReadError(
  reader: NodeAuthorizedFileReader,
  expectedCode: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await reader.read({
      rootId: 'repo',
      normalizedRelativePath: 'file.txt',
      maximumBytes: 1024,
      ...(signal ? { signal } : {}),
    });
    expect.fail('Expected a ContextVaultError.');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ContextVaultError);
    expect((error as ContextVaultError).code).toBe(expectedCode);
    expect((error as ContextVaultError).message).not.toContain('sensitive');
  }
}

/**
 * Captures the application error code and retryable flag produced by a read.
 *
 * Asserting the code and retry semantics is meaningful: these fields are the
 * contract that clients branch on and that prevent a transient condition from
 * being reported as a permanent authorization failure, or vice versa.
 */
export async function captureReadResolution(
  reader: NodeAuthorizedFileReader,
  normalizedRelativePath = 'file.txt',
): Promise<string> {
  try {
    await reader.read({
      rootId: 'repo',
      normalizedRelativePath,
      maximumBytes: 1024,
    });
    return 'SUCCESS';
  } catch (error: unknown) {
    return error instanceof ContextVaultError ? error.code : 'UNKNOWN_ERROR';
  }
}

/** Captures the safe error produced by a read so its content-free details can be asserted. */
export async function captureReadError(
  reader: NodeAuthorizedFileReader,
  normalizedRelativePath = 'file.txt',
  maximumBytes = 1024,
): Promise<ContextVaultError> {
  try {
    await reader.read({
      rootId: 'repo',
      normalizedRelativePath,
      maximumBytes,
    });
    throw new Error('Expected the read to fail.');
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      return error;
    }
    throw error;
  }
}

export async function captureRetryable(
  reader: NodeAuthorizedFileReader,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await reader.read({
      rootId: 'repo',
      normalizedRelativePath: 'file.txt',
      maximumBytes: 1024,
      ...(signal ? { signal } : {}),
    });
    throw new Error('Expected the read to fail.');
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      return error.retryable;
    }
    throw error;
  }
}

export async function captureDeniedRetryable(reader: NodeAuthorizedFileReader): Promise<boolean> {
  try {
    await reader.read({
      rootId: 'other',
      normalizedRelativePath: 'file.txt',
      maximumBytes: 1024,
    });
    throw new Error('Expected the read to fail.');
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      return error.retryable;
    }
    throw error;
  }
}

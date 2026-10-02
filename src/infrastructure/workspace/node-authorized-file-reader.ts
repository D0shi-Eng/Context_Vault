import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';

import type {
  AuthorizedFile,
  AuthorizedFileReader,
  AuthorizedFileReadRequest,
} from '../../application/ports/authorized-file-reader.js';
import { ContextVaultError, isContextVaultError } from '../../domain/errors/context-vault-error.js';
import {
  assertValidRootId,
  normalizeRelativePath,
} from '../../domain/workspace/workspace-path-policy.js';
import type { WorkspaceRootDefinition } from '../configuration/startup-arguments.js';
import {
  canonicalPathKey,
  hostPathSemantics,
  type PathModule,
  type PathSemantics,
} from './path-platform-semantics.js';

interface CanonicalWorkspaceRoot {
  readonly rootId: string;
  readonly canonicalPath: string;
}

export interface FileMetadata {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ReadableFileHandle {
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ readonly bytesRead: number }>;
  stat(): Promise<FileMetadata>;
}

export interface NodeFileSystem {
  lstat(targetPath: string): Promise<FileMetadata>;
  open(targetPath: string, flags: number): Promise<ReadableFileHandle>;
  realpath(targetPath: string): Promise<string>;
  stat(targetPath: string): Promise<FileMetadata>;
}

const SYSTEM_FILE_SYSTEM: NodeFileSystem = {
  lstat,
  open,
  realpath,
  stat,
};

export class NodeAuthorizedFileReader implements AuthorizedFileReader {
  readonly #fileSystem: NodeFileSystem;
  readonly #pathSemantics: PathSemantics;
  readonly #roots: ReadonlyMap<string, CanonicalWorkspaceRoot>;

  private constructor(
    roots: ReadonlyMap<string, CanonicalWorkspaceRoot>,
    fileSystem: NodeFileSystem,
    pathSemantics: PathSemantics,
  ) {
    this.#fileSystem = fileSystem;
    this.#pathSemantics = pathSemantics;
    this.#roots = roots;
  }

  get authorizedRootCount(): number {
    return this.#roots.size;
  }

  static async create(
    definitions: readonly WorkspaceRootDefinition[],
    fileSystem: NodeFileSystem = SYSTEM_FILE_SYSTEM,
    pathSemantics: PathSemantics = hostPathSemantics(),
  ): Promise<NodeAuthorizedFileReader> {
    const { path, platform } = pathSemantics;
    const roots = new Map<string, CanonicalWorkspaceRoot>();
    const canonicalPaths = new Set<string>();

    for (const definition of definitions) {
      assertValidRootId(definition.rootId);
      if (!path.isAbsolute(definition.absolutePath)) {
        throw configurationError();
      }
      let canonicalPath: string;
      let metadata: FileMetadata;
      try {
        canonicalPath = await fileSystem.realpath(definition.absolutePath);
        metadata = await fileSystem.stat(canonicalPath);
      } catch {
        throw configurationError();
      }
      if (
        !metadata.isDirectory() ||
        canonicalPathKey(canonicalPath, platform) ===
          canonicalPathKey(path.parse(canonicalPath).root, platform)
      ) {
        throw configurationError();
      }

      const canonicalKey = canonicalPathKey(canonicalPath, platform);
      if (roots.has(definition.rootId) || canonicalPaths.has(canonicalKey)) {
        throw configurationError();
      }

      canonicalPaths.add(canonicalKey);
      roots.set(definition.rootId, Object.freeze({ rootId: definition.rootId, canonicalPath }));
    }

    return new NodeAuthorizedFileReader(roots, fileSystem, pathSemantics);
  }

  async read(request: AuthorizedFileReadRequest): Promise<AuthorizedFile> {
    const { path, platform } = this.#pathSemantics;
    const root = this.#roots.get(request.rootId);
    if (!root) {
      throw new ContextVaultError({
        code: 'CV_AUTHORIZATION_DENIED',
        message: 'The requested source is not authorized.',
      });
    }

    const normalizedRelativePath = normalizeRelativePath(request.normalizedRelativePath);
    const segments = normalizedRelativePath.split('/') as [string, ...string[]];
    const candidatePath = path.join(root.canonicalPath, ...segments);

    try {
      assertNotCancelled(request.signal);
      const pathMetadata = await inspectPathComponents(
        this.#fileSystem,
        path,
        root.canonicalPath,
        segments,
      );
      const canonicalTarget = await this.#fileSystem.realpath(candidatePath);
      assertContained(path, root.canonicalPath, canonicalTarget);

      if (!pathMetadata.isFile()) {
        throw specialFileError();
      }

      const handle = await this.#fileSystem.open(canonicalTarget, readOnlyNoFollowFlags());
      try {
        const beforeRead = await handle.stat();
        assertSameIdentity(pathMetadata, beforeRead);
        if (!beforeRead.isFile()) {
          throw specialFileError();
        }
        if (beforeRead.size > request.maximumBytes) {
          throw sourceTooLargeError(request.maximumBytes);
        }

        const bytes = await readStableFile(handle, beforeRead.size, request.signal);
        const afterRead = await handle.stat();
        assertStableMetadata(beforeRead, afterRead);
        const canonicalTargetAfterRead = await this.#fileSystem.realpath(candidatePath);
        assertContained(path, root.canonicalPath, canonicalTargetAfterRead);
        if (
          canonicalPathKey(canonicalTargetAfterRead, platform) !==
          canonicalPathKey(canonicalTarget, platform)
        ) {
          throw sourceChangedError();
        }
        await inspectPathComponents(this.#fileSystem, path, root.canonicalPath, segments);

        return Object.freeze({ bytes, normalizedRelativePath });
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      throw mapReadError(error);
    }
  }
}

async function inspectPathComponents(
  fileSystem: NodeFileSystem,
  path: PathModule,
  canonicalRoot: string,
  segments: readonly [string, ...string[]],
): Promise<FileMetadata> {
  const [firstSegment, ...remainingSegments] = segments;
  let currentPath = path.join(canonicalRoot, firstSegment);
  let currentMetadata = await fileSystem.lstat(currentPath);
  assertSafePathComponent(currentMetadata, remainingSegments.length === 0);

  for (const [index, segment] of remainingSegments.entries()) {
    currentPath = path.join(currentPath, segment);
    currentMetadata = await fileSystem.lstat(currentPath);
    assertSafePathComponent(currentMetadata, index === remainingSegments.length - 1);
  }

  return currentMetadata;
}

function assertSafePathComponent(metadata: FileMetadata, isFinal: boolean): void {
  if (metadata.isSymbolicLink()) {
    throw new ContextVaultError({
      code: 'CV_PATH_REPARSE_POINT_DENIED',
      message: 'Linked source paths are not allowed.',
    });
  }
  if (!isFinal && !metadata.isDirectory()) {
    throw specialFileError();
  }
}

async function readStableFile(
  handle: ReadableFileHandle,
  expectedSize: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;

  while (offset < expectedSize) {
    assertNotCancelled(signal);
    const result = await handle.read(bytes, offset, expectedSize - offset, null);
    if (result.bytesRead === 0) {
      throw sourceChangedError();
    }
    offset += result.bytesRead;
  }

  const probe = Buffer.allocUnsafe(1);
  const trailingRead = await handle.read(probe, 0, 1, null);
  if (trailingRead.bytesRead !== 0) {
    throw sourceChangedError();
  }

  assertNotCancelled(signal);
  return bytes;
}

function assertContained(path: PathModule, canonicalRoot: string, canonicalTarget: string): void {
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ContextVaultError({
      code: 'CV_PATH_OUTSIDE_WORKSPACE',
      message: 'The requested source is not authorized.',
    });
  }
}

function assertSameIdentity(pathMetadata: FileMetadata, handleMetadata: FileMetadata): void {
  if (pathMetadata.dev !== handleMetadata.dev || pathMetadata.ino !== handleMetadata.ino) {
    throw sourceChangedError();
  }
}

function assertStableMetadata(beforeRead: FileMetadata, afterRead: FileMetadata): void {
  if (
    beforeRead.dev !== afterRead.dev ||
    beforeRead.ino !== afterRead.ino ||
    beforeRead.size !== afterRead.size ||
    beforeRead.mtimeMs !== afterRead.mtimeMs ||
    beforeRead.ctimeMs !== afterRead.ctimeMs
  ) {
    throw sourceChangedError();
  }
}

function readOnlyNoFollowFlags(): number {
  return constants.O_RDONLY | constants.O_NOFOLLOW;
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

function sourceTooLargeError(maximumBytes: number): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_RESOURCE_SOURCE_TOO_LARGE',
    message: 'The source exceeds the configured byte limit.',
    safeDetails: { maximumBytes },
  });
}

function sourceChangedError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_SOURCE_CHANGED',
    message: 'The source changed during inspection.',
    retryable: true,
  });
}

function specialFileError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_PATH_SPECIAL_FILE_DENIED',
    message: 'The requested source type is not allowed.',
  });
}

function configurationError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_CONFIGURATION_INVALID',
    message: 'An authorized workspace root is invalid.',
  });
}

function mapReadError(error: unknown): ContextVaultError {
  if (isContextVaultError(error)) {
    return error;
  }

  const code = getNodeErrorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new ContextVaultError({
      code: 'CV_SOURCE_NOT_FOUND',
      message: 'The requested source was not found.',
    });
  }
  if (code === 'ELOOP') {
    return new ContextVaultError({
      code: 'CV_PATH_REPARSE_POINT_DENIED',
      message: 'Linked source paths are not allowed.',
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new ContextVaultError({
      code: 'CV_AUTHORIZATION_DENIED',
      message: 'The requested source is not authorized.',
    });
  }
  if (code === 'EISDIR') {
    return specialFileError();
  }

  return new ContextVaultError({
    code: 'CV_INTERNAL_ERROR',
    message: 'The source could not be inspected safely.',
  });
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

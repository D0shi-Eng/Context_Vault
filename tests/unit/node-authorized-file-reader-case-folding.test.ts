import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  type NodeFileSystem,
  NodeAuthorizedFileReader,
  type ReadableFileHandle,
} from '../../src/infrastructure/workspace/node-authorized-file-reader.js';
import {
  canonicalPathKey,
  hostPathSemantics,
  POSIX_PATH_SEMANTICS,
  WIN32_PATH_SEMANTICS,
  type PathSemantics,
} from '../../src/infrastructure/workspace/path-platform-semantics.js';
import { captureReadResolution, fileMetadata } from './node-authorized-file-reader-scenario.js';

interface CaseScenarioOptions {
  readonly fileName?: string;
  readonly initialTarget?: string;
  readonly postReadTarget?: string;
  readonly rootPath: string;
  readonly secondRoot?: string;
}

interface CaseScenario {
  readonly fileSystem: NodeFileSystem;
  readonly primaryRoot: string;
  wasOpened(): boolean;
}

/**
 * Builds a deterministic file system for canonical-identity scenarios.
 *
 * realpath answers from a queue per requested path: workspace roots
 * canonicalize to themselves, the candidate resolves to `initialTarget` on the
 * pre-read resolution and to `postReadTarget` on the post-read re-resolution,
 * and every unmapped path resolves to itself. Only the reader's own path
 * semantics decide the outcome.
 */
function createCaseScenario(semantics: PathSemantics, options: CaseScenarioOptions): CaseScenario {
  const primaryRoot = options.rootPath;
  const candidatePath = semantics.path.join(primaryRoot, options.fileName ?? 'file.txt');
  const initialTarget = options.initialTarget ?? candidatePath;
  const postReadTarget = options.postReadTarget ?? initialTarget;
  const realpathQueue = new Map<string, string[]>([
    [candidatePath, [initialTarget, postReadTarget]],
  ]);
  const content = new TextEncoder().encode('data');
  const readSizes = [content.byteLength, 0];
  let opened = false;

  const handle: ReadableFileHandle = {
    close: () => Promise.resolve(),
    read: (buffer, offset) => {
      const bytesRead = readSizes.shift() ?? 0;
      if (bytesRead > 0) {
        buffer.set(content, offset);
      }
      return Promise.resolve({ bytesRead });
    },
    stat: () => Promise.resolve(fileMetadata()),
  };

  const fileSystem: NodeFileSystem = {
    lstat: () => Promise.resolve(fileMetadata()),
    open: () => {
      opened = true;
      return Promise.resolve(handle);
    },
    realpath: (targetPath: string) => {
      const responses = realpathQueue.get(targetPath);
      const resolved = responses === undefined ? targetPath : (responses.shift() ?? targetPath);
      return Promise.resolve(resolved);
    },
    stat: () => Promise.resolve(fileMetadata({ directory: true, size: 0 })),
  };

  return {
    fileSystem,
    primaryRoot,
    wasOpened: () => opened,
  };
}

async function createSingleRootReader(
  scenario: CaseScenario,
  semantics: PathSemantics,
): Promise<NodeAuthorizedFileReader> {
  return NodeAuthorizedFileReader.create(
    [{ rootId: 'repo', absolutePath: scenario.primaryRoot }],
    scenario.fileSystem,
    semantics,
  );
}

async function captureCreateError(
  creation: Promise<NodeAuthorizedFileReader>,
): Promise<ContextVaultError> {
  try {
    await creation;
    throw new Error('Expected the creation to fail.');
  } catch (error: unknown) {
    if (error instanceof ContextVaultError) {
      return error;
    }
    throw error;
  }
}

/**
 * Canonical path identity is exercised per path dialect instead of faking
 * `process.platform`: a platform override cannot turn `node:path` or realpath
 * into Windows implementations, so Windows behavior is tested through
 * `path.win32` semantics and Linux behavior through `path.posix` semantics,
 * deterministically on every host. The real host file system keeps its own
 * integration coverage in tests/integration/node-authorized-file-reader.test.ts.
 */
describe('NodeAuthorizedFileReader canonical path case folding', () => {
  describe('win32 dialect', () => {
    it('rejects two authorized roots that differ only by letter case', async () => {
      const scenario = createCaseScenario(WIN32_PATH_SEMANTICS, { rootPath: 'C:\\workspace' });

      const error = await captureCreateError(
        NodeAuthorizedFileReader.create(
          [
            { rootId: 'repo', absolutePath: scenario.primaryRoot },
            { rootId: 'twin', absolutePath: 'C:\\WORKSPACE' },
          ],
          scenario.fileSystem,
          WIN32_PATH_SEMANTICS,
        ),
      );

      expect(error.code).toBe('CV_CONFIGURATION_INVALID');
    });

    it('treats a post-read resolution that differs only by letter case as unchanged', async () => {
      const scenario = createCaseScenario(WIN32_PATH_SEMANTICS, {
        postReadTarget: 'C:\\WORKSPACE\\FILE.TXT',
        rootPath: 'C:\\workspace',
      });
      const reader = await createSingleRootReader(scenario, WIN32_PATH_SEMANTICS);

      const resolution = await captureReadResolution(reader);

      expect(resolution).toBe('SUCCESS');
    });

    it('denies a candidate whose canonical resolution escapes the root', async () => {
      const scenario = createCaseScenario(WIN32_PATH_SEMANTICS, {
        initialTarget: 'C:\\other\\file.txt',
        rootPath: 'C:\\workspace',
      });
      const reader = await createSingleRootReader(scenario, WIN32_PATH_SEMANTICS);

      const resolution = await captureReadResolution(reader);

      expect(resolution).toBe('CV_PATH_OUTSIDE_WORKSPACE');
      expect(scenario.wasOpened()).toBe(false);
    });

    it('denies a post-read resolution that escapes the root', async () => {
      const scenario = createCaseScenario(WIN32_PATH_SEMANTICS, {
        postReadTarget: 'C:\\other\\FILE.TXT',
        rootPath: 'C:\\workspace',
      });
      const reader = await createSingleRootReader(scenario, WIN32_PATH_SEMANTICS);

      const resolution = await captureReadResolution(reader);

      expect(resolution).toBe('CV_PATH_OUTSIDE_WORKSPACE');
    });

    it('does not merge distinct Unicode names when folding case', async () => {
      // Lower-casing keeps 'straße' and 'STRASSE' distinct; a fold that merged
      // them would treat two different files as one identity.
      const scenario = createCaseScenario(WIN32_PATH_SEMANTICS, {
        fileName: 'straße.txt',
        postReadTarget: 'C:\\workspace\\STRASSE.TXT',
        rootPath: 'C:\\workspace',
      });
      const reader = await createSingleRootReader(scenario, WIN32_PATH_SEMANTICS);

      const resolution = await captureReadResolution(reader, 'straße.txt');

      expect(resolution).toBe('CV_SOURCE_CHANGED');
    });
  });

  describe('posix dialect', () => {
    it('keeps two roots that differ only by letter case as distinct identities', async () => {
      const scenario = createCaseScenario(POSIX_PATH_SEMANTICS, { rootPath: '/workspace' });

      const reader = await NodeAuthorizedFileReader.create(
        [
          { rootId: 'repo', absolutePath: scenario.primaryRoot },
          { rootId: 'twin', absolutePath: '/WORKSPACE' },
        ],
        scenario.fileSystem,
        POSIX_PATH_SEMANTICS,
      );

      expect(reader.authorizedRootCount).toBe(2);
    });

    it('treats a post-read resolution that differs only by letter case as a change', async () => {
      const scenario = createCaseScenario(POSIX_PATH_SEMANTICS, {
        postReadTarget: '/workspace/FILE.TXT',
        rootPath: '/workspace',
      });
      const reader = await createSingleRootReader(scenario, POSIX_PATH_SEMANTICS);

      const resolution = await captureReadResolution(reader);

      expect(resolution).toBe('CV_SOURCE_CHANGED');
    });

    it('denies a candidate whose canonical resolution escapes the root', async () => {
      const scenario = createCaseScenario(POSIX_PATH_SEMANTICS, {
        initialTarget: '/other/file.txt',
        rootPath: '/workspace',
      });
      const reader = await createSingleRootReader(scenario, POSIX_PATH_SEMANTICS);

      const resolution = await captureReadResolution(reader);

      expect(resolution).toBe('CV_PATH_OUTSIDE_WORKSPACE');
      expect(scenario.wasOpened()).toBe(false);
    });
  });

  describe('canonical key rule', () => {
    it('folds letter case only for win32 identity keys', () => {
      expect(canonicalPathKey('C:\\Workspace\\A', 'win32')).toBe('c:\\workspace\\a');
      expect(canonicalPathKey('/Workspace/A', 'posix')).toBe('/Workspace/A');
    });

    it('keeps distinct Unicode names distinct under the win32 fold', () => {
      expect(canonicalPathKey('straße', 'win32')).not.toBe(canonicalPathKey('STRASSE', 'win32'));
    });

    it('wires the host dialect by default', () => {
      const hostDialect = process.platform === 'win32' ? 'win32' : 'posix';

      expect(hostPathSemantics().platform).toBe(hostDialect);
    });
  });
});

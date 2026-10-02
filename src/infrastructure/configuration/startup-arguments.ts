import path from 'node:path';

import { ContextVaultError } from '../../domain/errors/context-vault-error.js';
import { isValidRootId } from '../../domain/workspace/workspace-path-policy.js';

const WORKSPACE_ROOT_PREFIX = '--workspace-root=';

export interface WorkspaceRootDefinition {
  readonly rootId: string;
  readonly absolutePath: string;
}

export interface StartupArguments {
  readonly workspaceRoots: readonly WorkspaceRootDefinition[];
}

export function parseStartupArguments(arguments_: readonly string[]): StartupArguments {
  const roots: WorkspaceRootDefinition[] = [];
  const rootIds = new Set<string>();

  for (const argument of arguments_) {
    if (!argument.startsWith(WORKSPACE_ROOT_PREFIX)) {
      throw configurationError();
    }

    const declaration = argument.slice(WORKSPACE_ROOT_PREFIX.length);
    const separatorIndex = declaration.indexOf('=');

    const rootId = declaration.slice(0, separatorIndex);
    const absolutePath = declaration.slice(separatorIndex + 1);
    if (!isValidRootId(rootId) || !path.isAbsolute(absolutePath) || rootIds.has(rootId)) {
      throw configurationError();
    }

    rootIds.add(rootId);
    roots.push(Object.freeze({ rootId, absolutePath }));
  }

  return Object.freeze({ workspaceRoots: Object.freeze(roots) });
}

function configurationError(): ContextVaultError {
  return new ContextVaultError({
    code: 'CV_CONFIGURATION_INVALID',
    message: 'The startup configuration is invalid.',
  });
}

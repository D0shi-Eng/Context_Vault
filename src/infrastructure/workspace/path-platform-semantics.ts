import pathPosix from 'node:path/posix';
import pathWin32 from 'node:path/win32';

/**
 * The two path dialects the workspace reader must reason about.
 *
 * 'win32' stands for Windows volume semantics, where canonical paths that
 * differ only by letter case are one identity. 'posix' stands for
 * case-sensitive semantics.
 */
export type PathPlatform = 'win32' | 'posix';

/** The subset of `node:path` the workspace reader relies on. */
export interface PathModule {
  isAbsolute(candidatePath: string): boolean;
  join(...segments: string[]): string;
  parse(candidatePath: string): { readonly root: string };
  relative(from: string, to: string): string;
  readonly sep: string;
}

/** Path operations paired with the canonical identity rule of one dialect. */
export interface PathSemantics {
  readonly path: PathModule;
  readonly platform: PathPlatform;
}

export const POSIX_PATH_SEMANTICS: PathSemantics = {
  path: pathPosix,
  platform: 'posix',
};

export const WIN32_PATH_SEMANTICS: PathSemantics = {
  path: pathWin32,
  platform: 'win32',
};

/**
 * Returns the dialect of the running host, so the default wiring keeps the
 * exact behavior of the host `node:path` module and host file system.
 */
export function hostPathSemantics(): PathSemantics {
  return process.platform === 'win32' ? WIN32_PATH_SEMANTICS : POSIX_PATH_SEMANTICS;
}

/**
 * Computes the identity key used to compare canonical paths.
 *
 * Windows volumes are case-insensitive, so canonical paths that differ only
 * by letter case must fold to one key under 'win32'. Plain lower-casing is
 * deliberate: a fold that merges distinct names, such as upper-casing, would
 * treat 'straße' and 'STRASSE' as one path.
 */
export function canonicalPathKey(canonicalPath: string, platform: PathPlatform): string {
  return platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

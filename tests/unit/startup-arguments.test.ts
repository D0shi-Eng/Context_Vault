import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import { parseStartupArguments } from '../../src/infrastructure/configuration/startup-arguments.js';

describe('startup arguments', () => {
  it('accepts zero roots as deny-by-default configuration', () => {
    const result = parseStartupArguments([]);

    expect(result.workspaceRoots).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.workspaceRoots)).toBe(true);
  });

  it('parses repeated absolute workspace roots and preserves equals signs in paths', () => {
    const first = path.resolve('workspace-one');
    const second = path.resolve('workspace=two');

    expect(
      parseStartupArguments([
        `--workspace-root=primary=${first}`,
        `--workspace-root=secondary=${second}`,
      ]).workspaceRoots,
    ).toEqual([
      { rootId: 'primary', absolutePath: first },
      { rootId: 'secondary', absolutePath: second },
    ]);
  });

  it.each([
    ['--unknown=value'],
    ['--workspace-root='],
    ['--workspace-root=missing-path='],
    ['--workspace-root=Invalid=/absolute'],
    ['--workspace-root=repo=relative/path'],
  ])('rejects invalid declaration %s', (argument) => {
    expectErrorCode(() => parseStartupArguments([argument]), 'CV_CONFIGURATION_INVALID');
  });

  it('rejects duplicate root identifiers', () => {
    const absolutePath = path.resolve('workspace');
    expectErrorCode(
      () =>
        parseStartupArguments([
          `--workspace-root=repo=${absolutePath}`,
          `--workspace-root=repo=${absolutePath}`,
        ]),
      'CV_CONFIGURATION_INVALID',
    );
  });

  it('rejects a declaration that has no equals sign after the prefix', () => {
    expectErrorCode(
      () => parseStartupArguments(['--workspace-root=payload']),
      'CV_CONFIGURATION_INVALID',
    );
  });

  it('rejects an empty absolute path after a valid root identifier', () => {
    expectErrorCode(
      () => parseStartupArguments(['--workspace-root=repo=']),
      'CV_CONFIGURATION_INVALID',
    );
  });

  it('treats the first equals sign as the identifier separator', () => {
    const absolutePath = path.resolve('with=equals');
    const result = parseStartupArguments([`--workspace-root=primary=${absolutePath}`]);

    expect(result.workspaceRoots).toEqual([{ rootId: 'primary', absolutePath }]);
  });

  it('rejects a declaration whose separator is the first character', () => {
    expectErrorCode(
      () => parseStartupArguments(['--workspace-root==payload']),
      'CV_CONFIGURATION_INVALID',
    );
  });

  it('rejects a declaration that repeats a prefix but omits the identifier', () => {
    expectErrorCode(
      () => parseStartupArguments(['--workspace-root==/absolute']),
      'CV_CONFIGURATION_INVALID',
    );
  });

  it('rejects any argument that is not a workspace-root declaration', () => {
    expectErrorCode(() => parseStartupArguments(['--verbose']), 'CV_CONFIGURATION_INVALID');
    expectErrorCode(
      () => parseStartupArguments(['workspace-root=repo=absolute']),
      'CV_CONFIGURATION_INVALID',
    );
  });

  it('freezes every parsed root definition', () => {
    const result = parseStartupArguments([`--workspace-root=repo=${path.resolve('workspace')}`]);

    expect(Object.isFrozen(result.workspaceRoots[0])).toBe(true);
  });

  it('rejects a non-declaration argument even when its tail would parse as a valid root', () => {
    // The prefix guard must reject on its own. Without it, an argument whose
    // characters after the prefix length happen to form a valid declaration
    // would be silently accepted as configuration.
    const forged = `${'A'.repeat('--workspace-root='.length)}repo=${path.resolve('workspace')}`;

    expectErrorCode(() => parseStartupArguments([forged]), 'CV_CONFIGURATION_INVALID');
  });

  it('accepts a single-character root identifier whose separator is the second character', () => {
    // A one-character identifier yields a separator index of exactly one, which
    // is the smallest valid value. This separates the `>= 1` boundary from a
    // stricter `>= 2` reading.
    const absolutePath = path.resolve('workspace');
    const result = parseStartupArguments([`--workspace-root=a=${absolutePath}`]);

    expect(result.workspaceRoots).toEqual([{ rootId: 'a', absolutePath }]);
  });

  it('rejects an invalid root identifier even when the path is otherwise valid', () => {
    expectErrorCode(
      () => parseStartupArguments([`--workspace-root=Invalid=${path.resolve('workspace')}`]),
      'CV_CONFIGURATION_INVALID',
    );
  });

  it('rejects a relative path even when the root identifier is valid', () => {
    expectErrorCode(
      () => parseStartupArguments([`--workspace-root=repo=${path.join('relative', 'path')}`]),
      'CV_CONFIGURATION_INVALID',
    );
  });

  it('rejects a duplicate root identifier even when every path is valid', () => {
    const absolutePath = path.resolve('workspace');

    expectErrorCode(
      () =>
        parseStartupArguments([
          `--workspace-root=repo=${absolutePath}`,
          `--workspace-root=repo=${absolutePath}`,
        ]),
      'CV_CONFIGURATION_INVALID',
    );
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

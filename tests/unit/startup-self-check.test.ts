import { describe, expect, it } from 'vitest';

import { runStartupSelfCheck } from '../../src/application/startup/run-startup-self-check.js';

describe('runStartupSelfCheck', () => {
  it('returns a frozen local-only startup report', () => {
    const report = runStartupSelfCheck('24.19.0');

    expect(report).toEqual({
      serverName: 'contextvault',
      serverVersion: '0.0.0',
      nodeMajor: 24,
      transport: 'stdio',
      networkListeners: 0,
    });
    expect(Object.isFrozen(report)).toBe(true);
  });

  it.each(['invalid', '23.11.0'])('fails closed for unsupported runtime %j', (version) => {
    expect(() => runStartupSelfCheck(version)).toThrow('Unsupported Node.js runtime.');
  });
});

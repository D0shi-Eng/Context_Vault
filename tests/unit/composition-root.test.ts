import { describe, expect, it } from 'vitest';

import { composeApplication } from '../../src/infrastructure/composition-root.js';

describe('composeApplication', () => {
  it('constructs the server only after the startup self-check passes', async () => {
    const application = await composeApplication('24.19.0');

    expect(application.server).toBeDefined();
    expect(application.startupReport.networkListeners).toBe(0);
    expect(application.workspaceRootCount).toBe(0);
    expect(Object.isFrozen(application)).toBe(true);
  });

  it('does not construct an application for an unsupported runtime', async () => {
    await expect(composeApplication('23.0.0')).rejects.toThrow('Unsupported Node.js runtime.');
  });
});

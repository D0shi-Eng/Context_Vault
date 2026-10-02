import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SERVER_INSTRUCTIONS } from '../../src/adapters/inbound/mcp/create-mcp-server.js';
import { SERVER_IDENTITY } from '../../src/domain/server-identity.js';
import { composeApplication } from '../../src/infrastructure/composition-root.js';

describe('MCP initialization', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
  });

  it('negotiates over an in-memory transport and advertises only the accepted tool', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const application = await composeApplication('24.19.0');
    const server = application.server;
    const client = new Client({ name: 'contextvault-test-client', version: '0.0.0' });
    closeCallbacks.push(
      async () => client.close(),
      async () => server.close(),
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toEqual(SERVER_IDENTITY);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    const capabilities = client.getServerCapabilities();
    expect(capabilities).toBeDefined();
    expect(capabilities?.tools).toBeDefined();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'contextvault_inspect',
      'contextvault_prepare',
      'contextvault_retrieve',
      'contextvault_verify',
      'contextvault_stats',
      'contextvault_purge',
    ]);
  });
});

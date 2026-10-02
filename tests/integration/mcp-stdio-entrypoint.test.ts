import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SERVER_INSTRUCTIONS } from '../../src/adapters/inbound/mcp/create-mcp-server.js';
import { SERVER_IDENTITY } from '../../src/domain/server-identity.js';

describe('MCP stdio entrypoint', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];
  const temporaryPaths: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
    await Promise.all(
      temporaryPaths
        .splice(0)
        .map(async (temporaryPath) => rm(temporaryPath, { force: true, recursive: true })),
    );
  });

  it('initializes, lists exactly the implemented tools, and inspects through the production stdio entrypoint', async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), 'contextvault-stdio-'));
    temporaryPaths.push(workspacePath);
    await writeFile(path.join(workspacePath, 'guide.md'), '# Safe guide\n');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/main.js'), `--workspace-root=repo=${workspacePath}`],
      cwd: path.resolve('.'),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'contextvault-stdio-test-client', version: '0.0.0' });
    closeCallbacks.push(async () => client.close());

    await client.connect(transport);

    expect(client.getServerVersion()).toEqual(SERVER_IDENTITY);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    // The runtime instructions string is a public surface: it must stay
    // non-empty, phase-terminology-free, and honest about the boundary.
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/phase/i);
    expect(SERVER_INSTRUCTIONS).toContain('raw-content-free');
    expect(SERVER_INSTRUCTIONS).toContain('content-revealing by design');
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'contextvault_inspect',
      'contextvault_prepare',
      'contextvault_retrieve',
      'contextvault_verify',
      'contextvault_stats',
      'contextvault_purge',
    ]);

    const result = await client.callTool({
      name: 'contextvault_inspect',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'guide.md' },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: '1.0',
      ok: true,
      source: { mediaType: 'text/markdown', secretRisk: 'none' },
    });
    expect(JSON.stringify(result)).not.toContain('# Safe guide');
    expect(JSON.stringify(result)).not.toContain(workspacePath);
  });
});

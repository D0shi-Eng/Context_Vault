import { describe, expect, it } from 'vitest';

// This file intentionally avoids static imports of MCP adapter modules.
// Dynamic imports keep each discriminated-union boundary independently
// observable. If a schema variant loses its discriminator, zod rejects the
// module at load time and this focused test fails explicitly.

describe('mcp discriminated-union boundaries', () => {
  it('keeps the retrieval chunk variant loadable and exact', async (): Promise<void> => {
    const schemas = await import('../../src/adapters/inbound/mcp/common-schemas.js');
    const chunkId = `cv_chunk_${'c'.repeat(8)}`;
    const parsed = schemas.retrievalSelectorSchema.safeParse({ kind: 'chunk', chunkId });
    expect(parsed.success).toBe(true);
  });

  it('keeps the retrieval json_node variant loadable and exact', async (): Promise<void> => {
    const schemas = await import('../../src/adapters/inbound/mcp/common-schemas.js');
    const nodeId = `cv_node_${'n'.repeat(6)}`;
    const parsed = schemas.retrievalSelectorSchema.safeParse({ kind: 'json_node', nodeId });
    expect(parsed.success).toBe(true);
  });

  it('keeps the retrieval line_range variant loadable and exact', async (): Promise<void> => {
    const schemas = await import('../../src/adapters/inbound/mcp/common-schemas.js');
    const parsed = schemas.retrievalSelectorSchema.safeParse({
      kind: 'line_range',
      startLine: 1,
      endLine: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it('keeps the retrieval discriminator pinned to kind', async (): Promise<void> => {
    const schemas = await import('../../src/adapters/inbound/mcp/common-schemas.js');
    const chunkId = `cv_chunk_${'c'.repeat(8)}`;
    expect(schemas.retrievalSelectorSchema.safeParse({ kind: 'chunk', chunkId }).success).toBe(
      true,
    );
    expect(schemas.retrievalSelectorSchema.safeParse({ kind: '', chunkId }).success).toBe(false);
  });

  it('keeps the verify check union loadable', async (): Promise<void> => {
    const mod = await import('../../src/adapters/inbound/mcp/verify-tool.js');
    expect(typeof mod.registerVerifyTool).toBe('function');
  });
});

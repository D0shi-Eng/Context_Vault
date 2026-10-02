import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import type { McpServerDependencies } from '../../src/adapters/inbound/mcp/create-mcp-server.js';
import { createMcpServer } from '../../src/adapters/inbound/mcp/create-mcp-server.js';
import type { CorrelationIdFactory } from '../../src/application/ports/inspection-services.js';
import type { RequestCounters } from '../../src/domain/stats/stats-policy.js';
import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';

describe('MCP safe error mapping', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map(async (close) => close()));
  });

  it('returns allowlisted safe details for a known application error', async () => {
    const client = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_RESOURCE_SOURCE_TOO_LARGE',
        message: 'The source exceeds the configured byte limit.',
        safeDetails: { maximumBytes: 32 },
      }),
    );

    const result = await callInspect(client);
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(error.code).toBe('CV_RESOURCE_SOURCE_TOO_LARGE');
    expect(error.safeDetails).toEqual({ maximumBytes: 32 });
  });

  it('maps an unexpected exception without leaking its message', async () => {
    const sensitiveValue = 'unexpected-sensitive-value';
    const client = await connectWithFailure(new Error(sensitiveValue));

    const result = await callInspect(client);
    const serialized = JSON.stringify(result);
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error.retryable).toBe(false);
    expect(serialized).not.toContain(sensitiveValue);
  });

  it('fails closed for an application error whose fields turn hostile at runtime', async () => {
    const syntheticSecret = 'synthetic-secret-value-7f4a';
    const syntheticPath = 'C:\\synthetic\\absolute\\path\\leak.txt';
    const stackMarker = 'synthetic-hostile-stack-marker (C:\\synthetic\\marker.ts:1:1)';
    const hostile = new ContextVaultError({
      code: 'CV_RESOURCE_SOURCE_TOO_LARGE',
      message: 'The source exceeds the configured byte limit.',
      safeDetails: { maximumBytes: 32 },
    });
    // Runtime mutation stands in for a corrupted or maliciously crafted
    // application error: a schema-invalid code, an oversize message, an
    // unsafe detail map, and a stack that must never reach the client.
    (hostile as { code: string }).code = 'cv_leaked_internal_state';
    Object.assign(hostile, {
      message: `${syntheticSecret} ${'x'.repeat(600)}`,
      stack: `Error\n    at ${stackMarker}`,
      safeDetails: { leak: syntheticPath, nested: { secret: syntheticSecret } },
    });

    const client = await connectWithFailure(hostile);
    const result = await callInspect(client);
    const serialized = JSON.stringify(result);
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(structured.schemaVersion).toBe('1.0');
    expect(structured.ok).toBe(false);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error.retryable).toBe(false);
    expect(error.correlationId).toMatch(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u);
    expect(error).not.toHaveProperty('safeDetails');
    expect(serialized).not.toContain(syntheticSecret);
    expect(serialized).not.toContain(syntheticPath);
    expect(serialized).not.toContain('synthetic-hostile-stack-marker');
    expect(serialized).not.toContain('cv_leaked_internal_state');
  });

  it('drops safe details with a non-allowlisted value and keeps the typed code', async () => {
    const client = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_PATH_OUTSIDE_WORKSPACE',
        message: 'The requested path is outside the workspace.',
        safeDetails: { nested: { secret: 'value' } } as unknown as Record<string, string>,
      }),
    );

    const result = await callInspect(client);
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error.correlationId).toMatch(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u);
    expect(error).not.toHaveProperty('safeDetails');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a plain string', 'plain failure'],
    ['a symbol', Symbol('thrown-symbol')],
    ['a plain object', { unexpected: 'shape' }],
    ['an array', [1, 2, 3]],
  ])('returns a stable internal-error envelope when a handler throws %s', async (_name, thrown) => {
    const client = await connectWithFailure(thrown as unknown as Error);

    const result = await callInspect(client);
    const serialized = JSON.stringify(result);
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(structured.schemaVersion).toBe('1.0');
    expect(structured.ok).toBe(false);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error.message).toBe('The requested operation could not be completed safely.');
    expect(error.retryable).toBe(false);
    expect(error.correlationId).toMatch(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u);
    expect(error).not.toHaveProperty('safeDetails');
    expect(serialized).not.toContain('unexpected');
  });

  it('returns a schema-versioned safe error envelope for an application failure', async () => {
    const client = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_SOURCE_NOT_FOUND',
        message: 'The requested source was not found.',
      }),
    );

    const result = await callInspect(client);
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(structured.schemaVersion).toBe('1.0');
    expect(structured.ok).toBe(false);
    expect(error.code).toMatch(/^CV_[A-Z0-9_]{3,80}$/u);
    expect(error.correlationId).toMatch(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u);
    expect(error.retryable).toBe(false);
    expect(error.message).toBeTypeOf('string');
  });

  it('omits safeDetails when the application error carries none', async () => {
    const client = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_AUTHORIZATION_DENIED',
        message: 'The requested source is not authorized.',
      }),
    );

    const result = await callInspect(client);
    const error = asRecord(asRecord(result.structuredContent).error);

    expect(error).not.toHaveProperty('safeDetails');
  });

  it('preserves the retryable flag for a transient application error', async () => {
    const client = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_OPERATION_CANCELLED',
        message: 'The operation was cancelled.',
        retryable: true,
      }),
    );

    const result = await callInspect(client);
    const error = asRecord(asRecord(result.structuredContent).error);

    expect(error.retryable).toBe(true);
  });

  it('fails closed without dropping the correlation id when a safe detail is invalid', async () => {
    const client = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_RESOURCE_SOURCE_TOO_LARGE',
        message: 'The source exceeds the configured byte limit.',
        safeDetails: { 'unsafe key': 1, maximumBytes: 32 },
      }),
    );

    const result = await callInspect(client);
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    // The adapter must never forward a detail key that fails its own allowlist,
    // and it must still return a schema-conformant safe envelope rather than
    // letting the schema rejection escape as an unstructured transport error.
    expect(result.isError).toBe(true);
    expect(structured.ok).toBe(false);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error.correlationId).toMatch(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u);
    expect(error).not.toHaveProperty('safeDetails');
    expect(JSON.stringify(result)).not.toContain('unsafe key');
  });

  it('forwards the largest allowlisted safe-detail map and rejects one key more', async () => {
    const sixteenKeys = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`detail${String(index)}`, index]),
    );
    const seventeenKeys = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`detail${String(index)}`, index]),
    );

    const allowedClient = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_RESOURCE_SOURCE_TOO_LARGE',
        message: 'The source exceeds the configured byte limit.',
        safeDetails: sixteenKeys,
      }),
    );
    const rejectedClient = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_RESOURCE_SOURCE_TOO_LARGE',
        message: 'The source exceeds the configured byte limit.',
        safeDetails: seventeenKeys,
      }),
    );

    const allowed = await callInspect(allowedClient);
    const rejected = await callInspect(rejectedClient);

    expect(asRecord(asRecord(allowed.structuredContent).error).safeDetails).toEqual(sixteenKeys);
    // The oversized map must fail closed to the internal error and drop the map.
    expect(asRecord(asRecord(rejected.structuredContent).error).code).toBe('CV_INTERNAL_ERROR');
    expect(asRecord(rejected.structuredContent).error).not.toHaveProperty('safeDetails');
  });

  it.each([
    { create: (): string => 'invalid' },
    {
      create: (): string => {
        throw new Error('correlation failure');
      },
    },
  ])(
    'uses a safe fallback when correlation identifier generation fails',
    async (correlationIds: CorrelationIdFactory) => {
      const server = createMcpServer({
        correlationIds,
        requestCounters: createCounterStub(),
        inspectSource: {
          execute: () =>
            Promise.reject(
              new ContextVaultError({
                code: 'CV_AUTHORIZATION_DENIED',
                message: 'The requested source is not authorized.',
              }),
            ),
        },
        prepareSource: {
          execute: () =>
            Promise.reject(
              new ContextVaultError({
                code: 'CV_AUTHORIZATION_DENIED',
                message: 'The requested source is not authorized.',
              }),
            ),
        },
        retrieveSource: {
          execute: () =>
            Promise.reject(
              new ContextVaultError({
                code: 'CV_AUTHORIZATION_DENIED',
                message: 'The requested source is not authorized.',
              }),
            ),
        },
        verifyEnvelope: {
          execute: () =>
            Promise.reject(
              new ContextVaultError({
                code: 'CV_AUTHORIZATION_DENIED',
                message: 'The requested source is not authorized.',
              }),
            ),
        },
        collectSessionStats: {
          execute: () => {
            throw new ContextVaultError({
              code: 'CV_AUTHORIZATION_DENIED',
              message: 'The requested source is not authorized.',
            });
          },
        },
        purgeDerivedState: {
          preview: () => {
            throw new ContextVaultError({
              code: 'CV_AUTHORIZATION_DENIED',
              message: 'The requested source is not authorized.',
            });
          },
          execute: () => {
            throw new ContextVaultError({
              code: 'CV_AUTHORIZATION_DENIED',
              message: 'The requested source is not authorized.',
            });
          },
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'contextvault-correlation-test-client', version: '0.0.0' });
      closeCallbacks.push(
        async () => client.close(),
        async () => server.close(),
      );
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      // Enabling tool-list caching turns on client-side output-schema
      // validation, so malformed error envelopes fail the call.
      await client.listTools();

      const result = await callInspect(client);
      const error = asRecord(asRecord(result.structuredContent).error);

      expect(error.correlationId).toBe('cv_corr_fallback00000000');
    },
  );

  it.each([`Xcv_corr_${'A'.repeat(24)}`, `cv_corr_${'A'.repeat(24)}!`])(
    'falls back to the documented identifier for a malformed generated value %s',
    async (candidate) => {
      const client = await connectWithFailure(
        new ContextVaultError({
          code: 'CV_AUTHORIZATION_DENIED',
          message: 'The requested source is not authorized.',
        }),
        { correlationIds: { create: () => candidate } },
      );

      const result = await callInspect(client);
      const error = asRecord(asRecord(result.structuredContent).error);

      expect(error.correlationId).toBe('cv_corr_fallback00000000');
    },
  );

  it('forwards an allowlisted string safe detail without rejecting it', async () => {
    const client = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_RESOURCE_SOURCE_TOO_LARGE',
        message: 'The source exceeds the configured byte limit.',
        safeDetails: { reason: 'short' },
      }),
    );

    const result = await callInspect(client);
    const error = asRecord(asRecord(result.structuredContent).error);

    expect(error.code).toBe('CV_RESOURCE_SOURCE_TOO_LARGE');
    expect(error.safeDetails).toEqual({ reason: 'short' });
  });

  it('fails closed on prepare when an application error carries an unsafe detail', async () => {
    const unsafeKeyError = new ContextVaultError({
      code: 'CV_PREPARE_MEDIA_UNSUPPORTED',
      message: 'The source media type is not supported for preparation.',
      safeDetails: { 'unsafe key': true },
    });
    const client = await connectWithFailure(unsafeKeyError);

    const result = await client.callTool({
      name: 'contextvault_prepare',
      arguments: {
        source: { kind: 'workspace_file', rootId: 'repo', path: 'file.txt' },
      },
    });
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(structured.ok).toBe(false);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error.correlationId).toMatch(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u);
    expect(error).not.toHaveProperty('safeDetails');
    expect(JSON.stringify(result)).not.toContain('unsafe key');
  });

  it('fails closed on purge when an application error carries an unsafe detail', async () => {
    const unsafeKeyError = new ContextVaultError({
      code: 'CV_PURGE_INTENT_INVALID',
      message: 'The purge intent is invalid or was already consumed.',
      safeDetails: { 'unsafe key': true },
    });
    const client = await connectWithFailure(unsafeKeyError);

    const result = await client.callTool({
      name: 'contextvault_purge',
      arguments: {
        operation: 'preview',
        target: { kind: 'all_derived_state' },
      },
    });
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(structured.ok).toBe(false);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error).not.toHaveProperty('safeDetails');
    expect(JSON.stringify(result)).not.toContain('unsafe key');
  });

  it('fails closed when a purge execute result does not conform to its branch shape', async () => {
    const malformedExecuteResult: unknown = {
      schemaVersion: '1.0',
      ok: true,
      targetKind: 'envelope',
      deletedEnvelopes: 1,
    };
    const malformedPurgeStubs = {
      preview: () => ({
        schemaVersion: '1.0' as const,
        ok: true as const,
        purgeIntentId: 'cv_pur_abcdefghijklmnop',
        target: { kind: 'all_derived_state' as const },
        summary: { envelopeCount: 0, derivedBytes: 0 },
        expiresAt: '2026-09-10T12:30:00.000Z',
      }),
      execute: (): unknown => malformedExecuteResult,
    } as unknown as Pick<McpServerDependencies['purgeDerivedState'], 'preview' | 'execute'>;
    const client = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_INPUT_INVALID',
        message: 'The purge request is invalid.',
      }),
      { purgeDerivedState: malformedPurgeStubs },
    );

    const result = await client.callTool({
      name: 'contextvault_purge',
      arguments: { operation: 'execute', purgeIntentId: 'cv_pur_abcdefghijklmnop' },
    });
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error.correlationId).toMatch(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u);
    expect(JSON.stringify(result)).not.toContain('deletedEnvelopes');
  });

  it('fails closed when a purge preview result does not conform to its branch shape', async () => {
    const malformedResult: unknown = { schemaVersion: '1.0', ok: true, unexpected: 'shape' };
    const malformedPurgeStubs = {
      preview: (): unknown => malformedResult,
      execute: (): unknown => malformedResult,
    } as unknown as Pick<McpServerDependencies['purgeDerivedState'], 'preview' | 'execute'>;
    const client = await connectWithFailure(
      new ContextVaultError({
        code: 'CV_INPUT_INVALID',
        message: 'The purge request is invalid.',
      }),
      { purgeDerivedState: malformedPurgeStubs },
    );

    const result = await client.callTool({
      name: 'contextvault_purge',
      arguments: { operation: 'preview', target: { kind: 'all_derived_state' } },
    });
    const structured = asRecord(result.structuredContent);
    const error = asRecord(structured.error);

    expect(result.isError).toBe(true);
    expect(error.code).toBe('CV_INTERNAL_ERROR');
    expect(error.correlationId).toMatch(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u);
    expect(JSON.stringify(result)).not.toContain('unexpected');
  });

  async function connectWithFailure(
    failure: Error,
    overrides: {
      readonly correlationIds?: CorrelationIdFactory;
      readonly purgeDerivedState?: Pick<
        McpServerDependencies['purgeDerivedState'],
        'preview' | 'execute'
      >;
    } = {},
  ): Promise<Client> {
    const fallbackCorrelationIds: CorrelationIdFactory = {
      create: (): string => `cv_corr_${'c'.repeat(24)}`,
    };
    const failingPurgeStubs: Pick<
      McpServerDependencies['purgeDerivedState'],
      'preview' | 'execute'
    > = {
      preview: (): never => {
        throw failure;
      },
      execute: (): never => {
        throw failure;
      },
    };
    const server = createMcpServer({
      correlationIds: overrides.correlationIds ?? fallbackCorrelationIds,
      requestCounters: createCounterStub(),
      inspectSource: {
        execute: () => Promise.reject(failure),
      },
      prepareSource: {
        execute: () => Promise.reject(failure),
      },
      retrieveSource: {
        execute: () => Promise.reject(failure),
      },
      verifyEnvelope: {
        execute: () => Promise.reject(failure),
      },
      collectSessionStats: {
        execute: () => {
          throw failure;
        },
      },
      purgeDerivedState: overrides.purgeDerivedState ?? failingPurgeStubs,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contextvault-error-test-client', version: '0.0.0' });
    closeCallbacks.push(
      async () => client.close(),
      async () => server.close(),
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // Enabling tool-list caching turns on client-side output-schema
    // validation, so malformed error envelopes fail the call.
    await client.listTools();
    return client;
  }
});

async function callInspect(client: Client): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool({
    name: 'contextvault_inspect',
    arguments: {
      source: { kind: 'workspace_file', rootId: 'repo', path: 'file.txt' },
    },
  });
}

function createCounterStub(): RequestCounters {
  let successful = 0;
  let failed = 0;
  return {
    recordSuccess: (): void => {
      successful += 1;
    },
    recordFailure: (): void => {
      failed += 1;
    },
    snapshot: () => ({ successful, failed }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a structured object result.');
  }
  return value as Record<string, unknown>;
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { CorrelationIdFactory } from '../../../application/ports/inspection-services.js';
import type { RequestCounters } from '../../../domain/stats/stats-policy.js';
import { isContextVaultError } from '../../../domain/errors/context-vault-error.js';
import { SCHEMA_VERSION } from '../../../domain/inspection/source-inspection.js';

const CORRELATION_ID_PATTERN = /^cv_corr_[A-Za-z0-9_-]{16,128}$/u;
const FALLBACK_CORRELATION_ID = 'cv_corr_fallback00000000';

export const safeDetailValueSchema = z.union([
  z.string().max(256),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const safeErrorContentSchema = z
  .object({
    code: z.string().regex(/^CV_[A-Z0-9_]{3,80}$/u),
    message: z.string().min(1).max(512),
    correlationId: z.string().regex(/^cv_corr_[A-Za-z0-9_-]{16,128}$/u),
    retryable: z.boolean(),
    safeDetails: z
      .record(z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/u), safeDetailValueSchema)
      .refine((details) => Object.keys(details).length <= 16)
      .optional(),
  })
  .strict();

export const safeErrorEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.literal(false),
    error: safeErrorContentSchema,
  })
  .strict();

export interface SafeErrorEnvelope {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
    readonly retryable: boolean;
    readonly safeDetails?: Record<string, string | number | boolean | null>;
  };
}

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface RegisterToolConfig {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: z.ZodType;
  readonly outputSchema?: z.ZodType;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: Record<string, unknown>;
}

export interface ToolHandlerDependencies {
  readonly correlationIds: CorrelationIdFactory;
  readonly requestCounters: RequestCounters;
}

/**
 * Registers one tool with the shared fail-closed response pipeline.
 *
 * Every tool result passes through the same error mapping, the same
 * correlation-id discipline, and the same exact request counters, so no
 * individual handler can diverge from the disclosure policy. The MCP
 * SDK parses tool arguments with the tool's own strict input schema
 * before this handler runs; the use cases revalidate independently so
 * a bypassed adapter still fails closed.
 *
 * The handler takes `never` arguments because each tool module supplies
 * its own precisely typed handler: `never` is assignable to every
 * argument type, so no call site needs a cast while the wrapper still
 * cannot fabricate arguments of its own.
 */
export function registerVaultTool(
  server: McpServer,
  toolName: string,
  registration: RegisterToolConfig,
  handler: (args: never, signal: AbortSignal | undefined) => unknown,
  dependencies: ToolHandlerDependencies,
): void {
  const registrationRecord = registration as Parameters<McpServer['registerTool']>[1];
  server.registerTool(toolName, registrationRecord, (async (
    args: unknown,
    extra: { signal?: AbortSignal },
  ) => {
    const correlationId = createSafeCorrelationId(dependencies.correlationIds);
    try {
      const result = await handler(args as never, extra.signal);
      dependencies.requestCounters.recordSuccess();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error: unknown) {
      dependencies.requestCounters.recordFailure();
      const errorResult = buildErrorResult(error, correlationId);
      const parsed = safeErrorEnvelopeSchema.safeParse(errorResult);
      // If an application error carried a detail that fails the allowlist,
      // the envelope is rebuilt with the internal error so the response
      // still conforms to the output schema and still carries a
      // correlation id.
      const structuredContent = {
        ...(parsed.success ? parsed.data : buildErrorResult(undefined, correlationId)),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: true,
      };
    }
  }) as never);
}

/**
 * Builds the safe error envelope for one caught failure.
 *
 * Unexpected failures collapse to the generic internal error so no
 * exception internals can ever reach the client.
 */
export function buildErrorResult(error: unknown, correlationId: string): SafeErrorEnvelope {
  const safeError =
    error !== undefined && isContextVaultError(error)
      ? error
      : {
          code: 'CV_INTERNAL_ERROR' as const,
          message: 'The requested operation could not be completed safely.',
          retryable: false,
          safeDetails: undefined,
        };
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false as const,
    error: {
      code: safeError.code,
      message: safeError.message,
      correlationId,
      retryable: safeError.retryable,
      ...(safeError.safeDetails ? { safeDetails: { ...safeError.safeDetails } } : {}),
    },
  };
}

export function createSafeCorrelationId(factory: CorrelationIdFactory): string {
  try {
    const correlationId = factory.create();
    return CORRELATION_ID_PATTERN.test(correlationId) ? correlationId : FALLBACK_CORRELATION_ID;
  } catch {
    return FALLBACK_CORRELATION_ID;
  }
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { CorrelationIdFactory } from '../../../application/ports/inspection-services.js';
import type {
  RetrieveRequestInput,
  RetrieveSuccess,
} from '../../../domain/retrieval/retrieval-types.js';
import { SCHEMA_VERSION } from '../../../domain/inspection/source-inspection.js';
import {
  CAPABILITY_TOKEN_PATTERN,
  retrievalSelectorSchema,
  SOURCE_ID_PATTERN,
} from './common-schemas.js';
import {
  registerVaultTool,
  safeErrorContentSchema,
  type ToolHandlerDependencies,
} from './shared-handler.js';

const retrieveInputSchema = z
  .object({
    capability: z.string().regex(CAPABILITY_TOKEN_PATTERN),
    selector: retrievalSelectorSchema,
    maxBytes: z.number().int().min(1).max(1_048_576).optional(),
  })
  .strict();

const retrieveSuccessSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.literal(true),
    envelopeId: z.string().regex(/^cv_env_[A-Za-z0-9_-]{16,128}$/u),
    sourceId: z.string().regex(SOURCE_ID_PATTERN),
    sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    selector: retrievalSelectorSchema,
    locator: z
      .object({
        kind: z.string().min(1).max(64),
        value: z.string().min(0).max(512),
      })
      .strict(),
    byteCount: z.number().int().min(0).max(1_048_576),
    excerptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    content: z.string().max(1_048_576),
    truncated: z.boolean(),
    hasMore: z.boolean(),
  })
  .strict();

/**
 * SDK-facing output schema. The MCP SDK only converts top-level object
 * schemas, so the success/error union is expressed as one strict object
 * with variant fields optional. The exact per-branch shape is enforced
 * by the use case and the JSON Schema contracts.
 */
const retrieveOutputSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.boolean(),
    envelopeId: retrieveSuccessSchema.shape.envelopeId.optional(),
    sourceId: retrieveSuccessSchema.shape.sourceId.optional(),
    sourceDigest: retrieveSuccessSchema.shape.sourceDigest.optional(),
    selector: retrieveSuccessSchema.shape.selector.optional(),
    locator: retrieveSuccessSchema.shape.locator.optional(),
    byteCount: retrieveSuccessSchema.shape.byteCount.optional(),
    excerptDigest: retrieveSuccessSchema.shape.excerptDigest.optional(),
    content: retrieveSuccessSchema.shape.content.optional(),
    truncated: retrieveSuccessSchema.shape.truncated.optional(),
    hasMore: retrieveSuccessSchema.shape.hasMore.optional(),
    error: safeErrorContentSchema.optional(),
  })
  .strict();

export interface RetrieveToolDependencies {
  readonly correlationIds: CorrelationIdFactory;
  readonly requestCounters: ToolHandlerDependencies['requestCounters'];
  readonly retrieveSource: {
    readonly execute: (
      request: RetrieveRequestInput,
      signal?: AbortSignal,
    ) => Promise<RetrieveSuccess>;
  };
}

export function registerRetrieveTool(
  server: McpServer,
  dependencies: RetrieveToolDependencies,
): void {
  registerVaultTool(
    server,
    'contextvault_retrieve',
    {
      title: 'Retrieve an exact bounded excerpt',
      description:
        'Returns an exact, bounded source excerpt for one already prepared source with an explicitly issued retrieval capability. Content-revealing by design: never call this tool for content-free workflows.',
      inputSchema: retrieveInputSchema,
      outputSchema: retrieveOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (request: RetrieveToolArguments, signal) => {
      const retrieveRequest: RetrieveRequestInput = {
        capability: request.capability,
        selector: request.selector as RetrieveRequestInput['selector'],
        ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
      };
      const result = await dependencies.retrieveSource.execute(retrieveRequest, signal);
      return { ...result, selector: { ...result.selector }, locator: { ...result.locator } };
    },
    {
      correlationIds: dependencies.correlationIds,
      requestCounters: dependencies.requestCounters,
    },
  );
}

interface RetrieveToolArguments {
  readonly capability: string;
  readonly selector: unknown;
  readonly maxBytes?: number;
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { CorrelationIdFactory } from '../../../application/ports/inspection-services.js';
import type {
  InspectSuccess,
  SourceReferenceInput,
} from '../../../domain/inspection/source-inspection.js';
import { SCHEMA_VERSION } from '../../../domain/inspection/source-inspection.js';
import { retrievalSelectorKindSchema, sourceReferenceSchema } from './common-schemas.js';
import {
  registerVaultTool,
  safeErrorContentSchema,
  type ToolHandlerDependencies,
} from './shared-handler.js';

const inspectSuccessSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.literal(true),
    source: z
      .object({
        sourceId: z.string().regex(/^cv_src_[A-Za-z0-9_-]{16,128}$/u),
        sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        mediaType: z.string().min(1).max(255),
        bytes: z.number().int().min(0).max(67_108_864),
        sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted', 'prohibited']),
        secretRisk: z.enum(['none', 'suspected', 'confirmed', 'unknown']),
        // The announced kinds are the retrieval-side vocabulary: the
        // same enum the grant policy accepts, so inspect can never
        // advertise a selector a grant could not honor.
        supportedSelectors: z.array(retrievalSelectorKindSchema).max(3),
        inspectedAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();

/**
 * SDK-facing output schema. The MCP SDK only converts top-level object
 * schemas, so the success/error union is expressed as one strict object
 * with variant fields optional. The exact per-branch shape is enforced
 * by the handler and the JSON Schema contracts, not by this
 * declaration.
 */
const inspectOutputSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.boolean(),
    source: inspectSuccessSchema.shape.source.optional(),
    error: safeErrorContentSchema.optional(),
  })
  .strict();

export interface InspectToolDependencies {
  readonly correlationIds: CorrelationIdFactory;
  readonly requestCounters: ToolHandlerDependencies['requestCounters'];
  readonly inspectSource: {
    readonly execute: (
      source: SourceReferenceInput,
      signal?: AbortSignal,
    ) => Promise<InspectSuccess>;
  };
}

export function registerInspectTool(
  server: McpServer,
  dependencies: InspectToolDependencies,
): void {
  registerVaultTool(
    server,
    'contextvault_inspect',
    {
      title: 'Inspect an authorized source',
      description:
        'Returns content-free metadata for one file beneath a workspace root authorized at server startup.',
      inputSchema: z.object({ source: sourceReferenceSchema }).strict(),
      outputSchema: inspectOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (request: SourceReferenceEnvelope, signal) => {
      const result = await dependencies.inspectSource.execute(request.source, signal);
      return { ...result, source: { ...result.source } };
    },
    {
      correlationIds: dependencies.correlationIds,
      requestCounters: dependencies.requestCounters,
    },
  );
}

interface SourceReferenceEnvelope {
  readonly source: SourceReferenceInput;
}

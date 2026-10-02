import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { CorrelationIdFactory } from '../../../application/ports/inspection-services.js';
import type { PrepareRequest } from '../../../application/preparation/prepare-source.js';
import type { PrepareSuccess } from '../../../domain/preparation/preparation-types.js';
import { SCHEMA_VERSION } from '../../../domain/inspection/source-inspection.js';
import { PREPARE_DISCLOSURE_CLASSIFICATION } from '../../../domain/preparation/preparation-types.js';
import {
  chunkDescriptorSchema,
  jsonNodeDescriptorSchema,
  omissionSchema,
  retrievalSelectorKindSchema,
  sourceReferenceSchema,
  CAPABILITY_TOKEN_PATTERN,
} from './common-schemas.js';
import {
  registerVaultTool,
  safeErrorContentSchema,
  type ToolHandlerDependencies,
} from './shared-handler.js';

const prepareInputSchema = z
  .object({
    source: sourceReferenceSchema,
    ttlSeconds: z.number().int().min(60).max(7200).optional(),
    retrieval: z
      .object({
        allowedSelectorTypes: z.array(retrievalSelectorKindSchema).min(1).max(3),
        maxBytes: z.number().int().min(1).max(1_048_576).optional(),
        ttlSeconds: z.number().int().min(60).max(7200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const prepareSuccessSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.literal(true),
    envelope: z
      .object({
        envelopeId: z.string().regex(/^cv_env_[A-Za-z0-9_-]{16,128}$/u),
        sourceId: z.string().regex(/^cv_src_[A-Za-z0-9_-]{16,128}$/u),
        sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        mediaType: z.string().min(1).max(255),
        bytes: z.number().int().min(0).max(67_108_864),
        sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted', 'prohibited']),
        secretRisk: z.enum(['none', 'suspected', 'confirmed', 'unknown']),
        preparationKind: z.enum(['text_chunks', 'json_structure', 'minimal']),
        disclosureClass: z.literal(PREPARE_DISCLOSURE_CLASSIFICATION),
        retrievalAllowed: z.boolean(),
        lineCount: z.number().int().min(0).max(1_000_000),
        chunks: z.array(chunkDescriptorSchema).max(1024),
        jsonNodes: z.array(jsonNodeDescriptorSchema).max(1024),
        omissions: z.array(omissionSchema).max(8),
        structuralFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        createdAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        retrieval: z
          .object({
            capability: z.string().regex(CAPABILITY_TOKEN_PATTERN),
            expiresAt: z.iso.datetime(),
            allowedSelectorTypes: z.array(retrievalSelectorKindSchema).min(1).max(3),
            maxBytes: z.number().int().min(1).max(1_048_576),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

/**
 * SDK-facing output schema. The MCP SDK only converts top-level object
 * schemas, so the success/error union is expressed as one strict object
 * with variant fields optional. The exact per-branch shape is enforced
 * by the use case and the JSON Schema contracts.
 */
const prepareOutputSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.boolean(),
    envelope: prepareSuccessSchema.shape.envelope.optional(),
    error: safeErrorContentSchema.optional(),
  })
  .strict();

export interface PrepareToolDependencies {
  readonly correlationIds: CorrelationIdFactory;
  readonly requestCounters: ToolHandlerDependencies['requestCounters'];
  readonly prepareSource: {
    readonly execute: (request: PrepareRequest, signal?: AbortSignal) => Promise<PrepareSuccess>;
  };
}

export function registerPrepareTool(
  server: McpServer,
  dependencies: PrepareToolDependencies,
): void {
  registerVaultTool(
    server,
    'contextvault_prepare',
    {
      title: 'Prepare a bounded structural envelope',
      description:
        'Builds a bounded structural envelope for one authorized source. Returns raw-content-free structural metadata such as digests, byte and line ranges, and opaque identifiers, plus an explicit optional retrieval capability. Never returns source text unless a retrieval grant was issued in the same call.',
      inputSchema: prepareInputSchema,
      outputSchema: prepareOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (request: PreparedPrepareArguments, signal) => {
      const preparedRequest: PrepareRequest = {
        source: {
          kind: request.source.kind,
          rootId: request.source.rootId,
          path: request.source.path,
        },
        ...(request.ttlSeconds !== undefined ? { ttlSeconds: request.ttlSeconds } : {}),
        ...(request.retrieval !== undefined ? { retrieval: request.retrieval } : {}),
      };
      const result = await dependencies.prepareSource.execute(preparedRequest, signal);
      return { ...result, envelope: { ...result.envelope } };
    },
    {
      correlationIds: dependencies.correlationIds,
      requestCounters: dependencies.requestCounters,
    },
  );
}

interface PreparedPrepareArguments {
  readonly source: {
    readonly kind: 'workspace_file';
    readonly rootId: string;
    readonly path: string;
  };
  readonly ttlSeconds?: number;
  readonly retrieval?: {
    readonly allowedSelectorTypes: readonly ('chunk' | 'json_node' | 'line_range')[];
    readonly maxBytes?: number;
    readonly ttlSeconds?: number;
  };
}

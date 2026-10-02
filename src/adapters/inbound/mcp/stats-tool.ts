import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { CorrelationIdFactory } from '../../../application/ports/inspection-services.js';
import type { StatsSuccess } from '../../../application/stats/collect-session-stats.js';
import { SCHEMA_VERSION } from '../../../domain/inspection/source-inspection.js';
import {
  registerVaultTool,
  safeErrorContentSchema,
  type ToolHandlerDependencies,
} from './shared-handler.js';

const statsInputSchema = z.object({}).strict();

const countersSchema = z
  .object({
    activeEnvelopeCount: z.number().int().min(0),
    activeGrantCount: z.number().int().min(0),
    authorizedRootCount: z.number().int().min(0),
    serializedDerivedRecordBytes: z.number().int().min(0),
    provenanceRecordsRetained: z.number().int().min(0),
    successfulRequests: z.number().int().min(0),
    failedRequests: z.number().int().min(0),
    envelopesRemovedByExpiry: z.number().int().min(0),
    envelopesRemovedByPurge: z.number().int().min(0),
    grantsRevoked: z.number().int().min(0),
    purgeIntentsConsumed: z.number().int().min(0),
  })
  .strict();

const statsSuccessSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.literal(true),
    counters: countersSchema,
    measuredAt: z.iso.datetime(),
  })
  .strict();

/**
 * SDK-facing output schema. The MCP SDK only converts top-level object
 * schemas, so the success/error union is expressed as one strict object
 * with variant fields optional. The exact per-branch shape is enforced
 * by the use case and the JSON Schema contracts.
 */
const statsOutputSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.boolean(),
    counters: statsSuccessSchema.shape.counters.optional(),
    measuredAt: statsSuccessSchema.shape.measuredAt.optional(),
    error: safeErrorContentSchema.optional(),
  })
  .strict();

export interface StatsToolDependencies {
  readonly correlationIds: CorrelationIdFactory;
  readonly requestCounters: ToolHandlerDependencies['requestCounters'];
  readonly collectSessionStats: {
    readonly execute: () => StatsSuccess;
  };
}

export function registerStatsTool(server: McpServer, dependencies: StatsToolDependencies): void {
  registerVaultTool(
    server,
    'contextvault_stats',
    {
      title: 'Report exact process-scoped counters',
      description:
        'Returns exact operational counters for this private session: active envelopes, active grants, authorized roots, serialized derived-record bytes, request outcomes, and lifetime expiry/purge bookkeeping. Never returns content, paths, tokens, or savings metrics.',
      inputSchema: statsInputSchema,
      outputSchema: statsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    () => {
      const result = dependencies.collectSessionStats.execute();
      return { ...result, counters: { ...result.counters } };
    },
    {
      correlationIds: dependencies.correlationIds,
      requestCounters: dependencies.requestCounters,
    },
  );
}

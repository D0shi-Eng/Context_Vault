import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { CorrelationIdFactory } from '../../../application/ports/inspection-services.js';
import type {
  VerifyRequestInput,
  VerifySuccess,
} from '../../../domain/verification/verification-policy.js';
import { MAX_VERIFICATION_CHECKS } from '../../../domain/verification/verification-policy.js';
import { SCHEMA_VERSION } from '../../../domain/inspection/source-inspection.js';
import { CHUNK_ID_PATTERN, ENVELOPE_ID_PATTERN } from './common-schemas.js';
import {
  registerVaultTool,
  safeErrorContentSchema,
  type ToolHandlerDependencies,
} from './shared-handler.js';

const verificationCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source_freshness') }).strict(),
  z
    .object({
      kind: z.literal('chunk_integrity'),
      chunkId: z.string().regex(CHUNK_ID_PATTERN),
    })
    .strict(),
  z.object({ kind: z.literal('provenance_consistency') }).strict(),
]);

const verifyInputSchema = z
  .object({
    envelopeId: z.string().regex(ENVELOPE_ID_PATTERN),
    checks: z.array(verificationCheckSchema).min(1).max(MAX_VERIFICATION_CHECKS),
  })
  .strict();

const verificationResultSchema = z
  .object({
    kind: z.enum(['source_freshness', 'chunk_integrity', 'provenance_consistency']),
    chunkId: z.string().regex(CHUNK_ID_PATTERN).optional(),
    status: z.enum(['valid', 'stale', 'invalid', 'unavailable']),
    reasonCode: z.string().min(1).max(80),
  })
  .strict();

const verifySuccessSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.literal(true),
    envelopeId: z.string().regex(ENVELOPE_ID_PATTERN),
    results: z.array(verificationResultSchema).min(1).max(MAX_VERIFICATION_CHECKS),
    verifiedAt: z.iso.datetime(),
  })
  .strict();

/**
 * SDK-facing output schema. The MCP SDK only converts top-level object
 * schemas, so the success/error union is expressed as one strict object
 * with variant fields optional. The exact per-branch shape is enforced
 * by the use case and the JSON Schema contracts.
 */
const verifyOutputSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.boolean(),
    envelopeId: verifySuccessSchema.shape.envelopeId.optional(),
    results: verifySuccessSchema.shape.results.optional(),
    verifiedAt: verifySuccessSchema.shape.verifiedAt.optional(),
    error: safeErrorContentSchema.optional(),
  })
  .strict();

export interface VerifyToolDependencies {
  readonly correlationIds: CorrelationIdFactory;
  readonly requestCounters: ToolHandlerDependencies['requestCounters'];
  readonly verifyEnvelope: {
    readonly execute: (request: VerifyRequestInput, signal?: AbortSignal) => Promise<VerifySuccess>;
  };
}

export function registerVerifyTool(server: McpServer, dependencies: VerifyToolDependencies): void {
  registerVaultTool(
    server,
    'contextvault_verify',
    {
      title: 'Verify prepared-state integrity deterministically',
      description:
        'Runs machine-checkable integrity checks for one prepared envelope: source freshness, prepared chunk integrity, and retrieval provenance consistency. Never judges natural-language claims, never returns source content, and never reports capability state.',
      inputSchema: verifyInputSchema,
      outputSchema: verifyOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (request: VerifyToolArguments, signal) => {
      const verifyRequest: VerifyRequestInput = {
        envelopeId: request.envelopeId,
        checks: request.checks.map(
          (check) => ({ ...check }) as unknown as VerifyRequestInput['checks'][number],
        ),
      };
      const result = await dependencies.verifyEnvelope.execute(verifyRequest, signal);
      return {
        ...result,
        results: result.results.map((entry) => ({
          kind: entry.kind,
          ...(entry.chunkId !== undefined ? { chunkId: entry.chunkId } : {}),
          status: entry.status,
          reasonCode: entry.reasonCode,
        })),
      };
    },
    {
      correlationIds: dependencies.correlationIds,
      requestCounters: dependencies.requestCounters,
    },
  );
}

interface VerifyToolArguments {
  readonly envelopeId: string;
  readonly checks: readonly Record<string, unknown>[];
}

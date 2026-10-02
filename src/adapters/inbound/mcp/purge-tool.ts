import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { CorrelationIdFactory } from '../../../application/ports/inspection-services.js';
import type {
  PurgeExecuteSuccess,
  PurgePreviewSuccess,
} from '../../../application/preparation/purge-derived-state.js';
import { SCHEMA_VERSION } from '../../../domain/inspection/source-inspection.js';
import { ENVELOPE_ID_PATTERN } from './common-schemas.js';
import {
  registerVaultTool,
  safeErrorContentSchema,
  type ToolHandlerDependencies,
} from './shared-handler.js';

const INTENT_ID_PATTERN = /^cv_pur_[A-Za-z0-9_-]{16,128}$/u;

const purgeInputSchema = z
  .object({
    operation: z.enum(['preview', 'execute']),
    target: z
      .union([
        z
          .object({
            kind: z.literal('envelope'),
            envelopeId: z.string().regex(ENVELOPE_ID_PATTERN),
          })
          .strict(),
        z.object({ kind: z.literal('all_derived_state') }).strict(),
      ])
      .optional(),
    purgeIntentId: z.string().regex(INTENT_ID_PATTERN).optional(),
  })
  .strict()
  .refine(
    (request) =>
      request.operation === 'preview'
        ? request.target !== undefined && request.purgeIntentId === undefined
        : request.purgeIntentId !== undefined && request.target === undefined,
    { message: 'The purge request fields do not match the requested operation.' },
  );

const purgePreviewSuccessSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.literal(true),
    purgeIntentId: z.string().regex(INTENT_ID_PATTERN),
    target: z.union([
      z
        .object({ kind: z.literal('envelope'), envelopeId: z.string().regex(ENVELOPE_ID_PATTERN) })
        .strict(),
      z.object({ kind: z.literal('all_derived_state') }).strict(),
    ]),
    summary: z
      .object({
        envelopeCount: z.number().int().min(0).max(64),
        derivedBytes: z.number().int().min(0).max(4_194_304),
      })
      .strict(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

const purgeExecuteSuccessSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.literal(true),
    targetKind: z.enum(['envelope', 'all_derived_state']),
    deletedEnvelopes: z.number().int().min(0).max(64),
    deletedDerivedBytes: z.number().int().min(0).max(4_194_304),
    revokedIntents: z.number().int().min(0).max(16),
    revokedGrants: z.number().int().min(0).max(64),
    removedProvenanceRecords: z.number().int().min(0).max(32),
  })
  .strict();

/**
 * SDK-facing output schema. The MCP SDK normalizes top-level object
 * schemas only, so the union of the preview, execute, and error shapes
 * is expressed as one strict object with variant fields optional; the
 * exact per-branch shape is enforced by the handler before any response
 * is returned.
 */
const purgeSuccessSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    ok: z.boolean(),
    purgeIntentId: z.string().regex(INTENT_ID_PATTERN).optional(),
    target: z
      .union([
        z
          .object({
            kind: z.literal('envelope'),
            envelopeId: z.string().regex(ENVELOPE_ID_PATTERN),
          })
          .strict(),
        z.object({ kind: z.literal('all_derived_state') }).strict(),
      ])
      .optional(),
    summary: z
      .object({
        envelopeCount: z.number().int().min(0).max(64),
        derivedBytes: z.number().int().min(0).max(4_194_304),
      })
      .strict()
      .optional(),
    expiresAt: z.iso.datetime().optional(),
    targetKind: z.enum(['envelope', 'all_derived_state']).optional(),
    deletedEnvelopes: z.number().int().min(0).max(64).optional(),
    deletedDerivedBytes: z.number().int().min(0).max(4_194_304).optional(),
    revokedIntents: z.number().int().min(0).max(16).optional(),
    revokedGrants: z.number().int().min(0).max(64).optional(),
    removedProvenanceRecords: z.number().int().min(0).max(32).optional(),
    error: safeErrorContentSchema.optional(),
  })
  .strict();

export interface PurgeToolDependencies {
  readonly correlationIds: CorrelationIdFactory;
  readonly requestCounters: ToolHandlerDependencies['requestCounters'];
  readonly purgeDerivedState: {
    readonly preview: (request: unknown) => PurgePreviewSuccess;
    readonly execute: (request: unknown) => PurgeExecuteSuccess;
  };
}

export function registerPurgeTool(server: McpServer, dependencies: PurgeToolDependencies): void {
  registerVaultTool(
    server,
    'contextvault_purge',
    {
      title: 'Purge ContextVault-owned derived state',
      description:
        'Previews or executes deletion of ContextVault-owned in-memory derived state for one envelope or all derived state of this private session, including retrieval grants and provenance records. Never touches original sources, paths, or files.',
      inputSchema: purgeInputSchema,
      outputSchema: purgeSuccessSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (request: PurgeToolArguments) => {
      if (request.operation === 'preview') {
        const preview = dependencies.purgeDerivedState.preview({
          operation: 'preview',
          target: request.target,
        });
        const parsed = purgePreviewSuccessSchema.safeParse(preview);
        if (!parsed.success) {
          // A use-case result outside its declared branch shape must fail
          // closed to the generic internal error envelope.
          throw new Error('Purge result did not conform to its declared shape.');
        }
        return { ...parsed.data, target: { ...parsed.data.target } };
      }

      const executed = dependencies.purgeDerivedState.execute({
        operation: 'execute',
        purgeIntentId: request.purgeIntentId,
      });
      const parsed = purgeExecuteSuccessSchema.safeParse(executed);
      if (!parsed.success) {
        throw new Error('Purge result did not conform to its declared shape.');
      }
      return { ...parsed.data };
    },
    {
      correlationIds: dependencies.correlationIds,
      requestCounters: dependencies.requestCounters,
    },
  );
}

interface PurgeToolArguments {
  readonly operation: 'preview' | 'execute';
  readonly target?: { readonly kind: 'envelope'; readonly envelopeId: string };
  readonly purgeIntentId?: string;
}

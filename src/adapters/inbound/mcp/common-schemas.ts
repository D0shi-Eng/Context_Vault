import * as z from 'zod/v4';

/**
 * Shared MCP adapter schemas.
 *
 * Every tool reuses these definitions instead of re-declaring its own
 * copies, so a validation policy can never drift between handlers.
 */

export const sourceReferenceSchema = z
  .object({
    kind: z.literal('workspace_file'),
    rootId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    path: z.string().min(1).max(4096),
  })
  .strict();

export const ENVELOPE_ID_PATTERN = /^cv_env_[A-Za-z0-9_-]{16,128}$/u;
export const SOURCE_ID_PATTERN = /^cv_src_[A-Za-z0-9_-]{16,128}$/u;
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const CHUNK_ID_PATTERN = /^cv_chunk_[A-Za-z0-9_-]{8,128}$/u;
export const NODE_ID_PATTERN = /^cv_node_[A-Za-z0-9_-]{1,128}$/u;
export const OMISSION_ID_PATTERN = /^cv_omit_[A-Za-z0-9_-]{8,128}$/u;
export const CAPABILITY_TOKEN_PATTERN = /^cv1_[A-Za-z0-9_-]{43,512}$/u;
export const RETRIEVAL_SELECTOR_KIND_PATTERN = z.enum(['chunk', 'json_node', 'line_range']);

export const chunkDescriptorSchema = z
  .object({
    chunkId: z.string().regex(CHUNK_ID_PATTERN),
    byteStart: z.number().int().min(0),
    byteEndExclusive: z.number().int().min(1),
    lineStart: z.number().int().min(1),
    lineEndExclusive: z.number().int().min(1),
    byteLength: z.number().int().min(1),
    chunkDigest: z.string().regex(SHA256_PATTERN),
    truncated: z.boolean(),
  })
  .strict();

export const jsonNodeDescriptorSchema = z
  .object({
    nodeId: z.string().regex(NODE_ID_PATTERN),
    nodeType: z.enum(['object', 'array', 'string', 'number', 'boolean', 'null']),
    depth: z.number().int().min(0).max(64),
    childCount: z.number().int().min(0).max(250_000),
    pointer: z.union([z.string().max(2048), z.null()]),
    pointerRedacted: z.boolean(),
  })
  .strict();

export const omissionSchema = z
  .object({
    omissionId: z.string().regex(OMISSION_ID_PATTERN),
    locator: z
      .object({
        kind: z.enum(['byte_range', 'line_range', 'json_pointer']),
        value: z.string().min(1).max(512),
      })
      .strict(),
    reason: z.enum(['budget', 'duplicate', 'policy', 'unsupported']),
    itemCount: z.number().int().min(1),
    retrievable: z.literal(false),
  })
  .strict();

export const retrievalSelectorKindSchema = RETRIEVAL_SELECTOR_KIND_PATTERN;

export const retrievalSelectorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('chunk'),
      chunkId: z.string().regex(CHUNK_ID_PATTERN),
    })
    .strict(),
  z
    .object({
      kind: z.literal('json_node'),
      nodeId: z.string().regex(NODE_ID_PATTERN),
    })
    .strict(),
  z
    .object({
      kind: z.literal('line_range'),
      startLine: z.number().int().min(1).max(1_000_000),
      endLine: z.number().int().min(1).max(1_000_000),
    })
    .strict(),
]);

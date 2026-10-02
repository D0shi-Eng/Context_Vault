export interface SchemaFixture {
  readonly schemaId: string;
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const source = {
  kind: 'workspace_file',
  rootId: 'workspace',
  path: 'docs/example.md',
} as const;

const sourceId = 'cv_src_abcdefghijklmnop';
const envelopeId = 'cv_env_abcdefghijklmnop';
const purgeIntentId = 'cv_pur_abcdefghijklmnop';
const digest = `sha256:${'0'.repeat(64)}`;
const timestamp = '2026-09-10T00:00:00.000Z';
const retrievalSelector = {
  kind: 'chunk',
  chunkId: 'cv_chunk_000000000001',
} as const;

const capability = `cv1_${'a'.repeat(43)}`;

const prepareEnvelope = {
  envelopeId,
  sourceId,
  sourceDigest: digest,
  mediaType: 'text/markdown',
  bytes: 128,
  sensitivity: 'internal',
  secretRisk: 'none',
  preparationKind: 'text_chunks',
  disclosureClass: 'RAW_CONTENT_FREE_WITH_BOUNDED_STRUCTURAL_METADATA_DISCLOSURE',
  retrievalAllowed: true,
  lineCount: 4,
  chunks: [
    {
      chunkId: 'cv_chunk_000000000001',
      byteStart: 0,
      byteEndExclusive: 64,
      lineStart: 1,
      lineEndExclusive: 4,
      byteLength: 64,
      chunkDigest: digest,
      truncated: false,
    },
  ],
  jsonNodes: [],
  omissions: [],
  structuralFingerprint: digest,
  createdAt: timestamp,
  expiresAt: '2026-09-10T00:30:00.000Z',
  retrieval: {
    capability,
    expiresAt: '2026-09-10T00:30:00.000Z',
    allowedSelectorTypes: ['chunk', 'line_range'],
    maxBytes: 4096,
  },
} as const;

const verifyResults = [
  {
    kind: 'source_freshness',
    status: 'valid',
    reasonCode: 'digest_matches_prepared_state',
  },
  {
    kind: 'chunk_integrity',
    chunkId: 'cv_chunk_000000000001',
    status: 'valid',
    reasonCode: 'digest_matches_prepared_state',
  },
  {
    kind: 'provenance_consistency',
    status: 'valid',
    reasonCode: 'provenance_chain_consistent',
  },
] as const;

const counters = {
  activeEnvelopeCount: 1,
  activeGrantCount: 1,
  authorizedRootCount: 1,
  serializedDerivedRecordBytes: 512,
  provenanceRecordsRetained: 1,
  successfulRequests: 4,
  failedRequests: 0,
  envelopesRemovedByExpiry: 0,
  envelopesRemovedByPurge: 0,
  grantsRevoked: 0,
  purgeIntentsConsumed: 0,
} as const;

const successfulFixtures = {
  inspectInput: { source },
  inspectOutput: {
    schemaVersion: '1.0',
    ok: true,
    source: {
      sourceId,
      sourceDigest: digest,
      mediaType: 'text/markdown',
      bytes: 128,
      sensitivity: 'internal',
      secretRisk: 'none',
      supportedSelectors: ['chunk', 'line_range'],
      inspectedAt: timestamp,
    },
  },
  prepareInput: { source, ttlSeconds: 600 },
  prepareInputWithGrant: {
    source,
    retrieval: {
      allowedSelectorTypes: ['chunk', 'line_range'],
      maxBytes: 4096,
      ttlSeconds: 600,
    },
  },
  prepareOutput: { schemaVersion: '1.0', ok: true, envelope: prepareEnvelope },
  retrieveInput: {
    capability,
    selector: retrievalSelector,
    maxBytes: 4096,
  },
  retrieveOutput: {
    schemaVersion: '1.0',
    ok: true,
    envelopeId,
    sourceId,
    sourceDigest: digest,
    selector: retrievalSelector,
    locator: { kind: 'chunk', value: 'cv_chunk_000000000001' },
    byteCount: 23,
    excerptDigest: digest,
    content: 'Exact fixture content.\n',
    truncated: false,
    hasMore: false,
  },
  verifyInput: {
    envelopeId,
    checks: [
      { kind: 'source_freshness' },
      { kind: 'chunk_integrity', chunkId: 'cv_chunk_000000000001' },
    ],
  },
  verifyOutput: {
    schemaVersion: '1.0',
    ok: true,
    envelopeId,
    results: verifyResults,
    verifiedAt: timestamp,
  },
  statsInput: {},
  statsOutput: {
    schemaVersion: '1.0',
    ok: true,
    counters,
    measuredAt: timestamp,
  },
  purgeInputPreview: {
    operation: 'preview',
    target: { kind: 'envelope', envelopeId },
  },
  purgeInputExecute: { operation: 'execute', purgeIntentId },
  purgePreviewOutput: {
    schemaVersion: '1.0',
    ok: true,
    purgeIntentId,
    target: { kind: 'envelope', envelopeId },
    summary: { envelopeCount: 1, derivedBytes: 512 },
    expiresAt: '2026-09-10T00:30:00.000Z',
  },
  purgeExecuteOutput: {
    schemaVersion: '1.0',
    ok: true,
    targetKind: 'envelope',
    deletedEnvelopes: 1,
    deletedDerivedBytes: 512,
    revokedIntents: 1,
    revokedGrants: 1,
    removedProvenanceRecords: 1,
  },
} as const;

function withUnknownProperty(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...value, unknownProperty: true };
}

const schemaBase = 'https://contextvault.local/schemas/mcp';

export const schemaFixtures: readonly SchemaFixture[] = [
  {
    schemaId: `${schemaBase}/inspect.input.schema.json`,
    valid: [successfulFixtures.inspectInput],
    invalid: [{}, withUnknownProperty(successfulFixtures.inspectInput)],
  },
  {
    schemaId: `${schemaBase}/inspect.output.schema.json`,
    valid: [successfulFixtures.inspectOutput],
    invalid: [withUnknownProperty(successfulFixtures.inspectOutput)],
  },
  {
    schemaId: `${schemaBase}/prepare.input.schema.json`,
    valid: [successfulFixtures.prepareInput, { source }, successfulFixtures.prepareInputWithGrant],
    invalid: [
      { ...successfulFixtures.prepareInput, ttlSeconds: 59 },
      { ...successfulFixtures.prepareInputWithGrant, retrieval: { allowedSelectorTypes: [] } },
      {
        ...successfulFixtures.prepareInputWithGrant,
        retrieval: { allowedSelectorTypes: ['semantic'], maxBytes: 4096, ttlSeconds: 600 },
      },
      {
        ...successfulFixtures.prepareInputWithGrant,
        retrieval: { maxBytes: 4096, ttlSeconds: 600 },
      },
    ],
  },
  {
    schemaId: `${schemaBase}/prepare.output.schema.json`,
    valid: [successfulFixtures.prepareOutput],
    invalid: [withUnknownProperty(successfulFixtures.prepareOutput)],
  },
  {
    schemaId: `${schemaBase}/retrieve.input.schema.json`,
    valid: [successfulFixtures.retrieveInput],
    invalid: [
      { ...successfulFixtures.retrieveInput, maxBytes: 1_048_577 },
      { selector: retrievalSelector },
      { ...successfulFixtures.retrieveInput, capability: `cv2_${'a'.repeat(43)}` },
    ],
  },
  {
    schemaId: `${schemaBase}/retrieve.output.schema.json`,
    valid: [successfulFixtures.retrieveOutput],
    invalid: [withUnknownProperty(successfulFixtures.retrieveOutput)],
  },
  {
    schemaId: `${schemaBase}/verify.input.schema.json`,
    valid: [successfulFixtures.verifyInput],
    invalid: [
      { ...successfulFixtures.verifyInput, checks: [] },
      { ...successfulFixtures.verifyInput, checks: [{ kind: 'semantic_support' }] },
    ],
  },
  {
    schemaId: `${schemaBase}/verify.output.schema.json`,
    valid: [successfulFixtures.verifyOutput],
    invalid: [withUnknownProperty(successfulFixtures.verifyOutput)],
  },
  {
    schemaId: `${schemaBase}/stats.input.schema.json`,
    valid: [successfulFixtures.statsInput],
    invalid: [{ unexpected: true }],
  },
  {
    schemaId: `${schemaBase}/stats.output.schema.json`,
    valid: [successfulFixtures.statsOutput],
    invalid: [withUnknownProperty(successfulFixtures.statsOutput)],
  },
  {
    schemaId: `${schemaBase}/purge.input.schema.json`,
    valid: [successfulFixtures.purgeInputPreview, successfulFixtures.purgeInputExecute],
    invalid: [
      { operation: 'preview', target: { kind: 'envelope', envelopeId }, confirm: true },
      { operation: 'execute', purgeIntentId, target: { kind: 'all_derived_state' } },
    ],
  },
  {
    schemaId: `${schemaBase}/purge.output.schema.json`,
    valid: [successfulFixtures.purgePreviewOutput, successfulFixtures.purgeExecuteOutput],
    invalid: [
      withUnknownProperty(successfulFixtures.purgePreviewOutput),
      { ...successfulFixtures.purgeExecuteOutput, revokedCapabilities: 1 },
    ],
  },
];

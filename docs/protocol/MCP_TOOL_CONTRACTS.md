# MCP Tool Contracts

## Contract principles

- Exactly six tools are registered; no tool calls another tool, and there is no internal tool-to-tool path.
- Tool names and schemas are versioned public interfaces.
- All input and output objects reject unknown properties.
- Every success response contains `schemaVersion` (`"1.0"`) and `ok: true`.
- Every application failure contains `schemaVersion`, `ok: false`, and a safe structured error with a correlation id.
- MCP transport failures remain distinct from application failures.
- Tool descriptions never imply that an AI client may bypass policy through user text.
- Source-derived text is untrusted data, never an instruction channel.
- Every tool revalidates its input independently of the MCP schema, so a request that bypasses the adapter still fails closed.

Only the tools marked **discloses content** can ever return source-derived text; every other tool is content-free by contract.

## `contextvault_inspect`

Inspects one authorized workspace file without returning its content. **Content-free.**

**Input:** `source` — `{ kind: "workspace_file", rootId, path }`.

**Output:** `source` — `sourceId`, `sourceDigest` (SHA-256), `mediaType`, `bytes`, `sensitivity`, `secretRisk`, `supportedSelectors`, `inspectedAt`.

- `supportedSelectors` is derived from the same selector policy that retrieval grants honor: `["json_node", "line_range"]` for `application/json`, `["chunk", "line_range"]` for preparable plain text and Markdown, and `[]` for everything else (binary, source-code, CSV/TSV, YAML, NDJSON, and log media cannot be prepared in v1).
- Read limit: 32 MiB default, composition-configurable up to the 64 MiB hard ceiling.

**Errors:** `CV_INPUT_INVALID`, `CV_AUTHORIZATION_DENIED`, `CV_PATH_*`, `CV_SOURCE_NOT_FOUND`, `CV_RESOURCE_SOURCE_TOO_LARGE` (with `safeDetails.maximumBytes`), `CV_INTERNAL_ERROR`.

**Side effects:** none. No state is created; the request counters advance.

**Memory relation:** read-only. Establishes the identity (`sourceId`, digest, classification) used to decide whether preparation is worthwhile.

## `contextvault_prepare`

Builds a bounded, content-free structural envelope for one authorized source. **Content-free** unless an optional retrieval grant is issued in the same call (the grant is returned once; excerpts come only from `contextvault_retrieve`).

**Input:** `source`, optional `ttlSeconds` (60–7200, default 1800), optional `retrieval` — `{ allowedSelectorTypes (1–3 of chunk/json_node/line_range), maxBytes (≤ 1 MiB, default 256 KiB), ttlSeconds (60–7200) }`.

**Output:** `envelope` — `envelopeId`, `sourceId`, `sourceDigest`, `mediaType`, `bytes`, `sensitivity`, `secretRisk`, `preparationKind` (`text_chunks` | `json_structure` | `minimal`), `disclosureClass`, `retrievalAllowed`, `lineCount`, `chunks` (≤ 1024 descriptors), `jsonNodes` (≤ 1024 descriptors), `omissions`, `structuralFingerprint`, `createdAt`, `expiresAt`, and `retrieval` (`capability`, `expiresAt`, `allowedSelectorTypes`, `maxBytes`) when a grant was issued and narrowed successfully.

- Confirmed-secret sources always prepare as `minimal` with no chunks or JSON nodes, one policy omission, and no grant.
- Expired envelopes are swept before the active-envelope cap (64) is enforced.
- v1 prepares only `text/plain`, `text/markdown`, and `application/json`; everything else fails explicitly.

**Errors:** `CV_INPUT_INVALID`, `CV_PATH_*`, `CV_RETRIEVAL_POLICY_DENIED` (`safeDetails.reason`), `CV_PREPARE_MEDIA_UNSUPPORTED`, `CV_INPUT_UTF8_INVALID`, `CV_JSON_MALFORMED`, `CV_PARSE_*`, `CV_RESOURCE_*`, `CV_DEADLINE_EXCEEDED`, `CV_OPERATION_CANCELLED`, `CV_RESOURCE_CONCURRENCY_LIMIT`.

**Side effects:** commits one envelope (and at most one grant) to process memory; advances the version counter.

**Memory relation:** creates the derived state that every other stateful tool addresses.

## `contextvault_retrieve`

Returns one exact, bounded source slice for a prepared envelope. **Discloses content by design**, strictly bounded by the grant.

**Input:** `capability` (opaque token, shown once at prepare), exactly one `selector` (`chunk`+`chunkId`, `json_node`+`nodeId`, or `line_range`+`startLine`/`endLine`), optional `maxBytes` (≤ 1 MiB).

**Output:** `envelopeId`, `sourceId`, `sourceDigest`, `selector`, `locator`, `byteCount`, `excerptDigest`, `content` (≤ 1 MiB after UTF-8 boundary back-off), `truncated`, `hasMore`.

**Errors:** `CV_INPUT_INVALID`, `CV_CAPABILITY_INVALID` (unknown, malformed, expired, revoked, wrong session, wrong binding, or selector not allowlisted — indistinguishable), `CV_ENVELOPE_NOT_FOUND`, `CV_SELECTOR_UNSUPPORTED`, `CV_SOURCE_CHANGED`, `CV_RETRIEVAL_POLICY_DENIED` (`safeDetails.reason: "secret_policy"`), `CV_DEADLINE_EXCEEDED`, `CV_OPERATION_CANCELLED`.

**Side effects:** appends one bounded provenance record (≤ 32 per process, ≤ 8 per envelope) recording envelope/source/selector/digest metadata — never content.

**Memory relation:** consumes the grant issued at prepare; a second retrieval with the same capability is allowed while it stays valid.

## `contextvault_verify`

Runs deterministic, machine-checkable integrity checks for one prepared envelope. **Content-free.**

**Input:** `envelopeId`, `checks` (1–16) of `source_freshness`, `chunk_integrity` (+`chunkId`), `provenance_consistency`.

**Output:** per-check results with `status` (`valid` | `stale` | `invalid` | `unavailable`) and a `reasonCode`; `verifiedAt`.

- `source_unreadable` is a per-check outcome: when the source cannot be read (deleted, unauthorized, over-limit, or lost to a read race), source-dependent checks report `unavailable`/`source_unreadable` while envelope-local checks still evaluate. The failure detail, path, and system message are never disclosed.
- A missing envelope reports `unavailable`/`envelope_absent` for every requested check.

**Errors:** `CV_INPUT_INVALID`; operational failures (`CV_OPERATION_CANCELLED`, reader failures outside the readability set). Readability states are results, not errors.

**Side effects:** none beyond counters. Expired envelopes are swept first, so a stale envelope reports `envelope_absent`.

**Memory relation:** read-only over prepared state; proves internal consistency of the envelope chain, not external authenticity.

## `contextvault_stats`

Returns exact process-scoped counters. **Content-free.**

**Input:** `{}` (empty strict object).

**Output:** `counters` — `activeEnvelopeCount`, `activeGrantCount`, `authorizedRootCount`, `serializedDerivedRecordBytes`, `provenanceRecordsRetained`, `successfulRequests`, `failedRequests`, `envelopesRemovedByExpiry`, `envelopesRemovedByPurge`, `grantsRevoked`, `purgeIntentsConsumed` — plus `measuredAt`.

**Errors:** operational only (`CV_INTERNAL_ERROR` on internal failure); the input schema admits nothing else.

**Side effects:** none beyond counters. Expired envelopes are swept first, so counts reflect the live session.

**Memory relation:** read-only. The counters are operational bookkeeping, not savings, latency, or audit metrics.

## `contextvault_purge`

Deletes ContextVault-owned derived state for one envelope or the whole session. **Content-free.**

**Input:** two-step: `preview` requires `target` (`{ kind: "envelope", envelopeId }` or `{ kind: "all_derived_state" }`); `execute` requires the `purgeIntentId` returned by the preview.

**Output:** `preview` — `purgeIntentId`, `target`, `summary` (`envelopeCount`, `derivedBytes`), `expiresAt`. `execute` — `targetKind`, `deletedEnvelopes`, `deletedDerivedBytes`, `revokedIntents`, `revokedGrants`, `removedProvenanceRecords`.

**Errors:** `CV_INPUT_INVALID`, `CV_PURGE_INTENT_INVALID`, `CV_PURGE_INTENT_EXPIRED`, `CV_PURGE_INTENT_STALE`, `CV_ENVELOPE_NOT_FOUND`.

**Side effects:** `preview` stores one bounded intent (≤ 16 pending; oldest evicted); `execute` removes envelopes with their grants and provenance atomically and revokes matching pending intents. Original files are never touched.

**Memory relation:** the only destructive tool; scoped to this process session, never another session.

## Structured MCP result mapping

Application output is returned in MCP `structuredContent`. A concise JSON representation is returned in text content for compatible clients; it never duplicates large evidence payloads. Transport metadata belongs in MCP `_meta` and shall not contain sensitive source data. Failure responses always set `isError: true` and validate against the tool's output schema, so schema-aware clients can parse them without a special case.

## Schema inventory

| Tool     | Input schema                             | Output schema                             |
| -------- | ---------------------------------------- | ----------------------------------------- |
| Inspect  | `schemas/mcp/inspect.input.schema.json`  | `schemas/mcp/inspect.output.schema.json`  |
| Prepare  | `schemas/mcp/prepare.input.schema.json`  | `schemas/mcp/prepare.output.schema.json`  |
| Retrieve | `schemas/mcp/retrieve.input.schema.json` | `schemas/mcp/retrieve.output.schema.json` |
| Verify   | `schemas/mcp/verify.input.schema.json`   | `schemas/mcp/verify.output.schema.json`   |
| Stats    | `schemas/mcp/stats.input.schema.json`    | `schemas/mcp/stats.output.schema.json`    |
| Purge    | `schemas/mcp/purge.input.schema.json`    | `schemas/mcp/purge.output.schema.json`    |

Shared domain types are defined in `schemas/domain/common.schema.json`.

## Future design — not implemented

The following concepts appear nowhere in the version 1 runtime and must not be assumed by clients: task queries or token budgets as prepare inputs; fidelity levels or semantic transformation; `exact_text`, `symbol`, `json_path`, `event_id`, `time_range`, or `row_range` selectors; natural-language claim verification (`supported` / `contradicted` / `insufficient_evidence`); token-savings or latency metrics; network transports; persistence beyond process memory. They belong to future versions and require new schema versions before any client may rely on them.

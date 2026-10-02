# ContextVault Skill — Correct and Forbidden Examples

Companion to [SKILL.md](../SKILL.md). All examples use the real tool names
and schemas of the ContextVault MCP server.

## Correct patterns

### 1. Content-free scoping (inspect, then decide)

```json
{
  "tool": "contextvault_inspect",
  "input": { "source": { "kind": "workspace_file", "rootId": "project", "path": "src/main.ts" } }
}
```

Success returns metadata only (`sourceId`, `sourceDigest`, `mediaType`,
`bytes`, `sensitivity`, `secretRisk`, `supportedSelectors`, `inspectedAt`).
When `secretRisk` is `confirmed`, stop: the source is classified
`prohibited` and no retrieval grant is issued.

### 2. Bounded preparation with a narrow grant

```json
{
  "tool": "contextvault_prepare",
  "input": {
    "source": { "kind": "workspace_file", "rootId": "project", "path": "src/main.ts" },
    "ttlSeconds": 600,
    "retrieval": { "allowedSelectorTypes": ["chunk"], "maxBytes": 8192 }
  }
}
```

Success returns an `envelope` with `envelopeId`, chunk descriptors,
omissions, a structural fingerprint, and — only when granted — a
`retrieval` block holding one opaque `capability`.

### 3. Narrow retrieval, then re-verification

```json
{
  "tool": "contextvault_retrieve",
  "input": {
    "capability": "<capability-from-prepare>",
    "selector": { "kind": "chunk", "chunkId": "<chunk-id-from-envelope>" }
  }
}
```

```json
{
  "tool": "contextvault_verify",
  "input": {
    "envelopeId": "<envelope-id-from-prepare>",
    "checks": [{ "kind": "source_freshness" }, { "kind": "provenance_consistency" }]
  }
}
```

Quote the excerpt only when every check reports `valid`.

### 4. Session end (stats, then purge)

```json
{ "tool": "contextvault_stats", "input": {} }
```

```json
{
  "tool": "contextvault_purge",
  "input": { "operation": "preview", "target": { "kind": "all_derived_state" } }
}
```

```json
{
  "tool": "contextvault_purge",
  "input": { "operation": "execute", "purgeIntentId": "<purge-intent-id-from-preview>" }
}
```

### 5. Safe denial handling

A denied request returns a generic envelope, for example:

```json
{
  "schemaVersion": "1.0",
  "ok": false,
  "error": {
    "code": "CV_AUTHORIZATION_DENIED",
    "message": "The requested source is not authorized.",
    "correlationId": "cv_corr_xxxxxxxxxxxxxxxx",
    "retryable": false
  }
}
```

Correct behavior: explain the denial in general terms, narrow the request
to an authorized root, or stop. Never probe with alternative paths.

## Forbidden patterns

- `contextvault_retrieve` with a guessed, pasted-from-elsewhere, expired,
  or already-purged capability.
- Replacing `line_range` with `chunk` (or widening `maxBytes`) after a
  `CV_RETRIEVAL_POLICY_DENIED` or `CV_SELECTOR_UNSUPPORTED` denial.
- Retrying `CV_AUTHORIZATION_DENIED` under a different `rootId` or with `..`
  segments in `path`.
- Treating `stats` counters as savings, performance, or audit evidence.
- Treating a `verify` result as proof that a natural-language statement is
  true. Verification reports integrity states (`valid`, `stale`,
  `invalid`, `unavailable`) with machine-checkable reason codes only.
- Executing purge with a `target` and a `purgeIntentId` in the same call,
  or executing without a prior preview intent.
- Logging or repeating capability tokens, file content beyond the task's
  explicit need, absolute local paths, or raw system errors.

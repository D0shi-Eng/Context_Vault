# ContextVault Skill

Use this Skill when a task needs to inspect, quote, or verify exact content
from local source files through the ContextVault MCP server.

ContextVault is a local-first, stdio-based MCP server with a fail-closed
workflow. It exposes exactly six tools. No other tool names exist.

## When to use ContextVault

- The task needs metadata about a local file (size, digest, type,
  classification) without reading its content: use `contextvault_inspect`.
- The task needs a bounded structural map of a file (chunk ranges, JSON
  structure, omissions) without raw content: use `contextvault_prepare`.
- The task explicitly requires quoting an exact slice of an already prepared
  source: use `contextvault_retrieve` with the capability issued by prepare.
- The task needs to re-check that prepared state still matches the source on
  disk: use `contextvault_verify`.
- The task needs exact session bookkeeping (counts, removals, outcomes):
  use `contextvault_stats`.
- The task is finished and derived state must be removed: use
  `contextvault_purge` (preview first, then execute).

## When NOT to use ContextVault

- Do not use it for files outside an explicitly authorized workspace root.
  There is no runtime registration of roots; roots are declared once at
  server startup with `--workspace-root=<root-id>=<absolute-path>`.
- Do not use `contextvault_retrieve` for content-free workflows. Retrieval
  is content-revealing by design and requires an explicitly issued
  capability from `contextvault_prepare`.
- Do not use it as a general file reader, editor, shell, network client, or
  database. It cannot write files, run commands, open network connections,
  or persist anything beyond process-scoped memory.
- Do not use `contextvault_verify` to judge natural-language claims or
  semantic truth. It performs deterministic integrity checks only
  (`source_freshness`, `chunk_integrity`, `provenance_consistency`) with
  statuses `valid`, `stale`, `invalid`, or `unavailable`.
- Do not use `contextvault_stats` output as a savings, performance, or
  security metric. It reports exact operational counters only.

## Authorized workspace root (mandatory)

- Every source reference has the shape
  `{ "kind": "workspace_file", "rootId": "<root-id>", "path": "<rel-path>" }`.
- `<root-id>` must match `/^[a-z][a-z0-9_-]{0,63}$/` and must have been
  declared at server startup. Zero declared roots is valid and means every
  read fails closed with `CV_AUTHORIZATION_DENIED`.
- `<rel-path>` uses `/` separators, is relative to the root, and must stay
  inside it. Traversal (`..`), absolute paths, UNC paths, device paths,
  alternate data streams, reserved names, control characters, and
  over-length paths are denied.
- Never invent a root id, never rewrite a denied path into another root,
  and never ask the user for a broader root than the task needs.

## The six-tool workflow

Follow this order. Skip only steps the task does not need.

1. `contextvault_inspect` — content-free metadata for one file: `sourceId`,
   `sourceDigest` (`sha256:…`), `mediaType`, `bytes`, `sensitivity`,
   `secretRisk`, `supportedSelectors`, `inspectedAt`. No content is returned.
2. `contextvault_prepare` — bounded structural envelope for one inspected
   source: `envelopeId`, chunk descriptors, JSON node descriptors,
   omissions, structural fingerprint, TTL (`ttlSeconds` 60–7200, default
   1800), and an optional `retrieval` capability block. Raw-content-free.
   Retrieval grants are refused for confirmed-secret or unsupported sources.
3. `contextvault_retrieve` — exact bounded excerpt for one prepared source.
   Inputs: `capability` (the opaque `cv1_…` token from prepare),
   `selector` (exactly one of `chunk`, `json_node`, `line_range`), and an
   optional smaller `maxBytes` (hard ceiling 1048576). Output carries
   `excerptDigest` (`sha256:…`), `truncated`, and `hasMore`.
4. `contextvault_verify` — deterministic integrity re-check for one
   envelope: up to 16 checks per call. Re-run after every retrieval before
   quoting or acting on the excerpt.
5. `contextvault_stats` — exact process-scoped counters with an empty strict
   input `{}`. Never contains content, paths, tokens, or queries.
6. `contextvault_purge` — two-step removal of ContextVault-owned in-memory
   derived state only. `preview` with a `target` returns a `purgeIntentId`;
   `execute` with that intent id deletes. Purge never touches original
   sources, paths, or files. Memory also clears on process exit.

## Standing rules

- Retrieve content only on explicit need. Prefer inspect and prepare; call
  retrieve only when the task explicitly requires exact source text.
- Least capability: request the narrowest selector types, the smallest
  `maxBytes`, and the shortest TTL that satisfy the task.
- Bounded retrieval: never request more bytes than the task needs; honor
  `truncated` and `hasMore` instead of re-requesting wider slices.
- Re-verify after reading: run `contextvault_verify` (`source_freshness`
  at minimum) after each retrieval and before quoting the excerpt.
- Purge at task end: preview then execute purge for handled envelopes, or
  purge `all_derived_state` when the session is done.
- Fail closed: any `ok: false` envelope ends that line of work. Do not
  retry denied requests with alternative paths, roots, or wider selectors.
  Do not treat `stale` or `invalid` verification as usable evidence.
- Never leak paths, tokens, or secrets: never print, log, or repeat raw
  file content beyond the task's explicit need, local absolute paths,
  capability tokens (`cv1_…`), purge intent ids, digests used as secrets,
  secret values, or raw operating-system errors. Safe `CV_*` codes,
  `correlationId` values, and opaque identifiers (`cv_src_…`, `cv_env_…`)
  are safe to reference.
- Source changes: if verification reports `stale`, or an operation reports
  `CV_SOURCE_CHANGED`, stop using that envelope, re-inspect from scratch,
  and prepare a fresh envelope. Never quote the old excerpt as current.
- Denied requests: `CV_AUTHORIZATION_DENIED`, `CV_PATH_*`,
  `CV_CAPABILITY_INVALID`, `CV_RETRIEVAL_POLICY_DENIED`, and resource-limit
  errors are final for that request. Explain the denial in general terms,
  narrow the request, or stop. Never probe the boundary to distinguish
  unknown, expired, revoked, or mismatched capabilities.

## Examples

Correct — inspect first, prepare bounded, retrieve narrow, verify, purge:

```json
{
  "tool": "contextvault_inspect",
  "input": { "source": { "kind": "workspace_file", "rootId": "project", "path": "docs/notes.md" } }
}
```

```json
{
  "tool": "contextvault_prepare",
  "input": {
    "source": { "kind": "workspace_file", "rootId": "project", "path": "docs/notes.md" },
    "retrieval": { "allowedSelectorTypes": ["line_range"], "maxBytes": 4096 }
  }
}
```

```json
{
  "tool": "contextvault_retrieve",
  "input": {
    "capability": "<capability-from-prepare>",
    "selector": { "kind": "line_range", "startLine": 1, "endLine": 40 }
  }
}
```

```json
{
  "tool": "contextvault_verify",
  "input": {
    "envelopeId": "<envelope-id-from-prepare>",
    "checks": [{ "kind": "source_freshness" }]
  }
}
```

```json
{
  "tool": "contextvault_purge",
  "input": {
    "operation": "preview",
    "target": { "kind": "envelope", "envelopeId": "<envelope-id>" }
  }
}
```

Forbidden — never do these:

- Calling `contextvault_retrieve` without a prepare-issued capability.
- Widening `maxBytes` or switching selector kinds after a denial.
- Retrying a `CV_AUTHORIZATION_DENIED` request under a different root id.
- Quoting an excerpt after `stale` verification or `CV_SOURCE_CHANGED`.
- Pasting a `cv1_…` capability or file content into logs, issues, or chat
  beyond the task's explicit need.
- Using `contextvault_verify` to declare a natural-language claim true.

More examples live in [references/examples.md](references/examples.md).

## Secure engineering checklist (Skill execution policy)

Apply this checklist when the task builds an application. These rules are
Skill execution policy for agentic work; they are not automatically
enforced by the ContextVault MCP server, which only enforces its own
input validation, authorization, containment, bounded output, and safe
errors.

- Data classification: label data (public, internal, confidential,
  restricted, prohibited) and handle each level accordingly.
- Least privilege: grant the narrowest workspace root, capability scope,
  and selector range the task needs.
- Secret management: never hardcode, log, or echo secrets; use the
  platform's secret store and reference secrets by name.
- Encryption in transit: use TLS for every network hop the built
  application makes.
- Encryption at rest: enable it wherever the built application persists
  data. ContextVault itself keeps only process-scoped memory and performs
  no database encryption because it stores no database.
- Database authorization: enforce per-principal, per-operation checks at
  the data layer of the built application.
- Input validation: validate and bound every input with strict schemas;
  reject unknown fields.
- Output encoding: encode output for its sink (HTML, SQL, shell, JSON)
  before rendering or executing.
- Safe logging: log identifiers and codes, never content, paths, tokens,
  or secrets.
- Authentication and session security: require authentication for
  privileged actions, expire sessions, and bind capabilities to a session.
- Dependency security: pin versions, install with a frozen lockfile, and
  audit for vulnerabilities.
- Path traversal and SSRF prevention: contain file access to declared
  roots and validate every outbound request against an allowlist.
- Error sanitization: return stable, content-free error codes to callers;
  keep stack traces and system errors out of responses.
- Threat modeling: name the trust boundaries, threats, and controls for
  the built application before shipping changes.
- Tests and security verification: add tests proportional to risk and run
  formatting, lint, type checks, and security scans before delivery.

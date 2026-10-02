# Product Requirements

## 1. Purpose

ContextVault prepares large local sources for AI clients as bounded, content-free structural envelopes, declares every intentional omission, allows narrowly scoped exact retrieval under explicit grants, and verifies the integrity of prepared state deterministically.

## 2. Version 1 users

- A local user operating an MCP-compatible AI client.
- A security-conscious developer reviewing source code, logs, JSON, Markdown, or tabular data.
- An agent that must work within a bounded context budget without silently losing structural facts.

## 3. Functional requirements (implemented in v1)

### FR-001 — Local transport

The server operates over MCP `stdio` only. Version 1 opens no network listener.

### FR-002 — Explicit workspace authorization

The server accesses files only through relative paths rooted in workspace directories authorized at process startup with `--workspace-root=<id>=<absolute-path>`. With zero authorized roots every read fails closed with `CV_AUTHORIZATION_DENIED`.

### FR-003 — Source inspection

`contextvault_inspect` returns content-free metadata for one authorized source: canonical identity, media type, size, SHA-256 digest, sensitivity, secret risk, and the supported selectors derived from the retrieval grant policy.

### FR-004 — Deterministic preparation

`contextvault_prepare` builds a structural envelope deterministically: line-based chunking for plain text and Markdown, value-free JSON structural scanning for `application/json`, and a minimal record with an explicit policy omission for confirmed-secret material.

### FR-005 — Bounded structural disclosure

Envelopes carry descriptors, digests, byte and line spans, and opaque identifiers — never source content. Disclosure limits (1024 descriptors per envelope, 2048-character pointers, withheld locators) are recorded as explicit omission records with locator, reason, count, and retrievability.

### FR-006 — Omission disclosure

Every intentional omission or aggregation is recorded with its source locator, reason, item count, and retrieval availability.

### FR-007 — Context Envelope

Each prepare response returns a versioned envelope (`schemaVersion` `"1.0"`) containing provenance, classification, preparation kind, disclosure class, chunk or JSON-node descriptors, omissions, a structural fingerprint, and creation/expiry timestamps. An optional narrowed retrieval grant is returned exactly once.

### FR-008 — Scoped exact retrieval

`contextvault_retrieve` returns one exact, bounded slice selected by `chunk`, `json_node`, or `line_range` — the only selector kinds v1 grants can honor — with the output budget narrowed to the strictest of request, grant, and server ceiling, and truncation always reported.

### FR-009 — Capability isolation

Retrieval capabilities are opaque, digested at rest, short-lived, revocable, and bound to a session, envelope, workspace root, source identity and digest, selector-type allowlist, and byte limit. Every capability failure returns one generic code.

### FR-010 — Deterministic integrity verification

`contextvault_verify` evaluates machine-checkable checks — `source_freshness`, `chunk_integrity`, `provenance_consistency` — and returns per-check `valid`/`stale`/`invalid`/`unavailable` states with stable reason codes, including the per-check `source_unreadable` outcome. It never judges natural-language claims.

### FR-011 — Operational counters

`contextvault_stats` reports exact process-scoped counters: active envelopes and grants, authorized roots, serialized derived-record bytes, retained provenance, request outcomes, and lifetime expiry/purge bookkeeping.

### FR-012 — Session purge

`contextvault_purge` previews and then executes deletion of one envelope or all derived state of the current session, revoking associated capabilities, intents, and provenance. Original files are never touched.

### FR-013 — Safe cancellation and deadlines

Preparation and retrieval enforce deadlines; every long-running operation honors the caller's abort signal; failures never return partial content as success.

### FR-014 — Privacy-safe diagnostics

Errors use stable codes, concise English messages, allowlisted safe details, and correlation identifiers. No log, error, or response records source content, prompts, retrieved slices, secret values, capabilities, or canonical paths.

### FR-015 — Skill-guided workflow

The project includes an agent Skill that inspects before preparing, retrieves exact evidence only on explicit need, re-verifies after reading, and purges derived state at task end.

## 4. Non-functional requirements

### NFR-001 — Security

No public release may contain a known unresolved Critical or High finding. Authorization and integrity failures shall fail closed.

### NFR-002 — Fidelity

Structural descriptors, digests, and anchors in an envelope must be byte-exact against the prepared source; retrieval digests make completeness machine-checkable.

### NFR-003 — Privacy

Processing remains local in version 1. Remote telemetry and mandatory external APIs are prohibited.

### NFR-004 — Performance

Every operation enforces input, output, memory, time, and concurrency limits (see `docs/protocol/LIMITS_AND_TIMEOUTS.md`).

### NFR-005 — Reliability

Failure shall not silently corrupt evidence or convert an incomplete result into success. Every structural shortfall is explicit in the response.

### NFR-006 — Portability

The supported release matrix includes current supported Node.js LTS environments on Windows, macOS, and Linux, subject to verified CI evidence.

### NFR-007 — Maintainability

The Domain layer remains independent from MCP, filesystem, storage, network, and vendor SDKs. Forbidden dependency directions fail CI.

### NFR-008 — Testability

Time, identifiers, filesystem, hashing, and audit output are injected through ports or deterministic pure functions.

### NFR-009 — Accessibility of errors

Errors use stable codes, concise English messages, safe structured details, correlation identifiers, and explicit retry guidance.

### NFR-010 — Reproducibility

Release artifacts are traceable to a source revision, locked dependencies, checksums, provenance, and an SBOM.

## 5. Version 1 limits

Authoritative values are extracted from the implementation and maintained in `docs/protocol/LIMITS_AND_TIMEOUTS.md`. Summary:

| Limit                        |   Default | Hard maximum |
| ---------------------------- | --------: | -----------: |
| Source file read             |    32 MiB |       64 MiB |
| Retrieval output             |   256 KiB |        1 MiB |
| Serialized envelope metadata |   256 KiB |      256 KiB |
| Total derived state          |     4 MiB |        4 MiB |
| Active envelopes             |        64 |           64 |
| Chunks per envelope          |     1,024 |        1,024 |
| Concurrent preparations      |         2 |            4 |
| Envelope TTL                 |   1,800 s |      7,200 s |
| Preparation deadline         | 30,000 ms |    60,000 ms |
| Retrieval deadline           | 30,000 ms |    30,000 ms |

Hard maximums are compile-time or policy ceilings, not performance targets. Composition may reduce limits but shall not exceed them in version 1.

## 6. Prohibited version 1 behavior

- Reading a path outside an authorized workspace root.
- Treating a path string as authorization.
- Following a symbolic link or junction outside an authorized root.
- Disclosing content through inspect or prepare, or without a valid capability.
- Processing confirmed credential material beyond a minimal, non-content envelope.
- Logging raw content or retrieval capabilities.
- Returning content beyond the narrowed byte budget without reporting truncation.
- Opening a TCP, UDP, HTTP, WebSocket, or other network listener.
- Sending telemetry or source data over the network.
- Automatically changing an AI client's configuration.

## 7. Future design — not implemented

The following requirements are deliberately out of the v1 runtime and remain design targets for later versions; they are not contract and must not be assumed by clients: semantic transformation and fidelity levels; critical-evidence extractors with normalization rules; `exact_text`, `symbol`, `json_path`, `event_id`, `time_range`, and `row_range` selectors; natural-language claim verification; net token-savings metrics; persistence beyond process memory; network transports.

## 8. Success criteria for version 1

- All required quality gates pass: format, lint, typecheck, architecture, schemas, secrets, unit, integration, contract, build, E2E, coverage, package, SBOM, and mutation testing at or above the configured thresholds.
- Required test skips are zero.
- Secret findings across the complete Git history are zero.
- Cross-session and cross-workspace retrieval successes are zero.
- Public documentation and schemas match the implementation, and public limitations and residual risks match current evidence.

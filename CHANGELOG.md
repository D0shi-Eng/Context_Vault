# Changelog

All notable user-facing changes to ContextVault are documented here. Internal review rounds, raw verification evidence, and development-stage labels are intentionally excluded.

The project will follow Semantic Versioning after its first release.

## [Unreleased]

### Changed

- `inspect` now announces only the selector kinds a version 1 grant can actually honor (`chunk`, `json_node`, `line_range`), derived from the same policy that gates retrieval; previously announced selector kinds that v1 cannot prepare or honor (`exact_text`, `symbol`, `json_path`, `event_id`, `time_range`, `row_range`) are no longer advertised, and the JSON Schemas were aligned accordingly.
- `prepare` sweeps expired envelopes before enforcing the active-envelope cap, so a session holding only expired envelopes can prepare again without a purge.
- `verify` reports an unreadable source (deleted, unauthorized, over-limit, or lost to a read race) as a per-check `unavailable` / `source_unreadable` result instead of failing the whole tool call; envelope-local checks still evaluate.
- Documentation and schemas were rebuilt from the implementation: resource limits and deadlines, the error-code registry (two never-thrown codes were removed from the union), and all six tool contracts now match runtime behavior; requirements and acceptance-rubric items that depend on unimplemented v1+ design are explicitly marked `FUTURE DESIGN — NOT IMPLEMENTED`.

### Added

- A contract test keeps the documented error-code registry and the production `ContextVaultErrorCode` union from drifting apart.
- Focused scanner hardening tests for whitespace-padded empty JSON containers and post-separator whitespace, and use-case-level tests proving the retrieval grant barrier fails closed for non-object inputs without touching any port.
- Local `stdio` MCP server with six tools: inspect, prepare, retrieve, verify, stats, and purge.
- Startup-declared workspace roots with strict identifiers and canonical absolute paths.
- Fail-closed path authorization, linked-path denial, canonical containment, and bounded regular-file reads.
- Content-free inspection metadata, bounded structural envelopes, capability-scoped retrieval, integrity verification, exact session counters, and two-step derived-state purge.
- Conservative content classification that never returns or logs matched secret values.
- Process-scoped in-memory derived state with TTLs and hard resource ceilings.
- Strict JSON Schema contracts, stable `CV_*` error envelopes, and correlation identifiers.
- English and Arabic documentation for installation, MCP integration, security boundaries, tool usage, and troubleshooting.
- A ContextVault agent Skill with bounded retrieval and verification guidance.
- Static engineering diagrams and animated runtime wiring in English and Arabic.
- Reproducible TypeScript build, coverage gates, mutation testing, secret scanning, dependency auditing, SBOM generation, and pinned CI actions.

### Security

- Capability tokens contain 256 bits of cryptographic randomness; only SHA-256 digests are retained.
- Capability comparisons use constant-time digest comparison.
- Unexpected failures collapse to content-free internal errors.
- Source reads validate identity and stability before, during, and after bounded reading.

### Limitations

- Install from source only; no package or hosted service is published.
- The runtime is not approved for production or sensitive data.
- Current CI results are available in this repository's
  [Actions tab](https://github.com/D0shi-Eng/Context_Vault/actions).
  Hosted CI success does not imply production readiness or an independent
  security audit.

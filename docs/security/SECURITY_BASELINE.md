# Security Baseline

## Version 1 security boundary

- Local MCP over `stdio` only.
- No network listener.
- No remote telemetry.
- No mandatory AI-provider API.
- No arbitrary absolute-path authority.
- No persistent storage by default.
- No automatic client-configuration mutation.

## Protected assets

- User source content.
- Workspace paths and metadata.
- Exact evidence slices.
- Retrieval capabilities.
- Session identifiers.
- Local configuration.
- Release credentials and signing identities.
- Integrity of tool schemas, policies, and release artifacts.

## Initial threat categories

- Path traversal and symbolic-link escape.
- Prompt injection inside untrusted content.
- Capability disclosure, replay, mutation, or cross-session reuse.
- Secret leakage through source, tests, logs, errors, metrics, or Git history.
- Resource exhaustion through oversized, deeply nested, malformed, or adversarial input.
- Supply-chain compromise.
- Unauthorized persistence or retention.
- Tampering with evidence, omissions, metrics, or release artifacts.
- CI workflow injection and excessive token permissions.

## Baseline release requirements

No public release may claim complete security. The release may state that no known Critical or High finding remained after the documented checks, and must publish relevant limitations and residual risks.

# ADR-0002: Local-first Version 1 Boundary

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

Network listeners, hosted storage, remote telemetry, provider proxies, and automatic client configuration materially expand the attack surface and verification burden.

## Decision

Version 1 will use local MCP over `stdio`. It will not include an HTTP listener, remote telemetry, hosted storage, provider traffic interception, mandatory model API calls, or automatic mutation of client configuration.

Source access will require explicit workspace roots and canonical path authorization. Storage will be memory-only by default. Any persistent store will be optional, encrypted, and handled by a later accepted ADR.

## Alternatives considered

- HTTP and `stdio` in the first release: rejected because HTTP authentication, Origin validation, TLS, rate limiting, and network abuse controls require a separate security project.
- Provider proxy first: rejected because traffic interception broadens data exposure and creates model-specific coupling.
- Persistent database by default: rejected because it increases retention and key-management risks.

## Security consequences

The initial remote attack surface and default data retention are reduced. Local malicious processes and untrusted content remain in the threat model.

## Operational consequences

The first release prioritizes local clients and deterministic behavior. Remote and hosted use cases are deferred.

## Verification

Future CI will fail if version 1 introduces a network-listening dependency or remote telemetry path without a superseding ADR and security gate.

## Residual risks

- A compromised local client may send malicious tool arguments.
- Filesystem races and platform-specific path behavior require dedicated adversarial tests.
- `stdio` reduces network exposure but does not replace tool-level validation and authorization.

# ADR-0006: Canonical Workspace File Authority

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

A caller-controlled path string is not authorization. Cross-platform path syntax, symbolic links, junctions, device names, alternate data streams, Unicode ambiguity, and filesystem races can redirect an apparently relative path outside an intended workspace.

## Decision

ContextVault receives workspace roots only through trusted startup arguments. Each root has a validated opaque identifier and an absolute path that is canonicalized before MCP requests are accepted.

Every source request must pass all of these controls:

1. Strict protocol-schema validation.
2. Independent domain validation of the root identifier and relative path.
3. Rejection of absolute, drive-relative, UNC, device, alternate-stream, empty-segment, dot-segment, reserved-name, control-character, bidirectional-control, and non-NFC forms.
4. Selection of a previously canonicalized root by exact identifier.
5. Component-by-component symbolic-link and junction denial.
6. Canonical target containment beneath the authorized root.
7. Regular-file verification through the opened file handle.
8. Bounded reading with pre-read and post-read identity checks.

Authorization failures use stable content-free errors and do not disclose whether an unauthorized target exists.

## Alternatives considered

- String-prefix containment: rejected because sibling prefixes and separator differences bypass it.
- Normalize and accept ambiguous input: rejected because normalization can change caller intent and produce platform-specific aliases.
- Permit links that currently resolve inside the root: rejected for version 1 because retargeting and platform-specific reparse behavior increase race risk.
- Read by path after metadata checks: rejected because the checked object and opened object may differ.
- Expose absolute canonical paths as source identifiers: rejected because it leaks local layout and creates unstable public identifiers.

## Security consequences

The policy reduces traversal and link-based disclosure risk and limits successful reads to regular files under a startup-authorized root. It cannot prove atomic path traversal across every supported operating system because portable Node.js does not expose an identical `openat`-style primitive on all targets.

## Operational consequences

Users must declare roots when launching the MCP process. Links and junctions are denied even when they currently point inside the same authorized root. Source identifiers are derived from root identity, normalized relative path, and content digest without exposing the path.

## Verification

- Pure path-policy tests cover platform-independent hostile syntax.
- Property tests generate traversal and ambiguous path variants.
- Filesystem integration tests cover canonical containment, links, directories, missing sources, size limits, and stable reads.
- MCP tests assert schema validity and absence of content or local paths in success and error results.

## Residual risks

- A privileged or same-user attacker racing ancestor replacement may still exploit operating-system behavior that portable Node.js cannot make fully atomic.
- Network filesystems can provide weaker identity or timestamp semantics.
- Secret detection is defense in depth and cannot prove that a file contains no credential material.
- Platform-specific release gates remain mandatory on Windows, macOS, and Linux.

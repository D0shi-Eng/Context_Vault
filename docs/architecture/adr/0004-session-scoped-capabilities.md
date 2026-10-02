# ADR-0004: Session-scoped Retrieval Capabilities

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

A plain hash or global source identifier can become a bearer secret that grants broader retrieval than intended. Retrieval must remain narrow, expiring, revocable, and bound to the caller's current context.

## Decision

ContextVault will issue opaque authenticated capabilities. Each capability is bound to:

- Process session.
- Workspace root.
- Source identity and digest.
- Allowed operation.
- Supported selector classes.
- Maximum response bytes.
- Issued-at and expiry times.
- Revocation state.

The external token contains no readable path or source content. Authentication tags use constant-time comparison. Capabilities are never logged. Version 1 default lifetime is 30 minutes and the hard ceiling is two hours.

## Alternatives considered

- Truncated source hash as token: rejected because it lacks authorization scope and revocation semantics.
- Random database identifier: rejected because server-side lookup alone does not authenticate metadata integrity.
- Long-lived per-workspace token: rejected because compromise would expose too much data for too long.

## Security consequences

Leaked capabilities retain authority until expiry or revocation, but the blast radius is bounded. Process-memory compromise remains outside the guarantee of the application layer.

## Operational consequences

Session loss invalidates retrieval. Clients must handle expiry and re-prepare authorized sources.

## Verification

Tests must cover mutation, truncation, guessing, expiry, clock changes, revocation, replay, cross-session use, cross-workspace use, selector escalation, and byte-limit escalation.

## Residual risks

- A same-user local process may inspect memory depending on operating-system controls.
- Clock and lifecycle implementation errors could extend validity.
- Tokens may be copied by an AI client despite instructions; server enforcement remains authoritative.

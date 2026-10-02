# ADR-0005: Safe Errors and Allowlisted Observability

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

Debug logging and raw exception propagation can disclose source content, local paths, credentials, retrieval capabilities, or parser internals. Completely silent operation, however, prevents diagnosis and security monitoring.

## Decision

ContextVault will use stable structured error codes and allowlisted diagnostic fields. Logs record operation identity, correlation identifier, duration, byte counts, extractor identifier, result code, and bounded aggregate metrics only.

Raw source content, task queries, exact anchors, retrieved slices, capabilities, cryptographic material, detector matches, and unrestricted paths are prohibited from logs, metrics, snapshots, and user-facing errors.

Authorization failures do not reveal target existence. Development stack traces remain local and must pass redaction tests.

## Alternatives considered

- Log complete tool arguments and results in debug mode: rejected because debug mode is commonly enabled during incidents involving sensitive data.
- Disable all logs: rejected because it prevents reliable diagnosis and security evidence.
- Regex-only redaction of arbitrary payloads: rejected because unknown secret formats and personal data cannot be safely enumerated.

## Security consequences

Allowlisting materially reduces disclosure risk. Correlation metadata can still reveal operational patterns and therefore remains session-bounded.

## Operational consequences

Diagnosis relies on stable codes and reproducible tests instead of captured user content. Support procedures may request user-generated, explicitly reviewed diagnostic exports in a future design.

## Verification

Security tests inject synthetic secrets into every input and error path, then assert their absence from logs, metrics, snapshots, and exceptions.

## Residual risks

- Unexpected runtime or dependency output may bypass the application logger.
- File sizes and timing may provide limited side-channel information.
- Crash dumps are controlled by the operating system and require deployment guidance.

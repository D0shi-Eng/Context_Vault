# Protocol Versioning

## Schema version

The initial protocol schema version is `1.0`.

## Compatibility rules

- Adding an optional field is a minor-compatible change only when existing strict validators are not required to accept it. Because ContextVault rejects unknown properties, public output additions require a negotiated schema version or a documented compatibility mechanism.
- Removing a field, changing a field type, narrowing accepted input, changing identifier semantics, or changing authorization behavior is breaking.
- Error codes are stable public identifiers. Retiring a code requires a major version or an explicit deprecation period.
- Tool names remain stable within a major protocol version.
- Security tightening may intentionally reject requests accepted by an earlier version. Such changes require release notes, tests, and an ADR when client compatibility is affected.

## Version negotiation

Version 1 exposes `schemaVersion` in every application success and failure result. Future multi-version support must be explicit and shall not infer compatibility from client names or model identifiers.

## Deprecation policy

A public contract is not removed without:

1. A replacement or documented reason for removal.
2. A deprecation notice in release notes.
3. Compatibility tests for the supported transition.
4. Security review of downgrade and fallback behavior.

# Schemas

ContextVault uses JSON Schema 2020-12 for public MCP tool contracts and shared domain types.

## Rules

- Public objects reject unknown properties unless a documented compatibility boundary requires otherwise.
- `$id` values are stable logical identifiers and do not imply network retrieval.
- Runtime implementations shall bundle schemas locally and shall not fetch them from the network.
- Schema validation is necessary but not sufficient; semantic authorization, path policy, capability validation, range ordering, and source-integrity checks remain application responsibilities.
- Breaking schema changes require a new major schema version and an accepted Architecture Decision Record.

## Validation status

Automated validation verifies JSON syntax, identifier uniqueness, local reference existence, draft-2020-12 meta-schema conformance, and positive/negative instances.

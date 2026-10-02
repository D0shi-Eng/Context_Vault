# ADR-0003: Context Envelope as the Primary Output Contract

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

A compressed string hides what changed, what was omitted, where evidence came from, and whether exact recovery is possible. AI clients need structured provenance and explicit limitations rather than an opaque replacement text.

## Decision

`contextvault_prepare` returns a versioned Context Envelope. The envelope includes source and session identity, source digest, media type, fidelity policy, classification, summary, exact anchors, omissions, transformations, limitations, retrieval metadata, and measured metrics.

All omissions and transformations are explicit. Exact anchors carry source locators and digests. Retrieval is capability-scoped and optional. Unknown public fields are rejected in protocol version 1.

> **v1 implementation note.** The version 1 envelope implements the subset of the fields above that exist today: source and session identity, source digest, media type, classification, preparation kind, disclosure class, chunk/JSON-node descriptors, omission records, structural fingerprint, retrieval grant metadata, and creation/expiry timestamps. Fidelity policy, summaries, semantic transformations, and measured processing metrics do not exist in the v1 runtime and are `FUTURE DESIGN — NOT IMPLEMENTED` (see `docs/product/REQUIREMENTS.md`).

## Alternatives considered

- Return a compressed string: rejected because it lacks provenance and omission transparency.
- Return a summary and unrestricted source identifier: rejected because retrieval authorization would be ambiguous.
- Return the complete original with a summary: rejected because it does not solve the context-budget problem.

## Security consequences

The envelope can expose sensitive extracted evidence, so output limits and classification policy remain mandatory. Capability values are sensitive and prohibited from logs.

## Operational consequences

Clients can reason over structured evidence and request exact slices. Schema evolution requires explicit versioning.

## Verification

- JSON Schema exists for the envelope and all tool results.
- Golden corpus annotations define exact anchors and omissions.
- Meta-schema and positive/negative instance tests enforce the contract.

## Residual risks

- A correct envelope does not guarantee correct client reasoning.
- Large anchor sets may consume the output budget.
- Extractor policy may still fail to identify an important fact, requiring corpus expansion and retrieval.

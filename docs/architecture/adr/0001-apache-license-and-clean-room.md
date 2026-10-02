# ADR-0001: Apache-2.0 License and Clean-room Implementation

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

ContextVault is intended for public open-source distribution while preserving clear attribution, contribution provenance, and independent implementation ownership.

## Decision

ContextVault will use the Apache License, Version 2.0. Implementation, tests, documentation, diagrams, messages, and internal organization will be created independently from original requirements and public specifications.

The repository will include `LICENSE`, `NOTICE`, provenance rules, and contribution certification requirements. Third-party dependencies and incorporated material require compatible licensing and recorded attribution.

## Alternatives considered

- No license: rejected because it would not provide a practical open-source grant.
- MIT: rejected for the initial decision because Apache-2.0 provides an explicit patent grant and NOTICE mechanism.
- AGPL-3.0: rejected in favor of permissive adoption under Apache-2.0.

## Security consequences

License selection does not establish software security. Clean-room provenance reduces legal and supply-chain uncertainty but does not replace security review.

## Operational consequences

Contributors must submit compatible contributions. Release automation must preserve the license and NOTICE files.

## Verification

- Standard Apache-2.0 text is present in `LICENSE`.
- Attribution baseline is present in `NOTICE`.
- Clean-room requirements are documented.

## Residual risks

- The selected repository name overlaps with existing uses and requires a trademark-conflict review before commercial branding or package publication.
- The project currently uses an individual author identity rather than a registered company identity.

# Clean-room Development Policy

## Purpose

ContextVault must be an independently designed and implemented project. Public protocols, standards, and independently written requirements may inform behavior. Third-party implementation material must not become a substitute for original design.

## Prohibited actions

- Copying or mechanically translating third-party source code.
- Copying tests, fixtures, documentation, diagrams, messages, schemas, or comments.
- Preserving a third party's internal module layout or private terminology without an independent requirement.
- Removing attribution from incorporated third-party material.
- Using incompatible or unverified code snippets.
- Presenting third-party benchmark results as ContextVault evidence.

## Permitted inputs

- Public MCP and platform specifications.
- Official language and library documentation.
- Security standards and public vulnerability guidance.
- Original requirements, threat models, experiments, and independently generated tests.
- Compatible dependencies tracked through an approved dependency and license review.

## Evidence requirements

Each feature must link to an original requirement or public specification. Security and performance claims require current ContextVault test evidence. Similarity concerns must be reviewed before release.

## Escalation

If provenance or license compatibility is uncertain, development of the affected material stops until the issue is documented and resolved.

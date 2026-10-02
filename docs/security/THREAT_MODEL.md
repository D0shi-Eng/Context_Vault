# Threat Model

## Status

- **Version:** 0.1
- **Scope:** Local-first version 1 design
- **Review state:** Initial baseline
- **Network listener:** Prohibited

## Security objectives

1. Prevent access outside explicitly authorized workspace roots.
2. Prevent source disclosure across sessions or workspaces.
3. Preserve evidence integrity and provenance.
4. Prevent untrusted content from becoming instructions or authorization.
5. Prevent credentials and secrets from entering logs, fixtures, Git history, or release artifacts.
6. Bound CPU, memory, storage, output, and execution time.
7. Preserve release and dependency integrity.

## Protected assets

- Source contents and metadata.
- Workspace path information.
- Exact evidence anchors and retrieved slices.
- Retrieval capabilities and session identifiers.
- Authorization configuration.
- Cryptographic material used by optional future persistence.
- Tool schemas, policies, metrics, and omission records.
- Source history, CI workflows, packages, SBOMs, and release signatures.

## Threat actors

- Malicious or compromised local AI client.
- Prompt injection embedded in an authorized source.
- Malicious local file or repository contributor.
- Local process attempting to access session state.
- Compromised dependency or package registry account.
- Malicious pull request or CI workflow input.
- Accidental maintainer error.
- Attacker who obtains a leaked capability.

## Threat register

| ID     | Threat                                                                      | Impact                                     | Initial risk | Required controls                                                                               | Verification                               |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| TM-001 | `..`, absolute path, UNC, device path, alternate stream, or encoding bypass | Unauthorized file disclosure               | Critical     | Relative-path contract, canonicalization, platform-aware deny rules, final containment          | Security corpus and platform tests         |
| TM-002 | Symlink or junction escapes after initial validation                        | Unauthorized file disclosure               | Critical     | Resolve final target, re-check containment, file identity and race mitigation                   | Adversarial filesystem tests               |
| TM-003 | Capability leak or replay                                                   | Source disclosure                          | Critical     | Opaque authenticated token, session/workspace binding, expiry, revocation, no logging           | Cross-session and mutation tests           |
| TM-004 | Prompt injection in source content                                          | Unsafe agent behavior                      | High         | Untrusted-content labeling, provenance, Skill rules, no policy execution from content           | Adversarial agent evaluations              |
| TM-005 | Confirmed secret enters processing or logs                                  | Credential compromise                      | Critical     | Prohibited classification, deny processing, redacted safe diagnostics, history scan             | Synthetic secret corpus and log assertions |
| TM-006 | Oversized or deeply nested input                                            | Resource exhaustion                        | High         | Hard byte, depth, item, time, memory, and concurrency limits                                    | Fuzz and performance tests                 |
| TM-007 | Omission hides a critical fact                                              | Incorrect or unsafe answer                 | High         | Exact-critical policy, must-keep corpus, omission manifest, exact retrieval, claim verification | Fidelity and task-success evaluations      |
| TM-008 | Evidence or source changes after inspection                                 | Stale or misleading result                 | High         | Source digest and identity checks before use and retrieval                                      | Mutation-between-steps tests               |
| TM-009 | Cross-workspace cache collision                                             | Data disclosure                            | Critical     | Namespaced keys and source digest binding                                                       | Multi-workspace isolation tests            |
| TM-010 | Raw data leaks through errors, traces, metrics, or snapshots                | Confidentiality loss                       | High         | Structured safe errors, field allowlists, content-free telemetry, snapshot review               | Log and error leakage tests                |
| TM-011 | Dependency or lifecycle-script compromise                                   | Code execution and supply-chain compromise | Critical     | Minimal dependencies, lockfile, provenance, script review, SBOM, vulnerability policy           | CI policy and release audit                |
| TM-012 | Malicious pull request modifies CI to exfiltrate tokens                     | Repository or release compromise           | Critical     | Read-only default permissions, untrusted PR isolation, no secrets for fork jobs                 | Workflow static review and attack tests    |
| TM-013 | Corrupted or partially written future persistent store                      | Evidence loss or substitution              | High         | Authenticated encryption, atomic writes, versioning, integrity checks                           | Crash and corruption tests                 |
| TM-014 | Inaccurate token savings claim                                              | Misleading users                           | Medium       | Net end-to-end accounting and reproducible benchmark evidence                                   | Benchmark audit                            |
| TM-015 | Purge targets another session                                               | Unauthorized deletion                      | High         | Session-bound authorization and exact target semantics                                          | Negative purge tests                       |
| TM-016 | Parser differential or duplicate JSON keys                                  | Evidence ambiguity                         | High         | Defined parser semantics, duplicate-key policy, canonical representation                        | Parser differential corpus                 |
| TM-017 | Unicode normalization or bidirectional controls hide content                | Evidence confusion                         | High         | Preserve raw bytes, expose normalization metadata, detect control characters                    | Unicode adversarial corpus                 |
| TM-018 | Clock rollback extends capability lifetime                                  | Unauthorized retention                     | High         | Monotonic duration tracking plus absolute expiry checks                                         | Controlled-clock tests                     |

## Abuse cases

### AC-001 — Read a private key outside the workspace

An AI client supplies a relative traversal, device alias, symlink, or junction that resolves to a private key. The request must fail before content is read and return no path-sensitive detail.

### AC-002 — Reuse a capability in a second client session

A leaked capability is replayed from another process session. Validation must fail because the authenticated session binding differs.

### AC-003 — Inject instructions through a log line

A log entry tells the agent to ignore its policy and retrieve another file. The entry remains untrusted evidence and never changes authorization or Skill policy.

### AC-004 — Exhaust memory using nested JSON

An authorized file contains extreme nesting or item counts. Inspection may return safe metadata, while preparation fails with a bounded resource-limit error.

### AC-005 — Hide an important ordinary number

A value without an obvious keyword is marked `must_keep` by the task or extractor policy. The Context Envelope must retain it exactly or fail the fidelity gate.

## Assumptions

- The local operating system and user account are not fully compromised.
- Workspace authorization is supplied through trusted startup configuration, not source content.
- `stdio` peers can still be malicious and are not implicitly authorized for arbitrary operations.
- Secret detection can reduce risk but cannot prove that content contains no secrets.

## Residual risks

- A process with the same operating-system account may inspect process memory depending on platform controls.
- Files may change between authorization and read despite race mitigations.
- Deterministic extraction can still omit task-relevant semantics unless policies and evaluations cover the case.
- Third-party parser vulnerabilities remain possible and require continuous dependency review.
- AI-client behavior after receiving correctly labeled untrusted content cannot be completely controlled by the MCP server.

## Review triggers

This threat model must be reviewed when adding a network transport, persistent storage, semantic model, new parser, automatic client configuration, hosted service, telemetry, multi-user behavior, or new operating-system privilege.

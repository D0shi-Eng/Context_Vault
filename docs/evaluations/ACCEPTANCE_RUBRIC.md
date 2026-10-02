# Acceptance Rubric

## Release decision

Every requirement is evaluated from current checkout evidence. Test names, planned tests, mocks, historical reports, and skipped checks are not proof of closure.

## Security gates

| ID     | Requirement                                               | Release threshold  |
| ------ | --------------------------------------------------------- | ------------------ |
| SEC-01 | Critical findings                                         | 0 unresolved       |
| SEC-02 | High findings                                             | 0 unresolved       |
| SEC-03 | Known secrets in working tree or Git history              | 0 unresolved       |
| SEC-04 | Unauthorized path reads                                   | 0 successful cases |
| SEC-05 | Cross-session or cross-workspace retrieval                | 0 successful cases |
| SEC-06 | Raw content or capability leakage through logs and errors | 0 occurrences      |
| SEC-07 | Required security tests skipped or not run                | 0                  |
| SEC-08 | Unsupported network listener in version 1                 | 0                  |

## Fidelity gates

| ID     | Requirement                                             | Release threshold |
| ------ | ------------------------------------------------------- | ----------------- |
| FID-01 | `must_keep` fact preservation                           | 100%              |
| FID-02 | Numeric, unit, identifier, hash, and timestamp mutation | 0                 |
| FID-03 | Intentional omissions represented in manifest           | 100%              |
| FID-04 | Unsupported critical claims marked supported            | 0                 |
| FID-05 | Contradicted critical claims marked supported           | 0                 |
| FID-06 | Source digest mismatch accepted                         | 0                 |

> **v1 scope note.** Only FID-03 (omission records in the envelope) and FID-06 (digest-bound verification) are exercisable against the version 1 runtime as implemented. FID-01, FID-02, FID-04, and FID-05 depend on critical-evidence extractors and natural-language claim verification, which are `FUTURE DESIGN — NOT IMPLEMENTED` (see `docs/product/REQUIREMENTS.md`, section 7). They cannot gate a v1 release and must not be reported as `PASS` from v1 evidence; a v1 release decision marks them out of scope instead.

## Reliability gates

| ID     | Requirement                                           | Release threshold              |
| ------ | ----------------------------------------------------- | ------------------------------ |
| REL-01 | Flaky release-gate tests                              | 0                              |
| REL-02 | Capability expiry and revocation correctness          | 100% in controlled-clock suite |
| REL-03 | Unmarked partial success                              | 0                              |
| REL-04 | Crash or uncaught exception in approved fuzz duration | 0                              |
| REL-05 | Store or parser corruption reported as success        | 0                              |

## Maintainability gates

| ID       | Requirement                                                | Release threshold                     |
| -------- | ---------------------------------------------------------- | ------------------------------------- |
| MAINT-01 | Domain dependency on MCP, filesystem, network, or database | 0                                     |
| MAINT-02 | Overall branch coverage                                    | At least 90%                          |
| MAINT-03 | Domain and security-policy branch coverage                 | 100% or approved documented exception |
| MAINT-04 | Domain mutation score                                      | At least 85%                          |
| MAINT-05 | Unjustified `any` in TypeScript                            | 0                                     |
| MAINT-06 | Undocumented security-sensitive decision                   | 0                                     |

## Performance and value gates

Performance thresholds are established on named hardware and datasets before release. The initial target is a median net token reduction of at least 15% without a task-success regression greater than the approved confidence bound.

Net savings include retrievals, retries, generated outputs, and protocol overhead. Gross compression ratio alone is not an acceptance metric.

## Status assignment

- `PASS`: implementation and required evidence satisfy the threshold.
- `CONDITIONAL_PASS`: evidence satisfies a reduced or explicitly bounded scope.
- `IMPLEMENTED_NOT_VERIFIED`: code exists but required evidence is incomplete.
- `NOT_RUN`: the required check has not run.
- `BLOCKED`: an external prerequisite prevents the check.
- `NO_GO`: phase progression or release is prohibited.

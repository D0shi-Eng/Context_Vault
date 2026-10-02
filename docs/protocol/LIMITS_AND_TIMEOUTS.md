# Limits and Timeouts

## Policy

Limits are security controls. They are enforced inside the application boundary and cannot be increased beyond version 1 hard ceilings through tool arguments or environment variables. Every value below is extracted from the implementation; the authoritative constants live in `src/domain/preparation/preparation-limits.ts`, `src/domain/retrieval/retrieval-grant-policy.ts`, `src/domain/verification/verification-policy.ts`, and `src/application/inspection/inspect-source.ts`.

## Resource limits

| Resource                        |                    Default | Hard ceiling | Failure code                      |
| ------------------------------- | -------------------------: | -----------: | --------------------------------- |
| Source read bytes               |                     32 MiB |       64 MiB | `CV_RESOURCE_SOURCE_TOO_LARGE`    |
| Retrieval grant output bytes    |                    256 KiB |        1 MiB | narrowed, never an error          |
| Per-call retrieval output bytes |                        n/a |        1 MiB | narrowed, never an error          |
| Active envelopes                |                         64 |           64 | `CV_RESOURCE_ENVELOPE_LIMIT`      |
| Total derived state             |                      4 MiB |        4 MiB | `CV_RESOURCE_DERIVED_STATE_LIMIT` |
| Serialized envelope metadata    |                    256 KiB |      256 KiB | `CV_RESOURCE_ENVELOPE_TOO_LARGE`  |
| Chunks per envelope             |            keep 4 KiB each |        1,024 | recorded as omissions             |
| JSON nesting depth              |                         64 |           64 | `CV_PARSE_DEPTH_EXCEEDED`         |
| JSON nodes                      |                     50,000 |       50,000 | `CV_PARSE_ITEM_LIMIT_EXCEEDED`    |
| Disclosed JSON node descriptors |                      1,024 |        1,024 | recorded as omissions             |
| JSON Pointer length             | 2,048 chars (128 segments) |         same | withheld locators                 |
| Tracked JSON keys per object    |                      4,096 |        4,096 | duplicate detection disabled      |
| Retained JSON locator budget    |                    128 KiB |      128 KiB | withheld locators                 |
| Text lines                      |                  1,000,000 |    1,000,000 | `CV_PARSE_LINE_LIMIT_EXCEEDED`    |
| Concurrent preparations         |                          2 |            4 | `CV_RESOURCE_CONCURRENCY_LIMIT`   |

Notes:

- The source read default (32 MiB) applies to inspect, prepare, verify, and the retrieval source re-read. Only the inspect use case accepts a composition-time override, and it must stay at or below the 64 MiB hard ceiling. Exceeding the limit during a read fails with `CV_RESOURCE_SOURCE_TOO_LARGE`; it never truncates into a success.
- Retrieval output is bounded by narrowing, not rejection: the effective budget is the strictest of the request `maxBytes`, the grant `maxBytes`, and the 1 MiB server ceiling. Content beyond the budget is cut on a UTF-8 code-point boundary and reported through `byteCount`, `truncated`, and `hasMore`.
- Expired envelopes are swept before the active-envelope cap is enforced, so expired state can never wedge preparation. Live envelopes and their grants are never removed by the sweep.

## Timeouts and expiries

| Control                           |   Default | Hard ceiling | Failure code                               |
| --------------------------------- | --------: | -----------: | ------------------------------------------ |
| Envelope TTL                      |    1800 s |       7200 s | `CV_INPUT_INVALID` (out-of-bounds request) |
| Grant TTL                         |    1800 s |       7200 s | narrowed to envelope TTL                   |
| Minimum TTL                       |      60 s |         60 s | `CV_INPUT_INVALID`                         |
| Prepare deadline                  | 30,000 ms |    60,000 ms | `CV_DEADLINE_EXCEEDED`                     |
| Retrieve deadline                 | 30,000 ms |    30,000 ms | `CV_DEADLINE_EXCEEDED`                     |
| Inspect / verify / stats deadline |      none |         none | bounded by input limits                    |

Notes:

- Inspect, verify, stats, and purge run synchronously after input validation and are bounded by the structural limits above; they carry no wall-clock deadline in version 1.
- Expired envelopes and grants are removed by the shared sweep that runs at the start of prepare, retrieve, verify, and stats operations. A capability that is unknown, expired, revoked, or bound to different state always returns `CV_CAPABILITY_INVALID`; the failure reason is never distinguished to the caller.

## Request bounds

| Bound                           |                          Value | Failure code           |
| ------------------------------- | -----------------------------: | ---------------------- |
| Verification checks per request |                           1–16 | `CV_INPUT_INVALID`     |
| Retrieval selector line range   |                    ≤ 1,000,000 | `CV_INPUT_INVALID`     |
| Pending purge intents           |            16 (oldest evicted) | lifecycle errors below |
| Retained provenance records     | 32 per process, 8 per envelope | oldest evicted         |

## Failure behavior

- A limit violation is never truncated into an unmarked success.
- Safe partial diagnostic metadata (`safeDetails`) may be returned only inside an explicitly failed response.
- Capability and authorization checks occur before expensive parsing.
- Cancellation stops further reads and extractor work as soon as safely possible and is reported as `CV_OPERATION_CANCELLED`.
- A fallback to unmodified input is not implemented in version 1; over-budget structural content is disclosed as explicit omission records instead.

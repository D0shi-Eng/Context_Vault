# Data Classification and Handling

## Classification levels

| Level          | Examples                                                            | Version 1 handling                                                              |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `public`       | Published documentation and public source code                      | Deterministic preparation and session retrieval permitted.                      |
| `internal`     | Local project files without sensitive data                          | Deterministic preparation and session retrieval permitted.                      |
| `confidential` | Private source, internal logs, unpublished designs                  | Exact or exact-critical mode only by default; memory-only retention.            |
| `restricted`   | Personal data, security incidents, sensitive business records       | Exact-critical mode, stricter output limits, no persistence, explicit warnings. |
| `prohibited`   | Credentials, private keys, authentication tokens, credential stores | Processing and retrieval denied in version 1.                                   |

## Secret-risk states

- `none`: no known credential signal was detected.
- `suspected`: one or more heuristic indicators require restrictive handling.
- `confirmed`: a recognized credential or private-key structure was detected; processing is denied.
- `unknown`: classification could not complete safely; preparation fails closed.

Secret detection is defense in depth and shall never be described as complete.

## Transformation policy

| Classification |            `none` |           `exact` |  `exact-critical` |      `balanced` |           `semantic` |
| -------------- | ----------------: | ----------------: | ----------------: | --------------: | -------------------: |
| `public`       |             Allow |             Allow |             Allow |           Allow | Explicit opt-in only |
| `internal`     |             Allow |             Allow |             Allow |           Allow | Explicit opt-in only |
| `confidential` |             Allow |             Allow |             Allow | Deny by default |                 Deny |
| `restricted`   | Allow with limits | Allow with limits | Allow with limits |            Deny |                 Deny |
| `prohibited`   |              Deny |              Deny |              Deny |            Deny |                 Deny |

## Logging policy

Logs may contain:

- Correlation identifier.
- Tool name.
- Start and completion time.
- Duration bucket.
- Input and output byte counts.
- Result and error codes.
- Extractor identifier and version.

Logs shall not contain:

- Paths beyond a non-reversible workspace-relative identifier.
- Source text or binary content.
- User prompts or task queries.
- Exact anchors or retrieved slices.
- Capability values or cryptographic keys.
- Secret detector matches.

## Retention policy

- Session memory expires after 30 minutes by default.
- The user may shorten retention but not exceed the two-hour version 1 ceiling.
- Purge revokes all related capabilities immediately.
- Persistent storage is excluded until a separate accepted ADR and security review.
- Metrics use bounded aggregate counters and expire with the session unless the user explicitly exports a privacy-safe report.

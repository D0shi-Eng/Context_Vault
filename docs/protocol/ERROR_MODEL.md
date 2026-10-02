# Error Model

## Objectives

Errors must be stable for clients, safe for users, useful for operators, and incapable of leaking source content, paths, secrets, capabilities, or internal stack traces.

## Error shape

```json
{
  "schemaVersion": "1.0",
  "ok": false,
  "error": {
    "code": "CV_PATH_OUTSIDE_WORKSPACE",
    "message": "The requested source is not authorized.",
    "correlationId": "cv_corr_...",
    "retryable": false,
    "safeDetails": {
      "reason": "policy"
    }
  }
}
```

## Rules

- `message` is concise English and safe to display.
- `safeDetails` is an allowlisted flat map: keys must match `^[a-z][A-Za-z0-9]{0,63}$`, values must be strings (≤ 256 characters), numbers, booleans, or null, at most 16 entries. An application error carrying anything else is rebuilt as `CV_INTERNAL_ERROR` without the details.
- Stack traces never reach the transport layer; raw operating-system errors are mapped to stable application codes.
- Authorization failures do not reveal whether an unauthorized target exists.
- Secret detection does not echo the matched value, surrounding text, or exact location.
- Capability failures use one generic code; unknown, altered, expired, revoked, and wrong-binding capabilities are indistinguishable to the caller.
- Parse failures identify bounded structural coordinates (depth, counts, omission records) but never echo source fragments.
- Every failure response carries a correlation id, and every failure increments the session failure counter.

## Error code registry

The registry below matches the `ContextVaultErrorCode` union in `src/domain/errors/context-vault-error.ts` exactly. A contract test (`tests/contract/error-code-registry.test.ts`) fails when the documentation and the union drift apart. Codes that no production path can throw are removed from the union; there are no reserved or decorative codes.

### Input and schema

| Code               | Meaning and when returned                                                                                                                                                                                                 | Retryable | Safe details      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------- |
| `CV_INPUT_INVALID` | A request value failed its use-case boundary validation: unknown keys, out-of-range integers, malformed selectors, unsupported discriminator values, unknown verification check kinds, malformed purge or grant requests. | No        | No (message only) |

### Authorization and paths

| Code                           | Meaning and when returned                                                                                                                                                                                                  | Retryable     | Safe details |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ |
| `CV_AUTHORIZATION_DENIED`      | The `rootId` was not declared at startup, or the operating system denied access (`EACCES`/`EPERM`).                                                                                                                        | No            | No           |
| `CV_PATH_INVALID`              | The relative path is malformed (empty segment, control or bidirectional character, reserved Windows name, disallowed form).                                                                                                | No            | No           |
| `CV_PATH_ABSOLUTE_DENIED`      | The request carried an absolute or drive-relative path.                                                                                                                                                                    | No            | No           |
| `CV_PATH_OUTSIDE_WORKSPACE`    | The path escapes its authorized root via traversal.                                                                                                                                                                        | No            | No           |
| `CV_PATH_REPARSE_POINT_DENIED` | A path component is a symlink, junction, or reparse point (`ELOOP`).                                                                                                                                                       | No            | No           |
| `CV_PATH_SPECIAL_FILE_DENIED`  | The target is a directory or another special file type, not a regular file (`EISDIR`).                                                                                                                                     | No            | No           |
| `CV_SOURCE_NOT_FOUND`          | The source file does not exist (`ENOENT`/`ENOTDIR`).                                                                                                                                                                       | No            | No           |
| `CV_SOURCE_CHANGED`            | The source changed after preparation (digest mismatch) or during a read (metadata race). The mid-read variant is retryable; the digest-mismatch variant is not retryable until the source is re-inspected and re-prepared. | Mid-read: yes | No           |

### Classification and policy

| Code                           | Meaning and when returned                                                                                                                             | Retryable | Safe details                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------- |
| `CV_PREPARE_MEDIA_UNSUPPORTED` | The source media type cannot be prepared in version 1 (only `text/plain`, `text/markdown`, `application/json` are preparable).                        | No        | No                                  |
| `CV_INPUT_UTF8_INVALID`        | A source authorized for preparation is not valid UTF-8 text.                                                                                          | No        | No                                  |
| `CV_RETRIEVAL_POLICY_DENIED`   | A requested retrieval grant or excerpt was denied by policy: confirmed-secret material, unsupported preparation kind, or empty/narrowed selector set. | No        | `reason` (the denial category only) |
| `CV_SELECTOR_UNSUPPORTED`      | The requested selector exists but is not available for this envelope's preparation kind.                                                              | No        | No                                  |

### Parsing and extraction

| Code                           | Meaning and when returned                              | Retryable | Safe details |
| ------------------------------ | ------------------------------------------------------ | --------- | ------------ |
| `CV_JSON_MALFORMED`            | The JSON document failed strict structural validation. | No        | No           |
| `CV_PARSE_DEPTH_EXCEEDED`      | The JSON document exceeded 64 nesting levels.          | No        | No           |
| `CV_PARSE_ITEM_LIMIT_EXCEEDED` | The JSON document exceeded 50,000 nodes.               | No        | No           |
| `CV_PARSE_LINE_LIMIT_EXCEEDED` | The text source exceeded 1,000,000 lines.              | No        | No           |

### Capability and session

| Code                    | Meaning and when returned                                                                                                        | Retryable | Safe details |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------ |
| `CV_CAPABILITY_INVALID` | The capability token is unknown, malformed, expired, revoked, bound to another session, or not valid for the requested selector. | No        | No           |
| `CV_ENVELOPE_NOT_FOUND` | The envelope referenced by a retrieval no longer exists in this session.                                                         | No        | No           |

### Resource and operation

| Code                              | Meaning and when returned                                                | Retryable | Safe details                          |
| --------------------------------- | ------------------------------------------------------------------------ | --------- | ------------------------------------- |
| `CV_RESOURCE_SOURCE_TOO_LARGE`    | The source exceeds the configured read limit.                            | No        | `maximumBytes` (the configured limit) |
| `CV_RESOURCE_ENVELOPE_LIMIT`      | The active-envelope cap (64) was reached with no expired state to sweep. | No        | No                                    |
| `CV_RESOURCE_ENVELOPE_TOO_LARGE`  | The serialized derived metadata exceeds 256 KiB for one envelope.        | No        | No                                    |
| `CV_RESOURCE_DERIVED_STATE_LIMIT` | The total derived state exceeds 4 MiB.                                   | No        | No                                    |
| `CV_RESOURCE_CONCURRENCY_LIMIT`   | The concurrent-preparation gate (default 2) is full.                     | Yes       | No                                    |
| `CV_DEADLINE_EXCEEDED`            | The prepare or retrieve deadline passed.                                 | Yes       | No                                    |
| `CV_OPERATION_CANCELLED`          | The caller's abort signal fired.                                         | Yes       | No                                    |

### Purge lifecycle

| Code                      | Meaning and when returned                                               | Retryable | Safe details |
| ------------------------- | ----------------------------------------------------------------------- | --------- | ------------ |
| `CV_PURGE_INTENT_INVALID` | The purge intent identifier is unknown, malformed, or already consumed. | No        | No           |
| `CV_PURGE_INTENT_EXPIRED` | The purge intent outlived its preview validity.                         | No        | No           |
| `CV_PURGE_INTENT_STALE`   | The target state changed after the preview.                             | No        | No           |

### Internal and configuration

| Code                       | Meaning and when returned                                                                                                                                                             | Retryable | Safe details |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------ |
| `CV_CONFIGURATION_INVALID` | Startup arguments, composition limits, or a workspace root are invalid; also a mid-operation configuration violation. Never caused by client input.                                   | No        | No           |
| `CV_INTERNAL_ERROR`        | An unexpected failure, a failed integrity check inside the server, or an application error whose details could not be safely narrowed. The original failure never reaches the client. | No        | No           |

## Leak prohibitions

No error response may contain: source content or fragments, absolute or canonical paths, capability tokens, session identifiers beyond the correlation id, secret matches, operating-system messages, or stack frames. `safeDetails` carries only the allowlisted diagnostic fields listed above.

## Retry policy

Only transient resource and cancellation failures may set `retryable: true`: `CV_RESOURCE_CONCURRENCY_LIMIT`, `CV_DEADLINE_EXCEEDED`, `CV_OPERATION_CANCELLED`, and the mid-read variant of `CV_SOURCE_CHANGED`. Authorization, policy, capability, malformed-input, and digest-mismatch failures are not retryable without a material change to the request or the environment.

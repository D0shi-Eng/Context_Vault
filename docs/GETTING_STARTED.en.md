# Getting started with ContextVault

This guide covers installing ContextVault from source, building it, running
it as an MCP server over stdio, and operating one full, safe usage cycle.
For architecture and the security model, see
[README.en.md](../README.en.md); for connection details and error tables,
see [INTEGRATION.md](INTEGRATION.md).

## 1. Requirements

- **Node.js 24 or newer** (`engines` in `package.json` requires
  `>=24.0.0`). Check with `node --version`.
- **pnpm 11.19.0** (pinned by `packageManager` in `package.json`).
- A local source checkout of this repository. There is no published npm
  package and no hosted service; installing from source is the only
  supported way.
- A supported operating system with a local filesystem (Windows, Linux,
  or macOS). The server never opens a network port.

## 2. Install from source

Clone the repository into a directory named `ContextVault`. The repository
currently requires authorized access:

```bash
git clone https://github.com/D0shi-Eng/Context_Vault.git ContextVault
cd ContextVault
```

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
```

If corepack is unavailable on your Node distribution, install pnpm directly:

```bash
npm install -g pnpm@11.19.0
```

Then install the locked dependencies:

```bash
pnpm install --frozen-lockfile
```

## 3. Build

```bash
pnpm run build
```

This is a strict TypeScript compile (`tsc -p tsconfig.build.json`) that
produces ESM output in `dist/`. The server entrypoint is `dist/main.js`.

Optional, before first use — run the full local quality gate:

```bash
pnpm run check
```

## 4. Run the MCP server over stdio

The server is a child process of your MCP host. It reads JSON-RPC from
standard input and writes to standard output. Do not run it interactively
and expect useful output; it speaks JSON-RPC only.

Authorize workspace roots at startup:

```bash
node dist/main.js --workspace-root=demo=C:/Projects/ExampleWorkspace
```

Multiple roots use repeated flags:

```bash
node dist/main.js --workspace-root=alpha=C:/Projects/Alpha --workspace-root=beta=D:/Work/Beta
```

Root rules:

- Format: `--workspace-root=<root-id>=<absolute-path-to-directory>`.
- `<root-id>` matches `/^[a-z][a-z0-9_-]{0,63}$/`; duplicates are rejected.
- The path must be absolute, existing, and a directory. A root that
  canonicalizes to a filesystem root (`/`, `C:\`) is refused.
- Roots are fixed at startup. There is no runtime registration.
- Declaring zero roots is valid: the server starts and every read fails
  closed with `CV_AUTHORIZATION_DENIED`.

## 5. Generic MCP client configuration

Client-neutral shape — point `command` at your Node runtime and `args` at
the built entrypoint:

```json
{
  "mcpServers": {
    "contextvault": {
      "command": "node",
      "args": [
        "C:/Projects/ContextVault/dist/main.js",
        "--workspace-root=project=C:/Projects/ExampleWorkspace"
      ]
    }
  }
}
```

On Windows, escape JSON paths with forward slashes (`C:/…`) or doubled
backslashes (`C:\\…`).

## 6. One safe usage cycle

Source reference used throughout this cycle:

```json
{ "source": { "kind": "workspace_file", "rootId": "project", "path": "docs/notes.md" } }
```

1. **Inspect** — content-free metadata:

   Tool: `contextvault_inspect`, input: the source reference above.
   Returns `sourceId`, `sourceDigest`, `mediaType`, `bytes`,
   `sensitivity`, `secretRisk`, `supportedSelectors`, `inspectedAt`.
   The response never contains source content.

2. **Prepare** — bounded structural envelope, with a narrow retrieval
   grant:

   Tool: `contextvault_prepare`:

   ```json
   {
     "source": { "kind": "workspace_file", "rootId": "project", "path": "docs/notes.md" },
     "retrieval": { "allowedSelectorTypes": ["line_range"], "maxBytes": 4096 }
   }
   ```

   Returns `envelopeId` and an optional `retrieval.capability` token.
   The server stores only a SHA-256 digest of that token.

3. **Retrieve** — only when exact text is explicitly needed:

   Tool: `contextvault_retrieve`:

   ```json
   {
     "capability": "<from-prepare>",
     "selector": { "kind": "line_range", "startLine": 1, "endLine": 40 }
   }
   ```

   Returns one bounded excerpt with `excerptDigest`, `truncated`,
   `hasMore`. This is the only content-revealing tool.

4. **Verify** — before quoting prepared evidence:

   Tool: `contextvault_verify`:

   ```json
   { "envelopeId": "<from-prepare>", "checks": [{ "kind": "source_freshness" }] }
   ```

   Returns deterministic per-check results: `valid`, `stale`, `invalid`,
   or `unavailable`.

5. **Stats** — exact process-scoped counters:

   Tool: `contextvault_stats` with strict empty input `{}`.

6. **Purge** — two-step deletion of derived state:

   Call `contextvault_purge` with `preview` and a target to receive a
   `purgeIntentId`, then call it again with `execute` and that intent id.
   Original files are never touched.

Each step is an independent MCP call. The order above is a recommended
workflow, not an internal chain; every call is revalidated from scratch.

## 7. Common errors

| Error code                     | Meaning and first response                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `CV_INPUT_INVALID`             | The request violated a schema or policy rule. Fix the input shape.                                                 |
| `CV_AUTHORIZATION_DENIED`      | Unknown `rootId`, or no roots were declared at startup. Roots are startup-only.                                    |
| `CV_PATH_OUTSIDE_WORKSPACE`    | The path escapes the authorized root (`..` segments or an escaping link). Stay inside the root.                    |
| `CV_PATH_ABSOLUTE_DENIED`      | Absolute paths are not accepted inside the relative path.                                                          |
| `CV_PATH_REPARSE_POINT_DENIED` | A symlink, junction, or other link was traversed. Denied by design.                                                |
| `CV_PATH_SPECIAL_FILE_DENIED`  | The target is not a regular file (device, FIFO, socket, directory).                                                |
| `CV_RESOURCE_SOURCE_TOO_LARGE` | The file exceeds the source read limit (32 MiB default, 64 MiB hard ceiling). Denied by design.                    |
| `CV_SOURCE_CHANGED`            | The file changed during inspection. Re-inspect and prepare a fresh envelope.                                       |
| `CV_CAPABILITY_INVALID`        | Unknown, expired, revoked, or mismatched capability. Prepare a fresh envelope; never probe variants.               |
| `CV_RETRIEVAL_POLICY_DENIED`   | The selector type or byte request exceeds the granted policy. Narrow the request or re-prepare with a wider grant. |
| `CV_ENVELOPE_NOT_FOUND`        | The envelope expired (TTL), was purged, or the id is wrong. Prepare again.                                         |
| `CV_PURGE_INTENT_INVALID`      | Execute requires a `purgeIntentId` from a prior `preview` with the same target.                                    |
| `CV_OPERATION_CANCELLED`       | The request was cancelled through its abort signal. Retryable.                                                     |
| `CV_INTERNAL_ERROR`            | An unexpected internal condition. Retry once; report if it persists.                                               |

Every failure is a content-free `CV_*` envelope with a correlation
identifier and `isError: true`. Messages never contain paths, source
content, secrets, or tokens.

## 8. Security limits you will hit

These limits come from the implementation, not marketing:

| Resource                     | Current limit                       |
| ---------------------------- | ----------------------------------- |
| Source read                  | 32 MiB default; 64 MiB hard ceiling |
| Retrieve output              | 1 MiB maximum                       |
| Active envelopes             | 64                                  |
| Derived state in memory      | 4 MiB total                         |
| Serialized envelope metadata | 256 KiB                             |
| Envelope TTL                 | 60–7200 s; default 1800 s           |
| Concurrent preparations      | 2 default; hard cap 4               |
| Prepare/retrieve deadline    | 30 s per operation                  |
| Envelope chunks              | 1024 chunks × 4096 bytes each       |
| Verification checks          | 16 per call                         |
| Pending purge intents        | 16                                  |

When a limit is hit, the server fails closed with a specific `CV_*` code.
There is no flag to bypass a hard ceiling.

## 9. Stop the server and clean transient state

- Stop the server by ending the process as your MCP host normally does
  (closing the transport or terminating the child process). There is no
  daemon to stop and no port to close.
- All derived state — envelopes, capability digests, retrieval
  provenance, counters, purge intents — lives in process memory only and
  is discarded when the process exits. There is nothing to clean on disk.
- To drop state earlier, use `contextvault_purge` (section 6, step 6), or
  restart the process.
- Nothing is written outside process memory at any point: no logs, no
  cache files, no database.

## 10. Scope reminders

- No npm package is published; install from source only.
- No network listener, no telemetry, no external calls, no persistence.
- No file writing and no command execution, ever.
- Classification is heuristic and conservative; matched secret values are
  never returned or logged.
- Verification proves internal consistency, not the truth of any
  statement.

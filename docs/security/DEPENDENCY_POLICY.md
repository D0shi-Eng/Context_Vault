# Dependency and Build-Script Policy

## Scope

This policy applies to runtime dependencies, development dependencies, package-manager behavior, and generated source dependency SBOMs.

## Rules

- Dependencies must use exact versions in `package.json` and a committed `pnpm-lock.yaml`.
- CI must install with `pnpm install --frozen-lockfile`.
- Runtime dependencies must remain minimal and directly justified by an active architecture decision or protocol requirement.
- Dependency lifecycle scripts are denied unless the package and exact script have been reviewed and explicitly allow-listed.
- `esbuild` is the only allow-listed dependency with an install script. Its post-install step selects and validates the platform binary used transitively by the test toolchain.
- Package updates require the complete verification gate and a fresh vulnerability audit.
- A source dependency SBOM must be generated for review. It is not an image SBOM and must not be represented as proof about a container or published package.
- High and critical vulnerability findings block release unless a written, time-bounded exception is approved by a maintainer.

## Current runtime dependencies

| Package                     | Purpose                                 | Runtime authority                                            |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `@modelcontextprotocol/sdk` | MCP protocol server and stdio transport | Protocol framing only; no network transport is instantiated. |
| `zod`                       | Required schema peer for the MCP SDK    | Validation support only.                                     |

## Build-script review record

| Package          | Script            | Decision | Reason                                                                                              |
| ---------------- | ----------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `esbuild@0.28.2` | `node install.js` | Allowed  | Verifies or selects the platform-specific binary. No other dependency build script is allow-listed. |

## Required evidence

Before a phase review or release review, record:

1. Frozen-lockfile installation result.
2. `pnpm audit --audit-level high` result.
3. Full local verification result.
4. SBOM generation result and component count.
5. Any lifecycle-script allow-list change.

# Release Policy

## Source development and formal release control

The source repository currently has restricted access. Repository
visibility does not approve a formal release, an npm package, or production
use. These are separate, independently gated decisions:

1. **Source repository** — exists today with private access. Authorized
   users can install from source under Apache-2.0. Making it public requires
   an explicit maintainer decision.
2. **Formal GitHub Release** — none exists. Creating one requires the
   release evidence below and an explicit maintainer decision.
3. **Tag and SemVer version** — no version tag exists. Semantic versioning
   starts only with the first formal release; the tree remains `0.0.0`.
4. **npm publication** — none exists. `"private": true` in `package.json`
   stays in place as a guard against accidental `npm publish`; it is a
   packaging flag, not a statement about repository visibility.
5. **Production approval** — no version is approved for production use,
   and none may be used with sensitive or production data.

## Required release evidence

- Clean build from a fresh checkout.
- Passing format, lint, type, unit, integration, contract, security, property, fuzz, and compatibility checks that are in scope.
- Zero unresolved Critical or High findings.
- Full Git-history secret scan with zero unresolved results.
- Dependency and license review.
- Current threat model and residual-risk register.
- Matching source tag, checksums, SBOM, provenance, and release artifacts.
- Signed release commit and tag.
- Approved public documentation and known limitations.

## Decision states

- `PASS`: implemented and verified with current evidence.
- `CONDITIONAL_PASS`: verified only under stated limitations.
- `IMPLEMENTED_NOT_VERIFIED`: implementation exists but required evidence is incomplete.
- `NOT_RUN`: required verification has not run.
- `BLOCKED`: an external prerequisite prevents verification.
- `NO_GO`: release is prohibited.

Any unresolved Critical or High finding, unresolved secret, missing required test, stale threat model, or internal evidence in the public tree sets the release decision to `NO_GO`.

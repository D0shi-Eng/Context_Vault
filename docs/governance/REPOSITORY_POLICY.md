# Repository and Release Publication Policy

## Canonical repository

- **Canonical source:** [D0shi-Eng/Context_Vault](https://github.com/D0shi-Eng/Context_Vault)
- **Visibility:** private — repository access requires authorization;
  installation remains from source only
- **License:** Apache License, Version 2.0

Repository visibility and release approval are separate decisions. Making
the source public would not approve a formal release, an npm package, or
production use.

## Mandatory restrictions

- Do not change repository visibility; visibility changes are explicit
  maintainer decisions (see Visibility changes).
- Do not create formal releases, version tags, npm packages, containers,
  documentation sites, or published build artifacts; none exists today and
  each is gated separately (see Formal release gate).
- Do not create forks or mirrors that distribute development history
  outside this repository.
- Do not enable workflows that publish artifacts automatically.
- Do not add deployment, registry, signing, cloud, or personal credentials.
- Do not treat read access to the source repository as authorization to
  transmit local files.
- Do not commit internal review reports, raw verification evidence, local
  memories, temporary sandboxes, coverage output, or mutation output.

## Formal release gate

A formal release — a versioned GitHub Release with a tag, an npm package,
or a container image — requires all of the following:

1. The documented implementation scope is complete.
2. The pre-release security audit passes.
3. Unresolved Critical and High findings are zero.
4. Current-tree and Git-history secret scans pass.
5. License, dependency, SBOM, provenance, and release-integrity checks pass.
6. Known limitations and residual risks are documented accurately.
7. The released tree and its published history contain no internal review
   or verification material.
8. A maintainer explicitly approves the release.

Until every condition is met, formal releases and package publication
remain prohibited.

## Visibility changes

Automation and contributors must not change repository visibility. A
maintainer must perform and verify any visibility change explicitly.

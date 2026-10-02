# Golden Corpus Specification

## Purpose

The golden corpus measures fidelity, omission transparency, selector correctness, claim verification, multilingual behavior, resource limits, and resistance to adversarial content.

Only synthetic, generated, public-domain, or explicitly approved redistributable data may enter the repository.

## Corpus families

### JSON and JSON Lines

- Deep but permitted nesting.
- Duplicate keys and parser-differential cases.
- Large arrays with one ordinary-looking critical record.
- Numeric edge cases, large integers, decimals, exponent notation, negative zero, and Unicode keys.
- Errors represented as data rather than English keywords.
- Arabic, English, and mixed-language values.

### Logs

- Multiline stack traces.
- Interleaved requests and correlation identifiers.
- Clock skew and out-of-order events.
- Arabic and localized warnings and failures.
- Rare critical events surrounded by repetitive normal events.
- Prompt injection text embedded as untrusted data.
- Credentials represented by synthetic nonfunctional patterns.

### Source code

- Imports, exports, public signatures, type definitions, and call relationships.
- Security checks separated from the protected operation.
- Generated-looking but human-authored code.
- Unicode identifiers and bidirectional-control test cases.
- Comments containing untrusted prompt-injection text.
- Files that change between inspection and retrieval.

### Tabular data

- Important non-outlier rows.
- Missing values, duplicate headers, mixed types, and locale-specific numbers.
- Formula-like text that must not execute.
- Very wide and very tall tables.
- Row identifiers that resemble ordinary values.

### Markdown and text

- Nested sections, code fences, tables, lists, citations, and footnotes.
- Conflicting statements at different locations.
- Long repeated passages with a single changed number.
- Arabic right-to-left text mixed with code and paths.
- Embedded instructions that must remain untrusted content.

### Filesystem and capabilities

- Relative traversal, absolute paths, UNC paths, device names, alternate streams, symlinks, junctions, and path races.
- Expired, modified, revoked, cross-session, and cross-workspace capabilities.
- Cancellation and deadline boundaries.
- Corrupted session records and source digest changes.

## Annotation model

Each positive fixture includes a machine-readable sidecar with:

- Fixture identifier and license/provenance.
- Content type and language.
- Sensitivity and secret-risk expectation.
- `must_keep` facts with exact source locators.
- Expected omissions and allowed aggregation.
- Supported and unsupported selectors.
- Supported, contradicted, and insufficient-evidence claims.
- Expected result or stable error code.

## Integrity rules

- Fixture and annotation files receive SHA-256 manifests.
- Tests fail when content changes without annotation review.
- Real credentials and customer data are prohibited.
- Synthetic secret values must be unmistakably nonfunctional and isolated from production patterns where possible.
- Corpus generators use fixed seeds and record generator versions.

## Acceptance

- Every `must_keep` fact is preserved exactly.
- Every intentional omission is represented.
- Every expected denial fails closed with the correct error class.
- No fixture content appears in privacy-safe logs or metrics.
- Benchmark reports identify corpus version, code revision, operating system, runtime, hardware, configuration, and statistical method.

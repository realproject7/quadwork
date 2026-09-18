# Proposed matched workload (#1037)

Status: preparation specification, not a frozen or executed benchmark. Independent
review and baseline creation precede provider calibration. Every mode gets identical
ticket text and acceptance tests within a class. Provider-produced code is retained
per run. No reference solution is exposed in the starting repositories.

## Product

A dependency-free Node library for importing, querying, and exporting a small
catalogue. Inputs are bounded local strings and arrays, with no network or user
files. Export CommonJS functions and run acceptance checks with `node --test`.
The harness creates pristine target repositories from one recorded baseline per
class. It must not use the QuadWork repository as the coding workload.

There are two tickets and three implementation tasks. Ticket A requires both A1
and A2; delivering only one must leave that ticket open. Ticket B requires B1.
Completed exports are loaded by the same acceptance suite for every mode.

## A1: Parse catalogue records

Export `parseCatalog(text)` returning records in original input order. Each
nonblank NDJSON line contains exactly `id`, `title`, `tags`, and `enabled`.
`id` and `title` are nonempty strings; `tags` is an array of nonempty strings;
`enabled` is boolean. Reject unknown or missing fields, malformed JSON, wrong
types, and duplicate IDs without coercion. Preserve strings verbatim. Accept
LF and CRLF; skip whitespace-only lines. Empty input returns an empty array.
Throw an Error with one-based physical `line` for invalid input. Blank lines
still count when locating a later error. Input must be a string.

Acceptance covers normal and Unicode records, empty input, mixed blank lines,
CRLF, a last line without newline, duplicate IDs, malformed JSON, extra fields,
and every wrong field type. Input errors are observable test failures, not
silently skipped records.

## A2: Query catalogue records

Export `selectCatalog(records, options)` over validated records. Supported options
are `tag` (exact case-sensitive string), `enabled` (boolean), `offset` (nonnegative
safe integer, default zero), and `limit` (nonnegative safe integer, default all).
Filter before pagination and preserve input order. Reject unknown options and
wrong types. A zero limit returns an empty array. Do not mutate input records,
tags, or options. Selected records are fresh objects with fresh tag arrays.

Acceptance covers combined filters, false vs absent enabled, empty tags, missing
tag, zero limit, offset beyond end, invalid numbers including NaN/Infinity, stable
ordering, frozen input, and modification of output without affecting input.

## B1: Export catalogue CSV

Export `formatCatalogCsv(records)` over validated records. Emit a fixed header
`id,title,tags,enabled` followed by CRLF. Each row uses that column order;
encode tags as JSON text and booleans as `true` or `false`. Quote any field
containing comma, double quote, CR, or LF, doubling embedded double quotes.
End every row with CRLF, including the last. Empty input emits only the header.
Preserve Unicode, whitespace, order, and record content without mutation.

Acceptance covers commas, quotes, newlines, empty tags, Unicode, false enabled,
empty input, frozen inputs, and exact byte output. Export is a string operation,
not file writing or spreadsheet execution.

## Two performance classes

- Pipeline-eligible: A1 owns `src/parse.js`; A2 owns `src/select.js`; B1 owns
  `src/format.js`. A2 has a declared task dependency on A1, while B1 is independent
  and ready when A1 enters review. A fixed starting adapter exposes all exports;
  no task needs a shared export-file edit.
- Overlap-bound: same functions and acceptance checks, implemented in one
  `src/catalog.js`; dependencies are A1 → A2 → B1. A fixed starting adapter exposes
  those exports. This class correctly serializes even if remaining work is small.

Baseline files expose clear `not implemented` errors for the provider's target
tasks. These are workload starting fixtures, never QuadWork production code or
claimed completed deliverables. Acceptance files and adapters are read-only to
providers; verify their digests after every assignment. No deletion/skipping of
an assertion can qualify as completion. Each task gets its own targeted check;
the completed bundle must pass the complete same-class acceptance suite.

## Execution boundaries

The disposable remote repositories have Actions disabled before their first
push, no deployment integration, and no production secrets. Ordinary performance
runs use one repository; the separate multi-repository safety scenario duplicates
the baseline and uses repository-qualified ticket identities. Actual equal issue
numbers must be observed rather than asserted from fixture identifiers.

Runtime/provider models, correction caps, Head overhead, review granularity,
cache policy, host resource budget, trial order, and external waits are recorded
in the reviewed measurement manifest. V1's ticket-level reviews are preserved;
V2's extra task-level reviews remain visible as part of its real cost. Separate
seeded-defect and restart tests do not contribute timing samples to this workload.

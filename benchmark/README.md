# Offline benchmark preparation

This is the first preparation utility for #1037, not a benchmark runner.

```sh
node benchmark/preflight.cjs \
  --manifest docs/v2-benchmark-manifest.draft.json \
  --repo .
node --test benchmark/preflight.test.cjs
node benchmark/evidence.cjs --ledger /path/to/ledger.json
node --test benchmark/evidence.test.cjs
node benchmark/v1-zero-actions.cjs --repo .
node --test benchmark/v1-zero-actions.test.cjs
```

The report verifies local product commit/tag/tree identities, calculates a
canonical manifest digest, and lists missing preparation data. Exit zero means
the supplied draft was inspected successfully. It does **not** mean the benchmark
is ready. Invalid input, unavailable Git, and mismatched local identities return
nonzero. Every report has `execution_authorized: false`.

The tool cannot launch models, mutate a repository, contact GitHub, validate an
operator's approval, freeze targets, or run any benchmark. It never grants those
capabilities based on a caller-supplied approval or Mode 3 flag. It checks only
the preparation schema; nested run contracts and approval evidence need the
later reviewed implementation.

`evidence.cjs` is the companion offline validator for the append-only benchmark
ledger. It accepts a single provenance class (`live`, `replay`, or `historical`)
per ledger, validates fixed identity anchors and per-run ordering, and creates a
secret-free structural result summary. It never authorizes a speed result: the
later manifest/evidence verifier must bind actual receipts, complete tasks, and
the approved freeze before timing can be considered. Records bind an immutable
source/harness/workload run anchor separately from a changing candidate/repository
delivery identity, and include task, role, generation, attempt, and sanitized model identity.
Candidate identity is `null` only for pre-candidate start/ready/assignment,
failure/interruption, and recovery events.
Failed, interrupted,
replayed, historical, malformed, or incomplete runs remain represented but are
never counted as speed results. The module's `appendRecord` API returns a new
validated ledger with the prior prefix intact and links its records by hash; it
performs no persistence itself. The runner that eventually persists records must
use that API, retain all previous records, and retain the resulting ledger digest
as evidence. The chain detects changes only when a previously retained digest is
compared; it cannot by itself attest to external storage history. This tool does
not validate a manifest freeze, invoke a model,
or permit Mode 3 timing.

Use Node 20.3+ on macOS with Command Line Tools Git at
`/Library/Developer/CommandLineTools/usr/bin/git`, or Linux with `/usr/bin/git`.
No Windows support is claimed for this non-shipping helper. Git runs with a
restricted child environment, fixed argv, bounded execution and output, no
replacement objects, and no allowed network transport. No global config is
changed. The top-level `benchmark/` directory is outside the package's shipped
file allowlist.

The measurement design and proposed work bundle are in
[`docs/v2-benchmark-plan.md`](../docs/v2-benchmark-plan.md) and
[`docs/v2-benchmark-workload.md`](../docs/v2-benchmark-workload.md).

`fixtures/catalog/` contains the two non-shipping starting repositories for
that workload. Each has dependency-free acceptance tests and intentional
`not implemented` task stubs, so its acceptance command must fail before a
provider supplies a candidate. `WORKLOAD.json`, the adapter, and the acceptance
test are designated read-only inputs; the future adapter must record their
digests before and after every assignment. The fixtures do not start QuadWork,
call a provider, create a repository, or constitute a live benchmark.

`v1-zero-actions.cjs` is a separate read-only source-policy audit for the
shipped V1 tag. It proves only that V1's source-level ready predicate does not
require a check result. Its report deliberately leaves Mode 1 unproved because
branch protection and the complete disposable-repository delivery path require
a later live exercise. See
[`docs/v2-v1-zero-actions-feasibility.md`](../docs/v2-v1-zero-actions-feasibility.md).

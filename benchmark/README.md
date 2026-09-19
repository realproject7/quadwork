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
node --test benchmark/v2-workload-adapter.test.cjs
node --test benchmark/v2-disposable-runtime-harness.test.cjs
node benchmark/calibration-protocol.cjs --protocol /path/to/mode-1-or-mode-2-protocol.json
node --test benchmark/calibration-protocol.test.cjs
node --test benchmark/calibration-executor.test.cjs
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

`v2-workload-adapter.cjs` maps a parsed fixture plus caller-supplied ticket
bindings into V2's real frozen WorkTask manifest and in-memory
pipeline primitives. It cannot invent ticket identities from the fixture. Its
local contract test creates temporary Git worktrees and real V2 candidate
objects, then proves the pipeline fixture can build B1 while A1 is under
independent review and the overlap fixture refuses A2 before A1 is accepted.
It rejects task paths that overlap the fixture's declared read-only inputs. It
is replay coverage only: it does not attest that caller-supplied bindings were
observed, start the server, use authenticated
HTTP/MCP routes, launch a model, produce an authentic reviewer identity, or
qualify as a live benchmark observation.

`v2-disposable-runtime-harness.cjs` is the next local-only contract layer. It
starts only a caller-owned loopback HTTP app and preserves the fixed V2 route
names for build assignment and independent-review opening, receipt, and
reconciliation. The app composes the production WorkTask runtime, live identity
resolver, review/build services, and durable stores against a disposable config
directory. Its role tokens exercise server-derived Head/reviewer identity and
generation; they are synthetic local test identities, not provider or user
authentication. It deliberately has no MCP endpoint, provider launcher, GitHub
or Git transport, package/release operation, or process execution capability.
It starts only from a root created by `createDisposableV2RuntimeRoot()` or an
otherwise empty root explicitly marked with `markDisposableV2RuntimeRoot()`;
the marker, ownership, permissions, canonical path, and empty-root condition
are checked before the durable services are composed. A populated store
namespace or any root/marker symlink is rejected without writing. It is replay
coverage and cannot qualify as a live benchmark observation.

`calibration-protocol.cjs` accepts only a bounded Mode 1 or Mode 2 preparation
record. It binds source/harness/workload, the disposable target base, role
model/CLI/effort identities, cache and Actions storage observations, and turn,
token, and wall-time caps. Every safety field must be false. The module has no
execution, persistence, process, network, GitHub, Git, release, or npm APIs.
It returns a digest and redacted report with `execution_authorized: false`.
Mode 1 retains the zero-Actions feasibility blocker until a later bounded
delivery exercise proves it. A separately reviewed executor must bind this
exact digest to retained evidence and enforce the manifest, approval, and
provider budget gates itself.

`calibration-executor.cjs` is that separately bounded, non-shipping contract
layer. It accepts only an exact executor-run contract whose protocol digest,
source/harness/workload/adapter digests, target base, disposable-root
attestation, Actions/storage observations, identities, and positive caps agree.
Its explicit evidence directory must have been created by
`createDisposableCalibrationEvidenceRoot()`; every valid attempt atomically
persists an append-only `live` ledger there and refuses a replacement or
rewritten prefix. It probes only a configured absolute, non-shell executable
with its fixed `--version` argv and requires that output to match the bound
developer CLI version. A Mode 2 command has one fixed provider-turn allowance,
the remaining token cap in its argv, and the remaining wall-time as its process
timeout. It discards process output and a zero exit without a candidate receipt
is unqualified evidence, never a benchmark success. Mode 2 also requires a
caller-instantiated result from the existing V2 workload adapter and local
loopback harness. Mode 1 records its unproved zero-Actions blocker. It cannot
publish, release, mutate GitHub, authorize Mode 3 timing, or write outside its
marked evidence directory.

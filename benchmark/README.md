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
node --test benchmark/live-provider-compatibility.test.cjs
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

`calibration-executor.cjs` is the current separately bounded, non-shipping
evidence layer, not a provider runner. It accepts only exact contracts whose
source, harness, workload, adapter, protocol, and concrete base artifacts are
regular files at fixed absolute paths inside a caller-created marked disposable
target root. That root also contains a canonical artifact manifest whose digest
must equal the protocol-bound manifest digest; each artifact and concrete base
file is compared to the manifest before the first ledger append. It calculates
their SHA-256 digests itself, re-parses the protocol, and checks the concrete
base identity before recording anything. Its evidence
directory must have been created by `createDisposableCalibrationEvidenceRoot()`;
each append uses an exclusive lock, a re-read/CAS prefix check, file and
directory fsync, and an atomic rename. Reports retain only structured input
digests, actual injected Actions/cache/artifact observations, and monotonic
start/end/duration references; each observation is first persisted as a
secret-free content-addressed immutable file, and the authoritative ledger
commits only its digest in `evidence_ref`. An unreferenced observation after an
interrupted write is harmless; every committed ledger reference is rechecked.
No
provider text, credentials, or absolute artifact paths are retained publicly.

Current `calibration-protocol.cjs` fixes `provider_execution_permitted` to
false, so this executor always records a Mode 2
`provider_execution_not_permitted` result and never instantiates a provider,
adapter route, harness endpoint, or child process. It rejects shell, preload,
and eval argv even though they are never executed. A future reviewed execution
layer would need a non-serializable trusted authorization dependency containing
an explicit executable allowlist, exact artifact digest, and constrained argv;
a caller-supplied config or version string cannot grant that capability. Mode 1
continues to retain its unproved zero-Actions blocker. Nothing here can publish,
release, mutate GitHub, authorize Mode 3 timing, or write outside the marked
evidence directory.

`live-provider-compatibility.cjs` is the separately reviewed #1109 local smoke
for the current release-required Codex and Claude CLIs. It does not import,
weaken, or interpret the preparation protocol. Its frozen registry has exactly
those two adapters, with a pinned model and noninteractive tool-disabled or
read-only argv profile for each. A caller cannot supply a model, argv, shell
command, provider alias, or JSON authorization. A source-controlled reviewed
execution registry binds the wrapper path, resolved executable digest, and CLI
version digest before a provider turn. The observation records current harness,
source, and workload digests without claiming an independently verified delivery
base. A zero-exit process also must return exactly the fixed
`QUADWORK_LIVE_OK` sentinel on stdout with no stderr; the raw response is never
retained.

The smoke creates an executor-owned `0700` disposable Git root, rejects a
symlink, any remote, unsafe permissions, and a changed repository before and
after its one-turn run. It invokes only a digest-bound absolute executable with
`shell: false`, a restricted environment, and no Git credential helper or
inherited GitHub/npm credentials. Prompt text, provider output, absolute paths,
auth output, and environment values are not retained. A missing executable,
unsafe root, unsupported adapter/model, unavailable isolation, output cap,
timeout, login/entitlement failure, or second terminal record fails closed.

This is provider-CLI compatibility evidence only. It does not prove the full
QuadWork `buildAgentArgs` or PTY launch path. It does not authorize Mode 3 timing,
target freeze, a delivery claim, Actions, a release recommendation, a version
change, or npm publish. A future backend such as Grok needs a reviewed source
change adding one static adapter, a pinned model, a safe argv profile, and
equivalent fake-CLI tests. It cannot be enabled by JSON or config.

`v2-product-path-core.cjs` is a distinct #1113 baseline boundary. It does not
weaken or import the calibration protocol or executor. Before an authenticated
turn it creates an executor-owned `0700` temporary root, local no-remote Git
repository, and isolated `HOME/.quadwork/config.json`; the normal operator
`~/.quadwork` state is neither read nor written. The config has only one static
reviewed Codex or Claude identity, exact model, a disposable cwd,
`auto_approve:false`, and `mcp_inject:"none"`. The worker imports the unmodified
V2 server and uses its real `buildAgentArgs`, `buildAgentEnv`, `spawnAgentPty`,
lifecycle admission, PTY, and stop paths. It rejects MCP/token/proxy and
permission-bypass results before a provider prompt is written.

Before V2 admission, the worker checks only the reviewed resolved executable,
source, and owned-root integrity, then unconditionally writes a durable
zero-turn `preflight_blocked` result. It never authenticates a provider, loads
the V2 server, opens a PTY, attaches a terminal, or sends a workload. The
separate fake-CLI test alone exercises V2 argument/lifecycle behavior.

The worker also consumes one parent-issued authorization nonce and checks the
exact owned-root marker/layout, source digest, and binary digest before loading
the server. This is a same-user admission guard, not a credential boundary. No
provider-auth directory is referenced in this contract. A future live-auth
contract needs a provider-reviewed mechanism that can prove both read-only
credential access and the safe CLI profile; it cannot be enabled by an env var
or a caller-supplied path.

The artifact records only redacted digests and terminal facts. It never stores
the prompt, output, token, config bytes, absolute paths, authentication data,
or raw terminal data. Fake-only tests cover the config and root isolation,
argument rejection, static identities, report redaction, ownership, and the
absence of a production dependency-injection seam. A live run remains bounded
to one turn, requires post-merge review approval, and cannot authorize Actions,
remote Git, versioning, release, or npm publication.

`reviewed-execution-contract.cjs` and `reviewed-execution-runner.cjs` add the
#1115 execution-authorization preparation layer. It has exactly two closed
profiles: `v2_codex_readonly_v1` and `v2_claude_restricted_v1`. The private V2
resolver accepts only the owned `benchmark-product-path` role plus one of those
IDs. It fixes the resolved binary, model, provider argv, static environment,
`sandbox-exec` wrapper, backend, and PTY prompt route. Normal projects and
arbitrary configuration cannot select a profile.

Before any provider activity, preparation creates a source-generated `0600`
sandbox profile and atomically consumes a `0700` executor-owned `O_EXCL` ledger
record keyed to the candidate digest, profile, and authorization. The record is
never cleaned, so every retry is refused even after a blocked preflight. The
candidate digest explicitly covers the V2 launch chain, profile source,
sandbox template, reviewed binary/version evidence, workload, sentinel rule,
and runner. The final PTY construction recomputes it before launch.

This change contains no provider auth or workload invocation. Its local
preflight is capped at five seconds and 4 KiB, reports zero turns, and blocks
on any unavailable local prerequisite. The sandbox default-denies writes
outside the disposable root and ledger. It permits outbound connections only
for the fixed binary, fixed model, fixed no-tools argv path. It does not claim
hostname-level filtering or Keychain immutability, and it never copies,
prints, hashes, or persists credential values. Live activity remains prohibited
until two independent reviews approve the exact candidate and the required
Actions/cache/artifact observations are fresh.

The live selector is deliberately disabled in this change. In particular, this
layer does not run a provider CLI, PTY, or dynamic version command. The recorded
version digest is static reviewed evidence only. A later reviewed contract must
add the fresh-review and Actions/cache/artifact gate together with complete
sentinel, cleanup, post-root, and process-survivor proof before enabling it.

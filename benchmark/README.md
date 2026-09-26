# Offline benchmark preparation

This is the first preparation utility for #1037, not a benchmark runner.

## Current stage, 2026-09-20 (#1155)

Offline preparation, deterministic regression checks, and source audit may
continue. Real-provider turns, product E2E/device checks, and live benchmarks
must wait until the operator returns and explicitly resumes testing. Carry
this hold into the handoff and continuity watcher; no automation may launch
live tests while it applies.

The reviewed runner is a security harness and historical evidence, not required
provider-support or release proof. Preserve its authorizations, attempted runs,
failures, diagnostics, and receipts without rewriting their outcomes. Consumed
one-shot authorizations stay consumed and cannot be retried or reset. Only
unresolved future execution obligations are superseded; the older preparation
and execution descriptions below do not grant a fresh attempt.

Record source-audit completion separately from pending live verification, and
keep compound #1037 open for its retained product and release gates. Once the
implementation and audit fixes are complete, follow the
[local-install readiness procedure](../docs/release-v2.8.0-runbook.md#local-install-readiness-before-testing).
Build and pack the exact reviewed final source, record the commit and archive
digest, install into an isolated local target, and prepare disposable scenarios.
Do not start the product or providers during this preparation stage.

After the operator resumes, one bounded project-path action each with Codex and
Claude must use that exact installed artifact. Record raw-free success/failure,
source/artifact and provider/model identities, and bounded outcome facts.
CLI presence/version, startup, replay tests, and historical runner results do
not prove this installed-product path. Failed or unperformed proof blocks
provider-support and publish recommendation, not a scoped implementation claim.

No interactive login, OAuth grant, credential/auth-file/Keychain inspection,
copying, or change is authorized. Missing login, device confirmation, or extra
provider-state access is an operator gate under the unchanged
[authority boundary](../docs/reviewed-execution-provider-state-boundary.md).
Local-install provider proof precedes any version, tag, release, or npm publish.
The matched benchmark and manifest-freeze gates remain required for performance
and release claims and run only after testing resumes. Actions stays disabled,
with zero active cache and artifacts. This stage authorizes no release,
deployment, registry publication, or replacement of an existing installation.

## Offline commands and existing harness contracts

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
performs no persistence itself. `ledger-writer.cjs` persists that value. Retain
the resulting ledger digest as evidence: the chain detects changes only when a
previously retained digest is compared, and it cannot by itself attest to
external storage history. This tool does not validate a manifest freeze, invoke
a model, or permit Mode 3 timing.

The record schema is closed (#1182). No field accepts free text: each is an
enum, digest, SHA, number, timestamp, lowercase identifier, or one of these
fixed forms. `role` is `head`, `dev`, `re1`, or `re2`. `cache_policy` is
`fresh_local_session` or `record_provider_cache_telemetry`. `model_identity`
follows the calibration protocol's model-id rule, up to 128 characters, such as
`openai.gpt-5.6-luna`. `repository` is `owner/repo` within GitHub's limits: an
owner of up to 39 and a repository name of up to 100 letters, digits, `.`, `_`,
or `-`. A repository or model identity that contains one of the credential
shapes below, anywhere in the value, is refused. `evidence_ref` is generated,
never caller text. It is `writer/<sha256>` from the ledger writer, or
`executor/<reason>/<sha256>` with one of the historical calibration executor's
fixed reason codes. A `local_validation` record has origin `harness_acceptance`
or `local_validation`, the product's own validation. Origin is part of a
validation record's duplicate-event key, and only a product `local_validation`
record satisfies a successful run.

Each credential shape is a key prefix plus the body of the provider's real
format:

- GitHub: `gh[pousr]_` and 36 or more letters or digits, or `github_pat_` and
  22 or more letters, digits, or `_`.
- OpenAI: legacy `sk-` and 32 or more letters or digits with no hyphen (real
  keys have 48), or `sk-proj-`, `sk-svcacct-`, or `sk-admin-` and 40 or more
  letters, digits, `_`, or `-`. Real project keys are longer than either field
  allows, so this refuses a pasted fragment.
- Anthropic: `sk-ant-api` or `sk-ant-admin`, two digits, `-`, and 40 or more
  letters, digits, `_`, or `-` (real `sk-ant-api03-` keys have 95).
- Stripe: `sk_` or `rk_`, then `live_` or `test_`, and 16 or more letters or
  digits.
- Slack: `xox` and one of `a`, `b`, `p`, `o`, `s`, or `r`, then `-`, a numeric
  ID of 6 or more digits, `-`, and 10 or more letters, digits, or `-`. A bot
  token is `xoxb-`, two IDs of 10 to 13 digits, and 24 letters or digits.
- AWS `AKIA` and 16 capitals or digits. npm `npm_` and 36 letters or digits.
  GitLab `glpat-` and 20 letters, digits, `_`, or `-`. Hugging Face `hf_` and
  30 or more letters or digits. Google `AIza` and 35 letters, digits, `_`, or
  `-`.

The legacy OpenAI, OpenAI project, and GitLab bodies must also contain a
capital, digit, or `_`, which random keys always do. With the Slack numeric ID,
this means a lowercase hyphenated words-only name never matches. Names such as
`flask-restful-api-template`, `xoxo-game-of-life`, and `sk-tools` pass.

`ledger-writer.cjs` is the durable, append-only writer for one run's ledger.
`createRunLedgerRoot({ parent_dir })` creates a marked `0700` root that holds
one ledger for one run. `appendRunEvent(root, prior, record, observation)`
accepts any validator event for Modes 1 to 5. `prior` is the caller's last
committed ledger, so a stale or rewritten on-disk prefix is refused. The caller
supplies every record field except `sequence`, `prior_record_digest`, and
`evidence_ref`, which the writer generates. The writer persists the observation
first as a content-addressed `0600` file. It then commits the ledger under an
exclusive lock, with a re-read prefix check, fsync, and an atomic rename. An
append that would push the ledger past the validator's 512 KiB limit is refused
before anything is written. A killed writer leaves the last committed ledger
valid, with every observation it references present. The next append reclaims
a dead writer's lock and temporary files. Two kill points fail closed instead.
A kill before the lock holds a PID leaves an empty lock, which is refused as
possibly live. A kill inside an observation write leaves a partial file, which
blocks only that identical observation. The committed ledger references neither
file, and removing it clears the block. Two writers that recover the same
dead writer's lock at once can both proceed. Both report success, but one
committed append is silently overwritten. The losing writer's next append is
refused as a stale prefix (`ledger_writer_evidence_prefix`), and the ledger
stays valid. #1192 tracks these recovery limits. The calibration executor
persists through the same helpers. The writer's tests run with
`node --test benchmark/ledger-writer.test.cjs`.

Each observation payload has exactly these fields. Its only strings are fixed
enum values, so it cannot hold free text.

- `provider_turns`: one entry per provider turn, with `input_tokens`,
  `cached_input_tokens`, and `output_tokens`. Each is a count or `unavailable`,
  never zero or an estimate when telemetry is missing.
- `counters`, each counted since the run's previous record:
  - `remote_pushes`: Git pushes to a remote.
  - `pull_requests`: pull requests opened.
  - `merges`: pull requests merged.
  - `validation_attempts`: runs of product validation or harness acceptance.
  - `role_wakes`: times a role was woken or prompted to act.
  - `chat_bytes`: bytes of chat messages written. Only the count is kept.
  - `no_ops`: wakes that changed no task, review, or delivery state.
  - `recovery_events`: recoveries performed, such as a role restart.
- `external_waits`: one interval per wait, with a `category` of
  `provider_rate_limit`, `git_remote`, or `github_api`, and its start and end on
  the run's monotonic clock.
- `host`: `unavailable`, or the `sampling_interval_ms`, the sampler's measured
  `sampler_overhead_ms` (its own CPU time), and `samples` of host `cpu_percent`,
  `rss_bytes` summed over the run's processes, `swap_used_bytes`, and
  `memory_pressure` (`normal`, `warn`, or `critical`).

Use Node 20.3+ on macOS with Command Line Tools Git at
`/Library/Developer/CommandLineTools/usr/bin/git`, or Linux with `/usr/bin/git`.
No Windows support is claimed for this non-shipping helper. Git runs with a
restricted child environment, fixed argv, bounded execution and output, no
replacement objects, and no allowed network transport. No global config is
changed. Benchmark fixtures and standalone preparation tools are outside the
package's shipped file allowlist; only the selected runtime helpers explicitly
listed in `package.json` ship with the product.

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

The original #1115 preparation change contained no provider auth or workload
invocation. Its local preflight is capped at five seconds and 4 KiB, reports
zero turns, and blocks on any unavailable local prerequisite. The sandbox
default-denies writes outside the disposable root and ledger. It permits outbound connections only
for the fixed binary, fixed model, fixed no-tools argv path. It does not claim
hostname-level filtering or Keychain immutability, and it never copies,
prints, hashes, or persists credential values. Live activity remains prohibited
until two independent reviews approve the exact candidate and the required
Actions/cache/artifact observations are fresh.

The live selector was deliberately disabled in the original #1115 preparation
change. The later #1117 contract and its hardening defined reviewed live
execution separately, including fresh review, Actions/cache/artifact checks,
sentinel, cleanup, post-root, and process-survivor requirements. Those contracts
and their observed outcomes remain historical evidence. Their presence is not
authorization to execute now, and consumed one-shots cannot be repeated.

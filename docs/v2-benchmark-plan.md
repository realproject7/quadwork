# V2 release benchmark preparation (#1037)

Status: design draft. No calibration, Mode 3 timing, target freeze, or release approval.
This document implements the existing #1037 measurement contract; it does not
waive its acceptance criteria. The accompanying manifest is deliberately unfrozen.

## Verified identities

The shipped reference is npm `quadwork@2.7.1`, whose registry `gitHead` and Git
tag `v2.7.1` both resolve to `59198955480c2224e1980e1645690d34a8ec0db3`.
PR #1057 is closed without merge; its head is not an ancestor of that reference.
The V2 source is `9e1d08fc57ea46b2aa5356bfa573e8c028d1cdc8`; its tree equals the
verified candidate `75a1230addc5516c0be2c1b043dc7912687da19a`.
`4cd6e76` already contains V2 foundations and is not a shipped V1 baseline.
Record the eventual harness revision separately from the product revision.

Source identity alone does not prove installed-package identity. Before live
runs, verify the npm archive integrity, record the installed file manifest,
and bind each installation to its selected source/build artifact.

## Evidence classes

1. Deterministic replay exercises real stores, state transitions, and local Git
   with explicitly labeled provider/remote doubles. It proves behavior only.
2. Live process smoke uses actual isolated server/PTY/CLI processes. Without a
   completed provider turn it does not prove model latency or successful login.
3. Live benchmark executes the matched task bundle with actual models and the
   selected orchestration mode. Only observed complete runs support throughput.
4. Live delivery evidence uses disposable GitHub repositories, real PRs, sealed
   review evidence, merges, and post-merge reads. A local bare Git remote cannot
   establish actual PR/review/closure behavior.

Existing `server/work-task-delivery-pipeline.test.js` exercises real local Git
and stores but injects review receipts. Existing delivery executor fixtures
inject remote facts. Reuse them for replay coverage, never as live performance
observations. Preserve the prior macOS/Linux/VM receipts with their original
SHA and scope; the identical merged tree permits scoped reuse, not a claim of
new execution. Complete the audit ledger's final changed-file reconciliation
and AC-to-evidence map before closing #1037.

## Modes and matching

| Mode | Execution | Implementation slots | Review slots | Publication |
|---|---|---:|---:|---|
| 1 | Installed shipped V1 | 1 | 2 | V1's observed ticket path |
| 2 | Non-shipping local-first serial control | 1 | 2 | One per ticket |
| 3 | Installed V2 pipeline and integrated delivery | 1 | 2 | One per compatible repository cut |
| 4 | Direct orchestration | 1 | 2 | Declared, observed direct policy |
| 5 | Direct orchestration, descriptive ceiling | Proposed 2 | 2 | Declared, observed direct policy |

Use the same target repository baseline, ticket bodies, acceptance tests, role
models/efforts, correction limits, and host budget for Modes 1–4. Head's cost
is included. Direct orchestration must record its planner model and overhead;
it cannot silently use this conversation as a free, unmetered supervisor.
Mode 5 retains the host budget while permitting the declared second builder.
Record all active slots, including Head, and distinguish configured roles from
admitted simultaneous worker processes. Do not describe a changed slot budget
as a capacity-matched comparison.

Reviewer models must be distinct as #1037 requires and must remain fixed across
modes. This conversation's Astra/Terra setting does not select the benchmark
models. Pin actual supported model IDs, CLI versions, effort settings, and
whether aliases can drift before any calibration. A missing CLI or unsupported
model is a blocked preflight, never an automatic cheaper-model substitution.

Mode 2 is a harness-only adapter that serializes task/review/closure using the
reviewed V2 primitives. No product feature flag or merged #1057 code is needed.
Mode 3 must drive the normal authenticated runtime tools, including assignment,
candidate submission, sealed receipts, reconciliation, and delivery inspection.
Direct store mutation is allowed only in labeled replay tests.

## Zero-Actions baseline limitation

All disposable target repositories must have Actions disabled before any push
or PR and verified disabled throughout the experiment. No deployment webhook
is attached. No run, retry, check result, or approval is fabricated.

This prevents account-level Actions minutes and Actions cache/artifact storage
from the benchmark as well. Record repository Actions permission, active cache
bytes/count, and non-expired artifact bytes before and after any live exercise.
Do not trade local verification time for hosted `node_modules`/npm caches or
artifact uploads. Any future exception needs an explicit operator-approved
minutes and storage budget and is outside this benchmark contract.

An unmodified V1 gate may wait for hosted checks that this experiment forbids.
First prove whether its supported local policy can complete the matched flow.
If not, record Mode 1 as blocked. Do not patch V1, inject a green hosted status,
silently exclude the wait, or present historical unrelated CI time as a matched
observation. A V1 local-policy adaptation is a changed experimental condition
that requires an explicit contract decision before a total-improvement claim.
Missing matched baseline evidence leaves the corresponding release gate open.

The checked-in V1 source audit establishes a narrower result: the V1 dashboard
computes `ready` from two role-attributed approvals without using its displayed
check-rollup data. It does not audit Head's actual merge decision, establish
candidate freshness, show that a target repository's branch protection accepts
that path, or prove a real V1 delivery with Actions disabled. Its report is
therefore `dashboard_readiness_without_check_result_delivery_unproved`, and the manifest stays
`mode_1_zero_actions_feasibility: "unproved"` until the bounded live exercise
completes.

## Task bundle and safety scenarios

Build a small, dependency-free single-repository Node fixture project with real
user-visible library behavior and deterministic acceptance commands. Proposed
performance bundle: two tickets containing three tasks in total, each with
its own file boundary and acceptance tests. Final task specifications and
fixture baseline SHA must be reviewed before calibration; no canned solution
is supplied to providers. See [the workload specification](v2-benchmark-workload.md).
Only the separate multi-repository safety scenario uses two repositories.

- Pipeline-eligible class: independent parser, formatter, and query modules.
  At least one next task is ready while the preceding task is in review.
- Overlap-bound class: equivalent work volume in a dependency chain with an
  intentionally shared module. It must serialize honestly.
- Safety suite, separate from performance timing: enumerate every isolated
  delivery trigger from #1058/#1060; safe-cut with failed/changed task and
  ordered successor; V1 one-ticket compatibility; two-repository delivery
  with equal issue numbers and independently attributable PR/merge identities.
- Restart suite: owned Head, Dev, and reviewer processes restart at recorded
  transition boundaries. Preserve dirty WIP and prove no duplicate assignment,
  receipt, publication, or lost closure. Interrupt only experiment-owned PIDs.

Include correctness fixtures with deliberately seeded reviewable defects in a
separate labeled review-quality suite; keep its results out of speed timings.
Reviewers receive no peer verdict before both first passes are sealed.

## Observations and result rules

Each observation binds run ID, mode, class, repetition, repository, ticket/task,
role generation, candidate/base, source/harness/model identities, cache policy,
UTC timestamp, monotonic elapsed time, event origin, and evidence reference.
Persist observations append-only; reject stale/missing identities. Never store
authentication tokens or raw provider/chat content in the public report.

Record actual task-ready, assignment, candidate-ready, review-start/seal/release,
correction, local-validation, publication, merge/readback, and task-delivered
events. Count remote pushes, PRs, merges, validation attempts, role wakes,
chat bytes, no-ops, and recovery events. Include failures and interrupted runs.
An invalid or incomplete run cannot contribute a successful speed result.

Report total wall time plus separately identified external waits; never remove
waits to manufacture a win. Measure reviewer-wait-only Dev idle only while an
independent task is actually ready. Report active/idle builder-slot time and
delivered tasks per builder-slot-hour. Report host CPU/RSS/swap/pressure with
sampling interval and overhead. Missing token telemetry is `unavailable`, not
zero and not estimated from chat bytes. Treat cached-token counts separately.

Report V1-to-V2 total improvement and Mode-2-to-V2 incremental improvement
separately, as `(baseline_ms - v2_ms) / baseline_ms * 100`; never add the two
percentages or attribute all improvement uniquely to pipelining. Numeric targets
apply only to pipeline-eligible runs. Actual-run review evidence must report
unique and blocking defects, overlapping findings, disagreements, propagation
stops, and stale-review rejection. Seeded review-quality tests supplement it.
Compare authenticated independent receipts, ticket/task/manifest provenance,
crash/reset continuity, bounded reconciliation, and one-candidate local
verification with each direct mode's observed behavior.

Use a predeclared repetition count and order. Proposed initial bounded pass is
one complete run per mode/class (ten live batches). Three tasks with one build
and two reviews per task would mean 90 task-level model assignments, before
Head, corrections, final reviews, and probes. This is a planning estimate, not
a measured cost or mandatory count: V1 and the serial ablation review at ticket
boundaries, while V2 also has task reviews. Declare each mode's actual review
granularity and launch cap; do not artificially add V2 task review to V1 to make
counts identical. Additional runs require a declared budget; three repetitions
roughly triple execution volume. One run is a case study,
not a median or a stable speed estimate. Publish every sample and range; even a
median of three is descriptive, not statistically stable. Provider/server caching may not be
fully controllable: record observed cache telemetry, reset local sessions and
target repos, and do not call that a provider-cold cache guarantee.

## Calibration and freeze order

1. Review the methodology, task bundle, run/cost caps, identities, and adapters.
2. Build and validate the harness offline. Mode 3 throughput remains disabled.
3. Check provider authentication without exposing credentials; a harmless live
   probe follows only the accepted run budget. No credential copy/rotation.
4. Collect matched Modes 1 and 2 baseline runs. Unavailable baselines are blockers.
5. Produce concrete baseline-derived total and incremental improvement targets
   and a candidate-ready-to-next-assignment SLO. Record the derivation and
   numerical values in an immutable measurement manifest.
6. Obtain the operator review explicitly required by #1037, plus independent
   methodology review. Bind approval to the exact manifest digest. This draft
   and a model-setting change are not that approval.
7. Only then enable timed Modes 3–5 and the separate safety/recovery proofs.
   No observed Mode 3 timing may inform target selection. Failure retains its
   evidence; source/base/contract changes invalidate affected standing. Retain
   failed results and the original numeric targets. New source must not silently
   relax targets or restart calibration after observing Mode 3. Any contract
   revision remains visible and is not evidence of passing the original gate.
8. Independently review the result and unresolved evidence, then prepare the
   release-version PR and final package checks. Publish remains an operator step.

## Manifest validation contract

The manifest must contain per-mode definitions/ablation, builder/reviewer slot
budgets, exact workload identity and task-to-ticket/file/dependency mapping,
performance classes, role model identities, host/cache/run budgets and trial
order. Frozen manifests add immutable calibration artifact SHA256 references,
eligible class and target metric, both numeric target values and their
derivation, the assignment SLO, and digest-bound operator/independent approval.
Hash canonical JSON excluding approval records, derived status, and the
`freeze_digest` field itself. Keep `prior_freeze_digest` inside the hashed content.
Approval references must resolve to actual review evidence; a local string or
an approval boolean is not proof of human approval.

`mode_3_timing_permitted` is a derived display value; tools must never trust it
as authorization. A draft is valid preparation data but never runnable timing
data. Freeze validation rejects missing fields, empty calibration, malformed or
unresolved evidence, altered content after approval, and target relaxation.
Reports reject replay/live mixing, incomplete runs, missing identity anchors,
duplicate terminal observations, and regressions in monotonic ordering.

## Bounded implementation sequence

| Unit | Allowed scope | Done condition |
|---|---|---|
| A. Manifest and evidence collector | Non-shipping benchmark tools and focused tests | Typed observations, provenance, incomplete-run refusal, Mode 3 freeze guard, secret-free reports; no external writes/provider launches |
| B. Workload and runtime adapters | Non-shipping fixture project and adapter tests | Same acceptance bundle; actual HTTP/MCP V2 path; authentic reviewer identity; serial ablation; truthful V1 feasibility result |
| C. Calibration and execution | Owned disposable instances and repositories, retained evidence | Actual bounded runs, calibrated manifest approval, safety/recovery proof, no Actions |
| D. Release preparation | Version/lockfile, release procedure and notes | Independent release review and clean install artifact; coordinate existing #1026 release gate |

File-level ownership and live issue ACs are required before agent implementation.
Do not create a general scheduler or copy production state machines into the
harness. Unit A cannot claim completion of B or C.

The initial Unit A implementation has a deliberately read-only ledger validator
(`benchmark/evidence.cjs`). Its append operation is a pure, immutable-value
transformation so the future runtime must retain the returned full history; it
does not write a file or attempt to erase evidence. A single ledger carries one
of `live`, `replay`, or `historical` provenance only. Its public report excludes
anchor values and evidence references, so raw provider/chat content and secrets
have no accepted field. It returns structural completeness only: full task and
receipt validation stays in the later manifest/evidence verifier, so no report
from this utility can authorize calibration, a freeze, or Mode 3 timing.

The initial Unit B input is `benchmark/fixtures/catalog/`. Both fixture roots
have the same acceptance suite and fixed adapter, but the pipeline-eligible
layout gives A1, A2, and B1 separate implementation files while the overlap-
bound layout requires all three to change one file. Their baseline stubs are
intentionally incomplete. No fixture test result is evidence of a provider run
until a later adapter has created a recorded disposable repository and verified
the read-only input digests.

## Initial preflight, 2026-09-19

- Worktree: `quadwork-v2-benchmark-prep`, branch `task/1037-benchmark-prep`.
- Node `v24.18.0`, npm `11.16.0`; Codex `0.153.1` and Claude `2.1.267` are installed.
  Gemini was not found on PATH. `codex login status` returned exit 0 and reported
  logged in; no model request was made. Supported benchmark model IDs and
  endpoint entitlements remain unverified. No credential values were printed.
- `claude auth status --json` returned exit 1 and `loggedIn=false`. No inference
  or credential change occurred. Distinct reviewer models do not inherently
  require different providers, so review model assignment can consider two
  supported Codex models without claiming their endpoint access is verified.
- GitHub repository Actions permission is `enabled=false`.
- No provider inference or new benchmark run has been performed.
- No numeric target exists yet. No final measurement manifest is frozen.
- Open #1026 specifies `2.8.0`, a version-only PR, dual review, and a tag/release
  on the final merged main before operator npm publish. Retain that existing
  ordering; earlier conversational advice to tag only after publish did not
  reflect this issue. Update its release scope for V2 and replace hosted CI
  wording with the approved local verification contract. Do not run the chained
  `release:*` commands. A major version requires an explicit operator decision.

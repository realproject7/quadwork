# Local-first exact-SHA review

QuadWork's V1 workflow historically published a feature branch before substantive review. Every reviewer finding then produced another push, and repositories that run release-grade CI on every `pull_request.synchronize` multiplied that feedback loop into paid runner minutes.

The local-first review gate moves the **intermediate review loop** off GitHub:

```text
local implementation + tests
        ↓
exact candidate SHA + pinned base
        ↓
RE1 local review ─┐
RE2 local review ─┴─ both approve the same SHA
        ↓
one validated push + PR creation
        ↓
Head exact-SHA verification
        ↓
automatic PR CI or repository-defined candidate admission
        ↓
formal GitHub reviews on the unchanged SHA
        ↓
optional repository-defined final/full admission
        ↓
Head final verify + merge gate
```

It does not weaken the two-reviewer gate, skip required GitHub CI, or auto-merge. It makes one reviewed candidate—not each exploratory or reviewer-fix commit—the unit of remote work.

## Commands

Run these commands inside any worktree that belongs to the same Git repository. The candidate, pinned base, approvals, and publication record live in private `refs/quadwork/reviews/*` refs in the shared Git directory and are never pushed.

### Dev: create or replace a candidate

```bash
npx quadwork review candidate 123 --base origin/main
```

Requirements:

- named non-protected feature branch;
- clean worktree;
- base is an ancestor of `HEAD`;
- implementation, tests, and PR body are complete.

Creating a candidate atomically clears RE1, RE2, and publication refs. Any fix therefore needs two fresh local approvals.

### Reviewer: check out the exact candidate

Reuse the configured reviewer worktree and its installed dependencies:

```bash
npx quadwork review checkout 123 --role re1 --in-place
# or: --role re2
```

The review diff is:

```bash
git diff refs/quadwork/reviews/123/base...HEAD
```

A separate managed worktree is available by omitting `--in-place`.

### Reviewer: approve the exact SHA

```bash
npx quadwork review approve 123 --role re1 --summary "tests and diff reviewed"
npx quadwork review approve 123 --role re2 --summary "independent review complete"
```

The command refuses `HEAD` when it does not equal the current candidate. These local approvals authorize one publication; they are not substitutes for formal GitHub reviews or repository-required remote CI evidence.

### Dev: publish once

```bash
npx quadwork review publish 123 \
  --title "[#123] Description" \
  --body-file /tmp/pr-body.md
```

Before any remote mutation it verifies:

- both local approvals equal the candidate;
- Dev `HEAD` and branch equal the reviewed candidate/branch;
- the protected base has not moved;
- the worktree is clean;
- required PR details exist;
- an existing PR, when present, is still open and targets the reviewed branch/base.

It then pushes the reviewed branch once, creates or finds the PR, reads the PR back, and records publication only after the remote branch and PR head equal the candidate SHA. Re-running at the same SHA is idempotent.

After publication, Dev sends one remote-evidence handoff naming the PR and exact SHA to both reviewers. When the repository uses Head-owned CI admission, the same handoff must wake Head; a PR `opened` or `synchronize` event may intentionally run no expensive jobs.

### Reviewer/Head: verify the remote handoff

```bash
npx quadwork review verify 123 --pr 456
```

The command fails unless all of these still agree:

- candidate SHA;
- pinned base SHA;
- RE1 and RE2 local approvals;
- published SHA;
- remote branch head;
- open, non-draft PR head and target base.

Reviewers run it before submitting formal GitHub reviews. Head runs it before every repository-defined CI admission and again immediately before the existing live CI/review/mergeability checks.

## Repository CI admission compatibility

QuadWork does not prescribe a repository's workflow names, labels, or job topology. It supports two repository policies.

### Automatic PR CI

The validated publication triggers the repository's normal PR workflow. Because the local review loop already converged the candidate, the expected steady state is one publication and one remote candidate run. A real CI or formal-review code finding starts a new local candidate cycle and one replacement publication.

### Head-admitted CI

Some repositories intentionally keep expensive jobs off ordinary `opened` and `synchronize` events. Those source events may run only a cheap classifier/control-plane job. Head then requests remote evidence only after:

1. `quadwork review verify` succeeds for the exact published SHA;
2. the repository-specific candidate trigger is applied once; and
3. any later final/full trigger is applied only when the repository's own policy requires distinct final evidence.

A repository may call those triggers `ci:ready` and `ci:full`, use `workflow_dispatch`, or use another fixed mechanism. QuadWork deliberately does not hardcode them.

### Evidence and retip rules

- A label being present is not proof that CI ran for the current SHA. Where the trigger is a `pull_request:labeled` event, a new source SHA requires removing and reapplying the label after exact-SHA verification.
- Local RE1/RE2 approvals authorize publication only. Formal GitHub reviews on the published current SHA remain the remote review evidence.
- A new SHA invalidates the previous local approvals, formal reviews, candidate CI, and final/full CI.
- Reviewers do not mutate CI-admission labels. Head owns the exact-SHA admission sequence.
- Head must not start a final/full admission if doing so would cancel an unfinished candidate run in the same concurrency group.
- Final/full admission runs once, after both formal current-tip reviews, when the repository requires it.

### Minimize Actions, not only pushes

The lowest-cost safe policy depends on the repository:

- If one remote workflow can provide all required evidence, admit it once after the local two-reviewer gate.
- If early deterministic candidate evidence and later release-grade evidence are genuinely different, run each once and keep their job sets non-duplicative where possible.
- Do not run two labels that repeat the same gates merely because two names exist.
- Ordinary source events should remain cheap in admission mode.
- `cancel-in-progress` is a safety net, not a cost-control strategy; work already executed before cancellation is still consumed.
- Mutation commits, negative controls, speculative fixes, and reviewer-by-reviewer corrections stay local.

This protocol minimizes **remote candidate count**. Repository workflow design still determines **runner-minutes per candidate**; both layers must be efficient to minimize total Actions spend.

## Push guard

Creating a candidate installs a repository-local `pre-push` guard. It blocks a direct push only when the branch has an active QuadWork local-review state; unrelated branches remain untouched. `publish` uses a one-shot internal bypass after every gate has passed.

An existing user-owned `pre-push` hook is never overwritten. In that case the CLI prints a warning and the protocol remains enforced by role instructions and the publish/verify commands.

## Agent protocol migration

The `quadwork` entrypoint installs a versioned managed block into:

- the four role seed files in a published/npx package; and
- every configured role worktree's `AGENTS.md`.

The block is idempotently replaced on start/CLI use, so existing installations receive the local-first workflow without manually reseeding four files. A source checkout is not dirtied; its runtime worktrees are still migrated. Set `QUADWORK_DISABLE_LOCAL_FIRST_REVIEW=1` only for an explicit operator rollback.

## What stays remote

The final candidate still receives the repository's configured remote evidence policy: automatic PR CI or exact-SHA Head admission, deployment previews where required, formal RE1/RE2 GitHub reviews or repository-required attestations, and Head merge checks. CI or formal-review findings that require code changes create a new local candidate and invalidate all evidence tied to the prior SHA.

This is intentionally a bounded V1 cost-control layer. It does not implement the server-owned V2 dispatcher and authenticated receipt model in QuadWork issue #1048; that future cutover can replace the managed V1 block atomically.

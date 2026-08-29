# CI Economy for QuadWork Projects

QuadWork's two-review workflow is valuable, but a repository can accidentally multiply CI cost when every small push runs release-grade verification. The cost model is multiplicative:

```text
remote candidates per ticket × runner-minutes per candidate
```

The solution is not to weaken review. It is to make a **candidate** the unit of remote work.

## The candidate lifecycle

```text
local implementation
  → local fast verification
  → candidate C1 push
  → RE1 + RE2 review the same SHA
  → aggregate both verdicts
  → local consolidated fix
  → candidate C2 push
  → delta review + full candidate CI
  → merge
```

A candidate is a commit that Dev believes could merge. Work-in-progress commits, deliberately broken mutations, and one-reviewer-at-a-time fixes remain local.

### Invariants

1. The two reviewers remain independent.
2. Both final approvals name the same current SHA.
3. A push invalidates approvals and full-CI evidence for the previous SHA.
4. Dev waits for both verdicts before starting the next review revision.
5. One review round produces at most one remote push.
6. Negative controls and mutation/revert pairs never enter the remote PR history.

## Repository workflow contract

A QuadWork-friendly repository exposes two checks with stable names.

### Fast CI

Triggered by ordinary pull-request activity:

- `opened`
- `synchronize`
- `reopened`

It should normally finish in a few minutes and include only inexpensive deterministic checks:

- formatting and lint
- type checking
- focused or changed-package unit tests
- source guards and no-stub checks
- lightweight build or import smoke checks

Fast CI is the feedback loop for a candidate push. It is not a smaller copy of the release pipeline.

### Full Candidate CI

Triggered by one of:

- `pull_request: ready_for_review`
- `pull_request: labeled` when the added label is `ci:full`
- `push` to `main`
- `schedule`
- `workflow_dispatch`

It owns expensive or broad verification:

- complete OS/runtime matrices
- full E2E and browser suites
- container builds
- release-mode compilation
- database restore/dump verification
- provenance and publish checks

Do not include `synchronize` in the Full Candidate CI trigger. For a revised candidate, remove and re-add `ci:full` after the consolidated push. The label event then attaches full verification to the new HEAD without running it on intermediate commits.

## Reference GitHub Actions shape

### `.github/workflows/ci-fast.yml`

```yaml
name: CI Fast

on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: ci-fast-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  fast:
    name: fast
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/ci/fast
```

### `.github/workflows/ci-full.yml`

```yaml
name: CI Full Candidate

on:
  pull_request:
    types: [ready_for_review, labeled]
  push:
    branches: [main]
  schedule:
    - cron: "17 4 * * *"
  workflow_dispatch:

concurrency:
  group: ci-full-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      run: ${{ steps.plan.outputs.run }}
    steps:
      - id: plan
        env:
          EVENT: ${{ github.event_name }}
          ACTION: ${{ github.event.action }}
          LABEL: ${{ github.event.label.name }}
        run: |
          if [ "$EVENT" != pull_request ] || [ "$ACTION" = ready_for_review ] || [ "$LABEL" = ci:full ]; then
            echo 'run=true' >> "$GITHUB_OUTPUT"
          else
            echo 'run=false' >> "$GITHUB_OUTPUT"
          fi

  full:
    needs: plan
    if: needs.plan.outputs.run == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/ci/full
```

The small `plan` job is optional when every expensive job can share the same direct `if:` expression. It is useful when a workflow has a large matrix and you want one audited decision point.

## Path classification

Path filters reduce cost only when they are correct. Use these rules:

- Unknown paths run the broader lane; false positives cost time, false negatives ship defects.
- Workflow, lockfile, root configuration, Dockerfile, migration, and shared-package changes are broad-impact by default.
- Documentation-only paths may skip runtime jobs when they are truly outside every build context.
- Do not infer Docker impact from import graphs while the Dockerfile still uses `COPY . .`; first narrow the build context or stage copies.

For monorepos, compute the merge-base diff once and publish explicit outputs such as `web`, `server`, `shared`, `docker`, and `workflow`. Downstream jobs consume those outputs rather than each repeating checkout and classification.

## Containers and releases

PR image builds should run only when Docker/runtime inputs changed and only for a full candidate. Main-branch image publication should be separated from ordinary CI when possible:

- explicit deployment dispatch, or
- a release-train branch/tag, or
- a path-classified main push when immediate deployment is required.

Publishing three images after every tiny merge turns ticket granularity into deployment cost. A release train can batch several independently reviewed tickets without weakening the review gate on any ticket.

## Local evidence

Mutation and negative-control evidence belongs in the PR body, for example:

```markdown
- Mutation: inverted `canManageGuests` result locally
- Command: `pnpm test canManageGuests`
- Observed: 2 failures, expected assertion names shown
- Reverted locally before candidate SHA `abc1234`
```

Never push the broken mutation and a revert solely to prove the test. GitHub bills both candidates and may begin several jobs before cancellation takes effect.

## Expected impact

The savings depend on both factors:

```text
before = average remote pushes × full-run minutes

after = candidate pushes × (fast-run minutes + occasional full-run minutes)
```

A repository averaging three PR pushes plus one main run can commonly move from four full pipelines per ticket to:

- two or fewer fast pipelines,
- one full candidate pipeline, and
- one main pipeline or release-train publication.

Repositories with large OS matrices, E2E shards, or container matrices see the largest reduction. The review standard remains unchanged; only redundant remote execution is removed.

## Migration checklist

1. Measure job-minutes by job family, not only workflow count.
2. Establish `CI Fast` and `CI Full Candidate` as stable check names.
3. Move complete matrices, full E2E, image verification, and release compilation to the full lane.
4. Keep deterministic source gates in the fast lane.
5. Add the `ci:full` label.
6. Update branch protection to require the intended candidate checks.
7. Run one negative control proving a red candidate cannot merge.
8. Teach Dev to remove/re-add `ci:full` only after a consolidated candidate push.
9. Review usage after one week and tighten path classification only with evidence.

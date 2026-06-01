# Review batches

A **review batch** runs the same Head → Dev → RE1/RE2 → Head loop as a normal
code batch, but in **review-only** mode: the team reviews GitHub *tickets* or
*merged PRs* instead of building code. A review batch **never opens a PR and
never merges or lands code** — its output is review verdicts, edited issue
bodies, and follow-up tickets.

There are two batch types:

- **`ticket-review`** — review issue specs (scope, acceptance criteria, clarity) *before* they're built.
- **`pr-review`** — review already-merged PRs after the fact; capture findings as follow-up fix tickets.

## How to start one

Ask Head in chat, exactly as you'd start a code batch:

- **Tickets:** `@head review tickets #12 #15 #18`
- **Merged PRs:** `@head review merged PRs #40 #41`

Head writes the work into `OVERNIGHT-QUEUE.md` the normal way (next sequential
`**Batch:** N`), with one extra marker line and per-item state annotations.

## The queue contract

The only structural difference from a code batch is a **`**Batch type:**`**
line right after `**Batch:** N`, plus an in-place state annotation on each item.
The marker is scoped to the `## Active Batch` section.

```markdown
## Active Batch

**Batch:** 7
**Batch type:** ticket-review
**Started:** 2026-06-01 02:10

- #12 — queued
- #15 — in-review (1/2)
- #18 — approved
```

For `pr-review`, the marker is `**Batch type:** pr-review` and the items are PR
numbers. Each item is `- #<n> — <state>` (dash, space, `#`, number, space,
em-dash, space, state). The accepted markers are `code` (the default — absent or
unrecognized markers fall back to `code`), `ticket-review`, and `pr-review`.

### Item-state vocabulary (must match exactly)

| State | Meaning |
|-------|---------|
| `queued` | Not yet picked up |
| `in-review` | Dev requested review; reviewers working |
| `in-review (N/2)` | `N` of 2 reviewers have approved (e.g. `in-review (1/2)`) |
| `approved` | Both reviewers approved (terminal) |
| `changes-requested` | A reviewer asked for changes |

These exact strings are what the dashboard's **Current Batch Progress** panel
parses — it shows review states (*queued · in review · 1 of 2 approvals ·
approved*), never merge language. Items stay in `## Active Batch` with their
annotation (updated **in place**) until the **whole** batch is `approved`, then
Head archives the block to `## Done`, preserving the `**Batch:** N` and
`**Batch type:**` lines.

## What each agent does

| Agent | In a review batch |
|-------|-------------------|
| **Head** | Assigns each item to Dev; updates item states in place; archives the block when every item is `approved`. No merge step. |
| **Dev** | Reviews the ticket spec / merged diff, requests review from RE1 + RE2, edits issue bodies and files follow-up fix tickets **via REST**. |
| **RE1 / RE2** | Assess the ticket or merged diff against a rubric and report their verdict to Dev. |

For `ticket-review`, `approved` means both reviewers signed off on the spec
(after any edits). For `pr-review`, the PR is already in `main`, so `approved`
means **the findings were captured** — follow-up tickets filed and a summary
comment posted — not that the PR was reverted or re-merged.

## GraphQL-budget property

Review discovery is deliberately cheap on the GitHub API. Progress is computed
entirely from the queue's `## Active Batch` annotations — **zero** GitHub calls.
For live ticket bodies and diffs, Dev reads the server-authored
`~/.quadwork/<project>/GITHUB.md` first, then uses **REST** `gh api` endpoints
(`gh api repos/<repo>/issues/<n>`, `.../pulls/<n>/files`, …). It avoids the
GraphQL-backed `gh issue view --json` / `gh pr view --json` / `gh pr list`,
which would burn the hourly GraphQL points the review batch is meant to conserve.

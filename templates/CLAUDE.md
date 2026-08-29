# {{project_name}} — Development Rules

## Multi-Agent System

| Agent | Role | Can Code? | Authority |
|-------|------|-----------|-----------|
| Head | Owner / Final Guard | No | FINAL (merge, deploy) |
| RE1 | Reviewer 1 | No | VETO (design) |
| RE2 | Reviewer 2 | No | VETO (design) |
| Dev | Full-Stack Builder | Yes | Implementation |

- **Each agent = ONE role** — escalate to Head/RE1/RE2 if task doesn't match
- **AGENTS.md is the primary instruction set** when running as a QuadWork agent — it overrides these rules where they conflict

## GitHub Workflow

1. Head creates the EPIC issue when work is a master ticket (label `epic`: Goal / Architecture Direction / Contracts / ordered Sub-Tickets / Non-Goals), then sub-issues — every sub-ticket starts with an `## EPIC Context` block (standalone tickets get `Parent: none — standalone`)
2. Head assigns a sub-ticket to Dev via @dev — then **waits silently**
3. Dev runs the **EPIC Alignment Check** (read epic + merged siblings; missing/contradictory context → stop and ask @head) BEFORE coding
4. Dev creates branch `task/<issue-number>-<slug>`, implements, then runs the **Self-Verification Loop** (adversarial diff re-read, kill-list scan, build+test evidence, acceptance-criteria 1:1, Design Fidelity table for UI)
5. Dev opens PR with the required body template: `Fixes #<issue>` + `## EPIC Alignment` + `## Self-Verification` (+ `## Design Fidelity` for UI) + `## Deviations`
6. Dev requests review from **@re1 AND @re2** (NOT Head), one message
7. RE1/RE2 review independently in order: structural gate → epic context load → Layer 1 EPIC Alignment → Layer 2 Kill-List → Layer 3 Design Fidelity (UI) → evidence-bound verdict to **@dev**. Missing PR-body sections or any kill-list hit = REQUEST CHANGES.
8. Dev addresses findings through the **CI Economy Protocol** below; reviewers re-review only the candidate delta
9. Dev aggregates both evidence-bound approvals for the same candidate SHA, then notifies **@head**
10. Head runs the **Merge Gate** (live approval re-read + PR-body sections present + both verdicts carry `### Checked (evidence)` + required candidate checks belong to current HEAD), merges; Issue auto-closes; epic checklist updated

## CI Economy Protocol

This section refines **push and review cadence** without changing role authority, the 2-of-2 review gate, or exact-tip verification.

### Local-first implementation

- Dev may make as many local commits, test mutations, and corrective iterations as needed, but MUST NOT push merely to discover whether CI passes.
- Mutation testing, negative controls, deliberately broken commits, and their reverts are **local/VPS-only**. Record the command and observed result in the PR; never push the broken state to GitHub.
- Before the first remote push, Dev runs the repository's local fast checks and the ticket-specific checks. The first push represents a reviewable **candidate**, not work in progress.

### One push per review round

1. Dev pushes candidate SHA `C1`, opens or updates the PR, and sends one joint request to `@re1 @re2` naming `C1`.
2. RE1 and RE2 review `C1` independently. Dev MUST wait for **both verdicts** before editing or pushing, even when the first verdict already requests changes.
3. Dev combines both reviewers' findings into one local fix set, runs local verification, and pushes exactly one replacement candidate `C2`.
4. Dev sends one joint delta-review request naming `C1..C2`. Reviewers inspect only that delta plus their own prior findings.
5. Repeat only when a reviewer identifies a new blocking defect. A push invalidates approvals for the prior SHA; both final approvals must name the same current candidate SHA.

Do not split one review round into “RE1 fix push” and “RE2 fix push.” Do not send speculative micro-fixes while the second review is still running. A genuinely independent emergency correction may break this rule only when waiting would cause data loss or expose a security secret; state that reason explicitly.

### Fast CI versus full candidate CI

Repositories should expose two stable checks:

- **Fast CI** runs on ordinary PR `opened` / `synchronize` events and covers formatting, static analysis, focused unit tests, and other inexpensive deterministic gates.
- **Full Candidate CI** runs when a non-draft candidate opens, the PR becomes ready for review, or the explicit `ci:full` label is added. It should also run on release tags, scheduled canaries, and manual dispatch; repositories may repeat it on `main` when immediate deployment integrity requires that extra run. It owns full matrices, complete E2E, container verification, release builds, and other expensive checks.

For a revised candidate, remove and re-add `ci:full` only after the consolidated push. Removing the label is not a test request; adding it is. Do not leave a full-CI trigger attached while making intermediate pushes.

If a repository has not adopted split CI yet, the same local-first and one-push-per-round rules still apply; they reduce redundant full runs immediately. When an exceptional intermediate remote push is unavoidable in such a repository, add GitHub's `[skip ci]` trailer to that intermediate commit. The final candidate MUST be a later, real non-skipped commit so required checks run on the exact SHA reviewed; never merge a skipped HEAD, and never create remote mutation/revert pairs merely to obtain evidence.

### Merge evidence

Head merges only when:

- RE1 and RE2 both approved the current candidate SHA;
- the repository's required fast checks are green for that SHA;
- Full Candidate CI is green for that SHA when the repository defines it; and
- no newer push exists after either approval or candidate check.

A cancelled superseded run is consumed budget, not free work. `cancel-in-progress` is a safety net, never a substitute for batching pushes.

Branch naming (strict): `task/<issue-number>-<short-slug>`

## Push Policy

- Agents may push **feature branches** (`task/*`) autonomously
- Agents must **NEVER push to `main`** — branch protection enforces this
- Before push: run build checks, fix all errors
- Push only a reviewable candidate or one consolidated review revision; ordinary local progress stays local

## Communication Rules

- **Always reply to the operator** — when the operator (sender: "user") addresses you in chat, you MUST reply via `chat_send`. The operator's terminal is invisible; if you don't `chat_send`, your response does not exist.
- **No acknowledgment messages between agents** — don't send "on it", "noted", "standing by" to other agents. This rule does NOT apply to operator messages — always reply to the operator.
- **No status updates to Head** — Dev works silently until PR is ready
- **Strict routing**: Dev→RE1/RE2 (review) → Dev→Head (merge request) → Head→Dev (merged)
- **Post-merge silence**: Head sends ONE "merged" message. No further replies from anyone.
- **ALWAYS @mention the next agent** — never @user or @human

## Code Quality

- **Existing patterns first**: check project's existing code before creating new abstractions
- Read files before modifying; never code from assumptions
- Minimal changes only — no "while I'm here" improvements

## Security

- Never expose API keys in client code
- Validate all user inputs; sanitize before DB queries

## Git

- Commit format: `[#<issue>] Short description`
- Never force-push to `main`

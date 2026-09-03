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
5. Dev opens PR (draft until the Self-Verification Loop passes) with the required body template: `Fixes #<issue>` + `## EPIC Alignment` + `## Self-Verification` (+ `## Design Fidelity` for UI) + `## Deviations`
6. Dev marks the PR ready; the server emits one system-origin `@re1 @re2 [REVIEW REQUEST] repo=… issue=… contract=… pr=… sha=… cycle=…` — nobody hand-fans reviewers
7. RE1/RE2 review independently in order: structural gate → epic context load → Layer 1 EPIC Alignment → Layer 2 Kill-List → Layer 3 Design Fidelity (UI) → evidence-bound verdict to **@dev @head**, bound to the exact SHA via `issue_review_cycle_nonce` + `submit_review_cycle_receipt`. Missing PR-body sections or any kill-list hit = REQUEST CHANGES.
8. Dev addresses findings, pushes; the new tip is a new cycle with a new request; reviewers re-review the delta and file a new receipt
9. At `2/2` receipts + passing CI + mergeable the server emits `@head [MERGE GATE DUE]`; Dev sends `[STATUS DONE]` to **@head**
10. Head runs the **Merge Gate** (live re-read of both receipts at the exact SHA + PR-body sections present + both verdicts carry `### Checked (evidence)`), merges; Issue auto-closes; epic checklist updated

Branch naming (strict): `task/<issue-number>-<short-slug>`

## WorkTask Batches (V2)

Ticket → WorkTask → Delivery Candidate. A WorkTask is Head's immutable slice of one ticket in a frozen Batch Manifest; Dev builds it in the registered Dev worktree and records a clean local candidate SHA (`submit_work_task_candidate`); RE1/RE2 seal independent receipts (`submit_work_task_review_receipt`) before either sees the other's; Head reconciles and cuts. A WorkTask candidate never pushes, opens a PR, starts CI, merges, or deploys — publication happens only through the Delivery Candidate PR and the review cycle above.

## Push Policy

- Agents may push **feature branches** (`task/*`) autonomously
- Agents must **NEVER push to `main`** — branch protection enforces this
- Before push: run build checks, fix all errors

## Communication Rules

- **Always reply to the operator** — when the operator (sender: "user") addresses you in chat, you MUST reply via `chat_send`. The operator's terminal is invisible; if you don't `chat_send`, your response does not exist.
- **No acknowledgment messages between agents** — don't send "on it", "noted", "standing by" to other agents. This rule does NOT apply to operator messages — always reply to the operator.
- **No status updates to Head** — Dev works silently until PR is ready
- **Strict routing**: server→RE1/RE2 (`[REVIEW REQUEST]`) → RE1/RE2→Dev+Head (verdict) → server→Head (`[MERGE GATE DUE]`) → Head→Dev (merged)
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

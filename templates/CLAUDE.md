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
8. Dev addresses findings, pushes, re-requests; reviewers re-review the delta only
9. Dev aggregates both evidence-bound approvals, then notifies **@head**
10. Head runs the **Merge Gate** (live approval re-read + PR-body sections present + both verdicts carry `### Checked (evidence)`), merges; Issue auto-closes; epic checklist updated

Branch naming (strict): `task/<issue-number>-<short-slug>`

## Push Policy

- Agents may push **feature branches** (`task/*`) autonomously
- Agents must **NEVER push to `main`** — branch protection enforces this
- Before push: run build checks, fix all errors

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

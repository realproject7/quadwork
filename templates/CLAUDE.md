# {{project_name}} — Development Rules

## Multi-Agent System (AgentChattr)

| Agent | Role | Can Code? | Authority |
|-------|------|-----------|-----------|
| T1 | Owner / Final Guard | No | FINAL (merge, deploy) |
| T2a | Reviewer 1 | No | VETO (design) |
| T2b | Reviewer 2 | No | VETO (design) |
| T3 | Full-Stack Builder | Yes | Implementation |

- **Each agent = ONE role** — escalate to T1/T2a/T2b if task doesn't match
- **There is no agent named "t2"** — always use `@t2a` and `@t2b` separately
- **AGENTS.md is the primary instruction set** when running as an AgentChattr agent — it overrides these rules where they conflict

## GitHub Workflow

1. T1 creates Issue with scope, acceptance criteria, `agent/T*` label
2. T1 assigns to T3 via @t3 — then **waits silently**
3. T3 creates branch: `task/<issue-number>-<slug>`
4. T3 opens PR with `Fixes #<issue>`
5. T3 requests review from **@t2a AND @t2b** (NOT T1)
6. T2a/T2b review PR (APPROVE/REQUEST CHANGES/BLOCK) — send verdict to **@t3**
7. T3 aggregates both approvals, then notifies **@t1**
8. T1 verifies approvals, merges; Issue auto-closes

Branch naming (strict): `task/<issue-number>-<short-slug>`

## Push Policy

- Agents may push **feature branches** (`task/*`) autonomously
- Agents must **NEVER push to `main`** — branch protection enforces this
- Before push: run build checks, fix all errors

## Communication Rules

- **No acknowledgment messages** — don't send "on it", "noted", "standing by"
- **No status updates to T1** — T3 works silently until PR is ready
- **Strict routing**: T3→T2a/T2b (review) → T3→T1 (merge request) → T1→T3 (merged)
- **Post-merge silence**: T1 sends ONE "merged" message. No further replies from anyone.
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

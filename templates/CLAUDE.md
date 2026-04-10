# {{project_name}} — Development Rules

## Multi-Agent System (AgentChattr)

| Agent | Role | Can Code? | Authority |
|-------|------|-----------|-----------|
| Head | Owner / Final Guard | No | FINAL (merge, deploy) |
| RE1 | Reviewer 1 | No | VETO (design) |
| RE2 | Reviewer 2 | No | VETO (design) |
| Dev | Full-Stack Builder | Yes | Implementation |

- **Each agent = ONE role** — escalate to Head/RE1/RE2 if task doesn't match
- **AGENTS.md is the primary instruction set** when running as an AgentChattr agent — it overrides these rules where they conflict

## GitHub Workflow

1. Head creates Issue with scope, acceptance criteria, `agent/*` label
2. Head assigns to Dev via @dev — then **waits silently**
3. Dev creates branch: `task/<issue-number>-<slug>`
4. Dev opens PR with `Fixes #<issue>`
5. Dev requests review from **@re1 AND @re2** (NOT Head)
6. RE1/RE2 review PR (APPROVE/REQUEST CHANGES/BLOCK) — send verdict to **@dev**
7. Dev aggregates both approvals, then notifies **@head**
8. Head verifies approvals, merges; Issue auto-closes

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

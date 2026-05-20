# {{project_name}} — Overnight Queue

> **Repo:** {{repo}}
> **Updated by:** Head agent (do not edit manually unless necessary)
>
> Head reads this file to pick the next ticket. After each PR is merged,
> Head assigns the next item to Dev. Reviewers wait for Dev's request.

---

## Active Batch

(no active batch yet — operator will assign one via chat. Head will use batch number 1 for the first batch.)

---

## Backlog

(none)

---

## Done

(none)

---

## Rules

1. Head reads this file at startup and after every merge.
2. One ticket assigned to Dev at a time.
3. Wait for both reviewers to approve before merging.
4. After merge, immediately assign next item.
5. Operator interacts via the project chat panel (top-left) — never via terminal.

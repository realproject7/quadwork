# {{project_name}} — Overnight Queue

> **Repo:** {{repo}}
> **Updated by:** Head agent (do not edit manually unless necessary)
>
> Head reads this file to pick the next work. The server parses only the
> `## Active Batch` section; everything else is Head's human-readable record.

---

## Active Batch

(no active batch yet — operator will assign one via chat. Head will use batch number 1 for the first batch.)

---

## Holds

(none)

---

## Backlog

(none)

---

## Done

(none)

---

## Rules

1. Head reads this file at startup and after every merge, cut, or batch closure.
2. `## Active Batch` grammar the server parses: standalone `**Batch:** <n>`, `**Batch type:** code | ticket-review | pr-review` (at most one), `**Installation:** <id>`, `**Assignment attempt:** <id>`, then one item per line `- owner/repo#<n> — <state>`. A bare `#<n>` is legacy and leaves the batch unowned.
3. Nested task lines under an item (`  - <task_key> — <state>`, state one of `queued building candidate_ready independent_review reconcile changes_requested accepted staged blocked deferred`) are display only. Task identity and state live in the frozen Batch Manifest; the server ignores these lines. Record the batch delivery mode in the manifest and mirror it here as `**Delivery:** integrated | isolated`.

   ```
   **Batch:** 1
   **Batch type:** code
   **Installation:** <installation-id>
   **Assignment attempt:** <attempt>
   **Delivery:** integrated
   - owner/repo#12 — building
     - t1 — building
     - t2 — queued
   - owner/repo#15 — queued
   ```

4. One Dev build task at a time. Head may assign the next independent task with a disjoint file boundary while RE1 and RE2 review the previous candidate; dependent or overlapping tasks wait.
5. Review-batch item states: `queued | in-review | in-review (N/2) | approved | changes-requested`.
6. Merge only after the server's `[MERGE GATE DUE]` for the exact PR SHA and Head's own live gate. `accepted`/`staged` tasks are local and unmerged until their Delivery Candidate PR is merged.
7. After a merge or cut, move terminal items to `## Done` and assign the next non-conflicting item.
8. Operator interacts via the project chat panel (top-left) — never via terminal.

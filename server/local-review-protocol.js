"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const PROTOCOL_VERSION = 2;
const START_MARKER = "<!-- quadwork-local-first-review:start -->";
const END_MARKER = "<!-- quadwork-local-first-review:end -->";
const ROLE_ALIASES = new Map([
  ["head", "head"], ["t1", "head"],
  ["dev", "dev"], ["developer", "dev"], ["t3", "dev"],
  ["re1", "re1"], ["reviewer1", "re1"], ["t2a", "re1"],
  ["re2", "re2"], ["reviewer2", "re2"], ["t2b", "re2"],
]);

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase().split("-")[0];
  return ROLE_ALIASES.get(role) || null;
}

function commonHeader() {
  return [
    START_MARKER,
    `## Local-first exact-SHA review protocol (managed v${PROTOCOL_VERSION})`,
    "",
    "**This managed block supersedes any conflicting push-first PR/review steps earlier in this file.**",
    "It is the V1 Actions-cost control until the server-owned V2 handoff in QuadWork #1048 replaces it atomically.",
    "The quality gate remains two independent reviewers plus final live GitHub CI/approval verification; only the expensive intermediate publication loop moves local.",
    "",
  ];
}

function protocolLines(role) {
  const header = commonHeader();
  if (role === "dev") {
    return [
      ...header,
      "### Dev publication contract",
      "1. Keep mutation probes, intentionally broken negative controls, exploratory commits, and review revisions local. Never push them to GitHub.",
      "2. After the implementation, PR body, tests, and self-verification are complete, commit a clean candidate and run:",
      "   `npx quadwork review candidate <issue> --base origin/main`",
      "3. Send one chat request to `@re1 @re2` containing the issue number and printed candidate SHA. Do not open the PR yet.",
      "4. Collect both reviewers' findings before revising where practical. Each fix is a new local commit followed by the same `candidate` command; that atomically invalidates both earlier approvals.",
      "5. Ordinary `git push` of a candidate branch is forbidden. After RE1 and RE2 approve the same local SHA, publish exactly once:",
      "   `npx quadwork review publish <issue> --title \"[#<issue>] ...\" --body-file <file>`",
      "6. Send one remote-evidence handoff naming the PR number and exact published SHA to `@re1 @re2`; when the repository uses Head-gated CI admission, include `@head` so the verified candidate can be admitted. Do not assume `opened` or `synchronize` started the repository's expensive jobs.",
      "7. A CI or formal-review code fix starts a new local candidate cycle. It requires two fresh local approvals before one replacement publication, and it invalidates all remote reviews and CI evidence from the previous SHA.",
      "8. Do not claim pushed, PR-created, CI-admitted, or verified unless the corresponding command or live repository evidence names the exact SHA.",
      "",
      "Local approvals authorize one publication only. They do not replace formal GitHub reviews, repository-required CI evidence, or Head's merge gate.",
      END_MARKER,
    ];
  }
  if (role === "re1" || role === "re2") {
    const upper = role.toUpperCase();
    return [
      ...header,
      `### ${upper} review contract`,
      "1. A Dev chat request carrying an issue number and candidate SHA authorizes the local substantive review. A PR is not required yet.",
      "2. From your configured reviewer worktree, run:",
      `   \`npx quadwork review checkout <issue> --role ${role} --in-place\``,
      "3. Confirm the printed/checked-out SHA equals Dev's request, then review `git diff refs/quadwork/reviews/<issue>/base...HEAD` and run the relevant local checks.",
      "4. Send an evidence-bound verdict to `@dev`. On APPROVE, record it only after the review is complete:",
      `   \`npx quadwork review approve <issue> --role ${role} --summary \"<short evidence>\"\``,
      "5. A new candidate SHA makes every earlier local approval stale. Refresh and review the delta; never carry approval across a retip.",
      "6. After Dev publishes the PR, run `npx quadwork review verify <issue> --pr <number>`, then submit the formal GitHub review at that unchanged SHA. The local approval authorized publication only; the formal review is separate remote merge evidence.",
      "7. In a Head-admitted repository, do not add/remove CI-admission labels or dispatch heavy CI yourself. Head owns exact-SHA admission; you read only live checks attached to the verified current SHA.",
      "8. If verify reports draft, base drift, remote mismatch, or PR-head mismatch, do not approve; route the exact error to Dev.",
      "",
      "Ticket-review and merged-PR review batches keep their separate existing routing. This block governs implementation PRs only.",
      END_MARKER,
    ];
  }
  return [
    ...header,
    "### Head remote-evidence and merge contract",
    "1. Dev and both reviewers complete the local candidate cycle before the branch is published. Their local approvals authorize publication only, not merge.",
    "2. On every newly published or retipped PR, run `npx quadwork review verify <issue> --pr <number>` before any repository-defined remote CI admission.",
    "3. If the repository runs automatic PR CI, observe that current-SHA run. If it uses Head-gated admission, apply only the repository-defined candidate trigger after verify succeeds; QuadWork does not invent or hardcode repository labels.",
    "4. Persistent label membership is not current-SHA CI evidence. When a repository uses label events, a retip requires removing and reapplying the trigger after verify so the event is attached to the new HEAD.",
    "5. Local approvals never satisfy a final/full-CI policy that requires formal current-tip GitHub reviews. Start that final admission only after both formal reviews name the same verified SHA.",
    "6. Do not start a final/full admission while an earlier candidate run would be cancelled by the repository's concurrency group. Let the required candidate evidence finish, then request final evidence once.",
    "7. Any new SHA, moved base, or code fix invalidates local approvals, formal reviews, candidate CI, and final/full CI from the previous tip. Return to a new local candidate cycle.",
    "8. Immediately before merge, run `npx quadwork review verify <issue> --pr <number>` again, then perform the existing live required-check, current GitHub review, PR-body, mergeability, and exact-head checks.",
    "9. A non-zero verify or stale/missing current-SHA evidence is a hard merge stop. Head remains the only merger; nothing here auto-merges, mutates repository policy, or advances the queue.",
    END_MARKER,
  ];
}

function protocolBlock(roleInput) {
  const role = normalizeRole(roleInput);
  if (!role) throw new Error(`Unknown QuadWork role: ${roleInput}`);
  return `${protocolLines(role).join("\n")}\n`;
}

function upsertManagedBlock(source, role) {
  const current = String(source || "");
  const pattern = new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}\\n?`, "g");
  const without = current.replace(pattern, "").replace(/\s+$/, "");
  return `${without}${without ? "\n\n" : ""}${protocolBlock(role)}`;
}

function atomicWriteText(file, content, mode) {
  const temp = `${file}.quadwork-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { mode: mode & 0o777 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, mode & 0o777); } catch {}
}

function installProtocolFile(file, roleInput) {
  const role = normalizeRole(roleInput);
  if (!role) return { file, role: roleInput, status: "skipped", reason: "unknown role" };
  if (!fs.existsSync(file)) return { file, role, status: "skipped", reason: "file missing" };
  const before = fs.readFileSync(file, "utf8");
  const after = upsertManagedBlock(before, role);
  if (after === before) return { file, role, status: "unchanged" };
  const stat = fs.statSync(file);
  atomicWriteText(file, after, stat.mode);
  return { file, role, status: "updated" };
}

function readConfig(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function worktreeTargets(config) {
  const targets = [];
  for (const project of Array.isArray(config.projects) ? config.projects : []) {
    for (const [agentName, agent] of Object.entries(project.agents || {})) {
      const role = normalizeRole(agentName);
      if (!role || !agent || typeof agent.cwd !== "string" || !agent.cwd) continue;
      targets.push({ file: path.join(agent.cwd, "AGENTS.md"), role, project: project.id || null });
    }
  }
  return targets;
}

function seedTargets(templatesDir) {
  return ["head", "dev", "re1", "re2"].map((role) => ({
    role,
    file: path.join(templatesDir, "seeds", `${role}.AGENTS.md`),
    seed: true,
  }));
}

function installLocalReviewProtocol(options = {}) {
  if (process.env.QUADWORK_DISABLE_LOCAL_FIRST_REVIEW === "1") {
    return { disabled: true, results: [], errors: [] };
  }
  const configPath = options.configPath || path.join(os.homedir(), ".quadwork", "config.json");
  const targets = worktreeTargets(readConfig(configPath));
  if (options.patchTemplates !== false && options.templatesDir) {
    targets.push(...seedTargets(options.templatesDir));
  }

  const results = [];
  const errors = [];
  const seen = new Set();
  for (const target of targets) {
    const key = path.resolve(target.file);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      results.push({ ...target, ...installProtocolFile(key, target.role) });
    } catch (error) {
      const entry = { ...target, file: key, error: error.message };
      errors.push(entry);
      if (typeof options.onError === "function") options.onError(entry);
    }
  }
  return { disabled: false, results, errors };
}

module.exports = {
  END_MARKER,
  PROTOCOL_VERSION,
  START_MARKER,
  installLocalReviewProtocol,
  installProtocolFile,
  normalizeRole,
  protocolBlock,
  seedTargets,
  upsertManagedBlock,
  worktreeTargets,
};

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const PROTOCOL_VERSION = 1;
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
      "1. Keep mutation probes, intentionally broken negative controls, and review revisions local. Never push them to GitHub.",
      "2. After the implementation, PR body, tests, and self-verification are complete, commit a clean candidate and run:",
      "   `npx quadwork review candidate <issue> --base origin/main`",
      "3. Send one chat request to `@re1 @re2` containing the issue number and printed candidate SHA. Do not open the PR yet.",
      "4. Collect both reviewers' findings before revising where practical. Each fix is a new local commit followed by the same `candidate` command; that atomically invalidates both earlier approvals.",
      "5. Ordinary `git push` of a candidate branch is forbidden. After RE1 and RE2 approve the same local SHA, publish exactly once:",
      "   `npx quadwork review publish <issue> --title \"[#<issue>] ...\" --body-file <file>`",
      "6. Send the resulting PR number to both reviewers. A CI-driven code fix starts a new local candidate and requires two fresh local approvals before another publication.",
      "7. Do not claim pushed/PR-created/verified unless the command returned the corresponding SHA or PR URL.",
      "",
      "The final remote PR is still required. This protocol removes repeated full Actions runs during implementation/review; it does not bypass CI, formal GitHub reviews, or Head's merge gate.",
      END_MARKER,
    ];
  }
  if (role === "re1" || role === "re2") {
    const upper = role.toUpperCase();
    return [
      ...header,
      `### ${upper} review contract`,
      `1. A Dev chat request carrying an issue number and candidate SHA authorizes the local substantive review. A PR is not required yet.`,
      `2. From your configured reviewer worktree, run:`,
      `   \`npx quadwork review checkout <issue> --role ${role} --in-place\``,
      "3. Confirm the printed/checked-out SHA equals Dev's request, then review `git diff refs/quadwork/reviews/<issue>/base...HEAD` and run the relevant local checks.",
      "4. Send an evidence-bound verdict to `@dev`. On APPROVE, record it only after the review is complete:",
      `   \`npx quadwork review approve <issue> --role ${role} --summary \"<short evidence>\"\``,
      "5. A new candidate SHA makes every earlier approval stale. Refresh and review the delta; never carry approval across a retip.",
      "6. After Dev publishes the PR, run `npx quadwork review verify <issue> --pr <number>`, then read live GitHub CI and submit the formal GitHub review at that unchanged SHA.",
      "7. If verify reports draft, base drift, remote mismatch, or PR-head mismatch, do not approve; route the exact error to Dev.",
      "",
      "Ticket-review and merged-PR review batches keep their separate existing routing. This block governs implementation PRs only.",
      END_MARKER,
    ];
  }
  return [
    ...header,
    "### Head merge contract",
    "1. Dev and both reviewers complete the local candidate cycle before the branch is published.",
    "2. Immediately before merge, run `npx quadwork review verify <issue> --pr <number>` from any worktree sharing the project's Git repository.",
    "3. A non-zero result is a hard merge stop: candidate, both local approvals, published ref, remote branch, open non-draft PR head/base, and pinned base must all agree.",
    "4. Only after that succeeds, perform the existing live required-check, current GitHub review, PR-body, mergeability, and exact-head checks. Head remains the only merger; nothing here auto-merges or advances the queue.",
    "5. Any new SHA, changed base, or code fix requires a new candidate and two new local approvals.",
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

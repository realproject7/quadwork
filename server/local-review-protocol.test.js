// Managed local-first protocol migration tests.
// Plain node:assert script — run with `node server/local-review-protocol.test.js`.

"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  END_MARKER,
  PROTOCOL_VERSION,
  START_MARKER,
  installLocalReviewProtocol,
  protocolBlock,
  upsertManagedBlock,
  worktreeTargets,
} = require("./local-review-protocol");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `quadwork-review-protocol-${process.pid}-`));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  PASS: ${message}`);
}

ok(PROTOCOL_VERSION === 3, "managed protocol version advances for the minimum-remote-evidence decision contract");

for (const role of ["dev", "re1", "re2", "head"]) {
  const block = protocolBlock(role);
  ok(block.includes(START_MARKER) && block.includes(END_MARKER), `${role} block has a replaceable managed boundary`);
  ok(block.includes("exact-SHA"), `${role} block names the exact-SHA invariant`);
  ok(!block.includes("PB_CI_ADMISSION_MODE"), `${role} block does not hardcode a PokerBurn repository variable`);
  ok(!block.includes("ci:ready") && !block.includes("ci:full"), `${role} block leaves repository trigger names configurable`);
}

const dev = protocolBlock("dev");
ok(dev.includes("review candidate") && dev.includes("review publish"), "Dev block moves candidate review before the only publication");
ok(dev.includes("Never push") || dev.includes("forbidden"), "Dev block explicitly prohibits intermediate push churn");
ok(dev.includes("remote-evidence handoff") && dev.includes("include `@head`"), "Dev wakes Head when a repository needs exact-SHA CI admission");
ok(dev.includes("Do not assume `opened` or `synchronize`"), "Dev does not mistake a PR event for expensive CI evidence");
ok(dev.includes("do not ask Head to run both candidate and final lanes by default"), "Dev does not request duplicate remote evidence lanes");
ok(dev.includes("Local approvals authorize one publication only"), "Dev distinguishes local publication approval from remote merge evidence");

const re1 = protocolBlock("re1");
ok(re1.includes("--role re1 --in-place") && re1.includes("review verify"), "RE1 block covers local checkout and remote verification");
ok(re1.includes("local approval authorized publication only") && re1.includes("formal review is separate"), "RE1 distinguishes local approval from formal GitHub evidence");
ok(re1.includes("may proceed before remote CI"), "RE1 can complete formal review before the one final admitted run");
ok(re1.includes("do not add/remove CI-admission labels"), "RE1 leaves CI admission to Head");

const re2 = protocolBlock("re2");
ok(re2.includes("--role re2 --in-place") && re2.includes("review approve"), "RE2 block records its own role-bound approval");
ok(re2.includes("current SHA") && re2.includes("Head owns exact-SHA admission"), "RE2 reads only the Head-admitted current-SHA evidence");

const head = protocolBlock("head");
ok(head.includes("before any repository-defined remote CI admission"), "Head verifies the published SHA before starting remote CI");
ok(head.includes("do not automatically run both a candidate lane and a final/full lane"), "Head defaults away from duplicate admissions");
ok(head.includes("Single admitted run (preferred)") && head.includes("admit that one run exactly once"), "Head prefers one expensive current-SHA run when it can prove everything");
ok(head.includes("Two-stage admission (exception)") && head.includes("cheap and non-overlapping"), "Head uses two stages only for distinct evidence");
ok(head.includes("Automatic CI") && head.includes("Do not dispatch an additional candidate run"), "Head does not duplicate automatic PR CI");
ok(head.includes("Persistent label membership is not current-SHA CI evidence"), "Head treats admission as an event bound to the current tip");
ok(head.includes("formal current-tip GitHub reviews"), "Head does not substitute local approvals for final remote reviews");
ok(head.includes("would be cancelled") && head.includes("distinct final evidence once"), "Head sequences candidate and final admissions without cancellation churn");
ok(head.includes("hard merge stop") && head.includes("nothing here auto-merges"), "Head block keeps verification fail-closed without taking merge authority");

const original = "# Dev — Full-Stack Builder\n\nOld push-first instructions.\n";
const first = upsertManagedBlock(original, "dev");
const second = upsertManagedBlock(first, "dev");
ok(first === second, "managed protocol insertion is idempotent");
ok((first.match(new RegExp(START_MARKER, "g")) || []).length === 1, "managed protocol never duplicates its start marker");
ok(first.startsWith(original.trimEnd()), "managed protocol preserves the existing role instructions before the override");

const changedVersion = first.replace("managed v3", "managed v2");
const upgraded = upsertManagedBlock(changedVersion, "dev");
ok(upgraded.includes("managed v3") && !upgraded.includes("managed v2"), "the previous managed protocol is replaced in place");

const templates = path.join(TMP, "templates");
const worktrees = path.join(TMP, "worktrees");
for (const role of ["head", "dev", "re1", "re2"]) {
  const seed = path.join(templates, "seeds", `${role}.AGENTS.md`);
  const wt = path.join(worktrees, role);
  fs.mkdirSync(path.dirname(seed), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(seed, `# ${role}\n`);
  fs.writeFileSync(path.join(wt, "AGENTS.md"), `# ${role}\n`);
}
const configPath = path.join(TMP, "config.json");
fs.writeFileSync(configPath, JSON.stringify({
  projects: [{
    id: "sample",
    agents: Object.fromEntries(["head", "dev", "re1", "re2"].map((role) => [role, { cwd: path.join(worktrees, role) }])),
  }],
}));

const targets = worktreeTargets(JSON.parse(fs.readFileSync(configPath, "utf8")));
ok(targets.length === 4, "configuration discovery finds exactly the four role worktrees");
const installed = installLocalReviewProtocol({ configPath, templatesDir: templates });
ok(installed.errors.length === 0, "protocol migration reports no write errors on valid targets");
ok(installed.results.filter((result) => result.status === "updated").length === 8, "protocol migration updates four seeds and four existing worktrees");
for (const role of ["head", "dev", "re1", "re2"]) {
  ok(fs.readFileSync(path.join(templates, "seeds", `${role}.AGENTS.md`), "utf8").includes(START_MARKER), `${role} seed receives the managed protocol`);
  ok(fs.readFileSync(path.join(worktrees, role, "AGENTS.md"), "utf8").includes(START_MARKER), `${role} live worktree receives the managed protocol`);
}
const repeated = installLocalReviewProtocol({ configPath, templatesDir: templates });
ok(repeated.results.every((result) => result.status === "unchanged"), "re-running the migration causes no file churn");

const missingConfig = installLocalReviewProtocol({ configPath: path.join(TMP, "missing.json"), templatesDir: templates, patchTemplates: false });
ok(missingConfig.results.length === 0 && missingConfig.errors.length === 0, "missing configuration is a harmless no-op");

console.log(`\n${passed} passed`);
console.log("server/local-review-protocol.test.js: all assertions passed");

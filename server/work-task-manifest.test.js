"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  WorkTaskManifestError,
  workTaskKey,
  buildBatchManifest,
  freezeBatchManifest,
  assertManifestRegisteredCurrent,
  planManifestTransition,
  applyManifestTransition,
  adaptLegacyFlatCodeBatch,
} = require("./work-task-manifest");

const installation_id = "installation_alpha_0001";
const project_id = "quadwork";
const web42 = { repoKey: "web", repo: "Owner/Product-Web", number: 42, kind: "issue" };
const api42 = { repoKey: "api", repo: "Owner/Product-Api", number: 42, kind: "issue" };
const web43 = { repoKey: "web", repo: "Owner/Product-Web", number: 43, kind: "issue" };

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function revisionFor(work_item) {
  if (work_item.repoKey === "web" && work_item.number === 42) return "a".repeat(64);
  if (work_item.repoKey === "api") return "b".repeat(64);
  return "c".repeat(64);
}
function resolveRegisteredIdentity(input) {
  return {
    installation_id: input.installation_id,
    project_id: input.project_id,
    repository_key: input.repository_key,
    work_item: copy(input.work_item),
    issue_body_revision: revisionFor(input.work_item),
  };
}
function task({ task_key = "build", work_item = web42, goal = "implement isolated work", dependencies = [] } = {}) {
  return {
    task_key,
    repository_key: work_item.repoKey,
    work_item: copy(work_item),
    goal,
    file_boundary: ["server/work.js"],
    validation: ["node:test"],
    dependencies: copy(dependencies),
  };
}
function dependency(work_item, task_key) {
  return { repository_key: work_item.repoKey, work_item: copy(work_item), task_key };
}
function input(tasks, delivery_mode = "integrated") {
  return { version: 1, installation_id, project_id, delivery_mode, tasks };
}
function throwsCode(fn, expected) {
  assert.throws(fn, (error) => error instanceof WorkTaskManifestError && error.code === expected);
}

// Same issue numbers in different registered repositories produce distinct,
// repository-qualified WorkTaskRefs. The result retains Head's task order.
{
  const source = input([task({ work_item: web42 }), task({ work_item: api42 })]);
  const original = copy(source);
  const manifest = buildBatchManifest(source, { resolveRegisteredIdentity });
  assert.deepEqual(source, original);
  assert.deepEqual(manifest.tasks.map((entry) => entry.ref.repository_key), ["web", "api"]);
  assert.notEqual(workTaskKey(manifest.tasks[0].ref), workTaskKey(manifest.tasks[1].ref));
  assert.equal(manifest.tasks[0].contract.dependencies.length, 0);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(assertManifestRegisteredCurrent(manifest, { resolveRegisteredIdentity }), true);
  const reversed = buildBatchManifest(input([task({ work_item: api42 }), task({ work_item: web42 })]), { resolveRegisteredIdentity });
  assert.deepEqual(reversed.tasks.map((entry) => entry.ref.repository_key), ["api", "web"]);
  assert.equal(
    reversed.tasks.find((entry) => entry.ref.repository_key === "web").ref.task_revision,
    manifest.tasks.find((entry) => entry.ref.repository_key === "web").ref.task_revision,
  );
}

// Task revisions are lowercase SHA-256 over the canonical structured contract:
// identical input is stable, while a structured goal or issue-contract change is
// visible. Display/chat fields are rejected rather than becoming authority.
{
  const source = input([task()]);
  const first = buildBatchManifest(source, { resolveRegisteredIdentity });
  const second = buildBatchManifest(copy(source), { resolveRegisteredIdentity });
  assert.equal(first.tasks[0].ref.task_revision, second.tasks[0].ref.task_revision);
  assert.match(first.tasks[0].ref.task_revision, /^[a-f0-9]{64}$/);
  const changed = input([task({ goal: "implement changed structured work" })]);
  assert.notEqual(first.tasks[0].ref.task_revision, buildBatchManifest(changed, { resolveRegisteredIdentity }).tasks[0].ref.task_revision);
  const changedContract = buildBatchManifest(source, {
    resolveRegisteredIdentity(identity) { return { ...resolveRegisteredIdentity(identity), issue_body_revision: "d".repeat(64) }; },
  });
  assert.notEqual(first.tasks[0].ref.task_revision, changedContract.tasks[0].ref.task_revision);
  throwsCode(() => assertManifestRegisteredCurrent(first, {
    resolveRegisteredIdentity(identity) { return { ...resolveRegisteredIdentity(identity), issue_body_revision: "d".repeat(64) }; },
  }), "stale_work_task_contract");
  throwsCode(() => buildBatchManifest({ ...source, chat_title: "@head please run this" }, { resolveRegisteredIdentity }), "invalid_batch_manifest");
  throwsCode(() => buildBatchManifest(input([{ ...task(), branch: "untrusted-branch" }]), { resolveRegisteredIdentity }), "invalid_work_task_contract");
  throwsCode(() => buildBatchManifest(source, {
    resolveRegisteredIdentity(identity) { return { ...resolveRegisteredIdentity(identity), repository_key: "other" }; },
  }), "registered_identity_mismatch");
}

// Dependencies are exact resolved WorkTaskRefs. They reject duplicate source
// tasks, absent task locators, and dependency cycles before a manifest exists.
{
  throwsCode(() => buildBatchManifest(input([task(), task()]), { resolveRegisteredIdentity }), "duplicate_work_task_key");
  throwsCode(() => buildBatchManifest(input([
    task({ dependencies: [dependency(web43, "missing")] }),
  ]), { resolveRegisteredIdentity }), "unknown_work_task_dependency");
  throwsCode(() => buildBatchManifest(input([
    task({ task_key: "a", dependencies: [dependency(web42, "b")] }),
    task({ task_key: "b", dependencies: [dependency(web42, "a")] }),
  ]), { resolveRegisteredIdentity }), "cyclic_work_task_dependency");
  const manifest = buildBatchManifest(input([
    task({ task_key: "base" }),
    task({ task_key: "dependent", dependencies: [dependency(web42, "base")] }),
  ]), { resolveRegisteredIdentity });
  assert.deepEqual(manifest.tasks[1].contract.dependencies, [manifest.tasks[0].ref]);
  assert.notEqual(manifest.tasks[0].ref.task_revision, manifest.tasks[1].ref.task_revision);
}

// Freeze is explicit, persistent, and deeply immutable. Subsequent lifecycle
// changes are typed plans and append history; no task mutation API exists.
{
  const manifest = buildBatchManifest(input([task(), task({ task_key: "verify", dependencies: [dependency(web42, "build")] })]), { resolveRegisteredIdentity });
  const frozen = freezeBatchManifest(manifest, "2026-09-01T00:00:00Z");
  assert.equal(manifest.frozen, null);
  assert.deepEqual(frozen.history, [{ type: "freeze", at: "2026-09-01T00:00:00.000Z" }]);
  assert.equal(Object.isFrozen(frozen.tasks[0].contract), true);
  assert.throws(() => { frozen.tasks[0].contract.goal = "mutate after freeze"; }, TypeError);
  assert.notEqual(frozen.tasks[0].contract.goal, "mutate after freeze");

  for (const type of ["cut", "defer", "contract_change"]) {
    const plan = planManifestTransition(frozen, {
      type,
      tasks: [frozen.tasks[0].ref],
      reason: "server-authored scope transition",
      archived: false,
    });
    assert.equal(plan.type, type);
    assert.deepEqual(plan.tasks, [frozen.tasks[0].ref]);
  }
  const plan = planManifestTransition(frozen, {
    type: "cut", tasks: [frozen.tasks[0].ref], reason: "server-authored scope transition", archived: false,
  });
  const transitioned = applyManifestTransition(frozen, plan, "2026-09-01T00:01:00Z");
  assert.equal(transitioned.history.length, 2);
  assert.equal(transitioned.history[1].type, "cut");
  assert.equal(transitioned.history[1].tasks[0].task_revision, frozen.tasks[0].ref.task_revision);
  throwsCode(() => planManifestTransition(frozen, {
    type: "defer", tasks: [frozen.tasks[0].ref], reason: "archived", archived: true,
  }), "work_task_archive_blocked");
  throwsCode(() => planManifestTransition(manifest, {
    type: "defer", tasks: [manifest.tasks[0].ref], reason: "not frozen", archived: false,
  }), "work_task_manifest_not_frozen");
  const spoofed = { ...frozen.tasks[0].ref, task_revision: "e".repeat(64) };
  throwsCode(() => planManifestTransition(frozen, {
    type: "defer", tasks: [spoofed], reason: "stale ref", archived: false,
  }), "unknown_work_task_ref");
}

// V1 flat code batches migrate as one immutable `legacy` task per qualified
// ticket, preserving source ticket order without using title or array index as
// authority.
{
  const legacy = {
    version: 1,
    installation_id,
    project_id,
    delivery_mode: "isolated",
    work_items: [copy(api42), copy(web42)],
  };
  const manifest = adaptLegacyFlatCodeBatch(legacy, { resolveRegisteredIdentity });
  assert.equal(manifest.delivery_mode, "isolated");
  assert.deepEqual(manifest.tasks.map((entry) => [entry.ref.repository_key, entry.ref.task_key]), [["api", "legacy"], ["web", "legacy"]]);
  assert.equal(manifest.tasks[0].contract.goal, "legacy_flat_code_batch");
  throwsCode(() => adaptLegacyFlatCodeBatch({ ...legacy, work_items: [copy(web42), copy(web42)] }, { resolveRegisteredIdentity }), "invalid_legacy_code_batch");
}

// Purity guard: M1 has no route, queue, transport, GitHub, filesystem, or
// candidate integration dependency.
{
  const source = fs.readFileSync(path.join(__dirname, "work-task-manifest.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["'](?:node:)?(?:fs|path|child_process)["']\s*\)/);
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:routes|index|review-cycle|task-candidate)["']\s*\)/);
}

console.log("work-task-manifest.test.js: all assertions passed");

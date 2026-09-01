"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { canonicalizeBatchRequestAuthority } = require("./batch-request-contract");
const { VERSION, REQUEST_LABEL } = require("./batch-request-subscription");
const { createBatchRequestRuntimeOwner } = require("./batch-request-runtime-owner");

const installation_id = "installation_target_0001";
const project_id = "target-project";
const repository = "acme/coordination";
const request_id = "123e4567-e89b-42d3-a456-426614174000";
const authority = {
  schema: "quadwork-batch-request/v1",
  request_id,
  source_installation_id: "installation_source_0001",
  source_project_id: "source-project",
  target_installation_id: installation_id,
  target_project_id: project_id,
  coordination_repo: repository,
  mode: "implementation",
  work_refs: ["acme/web#42"],
  start_policy: "next-available",
};

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function project(overrides = {}) {
  return {
    id: project_id,
    archived: false,
    repositories: [
      { key: "coord", repo: "Acme/Coordination", working_dir: "/safe/coord", primary: true },
      { key: "web", repo: "Acme/Web", working_dir: "/safe/web", primary: false },
    ],
    coordination_repo_key: "coord",
    watch_batch_requests: true,
    environment_bindings: [{
      installation_id: "installation_source_0001",
      project_id: "source-project",
      label: "Source VPS",
      environment_class: "vps",
    }],
    ...overrides,
  };
}
function issue(request, overrides = {}) {
  return {
    repository,
    issue_number: 42,
    issue_url: `https://api.github.com/repos/${repository}/issues/42`,
    pull_request: null,
    labels: [REQUEST_LABEL],
    body: `\`\`\`quadwork-batch-request\n${JSON.stringify(authority)}\n\`\`\``,
    etag: 'W/"batch-request-42"',
    cursor: "issues:42",
    ...overrides,
  };
}

async function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-batch-owner-"));
  try { await run(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

async function main() {
await withDirectory(async (directory) => {
  let config = { installation_id, projects: [project()] };
  const calls = { read: 0, append: [], wake: 0 };
  const owner = createBatchRequestRuntimeOwner({
    config_dir: directory,
    fs,
    read_config: () => copy(config),
    capture_project_admission: (id) => ({ project_id: id, generation: 0 }),
    is_admission_current: (admission) => admission.project_id === project_id && admission.generation === 0,
    is_project_archived: (id, cfg) => cfg.projects.find((entry) => entry.id === id)?.archived === true,
    read_coordination_issues: async (request) => {
      calls.read += 1;
      return { version: VERSION, target: copy(request.target), coordination_repository: request.coordination_repository,
        request_label: request.request_label, cache: copy(request.cache), issues: [issue(request)] };
    },
    append_trusted_batch_request_once: (candidate) => {
      calls.append.push(copy(candidate));
      return { ok: true, id: calls.append.length, duplicate: false };
    },
    wake_trusted_batch_request: async (candidate) => {
      calls.wake += 1;
      assert.equal(candidate.project_id, project_id);
      return { ok: false, code: "head_not_running" };
    },
  });
  const first = await owner.reconcileProject(project_id);
  assert.equal(first.ok, true);
  assert.equal(first.skipped, false);
  assert.equal(first.result.delivery, "delivered");
  assert.equal(calls.read, 1);
  assert.equal(calls.append.length, 1);
  assert.equal(calls.append[0].head_generation, 0);
  assert.equal(calls.append[0].notification.authority.request_id, request_id);
  assert.equal(calls.wake, 1);
  const second = await owner.reconcileProject(project_id);
  assert.equal(second.result.delivery, "none");
  assert.equal(calls.append.length, 1);
  ok(true, "one admitted issue is persisted and posted once even when the immediate Head wake is unavailable");

  config = { installation_id, projects: [project({ watch_batch_requests: false })] };
  const disabled = await owner.reconcileProject(project_id);
  assert.deepEqual(disabled, { ok: true, skipped: true, code: "batch_request_subscription_unavailable" });
  assert.equal(calls.read, 2);
  assert.equal(calls.append.length, 1);
  ok(true, "a disabled live subscription is skipped before another GitHub read or Head notice");
  assert.equal(owner.revokeProject(project_id).ok, true);
});

{
  assert.throws(() => createBatchRequestRuntimeOwner({
    config_dir: "/tmp", fs, read_config() {}, capture_project_admission() {}, is_admission_current() {}, is_project_archived() {},
    read_coordination_issues() {}, append_trusted_batch_request_once() {}, wake_trusted_batch_request() {}, extra() {},
  }));
  const source = fs.readFileSync(path.join(__dirname, "batch-request-runtime-owner.js"), "utf8");
  assert.doesNotMatch(source, /(?:setTimeout\s*\(|setInterval\s*\(|fetch\s*\(|require\s*\(\s*["'](?:node:)?(?:http|https|net|child_process)["'])/);
  ok(true, "owner accepts only fixed dependencies and adds no scheduler or transport capability");
}

console.log(`\n${passed} batch request runtime owner checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

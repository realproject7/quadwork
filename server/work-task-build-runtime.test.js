"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWorkTaskBuildRuntime, WorkTaskBuildRuntimeError } = require("./work-task-build-runtime");

const installation_id = "installation_build_runtime_0001";
const project_id = "quadwork";
const ref = {
  version: 1, installation_id, project_id, repository_key: "web",
  work_item: { repoKey: "web", repo: "Owner/Web", number: 42, kind: "issue" },
  issue_body_revision: "c".repeat(64), task_key: "runtime", task_revision: "d".repeat(64),
};

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function throwsCode(run, code) {
  assert.throws(run, (error) => error instanceof WorkTaskBuildRuntimeError && error.code === code);
}
function session(role, verified = true) {
  return { projectId: project_id, agentId: role, state: "running", term: { pid: 123 }, lifecycleState: verified ? "verified" : "spawned" };
}
function fixture(options = {}) {
  const calls = [];
  const sessions = new Map([[`${project_id}/head`, session("head")], [`${project_id}/dev`, session("dev")]]);
  const runtime = createWorkTaskBuildRuntime({
    config_dir: "/tmp/quadwork-build-runtime", fs,
    capture_project_admission: () => ({ project_id, generation: 0 }), is_admission_current: () => options.current !== false,
    resolve_shim_principal: (token) => token === "head-token" ? { projectId: project_id, agentId: "head" } : null,
    agent_sessions: sessions,
    read_live_batch_context: () => ({}), read_repository_state: () => ({}), read_cached_repository_snapshot: () => ({}),
    create_live_identity_resolver: () => (input) => options.identity || {
      installation_id: input.installation_id, project_id: input.project_id, repository_key: input.repository_key,
      work_item: copy(input.work_item), issue_body_revision: ref.issue_body_revision,
    },
    create_assignment_service: (serviceOptions) => ({
      assignBuild: (input) => {
        calls.push({ kind: "assign", input: copy(input), base: serviceOptions.read_registered_base({ version: 1, work_task_ref: copy(input.work_task_ref) }) });
        return { outcome: "assigned", assignment_id: "build_" + "a".repeat(64), base_sha: "b".repeat(64) };
      },
    }),
    read_registered_base: (project, request) => {
      calls.push({ kind: "base", project, request: copy(request) });
      return { version: 1, repository_key: "web", base_sha: "b".repeat(64) };
    },
  });
  return { runtime, calls, sessions };
}

{
  const current = fixture();
  const result = current.runtime.assign({ token: "head-token", body: {
    event_id: "assign_runtime_001", work_task_ref: copy(ref), project_id: "caller-cannot-select-this",
  } });
  assert.equal(result.outcome, "assigned");
  assert.deepEqual(current.calls[0], { kind: "base", project: project_id, request: { version: 1, work_task_ref: copy(ref) } });
  assert.deepEqual(current.calls[1].input, { version: 1, event_id: "assign_runtime_001", work_task_ref: copy(ref) });
  console.log("  PASS: authenticated Head receives a server-bound base reader and exact task only");
}

{
  const missingDev = fixture();
  missingDev.sessions.set(`${project_id}/dev`, session("dev", false));
  throwsCode(() => missingDev.runtime.assign({ token: "head-token", body: { event_id: "assign_runtime_002", work_task_ref: copy(ref) } }), "work_task_build_principal_unavailable");
  assert.equal(missingDev.calls.length, 0);
  console.log("  PASS: build assignment fails closed until the assigned Dev is verified");
}

{
  const stale = fixture({ identity: { installation_id, project_id, repository_key: "web", work_item: copy(ref.work_item), issue_body_revision: "e".repeat(64) } });
  throwsCode(() => stale.runtime.assign({ token: "head-token", body: { event_id: "assign_runtime_003", work_task_ref: copy(ref) } }), "stale_work_task_build_authority");
  assert.equal(stale.calls.length, 0);
  console.log("  PASS: stale WorkTask contracts never reach assignment persistence");
}

{
  const source = fs.readFileSync(path.join(__dirname, "work-task-build-runtime.js"), "utf8");
  assert.doesNotMatch(source, /require\s*\(\s*["']\.\/(?:index|routes|file-chat|mcp|pty-dispatcher)["']\s*\)/);
  assert.doesNotMatch(source, /(?:execFile|spawn\s*\(|planWorkTaskPipelineEvent|delivery-candidate)/);
  console.log("  PASS: fixed build transport has no publication, process, or direct pipeline authority");
}

console.log("work-task-build-runtime.test.js: all assertions passed");

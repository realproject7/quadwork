"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  CiEvidenceStore,
  createCiLessEvidenceSubmitHandler,
  createCiLessEvidenceReadHandler,
} = require("./ci-less-evidence");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-ci-less-"));
const SHA = "b".repeat(40);
const REVISION = "c".repeat(64);
const POLICY = { version: 1, mode: "ci-less", evidence_keys: ["unit", "typecheck"] };
const principalByToken = new Map([
  ["dev-token", { projectId: "p1", agentId: "dev" }],
  ["head-token", { projectId: "p1", agentId: "head" }],
  ["other-token", { projectId: "p2", agentId: "dev" }],
  ["observer-token", { projectId: "p1", agentId: "observer" }],
]);
let generation = 4;
let targetMode = "current";
const store = new CiEvidenceStore({ rootDir: ROOT, now: () => new Date("2026-08-31T01:02:03.000Z") });

function responseCapture() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function request(results, overrides = {}) {
  return {
    headers: { "x-chat-token": "dev-token" },
    query: {},
    body: {
      assignment_attempt: "attempt-a",
      contract_revision: REVISION,
      repo_key: "web",
      item: { repo_key: "web", repo: "Acme/Web", number: 42, kind: "issue" },
      pr_number: 99,
      exact_sha: SHA,
      policy_version: 1,
      results: results || [
        { key: "unit", outcome: "pass", exit_code: 0, evidence_ref: "unit:sha256:abc" },
        { key: "typecheck", outcome: "pass", exit_code: 0, evidence_ref: "typecheck:sha256:def" },
      ],
      ...overrides,
    },
  };
}

function targetFor(projectId, submitted) {
  const target = {
    project_id: projectId,
    installation_id: "installation_1234567890abcdef",
    repo_key: "web",
    repo: "Acme/Web",
    item: submitted.item,
    assignment_attempt: submitted.assignment_attempt,
    contract_revision: submitted.contract_revision,
    pr_number: submitted.pr_number,
    exact_sha: submitted.exact_sha,
    policy_version: submitted.policy_version,
    policy: POLICY,
  };
  if (targetMode === "stale") return { ...target, assignment_attempt: "attempt-b" };
  if (targetMode === "sha") return { ...target, exact_sha: "d".repeat(40) };
  return target;
}

const submit = createCiLessEvidenceSubmitHandler({
  resolveShimPrincipal: (token) => principalByToken.get(token) || null,
  captureProjectAdmission: (projectId) => ({ project_id: projectId, generation }),
  isAdmissionCurrent: (admission) => admission?.generation === generation,
  resolveCurrentTarget: async (projectId, submitted) => targetFor(projectId, submitted),
  store,
});
const read = createCiLessEvidenceReadHandler({
  resolveShimPrincipal: (token) => principalByToken.get(token) || null,
  store,
});

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

(async () => {
  const first = responseCapture();
  await submit(request(), first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.payload.ok, true);
  const recordId = first.payload.record.record_id;
  ok(/^ce_[a-f0-9]{32}$/.test(recordId), "authenticated Dev submission returns a server-generated record ID");
  assert.equal(first.payload.record.identity.project_id, "p1");
  assert.equal(first.payload.record.results[0].evidence_ref, undefined);
  assert.match(first.payload.record.results[0].evidence_ref_digest, /^[a-f0-9]{64}$/);
  ok(true, "submit response is redacted and binds project/assignment/contract/PR/SHA/policy identity");

  const restartedStore = new CiEvidenceStore({ rootDir: ROOT, now: () => new Date("2026-08-31T01:02:04.000Z") });
  assert.equal(restartedStore.readByRecordId("p1", recordId)?.record_id, recordId);
  ok(true, "a fresh store instance reads the persisted receipt after restart");

  const file = path.join(ROOT, "p1", "ci-evidence.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  ok(true, "evidence receipt is persisted atomically in owner-only storage");

  const duplicate = responseCapture();
  await submit(request(), duplicate);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.payload.record.record_id, recordId);
  ok(true, "same full identity and digest retry is idempotent after an ambiguous response");

  const readAsHead = responseCapture();
  read({ headers: { "x-chat-token": "head-token" }, query: {}, body: { record_id: recordId } }, readAsHead);
  assert.equal(readAsHead.statusCode, 200);
  assert.equal(readAsHead.payload.record.record_id, recordId);
  assert.equal(JSON.stringify(readAsHead.payload).includes("unit:sha256:abc"), false);
  ok(true, "Head can read the receipt while raw evidence references remain hidden");

  const failed = responseCapture();
  await submit(request([
    { key: "unit", outcome: "fail", exit_code: 1, evidence_ref: "unit:sha256:failed" },
    { key: "typecheck", outcome: "pass", exit_code: 0, evidence_ref: "typecheck:sha256:def" },
  ]), failed);
  assert.equal(failed.statusCode, 200);
  assert.notEqual(failed.payload.record.record_id, recordId);
  assert.equal(failed.payload.record.results.find((result) => result.key === "unit").outcome, "fail");
  ok(true, "an explicit authenticated failure replaces the current same-identity receipt rather than being hidden");

  const foreignRead = responseCapture();
  read({ headers: { "x-chat-token": "other-token" }, query: {}, body: { record_id: recordId } }, foreignRead);
  assert.equal(foreignRead.statusCode, 404);
  ok(true, "cross-project redacted receipt reads fail closed");

  const headSubmit = responseCapture();
  await submit({ ...request(), headers: { "x-chat-token": "head-token" } }, headSubmit);
  assert.equal(headSubmit.statusCode, 403);
  ok(true, "server rejects non-Dev forged submit even when the shim tool is hidden");

  const observerRead = responseCapture();
  read({ headers: { "x-chat-token": "observer-token" }, query: {}, body: { record_id: recordId } }, observerRead);
  assert.equal(observerRead.statusCode, 403);
  ok(true, "server rejects non-project-role forged read calls");

  const unknownKey = responseCapture();
  await submit(request([
    { key: "unit", outcome: "pass", exit_code: 0, evidence_ref: "unit" },
    { key: "shell", outcome: "pass", exit_code: 0, evidence_ref: "shell" },
  ]), unknownKey);
  assert.equal(unknownKey.statusCode, 400);
  assert.equal(unknownKey.payload.code, "invalid_ci_evidence_result");
  ok(true, "unknown evidence keys cannot be smuggled through the Dev boundary");

  const missingKey = responseCapture();
  await submit(request([{ key: "unit", outcome: "pass", exit_code: 0, evidence_ref: "unit" }]), missingKey);
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.payload.code, "incomplete_ci_evidence");
  ok(true, "missing configured evidence keys fail closed");

  targetMode = "stale";
  const stale = responseCapture();
  await submit(request(), stale);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.payload.code, "ci_evidence_target_changed");
  targetMode = "current";
  ok(true, "stale assignment/contract/PR target cannot create an authoritative receipt");

  targetMode = "sha";
  const staleSha = responseCapture();
  await submit(request(), staleSha);
  assert.equal(staleSha.statusCode, 409);
  assert.equal(staleSha.payload.code, "ci_evidence_target_changed");
  targetMode = "current";
  ok(true, "a stale exact SHA cannot create an authoritative receipt");

  const changedSha = "e".repeat(40);
  const changedCandidate = responseCapture();
  await submit(request(undefined, { exact_sha: changedSha }), changedCandidate);
  assert.equal(changedCandidate.statusCode, 200);
  assert.equal(changedCandidate.payload.record.identity.exact_sha, changedSha);
  assert.equal(Object.keys(store.readDocument("p1").records).length, 2);
  ok(true, "a changed SHA creates a distinct historical identity instead of reusing prior evidence");

  // Two different submissions start together. The first holds the live-target
  // read open; the second must not even begin its target read until the first
  // receipt commits, otherwise two read-modify-write snapshots could lose one
  // record despite each replacement being individually atomic.
  const concurrencyStore = new CiEvidenceStore({ rootDir: path.join(ROOT, "concurrency") });
  let targetReads = 0;
  let markFirstTargetRead;
  let releaseFirstTargetRead;
  const firstTargetRead = new Promise((resolve) => { markFirstTargetRead = resolve; });
  const firstTargetGate = new Promise((resolve) => { releaseFirstTargetRead = resolve; });
  const concurrentSubmit = createCiLessEvidenceSubmitHandler({
    resolveShimPrincipal: (token) => principalByToken.get(token) || null,
    captureProjectAdmission: (projectId) => ({ project_id: projectId, generation: 1 }),
    isAdmissionCurrent: (admission) => admission?.generation === 1,
    resolveCurrentTarget: async (projectId, submitted) => {
      targetReads += 1;
      if (targetReads === 1) {
        markFirstTargetRead();
        await firstTargetGate;
      }
      return {
        project_id: projectId,
        installation_id: "installation_1234567890abcdef",
        repo_key: "web",
        repo: "Acme/Web",
        item: submitted.item,
        assignment_attempt: submitted.assignment_attempt,
        contract_revision: submitted.contract_revision,
        pr_number: submitted.pr_number,
        exact_sha: submitted.exact_sha,
        policy_version: submitted.policy_version,
        policy: POLICY,
      };
    },
    store: concurrencyStore,
  });
  const parallelOne = responseCapture();
  const firstWrite = concurrentSubmit(request(undefined, { exact_sha: "1".repeat(40) }), parallelOne);
  await firstTargetRead;
  const parallelTwo = responseCapture();
  const secondWrite = concurrentSubmit(request(undefined, { exact_sha: "2".repeat(40) }), parallelTwo);
  await Promise.resolve();
  assert.equal(targetReads, 1, "second target read waits behind the first project receipt transaction");
  releaseFirstTargetRead();
  await Promise.all([firstWrite, secondWrite]);
  assert.equal(parallelOne.statusCode, 200);
  assert.equal(parallelTwo.statusCode, 200);
  assert.equal(Object.keys(concurrencyStore.readDocument("p1").records).length, 2);
  assert.equal(concurrencyStore._projectWrites.size, 0);
  ok(true, "concurrent different identities serialize without losing either durable receipt");

  // A final admission change after the initial preflight but before the
  // serialized write must reject without creating any persistent receipt.
  const rejectedStoreRoot = path.join(ROOT, "rejected-admission");
  const rejectedStore = new CiEvidenceStore({ rootDir: rejectedStoreRoot });
  let rejectedGeneration = 1;
  const rejectOnFinalAdmission = createCiLessEvidenceSubmitHandler({
    resolveShimPrincipal: (token) => principalByToken.get(token) || null,
    captureProjectAdmission: (projectId) => ({ project_id: projectId, generation: rejectedGeneration }),
    isAdmissionCurrent: (admission) => admission?.generation === rejectedGeneration,
    resolveCurrentTarget: async (projectId, submitted) => {
      rejectedGeneration = 2;
      return {
        project_id: projectId,
        installation_id: "installation_1234567890abcdef",
        repo_key: "web",
        repo: "Acme/Web",
        item: submitted.item,
        assignment_attempt: submitted.assignment_attempt,
        contract_revision: submitted.contract_revision,
        pr_number: submitted.pr_number,
        exact_sha: submitted.exact_sha,
        policy_version: submitted.policy_version,
        policy: POLICY,
      };
    },
    store: rejectedStore,
  });
  const rejectedAdmission = responseCapture();
  await rejectOnFinalAdmission(request(undefined, { exact_sha: "3".repeat(40) }), rejectedAdmission);
  assert.equal(rejectedAdmission.statusCode, 409);
  assert.equal(rejectedAdmission.payload.code, "ci_evidence_admission_changed");
  assert.equal(fs.existsSync(path.join(rejectedStoreRoot, "p1", "ci-evidence.json")), false);
  assert.deepEqual(rejectedStore.readDocument("p1").records, {});
  ok(true, "a rejected final admission leaves no durable evidence receipt");

  const beforeRecords = Object.keys(store.readDocument("p1").records).length;
  generation += 1;
  const admissionChanged = responseCapture();
  await submit(request(), admissionChanged);
  assert.equal(admissionChanged.statusCode, 200, "new capture observes the current generation");
  assert.equal(Object.keys(store.readDocument("p1").records).length, beforeRecords);
  ok(true, "unchanged retry under a current admission does not duplicate persistent records");

  console.log(`\n${passed} CI-less evidence assertions passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

"use strict";

const assert = require("node:assert/strict");
const {
  WORKER_UNIT_PREFIX,
  CONTROL_UNIT_PREFIX,
  MAX_UNIT_BASE_LENGTH,
  createWorkerUnitBase,
  createControlUnitBase,
  validateGeneratedUnitBase,
  scopeUnitFromBase,
  baseFromScopeUnit,
} = require("./resource-unit");

const workerIdentity = { projectId: "quadwork", generationId: "generation-7" };
const worker = createWorkerUnitBase(workerIdentity);
assert.equal(worker, createWorkerUnitBase({ ...workerIdentity }), "worker identity is deterministic");
assert(worker.startsWith(WORKER_UNIT_PREFIX), "worker prefix is the preflight counting prefix");
assert(worker.length <= MAX_UNIT_BASE_LENGTH);
assert.match(worker, /^quadwork-worker-[a-f0-9]{40}$/);

const control = createControlUnitBase({ ...workerIdentity, operationId: "github-refresh-1" });
assert(control.startsWith(CONTROL_UNIT_PREFIX));
assert(control.length <= MAX_UNIT_BASE_LENGTH);
assert.match(control, /^quadwork-control-[a-f0-9]{40}$/);
assert.notEqual(control, worker, "resource classes occupy separate identity domains");

const identities = new Set();
for (let index = 0; index < 2_000; index += 1) {
  const base = createWorkerUnitBase({ projectId: `project-${index}`, generationId: `generation-${index}` });
  assert.equal(identities.has(base), false, `identity ${index} did not collide`);
  identities.add(base);
}
assert.notEqual(
  createWorkerUnitBase({ projectId: "a", generationId: "b-c" }),
  createWorkerUnitBase({ projectId: "a-b", generationId: "c" }),
  "length-delimited identity hashing avoids delimiter ambiguity",
);
assert.notEqual(
  createControlUnitBase({ projectId: "p", generationId: "g", operationId: "one" }),
  createControlUnitBase({ projectId: "p", generationId: "g", operationId: "two" }),
);

const actualWorker = scopeUnitFromBase(worker);
assert.equal(actualWorker, `${worker}.scope`);
assert.equal(baseFromScopeUnit(actualWorker), worker);
assert.equal(validateGeneratedUnitBase(worker), worker);

for (const invalidIdentity of [
  { projectId: "../escape", generationId: "g" },
  { projectId: "p", generationId: "g/path" },
  { projectId: "P", generationId: "" },
  { projectId: "p", generationId: "x".repeat(129) },
]) {
  assert.throws(() => createWorkerUnitBase(invalidIdentity), { code: "QW_INVALID_RESOURCE_UNIT_IDENTITY" });
}
assert.throws(
  () => createControlUnitBase({ projectId: "p", generationId: "g", operationId: "raw command --" }),
  { code: "QW_INVALID_RESOURCE_UNIT_IDENTITY" },
);

for (const rawUnit of [
  "quadwork-worker-user-supplied",
  "quadwork-worker-" + "a".repeat(39),
  "quadwork-worker-" + "A".repeat(40),
  "../quadwork-worker-" + "a".repeat(40),
  "other-" + "a".repeat(40),
]) {
  assert.throws(() => validateGeneratedUnitBase(rawUnit), { code: "QW_INVALID_RESOURCE_UNIT_IDENTITY" });
}
for (const rawActual of [
  worker,
  `${worker}.service`,
  `${worker}.scope.scope`,
  `../${worker}.scope`,
]) {
  assert.throws(() => baseFromScopeUnit(rawActual), { code: "QW_INVALID_RESOURCE_UNIT_IDENTITY" });
}

console.log("resource-unit.test.js: all assertions passed");

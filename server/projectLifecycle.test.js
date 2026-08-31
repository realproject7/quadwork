const assert = require("assert");
const {
  ProjectLifecycleError,
  isProjectArchived,
  assertProjectAdmitted,
  captureProjectAdmission,
  isAdmissionCurrent,
  revokeProjectAdmission,
  unarchiveCandidate,
  createProjectLifecycleController,
} = require("./project-lifecycle");

function config(...projects) {
  return { installation_id: "installation-test-0001", projects };
}

function project(id, archived = false) {
  return { id, archived, repositories: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function inMemoryCommit(initial, events = []) {
  let stored = clone(initial);
  return {
    read: () => clone(stored),
    commit: (mutator) => {
      const candidate = clone(stored);
      mutator(candidate);
      stored = candidate;
      events.push(`commit:${stored.projects.map((entry) => `${entry.id}:${entry.archived === true}`).join(",")}`);
      return clone(stored);
    },
  };
}

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error instanceof ProjectLifecycleError && error.code === code);
}

(async () => {
  const open = config(project("open"), project("archived", true), project("idle", false));
  open.projects[2].idle = true;
  assert.equal(isProjectArchived("open", open), false);
  assert.equal(isProjectArchived("archived", open), true);
  assert.equal(isProjectArchived("idle", open), false, "idle is not archive authority");
  assert.equal(isProjectArchived("missing", open), true, "unknown project fails closed");
  assert.equal(isProjectArchived("bad-archive", config({ id: "bad-archive", archived: "true" })), true);
  assert.equal(isProjectArchived("open", undefined, { readConfig: () => { throw new Error("boom"); } }), true);
  assert.equal(assertProjectAdmitted("open", open).id, "open");
  assert.throws(() => assertProjectAdmitted("archived", open), (error) => error.code === "project_archived");
  assert.throws(() => assertProjectAdmitted("missing", open), (error) => error.code === "unknown_project");

  const leaseConfig = config(project("lease"));
  const firstLease = captureProjectAdmission("lease", { readConfig: () => leaseConfig });
  assert.equal(isAdmissionCurrent(firstLease, { readConfig: () => leaseConfig }), true);
  revokeProjectAdmission("lease");
  assert.equal(isAdmissionCurrent(firstLease, { readConfig: () => leaseConfig }), false, "revocation invalidates in-flight work");
  const secondLease = captureProjectAdmission("lease", { readConfig: () => leaseConfig });
  assert.equal(isAdmissionCurrent(secondLease, { readConfig: () => leaseConfig }), true);
  assert.equal(isAdmissionCurrent(secondLease, { readConfig: () => config(project("lease", true)) }), false);
  assert.throws(
    () => captureProjectAdmission("lease", { readConfig: () => config(project("lease", true)) }),
    (error) => error.code === "project_archived",
    "a stale active snapshot cannot mint a lease after the live project is archived",
  );

  const ordering = [];
  const durable = inMemoryCommit(config(project("alpha")), ordering);
  const controller = createProjectLifecycleController({
    commitV2Configuration: durable.commit,
    cleanupProject: async (projectId) => {
      assert.equal(durable.read().projects.find((entry) => entry.id === projectId).archived, true);
      ordering.push("cleanup");
      return { ok: true, resources: { sessions: 2, viewers: 1 } };
    },
  });
  const archived = await controller.archiveProject("alpha");
  assert.equal(archived.ok, true);
  assert.equal(archived.archived, true);
  assert.deepEqual(archived.resources, { sessions: 2, viewers: 1 });
  assert.equal(ordering[0].startsWith("commit:"), true, "barrier commits before cleanup");
  assert.equal(ordering[1], "cleanup");

  let cleanupAttempt = 0;
  const retryStore = inMemoryCommit(config(project("retry")));
  const retriedResources = [];
  const retryController = createProjectLifecycleController({
    commitV2Configuration: retryStore.commit,
    cleanupProject: async () => {
      cleanupAttempt += 1;
      if (cleanupAttempt === 1) {
        retriedResources.push("sessions");
        return {
          ok: false,
          resources: { sessions: 2 },
          cleanup_errors: [{ resource: "bridge", code: "bridge_stop_failed", message: "retry bridge" }],
        };
      }
      retriedResources.push("bridge");
      return { ok: true, resources: { bridges: 1 } };
    },
  });
  const partial = await retryController.archiveProject("retry");
  assert.equal(partial.ok, false);
  assert.equal(partial.archived, true);
  assert.deepEqual(partial.cleanup_errors, [{ resource: "bridge", code: "bridge_stop_failed", message: "retry bridge" }]);
  assert.equal(retryStore.read().projects[0].archived, true, "partial failure keeps barrier");
  const retry = await retryController.archiveProject("retry");
  assert.equal(retry.ok, true);
  assert.equal(retry.already_archived, true);
  assert.deepEqual(retriedResources, ["sessions", "bridge"]);

  const noCleanupStore = inMemoryCommit(config(project("unsafe")));
  const noCleanup = createProjectLifecycleController({ commitV2Configuration: noCleanupStore.commit });
  const unsafe = await noCleanup.archiveProject("unsafe");
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.cleanup_errors[0].code, "cleanup_unavailable");
  assert.equal(noCleanupStore.read().projects[0].archived, true);

  for (const [id, cleanupValue] of [
    ["empty", {}],
    ["null", null],
    ["string-ok", { ok: "true" }],
    ["invalid-count", { ok: true, resources: { sessions: -1 } }],
    ["invalid-errors", { ok: true, cleanup_errors: "none" }],
  ]) {
    const failClosedStore = inMemoryCommit(config(project(id)));
    const failClosedController = createProjectLifecycleController({
      commitV2Configuration: failClosedStore.commit,
      cleanupProject: async () => cleanupValue,
    });
    const incomplete = await failClosedController.removeProject(id);
    assert.equal(incomplete.ok, false, `${id} cleanup result fails closed`);
    assert.equal(incomplete.removed, false, `${id} metadata is preserved`);
    assert.equal(failClosedStore.read().projects.length, 1);
  }

  const restoreEvents = [];
  const restoreStore = inMemoryCommit(config(project("restore", true)), restoreEvents);
  let cleanupCalls = 0;
  const restoreController = createProjectLifecycleController({
    commitV2Configuration: restoreStore.commit,
    readConfig: restoreStore.read,
    validateV2Configuration: () => {},
    cleanupProject: async () => { cleanupCalls += 1; return { ok: true, resources: { sessions: 0 } }; },
  });
  const restored = await restoreController.unarchiveProject("restore");
  assert.equal(restored.ok, true);
  assert.equal(restored.archived, false);
  assert.equal(cleanupCalls, 1, "unarchive verifies the archived runtime is fully quiesced");
  assert.deepEqual(restored.resources, { sessions: 0 });
  assert.equal(restoreStore.read().projects[0].archived, false);

  const dirtyRestoreStore = inMemoryCommit(config(project("dirty-restore", true)));
  const dirtyRestore = createProjectLifecycleController({
    commitV2Configuration: dirtyRestoreStore.commit,
    readConfig: dirtyRestoreStore.read,
    validateV2Configuration: () => {},
    cleanupProject: async () => ({
      ok: false,
      resources: { sessions: 1 },
      cleanup_errors: [{ resource: "pty", code: "kill_failed", message: "retry" }],
    }),
  });
  const heldRestore = await dirtyRestore.unarchiveProject("dirty-restore");
  assert.equal(heldRestore.ok, false);
  assert.equal(heldRestore.archived, true, "partial cleanup keeps the admission barrier set");
  assert.equal(dirtyRestoreStore.read().projects[0].archived, true);

  const alreadyOpenStore = inMemoryCommit(config(project("already-open", false)));
  let alreadyOpenCleanupCalls = 0;
  const alreadyOpen = createProjectLifecycleController({
    commitV2Configuration: alreadyOpenStore.commit,
    readConfig: alreadyOpenStore.read,
    validateV2Configuration: () => {},
    cleanupProject: async () => { alreadyOpenCleanupCalls += 1; return { ok: true }; },
  });
  const alreadyRestored = await alreadyOpen.unarchiveProject("already-open");
  assert.equal(alreadyRestored.already_unarchived, true);
  assert.equal(alreadyOpenCleanupCalls, 0, "idempotent unarchive never stops a live project");

  const collisionStore = inMemoryCommit(config(project("owner"), project("collision", true)));
  const beforeCollision = JSON.stringify(collisionStore.read());
  const collisionController = createProjectLifecycleController({
    commitV2Configuration: (mutator) => {
      const candidate = collisionStore.read();
      mutator(candidate);
      const error = new Error("owned by owner");
      error.code = "repository_owned_by_active_project";
      error.owner_project_id = "owner";
      throw error;
    },
    readConfig: collisionStore.read,
    validateV2Configuration: () => {
      const error = new Error("owned by owner");
      error.code = "repository_owned_by_active_project";
      error.owner_project_id = "owner";
      throw error;
    },
    cleanupProject: async () => { throw new Error("collision must fail before cleanup"); },
  });
  await assert.rejects(() => collisionController.unarchiveProject("collision"), (error) => {
    assert.equal(error.code, "repository_owned_by_active_project");
    assert.equal(error.owner_project_id, "owner");
    return true;
  });
  assert.equal(JSON.stringify(collisionStore.read()), beforeCollision);

  assert.throws(
    () => unarchiveCandidate("bad", config({ id: "bad", archived: "true", repositories: [] }), () => {}),
    (error) => error.code === "invalid_project_archive_state",
  );

  // Repository ownership is installation-wide. Two archived projects may each
  // look eligible in isolation, but concurrent unarchives must not both run
  // cleanup before one publishes ownership and makes the other collide.
  const ownershipStore = inMemoryCommit(config(project("owner-a", true), project("owner-b", true)));
  let releaseOwnerA;
  const ownerAGate = new Promise((resolve) => { releaseOwnerA = resolve; });
  const ownershipCleanup = [];
  const validateSingleOwner = (candidate) => {
    const active = candidate.projects.filter((entry) => entry.archived !== true);
    if (active.length > 1) {
      const error = new Error(`owned by ${active[0].id}`);
      error.code = "repository_owned_by_active_project";
      error.owner_project_id = active[0].id;
      throw error;
    }
  };
  const ownerAController = createProjectLifecycleController({
    commitV2Configuration: ownershipStore.commit,
    readConfig: ownershipStore.read,
    validateV2Configuration: validateSingleOwner,
    cleanupProject: async () => {
      ownershipCleanup.push("owner-a");
      await ownerAGate;
      return { ok: true };
    },
  });
  const ownerBController = createProjectLifecycleController({
    commitV2Configuration: ownershipStore.commit,
    readConfig: ownershipStore.read,
    validateV2Configuration: validateSingleOwner,
    cleanupProject: async () => {
      ownershipCleanup.push("owner-b");
      return { ok: true };
    },
  });
  const ownerAUnarchive = ownerAController.unarchiveProject("owner-a");
  await new Promise((resolve) => setImmediate(resolve));
  const ownerBUnarchive = ownerBController.unarchiveProject("owner-b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ownershipCleanup, ["owner-a"], "second ownership candidate waits before cleanup");
  releaseOwnerA();
  await ownerAUnarchive;
  await assert.rejects(ownerBUnarchive, (error) => {
    assert.equal(error.code, "repository_owned_by_active_project");
    assert.equal(error.owner_project_id, "owner-a");
    return true;
  });
  assert.deepEqual(ownershipCleanup, ["owner-a"], "collision leaves the losing project's resources unchanged");
  assert.equal(ownershipStore.read().projects.find((entry) => entry.id === "owner-a").archived, false);
  assert.equal(ownershipStore.read().projects.find((entry) => entry.id === "owner-b").archived, true);

  const removeStore = inMemoryCommit(config(project("remove")));
  let allowRemove = false;
  const removeController = createProjectLifecycleController({
    commitV2Configuration: removeStore.commit,
    cleanupProject: async () => allowRemove
      ? { ok: true, resources: { sessions: 1 } }
      : { ok: false, cleanup_errors: [{ resource: "pty", code: "kill_failed", message: "retry" }] },
  });
  const held = await removeController.removeProject("remove");
  assert.equal(held.removed, false);
  assert.equal(removeStore.read().projects.length, 1, "cleanup failure preserves metadata");
  allowRemove = true;
  const removed = await removeController.removeProject("remove");
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(removeStore.read().projects.length, 0);

  const serialEvents = [];
  const serialStore = inMemoryCommit(config(project("serial")), serialEvents);
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const serialArchiveController = createProjectLifecycleController({
    commitV2Configuration: serialStore.commit,
    cleanupProject: async () => {
      serialEvents.push("cleanup:start");
      await cleanupGate;
      serialEvents.push("cleanup:end");
      return { ok: true };
    },
  });
  const serialRestoreController = createProjectLifecycleController({
    commitV2Configuration: serialStore.commit,
    readConfig: serialStore.read,
    validateV2Configuration: () => {},
    cleanupProject: async () => ({ ok: true }),
  });
  const first = serialArchiveController.archiveProject("serial");
  const second = serialRestoreController.unarchiveProject("serial");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serialStore.read().projects[0].archived, true, "cross-controller unarchive waits behind cleanup");
  releaseCleanup();
  await Promise.all([first, second]);
  assert.equal(serialStore.read().projects[0].archived, false);
  assert.ok(serialEvents.indexOf("cleanup:end") < serialEvents.lastIndexOf("commit:serial:false"));

  const isolatedStore = inMemoryCommit(config(project("a"), project("b")));
  const touched = [];
  const isolatedController = createProjectLifecycleController({
    commitV2Configuration: isolatedStore.commit,
    cleanupProject: async (id) => { touched.push(id); return { ok: true, resources: { sessions: 1 } }; },
  });
  await isolatedController.archiveProject("a");
  assert.equal(isolatedStore.read().projects.find((entry) => entry.id === "b").archived, false);
  assert.deepEqual(touched, ["a"]);

  const missingStore = inMemoryCommit(config(project("known")));
  const missingController = createProjectLifecycleController({
    commitV2Configuration: missingStore.commit,
    cleanupProject: async () => ({ ok: true }),
  });
  await rejectsCode(() => missingController.archiveProject("missing"), "unknown_project");
  await rejectsCode(() => missingController.removeProject("missing"), "unknown_project");

  console.log("project lifecycle contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

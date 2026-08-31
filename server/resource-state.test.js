"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  RESOURCE_STATE_VERSION,
  ResourceStateStore,
  createResourceSnapshot,
} = require("./resource-state");

const fixtures = [];
process.on("exit", () => {
  for (const fixture of fixtures) {
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
  }
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-resource-state-"));
  fixtures.push(dir);
  return { dir, filePath: path.join(dir, "resource-state.json") };
}

function fact(index, extra = {}) {
  return {
    project_id: "quadwork",
    generation_id: `generation-${index}`,
    resource_class: index % 2 ? "control" : "worker",
    unit_name: `qw-worker-${index}.scope`,
    reason: "normal_exit",
    exit_code: 0,
    signal: null,
    finished_at: `2026-08-31T00:00:${String(index).padStart(2, "0")}.000Z`,
    ...extra,
  };
}

function fullState(terminalFacts = [fact(1)]) {
  return {
    status: "ready",
    counts: {
      active_worker_scopes: 2,
      active_control_children: 1,
      queued_control_children: 3,
    },
    limits: {
      host_reserve_mib: 1536,
      max_worker_scopes: 4,
      max_control_children: 2,
      worker_memory_high_mib: 1024,
      worker_memory_max_mib: 1280,
      worker_swap_max_mib: 512,
      control_memory_max_mib: 512,
      control_swap_max_mib: 256,
      api_memory_low_mib: 256,
      api_memory_max_mib: 512,
      temp_min_free_mib: 4096,
    },
    usage: {
      host_memory_total_mib: 8192,
      host_memory_available_mib: 4096,
      swap_total_mib: 2048,
      swap_free_mib: 1024,
      worker_memory_mib: 900,
      control_memory_mib: 120,
      api_memory_mib: 200,
      static_reservation_mib: 7440,
      static_headroom_mib: 752,
      configured_swap_mib: 1792,
      swap_headroom_mib: 256,
    },
    temp: { disk_backed: true, free_mib: 12000, total_mib: 24000 },
    terminal_facts: terminalFacts,
  };
}

// Atomic 0600 persistence survives process-local store recreation.
{
  const { filePath } = fixture();
  const first = new ResourceStateStore({ filePath, terminalFactLimit: 3 });
  const saved = first.save(fullState([fact(1), fact(2)]));
  assert.equal(saved.version, RESOURCE_STATE_VERSION);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const reloaded = new ResourceStateStore({ filePath, terminalFactLimit: 3 }).load();
  assert.deepEqual(reloaded, saved);
  assert.ok(Object.isFrozen(reloaded));
  assert.ok(Object.isFrozen(reloaded.terminal_facts));
}

// Malformed, unsupported-version, and missing files fail to an empty redacted snapshot.
{
  const { filePath } = fixture();
  fs.writeFileSync(filePath, "{not json", { mode: 0o600 });
  const store = new ResourceStateStore({ filePath });
  assert.deepEqual(store.load(), createResourceSnapshot({}));
  fs.writeFileSync(filePath, JSON.stringify({ version: 999, terminal_facts: [fact(1)] }), { mode: 0o600 });
  assert.deepEqual(store.load(), createResourceSnapshot({}));
  fs.unlinkSync(filePath);
  assert.deepEqual(store.load(), createResourceSnapshot({}));
}

// Only the documented schema crosses the persistence boundary.
{
  const { filePath } = fixture();
  const secret = "SECRET-MUST-NOT-PERSIST";
  const input = fullState([fact(1, {
    command: secret,
    args: [secret],
    env: { TOKEN: secret },
    raw_error: `/private/${secret}`,
    terminal: secret,
  })]);
  input.config_path = `/private/${secret}`;
  input.process = { input: secret };
  input.unknown = secret;
  input.counts.secret_count = 7;
  input.limits.private_path = `/tmp/${secret}`;
  input.usage.raw = secret;
  input.temp.path = `/private/tmp/${secret}`;
  const snapshot = new ResourceStateStore({ filePath }).save(input);
  const serialized = fs.readFileSync(filePath, "utf8");
  assert.ok(!serialized.includes(secret));
  assert.deepEqual(Object.keys(snapshot), ["version", "status", "counts", "limits", "usage", "temp", "terminal_facts"]);
  assert.deepEqual(Object.keys(snapshot.terminal_facts[0]), [
    "project_id", "generation_id", "resource_class", "unit_name",
    "reason", "exit_code", "signal", "finished_at",
  ]);
  assert.deepEqual(snapshot.temp, { disk_backed: true, free_mib: 12000, total_mib: 24000 });
  assert.deepEqual(
    createResourceSnapshot({ temp: { disk_backed: false, free_mib: 100, total_mib: 200 } }).temp,
    { disk_backed: false, free_mib: 100, total_mib: 200 },
  );
}

// History retains only the newest valid bounded facts.
{
  const { filePath } = fixture();
  const facts = [fact(0), fact(1), fact(2), fact(3), fact(4)];
  const snapshot = new ResourceStateStore({ filePath, terminalFactLimit: 3 }).save(fullState(facts));
  assert.deepEqual(snapshot.terminal_facts.map((entry) => entry.generation_id), [
    "generation-2", "generation-3", "generation-4",
  ]);
  const disk = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(disk.terminal_facts.length, 3);
}

// A failed atomic commit preserves both the prior file and in-memory snapshot.
{
  const { dir, filePath } = fixture();
  const baselineStore = new ResourceStateStore({ filePath });
  const baseline = baselineStore.save(fullState([fact(1)]));
  const originalBytes = fs.readFileSync(filePath, "utf8");
  const failingFs = Object.create(fs);
  failingFs.renameSync = () => {
    const error = new Error("injected rename failure");
    error.code = "ENOSPC";
    throw error;
  };
  const failingStore = new ResourceStateStore({ filePath, fsImpl: failingFs });
  assert.deepEqual(failingStore.load(), baseline);
  assert.throws(() => failingStore.save(fullState([fact(2)])), /injected rename failure/);
  assert.equal(fs.readFileSync(filePath, "utf8"), originalBytes);
  assert.deepEqual(failingStore.snapshot(), baseline);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
}

// Throwing getters and contradictory/unsafe numeric facts are invalid input,
// never a reason to inspect unknown fields or serialize raw data.
{
  const secret = "GETTER-SECRET-MUST-NOT-LEAK";
  const input = fullState([fact(1), fact(2)]);
  Object.defineProperty(input, "status", { get() { throw new Error(secret); } });
  Object.defineProperty(input.counts, "active_worker_scopes", { get() { throw new Error(secret); } });
  Object.defineProperty(input.limits, "worker_memory_high_mib", { get() { throw new Error(secret); } });
  Object.defineProperty(input.usage, "host_memory_available_mib", { get() { throw new Error(secret); } });
  Object.defineProperty(input.temp, "free_mib", { get() { throw new Error(secret); } });
  Object.defineProperty(input.terminal_facts[0], "reason", { get() { throw new Error(secret); } });
  Object.defineProperty(input, "unknown", { get() { throw new Error("unknown field was read"); } });
  input.counts.queued_control_children = Number.MAX_SAFE_INTEGER + 1;
  input.limits.api_memory_low_mib = 900;
  input.limits.api_memory_max_mib = 800;
  input.limits.max_worker_scopes = 0;
  input.usage.swap_free_mib = 3000;
  input.usage.swap_total_mib = 2000;
  const snapshot = createResourceSnapshot(input, { terminalFactLimit: 5 });
  assert.equal(snapshot.status, "unknown");
  assert.equal(snapshot.counts.active_worker_scopes, undefined);
  assert.equal(snapshot.counts.queued_control_children, undefined);
  assert.equal(snapshot.limits.worker_memory_high_mib, undefined);
  assert.equal(snapshot.limits.api_memory_low_mib, undefined);
  assert.equal(snapshot.limits.api_memory_max_mib, undefined);
  assert.equal(snapshot.limits.max_worker_scopes, undefined);
  assert.equal(snapshot.usage.host_memory_available_mib, undefined);
  assert.equal(snapshot.usage.swap_free_mib, undefined);
  assert.equal(snapshot.usage.swap_total_mib, undefined);
  assert.equal(snapshot.temp, null);
  assert.deepEqual(snapshot.terminal_facts.map((entry) => entry.generation_id), ["generation-2"]);
  assert.ok(!JSON.stringify(snapshot).includes(secret));
}

// The pure snapshot function performs no filesystem work.
{
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  fs.writeFileSync = () => { throw new Error("pure snapshot attempted a write"); };
  fs.renameSync = () => { throw new Error("pure snapshot attempted a rename"); };
  let snapshot;
  try {
    snapshot = createResourceSnapshot(fullState());
  } finally {
    fs.writeFileSync = originalWrite;
    fs.renameSync = originalRename;
  }
  assert.equal(snapshot.status, "ready");
}

console.log("resource-state.test.js: all assertions passed");

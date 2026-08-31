"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MAX_STATE_BYTES,
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
      swap_total_mib: 4096,
      swap_free_mib: 1024,
      worker_memory_mib: 900,
      control_memory_mib: 120,
      api_memory_mib: 200,
      static_reservation_mib: 7680,
      static_headroom_mib: 512,
      configured_swap_mib: 2304,
      swap_headroom_mib: 1792,
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
  assert.deepEqual(Object.keys(snapshot), [
    "version", "status", "counts", "limits", "usage", "temp", "last_cgroup_oom", "terminal_facts",
  ]);
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

// Invalid facts interleaved at the tail do not displace the newest valid N,
// while a hostile sparse array cannot force an unbounded scan.
{
  const invalidFact = (index) => fact(index, { reason: "not-a-terminal-reason" });
  const input = [fact(0), invalidFact(10), fact(1), invalidFact(11), fact(2), invalidFact(12), fact(3), invalidFact(13)];
  const snapshot = createResourceSnapshot({ terminal_facts: input }, { terminalFactLimit: 3 });
  assert.deepEqual(snapshot.terminal_facts.map((entry) => entry.generation_id), [
    "generation-1", "generation-2", "generation-3",
  ]);

  const sparse = [];
  sparse.length = 1_000_000;
  let numericReads = 0;
  const hostileSparse = new Proxy(sparse, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) numericReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.deepEqual(
    createResourceSnapshot({ terminal_facts: hostileSparse }, { terminalFactLimit: 3 }).terminal_facts,
    [],
  );
  assert.equal(numericReads, 30, "scan work is capped at ten times the retention limit");
}

// Terminal reason authority has one explicit matrix. Contradictory claims are
// retained only as unknown facts, never as a false normal/signal/OOM outcome.
{
  const matrix = [
    fact(10, { reason: "normal_exit", exit_code: 0, signal: null }),
    fact(11, { reason: "normal_exit", exit_code: 1, signal: null }),
    fact(12, { reason: "normal_exit", exit_code: 0, signal: "SIGTERM" }),
    fact(13, { reason: "signal", exit_code: null, signal: "SIGTERM" }),
    fact(14, { reason: "signal", exit_code: 143, signal: "SIGTERM" }),
    fact(15, { reason: "signal", exit_code: null, signal: null }),
    fact(16, { reason: "oom_kill", exit_code: 137, signal: null }),
    fact(17, { reason: "oom_kill", exit_code: null, signal: "SIGKILL" }),
    fact(18, { reason: "oom_kill", exit_code: null, signal: 9 }),
    fact(19, { reason: "oom_kill", exit_code: 0, signal: null }),
    fact(20, { reason: "oom_kill", exit_code: 0, signal: "SIGKILL" }),
    fact(21, { reason: "oom_kill", exit_code: 137, signal: "SIGTERM" }),
    fact(22, { reason: "unknown", exit_code: 0, signal: null }),
    fact(23, { reason: "unknown", exit_code: 17, signal: "SIGTERM" }),
    fact(24, { reason: "unsupported", exit_code: 0, signal: null }),
  ];
  matrix.push(
    fact(25, { reason: "normal_exit", exit_code: 0, signal: "invalid-signal" }),
    fact(26, { reason: "signal", exit_code: 999, signal: "SIGTERM" }),
    fact(27, { reason: "signal", exit_code: null, signal: "invalid-signal" }),
    fact(28, { reason: "oom_kill", exit_code: null, signal: "invalid-signal" }),
  );
  const output = createResourceSnapshot({
    last_cgroup_oom: {
      project_id: "quadwork",
      generation_id: "generation-19",
      resource_class: "control",
      unit_name: "qw-worker-19.scope",
      oom_kill_count: 1,
      observed_at: "2026-08-31T00:00:19Z",
    },
    terminal_facts: matrix,
  }, { terminalFactLimit: 20 }).terminal_facts;
  assert.deepEqual(output.map((entry) => entry.reason), [
    "normal_exit", "unknown", "unknown",
    "signal", "unknown", "unknown",
    "unknown", "unknown", "unknown", "oom_kill", "unknown", "unknown",
    "unknown", "unknown",
    "unknown", "unknown", "unknown", "unknown",
  ]);
  assert.equal(output.some((entry) => entry.generation_id === "generation-24"), false);
  assert.equal(
    createResourceSnapshot({ terminal_facts: [fact(29, { reason: "oom_kill", exit_code: 0, signal: null })] })
      .terminal_facts[0].reason,
    "unknown",
    "OOM without a validated persisted counter is not authoritative",
  );
  const zeroObservation = createResourceSnapshot({
    last_cgroup_oom: {
      project_id: "quadwork",
      generation_id: "generation-29",
      resource_class: "control",
      unit_name: "qw-worker-29.scope",
      oom_kill_count: 0,
      observed_at: "2026-08-31T00:00:29Z",
    },
    terminal_facts: [fact(29, { reason: "oom_kill", exit_code: 0, signal: null })],
  });
  assert.equal(zeroObservation.last_cgroup_oom.oom_kill_count, "0", "a valid zero observation persists");
  assert.equal(
    zeroObservation.terminal_facts[0].reason,
    "unknown",
    "a valid zero counter cannot claim an OOM",
  );
}

// OOM authority belongs to one exact immutable resource identity. Both the
// controller's durable pre-collect observation and a post-exit observation are
// valid; timestamp ordering is not fabricated from those separate events.
{
  const oomFact = fact(31, { reason: "oom_kill", exit_code: 0, signal: null });
  const exactPreCollect = {
    project_id: oomFact.project_id,
    generation_id: oomFact.generation_id,
    resource_class: oomFact.resource_class,
    unit_name: oomFact.unit_name,
    oom_kill_count: 3,
    observed_at: "2026-08-01T00:00:00.000Z",
  };
  assert.equal(createResourceSnapshot({
    last_cgroup_oom: exactPreCollect,
    terminal_facts: [oomFact],
  }).terminal_facts[0].reason, "oom_kill", "long-lived generation pre-collect observation authorizes OOM");

  assert.equal(createResourceSnapshot({
    last_cgroup_oom: { ...exactPreCollect, observed_at: "2026-09-01T00:00:00.000Z" },
    terminal_facts: [oomFact],
  }).terminal_facts[0].reason, "oom_kill", "post-exit observation authorizes OOM");

  for (const mismatch of [
    { generation_id: "another-generation" },
    { project_id: "another-project" },
    { resource_class: oomFact.resource_class === "worker" ? "control" : "worker" },
    { unit_name: "another-worker.scope" },
  ]) {
    assert.equal(createResourceSnapshot({
      last_cgroup_oom: { ...exactPreCollect, ...mismatch },
      terminal_facts: [oomFact],
    }).terminal_facts[0].reason, "unknown");
  }

  const legacyGlobal = createResourceSnapshot({
    last_cgroup_oom: { oom_kill_count: 7, observed_at: oomFact.finished_at },
    terminal_facts: [oomFact],
  });
  assert.equal(legacyGlobal.last_cgroup_oom, null);
  assert.equal(legacyGlobal.terminal_facts[0].reason, "unknown");
}

// `ready` is authority-bearing. It survives only when every required fact is
// present and the policy, usage arithmetic, counts, and disk facts agree.
{
  assert.equal(createResourceSnapshot(fullState()).status, "ready");

  const missing = fullState();
  delete missing.counts.active_worker_scopes;
  assert.equal(createResourceSnapshot(missing).status, "unknown");

  const overLimit = fullState();
  overLimit.counts.active_worker_scopes = overLimit.limits.max_worker_scopes + 1;
  assert.equal(createResourceSnapshot(overLimit).status, "unknown");

  const contradictory = fullState();
  contradictory.usage.static_headroom_mib += 1;
  assert.equal(createResourceSnapshot(contradictory).status, "unknown");

  const unsafeTemp = fullState();
  unsafeTemp.temp.disk_backed = false;
  assert.equal(createResourceSnapshot(unsafeTemp).status, "unknown");

  const lowTemp = fullState();
  lowTemp.temp.free_mib = lowTemp.limits.temp_min_free_mib - 1;
  assert.equal(createResourceSnapshot(lowTemp).status, "unknown");

  const partialFailure = createResourceSnapshot({ status: "unavailable", counts: { active_worker_scopes: 0 } });
  assert.equal(partialFailure.status, "unavailable", "a declared non-ready state may remain partial");

  const { filePath } = fixture();
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, status: "ready", counts: {} }), { mode: 0o600 });
  assert.equal(new ResourceStateStore({ filePath }).load().status, "unknown", "reload revalidates ready authority");
}

// The last cgroup OOM counter/time pair is all-or-none and uses a canonical
// decimal string so counters above Number.MAX_SAFE_INTEGER remain JSON-safe.
{
  const { filePath } = fixture();
  const input = fullState();
  input.last_cgroup_oom = {
    project_id: "quadwork",
    generation_id: "generation-1",
    resource_class: "control",
    unit_name: "qw-worker-1.scope",
    oom_kill_count: 9_007_199_254_740_993n,
    observed_at: "2026-08-31T09:15:00+09:00",
    raw_path: "/sys/fs/cgroup/private/memory.events",
  };
  const store = new ResourceStateStore({ filePath });
  const saved = store.save(input);
  assert.deepEqual(saved.last_cgroup_oom, {
    project_id: "quadwork",
    generation_id: "generation-1",
    resource_class: "control",
    unit_name: "qw-worker-1.scope",
    oom_kill_count: "9007199254740993",
    observed_at: "2026-08-31T00:15:00.000Z",
  });
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, "utf8")), "no bigint crosses JSON encoding");
  assert.deepEqual(new ResourceStateStore({ filePath }).load().last_cgroup_oom, saved.last_cgroup_oom);
  assert.ok(!fs.readFileSync(filePath, "utf8").includes("/sys/fs"));

  const identity = {
    project_id: "quadwork",
    generation_id: "generation-1",
    resource_class: "control",
    unit_name: "qw-worker-1.scope",
  };
  assert.equal(createResourceSnapshot({ last_cgroup_oom: { ...identity, oom_kill_count: 1 } }).last_cgroup_oom, null);
  assert.equal(createResourceSnapshot({ last_cgroup_oom: { ...identity, observed_at: "2026-08-31T00:00:00Z" } }).last_cgroup_oom, null);
  assert.equal(createResourceSnapshot({ last_cgroup_oom: { ...identity, oom_kill_count: -1, observed_at: "2026-08-31T00:00:00Z" } }).last_cgroup_oom, null);
  assert.equal(createResourceSnapshot({ last_cgroup_oom: { ...identity, oom_kill_count: "01", observed_at: "2026-08-31T00:00:00Z" } }).last_cgroup_oom, null);
  assert.equal(createResourceSnapshot({ last_cgroup_oom: { ...identity, oom_kill_count: 1n << 64n, observed_at: "2026-08-31T00:00:00Z" } }).last_cgroup_oom, null);
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

// A successful rename is the sole commit point. No post-rename pathname
// verification may report failure after disk state has already advanced.
{
  const { filePath } = fixture();
  const commitFs = Object.create(fs);
  let renamed = false;
  let finalLstatCalls = 0;
  commitFs.renameSync = (source, destination) => {
    fs.renameSync(source, destination);
    renamed = true;
  };
  commitFs.lstatSync = (target) => {
    if (renamed && target === filePath) {
      finalLstatCalls += 1;
      throw new Error("post-rename lstat must not run");
    }
    return fs.lstatSync(target);
  };
  const store = new ResourceStateStore({ filePath, fsImpl: commitFs });
  const saved = store.save(fullState([fact(2)]));
  assert.equal(renamed, true);
  assert.equal(finalLstatCalls, 0);
  assert.deepEqual(store.snapshot(), saved);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), saved);
}

// Swapping the freshly written temp pathname to a symlink is detected before
// rename. Cleanup unlinks only the symlink entry and never chmods or writes the
// target outside the state store.
{
  const { dir, filePath } = fixture();
  const outside = path.join(dir, "outside.txt");
  const outsideBytes = "outside-content-must-survive\n";
  fs.writeFileSync(outside, outsideBytes, { mode: 0o644 });
  fs.chmodSync(outside, 0o644);
  const swapFs = Object.create(fs);
  let tmpPath = null;
  let swapped = false;
  swapFs.openSync = (target, flags, mode) => {
    tmpPath = target;
    return fs.openSync(target, flags, mode);
  };
  swapFs.writeFileSync = (target, data, options) => {
    fs.writeFileSync(target, data, options);
    const orphan = `${tmpPath}.orphan`;
    fs.renameSync(tmpPath, orphan);
    fs.symlinkSync(outside, tmpPath);
    swapped = true;
  };
  const store = new ResourceStateStore({ filePath, fsImpl: swapFs });
  assert.throws(() => store.save(fullState()), /temporary state file identity changed/);
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(outside, "utf8"), outsideBytes);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(tmpPath), false);
  assert.equal(store.snapshot().status, "unknown");
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
  input.last_cgroup_oom = { oom_kill_count: 1, observed_at: "2026-08-31T00:00:00Z" };
  Object.defineProperty(input.last_cgroup_oom, "oom_kill_count", { get() { throw new Error(secret); } });
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
  assert.equal(snapshot.last_cgroup_oom, null);
  assert.deepEqual(snapshot.terminal_facts.map((entry) => entry.generation_id), ["generation-2"]);
  assert.ok(!JSON.stringify(snapshot).includes(secret));
}

// Reload trusts only the same regular 0600 file opened without symlink
// following. Unsafe files are left untouched and yield an empty non-ready state.
{
  const expectedEmpty = createResourceSnapshot({});

  const insecure = fixture();
  fs.writeFileSync(insecure.filePath, JSON.stringify({ version: 1, ...fullState() }), { mode: 0o644 });
  fs.chmodSync(insecure.filePath, 0o644);
  assert.deepEqual(new ResourceStateStore({ filePath: insecure.filePath }).load(), expectedEmpty);
  assert.equal(fs.statSync(insecure.filePath).mode & 0o777, 0o644);

  const symlinked = fixture();
  const realState = path.join(symlinked.dir, "real-state.json");
  fs.writeFileSync(realState, JSON.stringify({ version: 1, ...fullState() }), { mode: 0o600 });
  fs.symlinkSync(realState, symlinked.filePath);
  assert.deepEqual(new ResourceStateStore({ filePath: symlinked.filePath }).load(), expectedEmpty);
  assert.equal(fs.lstatSync(symlinked.filePath).isSymbolicLink(), true);

  const directory = fixture();
  fs.mkdirSync(directory.filePath, { mode: 0o600 });
  assert.deepEqual(new ResourceStateStore({ filePath: directory.filePath }).load(), expectedEmpty);

  const wrongOwner = fixture();
  fs.writeFileSync(wrongOwner.filePath, JSON.stringify({ version: 1, ...fullState() }), { mode: 0o600 });
  const ownerFs = Object.create(fs);
  let ownerOpenCalls = 0;
  ownerFs.lstatSync = (target) => {
    const st = fs.lstatSync(target);
    return new Proxy(st, {
      get(object, property) {
        if (property === "uid") return Number(object.uid) + 1;
        const value = Reflect.get(object, property);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  };
  ownerFs.openSync = (...args) => { ownerOpenCalls += 1; return fs.openSync(...args); };
  assert.deepEqual(new ResourceStateStore({ filePath: wrongOwner.filePath, fsImpl: ownerFs }).load(), expectedEmpty);
  assert.equal(ownerOpenCalls, 0, "wrong ownership fails before the pathname is opened");

  const swapped = fixture();
  const replacement = path.join(swapped.dir, "replacement.json");
  fs.writeFileSync(swapped.filePath, JSON.stringify({ version: 1, ...fullState() }), { mode: 0o600 });
  fs.writeFileSync(replacement, JSON.stringify({ version: 1, status: "unavailable" }), { mode: 0o600 });
  const original = `${swapped.filePath}.original`;
  const swapFs = Object.create(fs);
  let swappedOnce = false;
  swapFs.openSync = (target, flags) => {
    if (!swappedOnce) {
      swappedOnce = true;
      fs.renameSync(target, original);
      fs.renameSync(replacement, target);
    }
    return fs.openSync(target, flags);
  };
  assert.deepEqual(new ResourceStateStore({ filePath: swapped.filePath, fsImpl: swapFs }).load(), expectedEmpty);

  const oversized = fixture();
  fs.writeFileSync(oversized.filePath, "", { mode: 0o600 });
  fs.truncateSync(oversized.filePath, MAX_STATE_BYTES + 1);
  const boundedFs = Object.create(fs);
  let reads = 0;
  boundedFs.readFileSync = (...args) => { reads += 1; return fs.readFileSync(...args); };
  assert.deepEqual(new ResourceStateStore({ filePath: oversized.filePath, fsImpl: boundedFs }).load(), expectedEmpty);
  assert.equal(reads, 0, "oversized trusted files are rejected before read/JSON parse");
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

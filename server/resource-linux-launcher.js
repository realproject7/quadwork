"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pty = require("node-pty");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { ResourceController, buildControlClassConfiguration } = require("./resource-controller");
const { createWorkerUnitBase, createControlUnitBase } = require("./resource-unit");
const { inspectTempRoot, createGenerationTemp, reclaimGenerationTemp } = require("./resource-temp");
const { runResourcePreflight, createReadOnlyProbes } = require("./resource-preflight");
const facts = require("./resource-linux-facts");
const exec = promisify(execFile);
const STATE = new WeakMap();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boundedUntil(read, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do { const value = await read(); if (value) return value; await wait(25); } while (Date.now() < deadline);
  facts.fail("scope_observation_timeout");
}
function dataRecords(term) {
  const records = []; let pending = "";
  const subscription = term.onData((chunk) => {
    pending = (pending + chunk).slice(-65536);
    for (;;) {
      const start = pending.indexOf("QW_RESOURCE:"), end = pending.indexOf("\n", start);
      if (start < 0 || end < 0) break;
      try { const record = JSON.parse(pending.slice(start + 12, end).trim()); if (records.length < 4096) records.push(record); } catch {}
      pending = pending.slice(end + 1);
    }
  });
  return { records, close: () => subscription.dispose() };
}
function checkProcessSet(ready, group) {
  if (!ready.tty || !Array.isArray(ready.children) || ready.children.length !== 3) facts.fail("pty_descendant_proof_failed");
  const main = facts.readProcess(ready.pid);
  if (main.tty === 0 || main.cgroup !== group) facts.fail("controlling_tty_unproven");
  for (const pid of ready.children) {
    const child = facts.readProcess(pid);
    if (child.ppid !== ready.pid || child.cgroup !== group) facts.fail("descendant_cgroup_mismatch");
  }
  return main;
}

// One owner per API process. The governor remains the admission/state owner;
// this object owns actual scopes, PTYs and generation temp until tree exit.
class LinuxResourceLauncher {
  constructor(policy) {
    const pending = new Map();
    const state = { policy, pending, records: new Map(), proof: false, preparing: null, closed: false, controlGeneration: `api-${crypto.randomBytes(12).toString("hex")}` };
    state.controller = new ResourceController({
      maxControlChildren: policy.control.max_concurrent_children,
      queryScope: async () => null,
      executeProcess: (invocation) => this._execute(invocation),
    });
    STATE.set(this, state);
    Object.freeze(this);
  }
  ready() { return STATE.get(this).proof; }
  snapshot() { return STATE.get(this).controller.snapshot(); }
  async prepare() {
    const s = STATE.get(this);
    if (s.proof) return true;
    if (s.preparing) return s.preparing;
    s.preparing = (async () => {
      if (process.platform !== "linux") return false;
      // These read-only prerequisites cannot be replaced by config proof data.
      const probes = createReadOnlyProbes({ scopeProof: true });
      if (!runResourcePreflight({ runtimeResources: s.policy, probes, requestedWorkerScopes: 1 }).ok) return false;
      const version = facts.command("systemctl", ["--user", "show", "--property=Version", "--value"]);
      if (!(Number(/^(\d+)/.exec(version)?.[1]) >= 253)) return false;
      const control = buildControlClassConfiguration({ controlClassName: "quadwork-control.slice", limits: { memoryMaxMib: s.policy.control.memory_max_mib, swapMaxMib: s.policy.control.swap_max_mib } });
      await exec(control.file, control.args, { timeout: 5000, maxBuffer: 16384 });
      const generationId = `probe-${crypto.randomBytes(12).toString("hex")}`;
      const term = await this.spawnPty({ projectId: "resource-probe", generationId, command: process.execPath, args: [path.join(__dirname, "resource-staging-worker.js")], cwd: __dirname, env: { ...process.env }, probe: true });
      const trace = s.records.get(generationId).trace;
      try {
        const ready = await boundedUntil(() => trace.records.find((row) => row.kind === "ready"));
        const group = facts.scopeGroup(`${createWorkerUnitBase({ projectId: "resource-probe", generationId })}.scope`);
        const main = checkProcessSet(ready, group);
        facts.verifyTempFile(ready.temp_file, this.tempForGeneration(generationId));
        term.resize(103, 37);
        await boundedUntil(() => trace.records.find((row) => row.kind === "resize" && row.columns === 103 && row.rows === 37));
        if (!facts.sameProcess(main, facts.readProcess(main.pid))) facts.fail("process_identity_changed");
        process.kill(main.pid, "SIGUSR1");
        await boundedUntil(() => trace.records.find((row) => row.kind === "signal" && row.signal === "SIGUSR1"));
        term.write(`${JSON.stringify({ kind: "exit", challenge: ready.challenge })}\n`);
        const result = await this.waitForGeneration(generationId);
        if (result?.result?.code !== 23) facts.fail("pty_exit_propagation_failed");
        s.proof = true;
        return true;
      } finally { trace.close(); await this.stopGeneration(generationId); }
    })().catch(() => false).finally(() => { s.preparing = null; });
    return s.preparing;
  }
  tempForGeneration(generationId) { return STATE.get(this).records.get(generationId)?.tempPath || null; }
  async spawnPty(spec) {
    const s = STATE.get(this);
    if (s.closed) facts.fail("server_shutting_down");
    if (!s.proof && spec.probe !== true) facts.fail("containment_unavailable");
    const unitName = createWorkerUnitBase(spec);
    if (s.pending.has(unitName) || s.records.has(spec.generationId)) facts.fail("scope_identity_collision");
    const tempFacts = inspectTempRoot({ tempRoot: s.policy.temp_root, minimumFreeBytes: s.policy.temp_min_free_mib * facts.MIB });
    if (!tempFacts.available) facts.fail("temp_unavailable");
    const temp = createGenerationTemp({ facts: tempFacts, generationId: spec.generationId });
    let resolveStarted, rejectStarted;
    const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const record = { ...spec, unitName, parentSlice: `quadwork-worker-group-${unitName.slice("quadwork-worker-".length)}.slice`, tempFacts, tempPath: temp.path || temp, resolveStarted, rejectStarted, term: null, group: null, done: null, cleaned: false };
    s.pending.set(unitName, record); s.records.set(spec.generationId, record);
    record.done = s.controller.runWorkerScope({ projectId: spec.projectId, generationId: spec.generationId, unitName, parentSlice: record.parentSlice, ...(spec.probe ? { runtimeMaxSec: 90 } : {}), command: spec.command, args: spec.args, limits: { memoryHighMib: s.policy.worker.memory_high_mib, memoryMaxMib: s.policy.worker.memory_max_mib, swapMaxMib: s.policy.worker.swap_max_mib } });
    record.done.catch((error) => { rejectStarted(error); }).finally(() => s.pending.delete(unitName));
    return started;
  }
  async _execute(invocation) {
    const s = STATE.get(this), record = s.pending.get(invocation.unitName);
    if (!record) facts.fail("scope_owner_missing");
    if (invocation.resourceClass === "control") {
      if (s.closed || !s.proof) facts.fail("containment_unavailable");
      const output = await exec(invocation.file, invocation.args, record.options);
      return { code: 0, signal: null, stdout: output.stdout, stderr: output.stderr };
    }
    record.setup = this._prepareSlice(record);
    await record.setup;
    if (s.closed) facts.fail("server_shutting_down");
    record.assertLaunchCurrent?.();
    const term = pty.spawn(invocation.file, invocation.args, { name: "xterm-256color", cols: 120, rows: 30, cwd: record.cwd, env: { ...record.env, TMPDIR: record.tempPath } });
    record.term = term;
    record.trace = dataRecords(term);
    const exited = new Promise((resolve) => term.onExit(resolve));
    try {
      const group = await boundedUntil(() => { try { return facts.scopeGroup(`${invocation.unitName}.scope`); } catch { return null; } });
      record.group = group;
      record.parentGroup = path.posix.dirname(group);
      if (!record.parentGroup.endsWith(`/${record.parentSlice}`)) facts.fail("scope_parent_mismatch");
      facts.verifyWorkerGroup(group, { memoryHighMib: s.policy.worker.memory_high_mib, memoryMaxMib: s.policy.worker.memory_max_mib, swapMaxMib: s.policy.worker.swap_max_mib }, [facts.readProcess(process.pid).cgroup]);
      record.resolveStarted(term);
      const exit = await exited;
      let observation = null;
      try { observation = { capturedBeforeCollect: true, oomKillCount: String(facts.readGroup(record.parentGroup).events.oom_kill), observedAt: new Date().toISOString() }; } catch {}
      await this._confirmExit(record);
      return { code: exit.exitCode, signal: exit.signal ? `SIG${exit.signal}` : null, ...(observation ? { scopeObservation: observation } : {}) };
    } catch (error) {
      record.rejectStarted(error);
      await this.stopGeneration(record.generationId);
      throw error;
    }
  }
  async _prepareSlice(record) {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (runtimeDir !== `/run/user/${process.getuid()}` || fs.lstatSync(runtimeDir).uid !== process.getuid()) facts.fail("user_runtime_identity_invalid");
    const unitDirectory = path.join(runtimeDir, "systemd", "user");
    fs.mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(unitDirectory) !== unitDirectory) facts.fail("user_unit_path_unsafe");
    record.unitFile = path.join(unitDirectory, record.parentSlice);
    fs.writeFileSync(record.unitFile, "[Unit]\nDescription=QuadWork owned generation observations\nStopWhenUnneeded=no\n[Slice]\nMemoryAccounting=yes\n", { flag: "wx", mode: 0o600 });
    record.unitInode = fs.lstatSync(record.unitFile).ino;
    await exec("systemctl", ["--user", "daemon-reload"], { timeout: 5000, maxBuffer: 16384 });
    await exec("systemctl", ["--user", "start", record.parentSlice], { timeout: 5000, maxBuffer: 16384 });
  }
  async _confirmExit(record) {
    if (record.cleaned) return;
    await boundedUntil(() => {
      try { const group = facts.readGroup(record.group); return group.pids.length === 0; }
      catch (error) { return error.code === "ENOENT"; }
    });
    reclaimGenerationTemp({ facts: record.tempFacts, generationId: record.generationId, confirmedProcessTreeExit: true });
    record.cleaned = true;
  }
  async waitForGeneration(generationId) { return STATE.get(this).records.get(generationId)?.done; }
  async stopGeneration(generationId) {
    const s = STATE.get(this), record = s.records.get(generationId);
    if (!record) return;
    if (record.setup) await record.setup.catch(() => {});
    if (record.group) {
      let live = false;
      try { live = facts.readGroup(record.group).pids.length !== 0; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (live) {
        if (facts.scopeGroup(`${record.unitName}.scope`) !== record.group) facts.fail("scope_identity_changed");
        await exec("systemctl", ["--user", "kill", "--signal=SIGKILL", "--kill-whom=all", `${record.unitName}.scope`], { timeout: 3000, maxBuffer: 16384 });
      }
      await this._confirmExit(record);
    } else if (record.term) {
      // Before scope creation only the exact owned node-pty child is signalled.
      try { record.term.kill("SIGKILL"); } catch {}
      // The scope may have appeared concurrently. Resolve and verify it first.
      try { record.group = facts.scopeGroup(`${record.unitName}.scope`); return this.stopGeneration(generationId); } catch (e) { if (e.check === "scope_identity_changed") throw e; }
    }
    if (record.unitFile) {
      await exec("systemctl", ["--user", "stop", record.parentSlice], { timeout: 3000, maxBuffer: 16384 });
      if (fs.lstatSync(record.unitFile).ino !== record.unitInode) facts.fail("unit_file_identity_changed");
      fs.unlinkSync(record.unitFile);
      record.unitFile = null;
    }
    if (!record.term && !record.cleaned) {
      reclaimGenerationTemp({ facts: record.tempFacts, generationId: record.generationId, confirmedProcessTreeExit: true });
      record.cleaned = true;
    }
    record.trace?.close();
    return { ok: true, owned: true };
  }
  ownsGeneration(generationId) { return STATE.get(this).records.has(generationId); }
  async runControlChild(file, args, options = {}) {
    const s = STATE.get(this);
    if (!s.proof || s.closed) facts.fail("containment_unavailable");
    const ids = { projectId: "control-plane", generationId: s.controlGeneration, operationId: crypto.randomBytes(12).toString("hex") };
    const unitName = createControlUnitBase(ids);
    s.pending.set(unitName, { options: { encoding: "utf8", timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...options } });
    try {
      const output = await s.controller.runControlChild({ ...ids, unitName, command: file, args, signal: options.signal });
      return { stdout: output.result.stdout, stderr: output.result.stderr };
    } finally { s.pending.delete(unitName); }
  }
  async shutdown() {
    const s = STATE.get(this); s.closed = true;
    const results = await Promise.allSettled([...s.records.keys()].map((id) => this.stopGeneration(id)));
    return { ok: results.every((row) => row.status === "fulfilled"), owned_generations: s.records.size };
  }
}
module.exports = { LinuxResourceLauncher, boundedUntil, dataRecords, checkProcessSet };

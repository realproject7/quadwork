"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pty = require("node-pty");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const { ResourceController, buildControlScopeInvocation } = require("./resource-controller");
const { createWorkerUnitBase, createControlUnitBase } = require("./resource-unit");
const { inspectTempRoot, createGenerationTemp, reclaimGenerationTemp } = require("./resource-temp");
const { runResourcePreflight, createReadOnlyProbes } = require("./resource-preflight");
const facts = require("./resource-linux-facts");
const { createDurableStoreFiles } = require("./durable-store-files");
const exec = promisify(execFile);
const STATE = new WeakMap();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class ResourceLockError extends Error { constructor(code, message) { super(message); this.code = code; this.check = "resource_admission_lock_unavailable"; } }
const lockFiles = createDurableStoreFiles({ fs, error: ResourceLockError, codes: Object.fromEntries(["options", "unreadable", "symlink_rejected", "insecure_permissions", "write_failed", "locked", "lock_unsafe", "lock_failed", "lock_acquire_changed", "lock_release_changed", "lock_release_failed"].map((code) => [code, `resource_${code}`])) });

async function boundedUntil(read, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do { const value = await read(); if (value) return value; await wait(25); } while (Date.now() < deadline);
  facts.fail("scope_observation_timeout");
}
function runtimeDirectory() {
  const root = `/run/user/${process.getuid()}`;
  if (process.env.XDG_RUNTIME_DIR !== root || fs.realpathSync(root) !== root || fs.lstatSync(root).uid !== process.getuid()) facts.fail("user_runtime_identity_invalid");
  const directory = path.join(root, "quadwork-resources");
  lockFiles.ensureDirectories([{ path: directory, mode: 0o700 }]);
  return directory;
}
function unitProperties(raw) {
  return Object.fromEntries(String(raw).trim().split("\n").map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
}
function absentUnitOutput(error) {
  const raw = error?.stdout;
  if (raw && unitProperties(raw).LoadState === "not-found" && !unitProperties(raw).ControlGroup) return raw;
  throw error;
}
function controlOptions(options, fallbackTimeout) {
  const timeout = options.timeout ?? fallbackTimeout, maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 110000 || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 32 * 1024 * 1024) facts.fail("control_bounds_invalid");
  return { ...options, timeout, maxBuffer };
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
  for (const [index, pid] of ready.children.entries()) {
    const child = facts.readProcess(pid);
    if (child.ppid !== ready.pid || child.cgroup !== group) facts.fail("descendant_cgroup_mismatch");
    const executable = path.basename(fs.readlinkSync(`/proc/${pid}/exe`));
    if (index === 1 ? executable !== "git" : executable !== path.basename(process.execPath)) facts.fail("descendant_executable_mismatch");
    if (index === 2 && (child.session !== child.pid || child.pgrp !== child.pid || child.pgrp === main.pgrp)) facts.fail("detached_descendant_unproven");
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
  ready() { const s = STATE.get(this); return s.proof && !s.closed && !s.cleanupFailed; }
  snapshot() { return STATE.get(this).controller.snapshot(); }
  async prepare() {
    const s = STATE.get(this);
    if (s.closed || s.cleanupFailed) return false;
    if (s.proof) return true;
    if (s.preparing) return s.preparing;
    s.preparing = (async () => {
      if (process.platform !== "linux") return false;
      // These read-only prerequisites cannot be replaced by config proof data.
      const probes = createReadOnlyProbes({ scopeProof: true });
      if (!runResourcePreflight({ runtimeResources: s.policy, probes, requestedWorkerScopes: 1 }).ok) return false;
      const version = facts.command("systemctl", ["--user", "show", "--property=Version", "--value"]);
      if (!(Number(/^(\d+)/.exec(version)?.[1]) >= 253)) return false;
      await this._prepareControlClass();
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
    const directory = runtimeDirectory();
    return lockFiles.withAsyncWriterLock(path.join(directory, "worker-admission"), () => this._spawnPty(spec), Date.now() + 15000);
  }
  async _spawnPty(spec) {
    const s = STATE.get(this);
    if (s.closed) facts.fail("server_shutting_down");
    if (!s.proof && spec.probe !== true) facts.fail("containment_unavailable");
    const preflight = runResourcePreflight({ runtimeResources: s.policy, probes: createReadOnlyProbes({ scopeProof: true }), requestedWorkerScopes: 1 });
    if (!preflight.ok) facts.fail("worker_capacity_or_limits_unavailable");
    // A replacement can retire the exact previous generation after its tree
    // has exited; the current generation's parent counter stays until stop.
    for (const record of s.records.values()) if (record.projectId === spec.projectId && record.exited && !record.retired) await this.stopGeneration(record.generationId);
    const unitName = createWorkerUnitBase(spec);
    if (s.pending.has(unitName) || s.records.has(spec.generationId)) facts.fail("scope_identity_collision");
    const tempFacts = inspectTempRoot({ tempRoot: s.policy.temp_root, minimumFreeBytes: s.policy.temp_min_free_mib * facts.MIB });
    if (!tempFacts.available) facts.fail("temp_unavailable");
    const temp = createGenerationTemp({ facts: tempFacts, generationId: spec.generationId });
    let resolveStarted, rejectStarted;
    const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const record = { ...spec, unitName, parentSlice: `quadwork-worker-group-${unitName.slice("quadwork-worker-".length)}.slice`, tempFacts, tempPath: temp.path || temp, resolveStarted, rejectStarted, term: null, group: null, done: null, cleaned: false };
    s.pending.set(unitName, record); s.records.set(spec.generationId, record);
    record.done = s.controller.runWorkerScope({ projectId: spec.projectId, generationId: spec.generationId, unitName, parentSlice: record.parentSlice, ...(spec.probe || spec.command === path.join(__dirname, "resource-staging-worker.js") ? { runtimeMaxSec: 90 } : {}), command: spec.command, args: spec.args, limits: { memoryHighMib: s.policy.worker.memory_high_mib, memoryMaxMib: s.policy.worker.memory_max_mib, swapMaxMib: s.policy.worker.swap_max_mib } });
    record.done.catch(async (error) => {
      try { await this.stopGeneration(spec.generationId); } catch { s.proof = false; }
      rejectStarted(error);
    }).finally(() => s.pending.delete(unitName));
    return started;
  }
  async _execute(invocation) {
    const s = STATE.get(this), record = s.pending.get(invocation.unitName);
    if (!record) facts.fail("scope_owner_missing");
    if (invocation.resourceClass === "control") return this._withControlSlot(() => this._executeControl(invocation, record), record.options.signal);
    record.setup = this._prepareSlice(record);
    await record.setup;
    if (s.closed) facts.fail("server_shutting_down");
    record.assertLaunchCurrent?.();
    const term = pty.spawn(invocation.file, invocation.args, { name: "xterm-256color", cols: 120, rows: 30, cwd: record.cwd, env: { ...record.env, TMPDIR: record.tempPath } });
    record.term = term;
    // Retain the native child exit before subscribing to output or awaiting
    // scope discovery. Early systemd-run failure still has this exact owner.
    record.nativeExit = new Promise((resolve) => term.onExit((exit) => { record.nativeExited = true; record.exited = true; resolve(exit); }));
    record.nativeIdentity = null;
    try { record.nativeIdentity = facts.readProcess(term.pid); } catch {}
    record.trace = dataRecords(term);
    try {
      const group = await boundedUntil(() => {
        if (record.nativeExited) facts.fail("native_exit_before_scope_observation");
        try { return facts.scopeGroup(`${invocation.unitName}.scope`); } catch { return null; }
      });
      record.group = group;
      record.parentGroup = path.posix.dirname(group);
      if (!record.parentGroup.endsWith(`/${record.parentSlice}`)) facts.fail("scope_parent_mismatch");
      facts.verifyWorkerGroup(group, { memoryHighMib: s.policy.worker.memory_high_mib, memoryMaxMib: s.policy.worker.memory_max_mib, swapMaxMib: s.policy.worker.swap_max_mib }, [facts.readProcess(process.pid).cgroup]);
      this._verifyAncestorBudget(group);
      // Publish terminal callbacks only after the controller has retained its
      // exact generation OOM/exit fact and confirmed tree exit. Other PTY
      // operations remain bound to the real native instance.
      const publicTerm = new Proxy(term, { get(target, key) {
        if (key === "onExit") return (listener) => {
          let active = true;
          const subscription = target.onExit((exit) => {
            const deliver = () => { if (active) listener(exit); };
            record.done.then(deliver, deliver).catch(() => {});
          });
          return { dispose() { active = false; subscription.dispose(); } };
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      record.resolveStarted(publicTerm);
      const exit = await record.nativeExit;
      let observation = null;
      try { observation = { capturedBeforeCollect: true, oomKillCount: String(facts.readGroup(record.parentGroup).events.oom_kill), observedAt: new Date().toISOString() }; } catch {}
      await this._confirmExit(record);
      return { code: exit.signal ? null : exit.exitCode, signal: exit.signal || null, ...(observation ? { scopeObservation: observation } : {}) };
    } catch (error) {
      // Keep the admission lock until cleanup completes or installs its
      // permanent uncertainty fence; callers cannot race a failed launch.
      await this.stopGeneration(record.generationId);
      record.rejectStarted(error);
      throw error;
    }
  }
  async _executeControl(invocation, record) {
      const s = STATE.get(this);
      if (s.closed || !s.proof || record.options.signal?.aborted) facts.fail("containment_unavailable");
      this._verifyControlClass();
      const args = [...invocation.args]; args.splice(args.indexOf("--"), 0, "-p", `RuntimeMaxSec=${Math.ceil(record.options.timeout / 1000) + 5}s`);
      const { input, ...options } = record.options;
      if (input !== undefined && (!Buffer.isBuffer(input) && typeof input !== "string" || Buffer.byteLength(input) > 16 * 1024 * 1024)) facts.fail("control_input_invalid");
      try {
        const output = await new Promise((resolve, reject) => {
          const child = execFile(invocation.file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
          record.child = child;
          child.stdin.on("error", () => {});
          child.stdin.end(input);
        });
        return { code: 0, signal: null, stdout: output.stdout, stderr: output.stderr };
      } finally {
        try { await this._cleanupControlScope(invocation.unitName); }
        catch (error) { s.proof = false; s.cleanupFailed = true; throw error; }
      }
  }
  _verifyAncestorBudget(group) {
    const { policy } = STATE.get(this), apiGroup = facts.readProcess(process.pid).cgroup;
    const allClassesMib = policy.api.memory_max_mib + policy.control.memory_max_mib + policy.max_worker_scopes * policy.worker.memory_max_mib;
    for (let parent = path.posix.dirname(group); parent !== "/"; parent = path.posix.dirname(parent)) {
      if (apiGroup === parent || apiGroup.startsWith(`${parent}/`)) {
        const raw = facts.text(path.join(facts.cgroupPath(parent), "memory.max")).trim();
        if (raw !== "max" && (!/^\d+$/.test(raw) || Number(raw) < allClassesMib * facts.MIB)) facts.fail("shared_ancestor_capacity_unavailable");
      }
    }
  }
  async _prepareControlClass() {
    const s = STATE.get(this); runtimeDirectory();
    const directory = path.join(process.env.XDG_RUNTIME_DIR, "systemd", "user");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory) facts.fail("user_unit_path_unsafe");
    const file = path.join(directory, "quadwork-control.slice");
    const content = `[Unit]\nDescription=QuadWork shared bounded control children\nStopWhenUnneeded=no\n[Slice]\nMemoryAccounting=yes\nMemoryMax=${s.policy.control.memory_max_mib}M\nMemorySwapMax=${s.policy.control.swap_max_mib}M\n# concurrency=${s.policy.control.max_concurrent_children}\n`;
    await lockFiles.withAsyncWriterLock(path.join(runtimeDirectory(), "control-policy"), async () => {
      try { fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 }); }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || facts.text(file) !== content) facts.fail("control_policy_owner_conflict");
      }
      await exec("systemctl", ["--user", "daemon-reload"], { timeout: 5000, maxBuffer: 16384 });
      await exec("systemctl", ["--user", "start", "quadwork-control.slice"], { timeout: 5000, maxBuffer: 16384 });
      this._verifyControlClass();
    });
  }
  _verifyControlClass() {
    const s = STATE.get(this), group = facts.command("systemctl", ["--user", "show", "quadwork-control.slice", "--property=ControlGroup", "--value"]);
    if (!group.endsWith("/quadwork-control.slice")) facts.fail("control_class_identity_changed");
    const limits = facts.readGroup(group);
    if (limits.memoryMax !== s.policy.control.memory_max_mib * facts.MIB || limits.swapMax !== s.policy.control.swap_max_mib * facts.MIB) facts.fail("control_limits_unavailable");
    this._verifyAncestorBudget(group);
  }
  async _withControlSlot(action, signal) {
    const s = STATE.get(this), root = runtimeDirectory(), deadline = Date.now() + 30000;
    do {
      if (s.closed || signal?.aborted) facts.fail("server_shutting_down");
      for (let slot = 0; slot < s.policy.control.max_concurrent_children; slot += 1) {
        let entered = false;
        try { return await lockFiles.withAsyncWriterLock(path.join(root, `control-slot-${slot}`), () => { entered = true; return action(); }, Date.now()); }
        catch (e) { if (entered || e.code !== "resource_locked") throw e; }
      }
      await wait(25);
    } while (Date.now() < deadline);
    facts.fail("control_capacity_exhausted");
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
    if (record.reclaiming) return record.reclaiming;
    record.reclaiming = (async () => { await boundedUntil(() => {
      try { const group = facts.readGroup(record.group); return group.pids.length === 0; }
      catch (error) { return error.code === "ENOENT"; }
    });
    reclaimGenerationTemp({ facts: record.tempFacts, generationId: record.generationId, confirmedProcessTreeExit: true });
    record.cleaned = true;
    })();
    return record.reclaiming;
  }
  async waitForGeneration(generationId) { return STATE.get(this).records.get(generationId)?.done; }
  async stopGeneration(generationId) {
    const s = STATE.get(this), record = s.records.get(generationId);
    if (!record) return;
    if (record.stopping) return record.stopping;
    record.stopping = this._stopGeneration(record).catch((error) => { s.proof = false; s.cleanupFailed = true; throw error; });
    return record.stopping;
  }
  async _waitNativeExit(record) {
    if (!record.nativeExit) facts.fail("native_exit_unconfirmed");
    let timer;
    try {
      await Promise.race([record.nativeExit, new Promise((_, reject) => {
        timer = setTimeout(() => { try { facts.fail("native_exit_unconfirmed"); } catch (e) { reject(e); } }, 3000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async _ownedUnitGroup(unit) {
    const result = await exec("systemctl", ["--user", "show", unit, "--property=Id,LoadState,ActiveState,ControlGroup"], { timeout: 2000, maxBuffer: 16384 }).catch((e) => ({ stdout: absentUnitOutput(e) }));
    const props = unitProperties(result.stdout);
    if (props.LoadState === "not-found" && !props.ControlGroup) return null;
    if (props.Id !== unit) facts.fail("scope_identity_changed");
    if (!props.ControlGroup && ["inactive", "failed"].includes(props.ActiveState)) return null;
    if (!props.ControlGroup?.endsWith(`/${unit}`)) facts.fail("scope_identity_changed");
    return facts.parseCgroup(`0::${props.ControlGroup}`);
  }
  async _confirmOwnedParentEmpty(record) {
    const group = await this._ownedUnitGroup(record.parentSlice);
    if (group === null) return;
    // Parent cgroup.procs alone excludes descendants. Inspect the complete
    // exact owned subtree, including a scope created during native shutdown.
    const queue = [facts.cgroupPath(group)]; let count = 0;
    while (queue.length) {
      const directory = queue.shift();
      if (++count > 64) facts.fail("owned_parent_observation_unbounded");
      try {
        if (facts.parsePids(facts.text(path.join(directory, "cgroup.procs"))).length) facts.fail("owned_parent_not_empty");
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) facts.fail("owned_parent_identity_changed");
          if (entry.isDirectory()) queue.push(path.join(directory, entry.name));
        }
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
  async _stopGeneration(record) {
    if (record.setup) await record.setup.catch(() => {});
    const earlyNative = !!record.term && !record.group;
    if (earlyNative) {
      // Signal only this still-identical native child. A missing identity is
      // not permission to signal a PID, but an already observed exit suffices.
      if (!record.nativeExited && record.nativeIdentity) {
        let current = null; try { current = facts.readProcess(record.term.pid); } catch {}
        if (current && record.nativeIdentity.pid === current.pid && record.nativeIdentity.startTime === current.startTime) {
          try { record.term.kill("SIGKILL"); } catch {}
        }
      }
      await this._waitNativeExit(record);
      const group = await this._ownedUnitGroup(`${record.unitName}.scope`);
      if (group !== null) {
        if (!path.posix.dirname(group).endsWith(`/${record.parentSlice}`)) facts.fail("scope_parent_mismatch");
        record.group = group;
      }
    }
    if (record.group) {
      let live = false;
      try { live = facts.readGroup(record.group).pids.length !== 0; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (live) {
        if (facts.scopeGroup(`${record.unitName}.scope`) !== record.group) facts.fail("scope_identity_changed");
        await exec("systemctl", ["--user", "kill", "--signal=SIGKILL", "--kill-whom=all", `${record.unitName}.scope`], { timeout: 3000, maxBuffer: 16384 });
      }
      if (record.term) await this._waitNativeExit(record);
      if (earlyNative) await this._confirmOwnedParentEmpty(record);
      await this._confirmExit(record);
    } else if (earlyNative) {
      await this._confirmOwnedParentEmpty(record);
    }
    if (record.unitFile) {
      await exec("systemctl", ["--user", "stop", record.parentSlice], { timeout: 3000, maxBuffer: 16384 });
      if (fs.lstatSync(record.unitFile).ino !== record.unitInode) facts.fail("unit_file_identity_changed");
      fs.unlinkSync(record.unitFile);
      record.unitFile = null;
    }
    if ((!record.term || earlyNative) && !record.cleaned) {
      reclaimGenerationTemp({ facts: record.tempFacts, generationId: record.generationId, confirmedProcessTreeExit: true });
      record.cleaned = true;
    }
    record.trace?.close(); record.retired = true;
    const records = STATE.get(this).records;
    const retired = [...records.values()].filter((entry) => entry.retired);
    for (const old of retired.slice(0, -100)) records.delete(old.generationId);
    return { ok: true, owned: true };
  }
  async _cleanupControlScope(unitName) {
    const unit = `${unitName}.scope`;
    const output = await exec("systemctl", ["--user", "show", unit, "--property=LoadState,ActiveState,ControlGroup"], { timeout: 2000, maxBuffer: 16384 }).catch((e) => ({ stdout: absentUnitOutput(e) }));
    const values = unitProperties(output.stdout);
    if (values.LoadState === "not-found" && !values.ControlGroup) return;
    if (!values.ControlGroup && ["inactive", "failed"].includes(values.ActiveState)) return;
    if (!values.ControlGroup?.endsWith(`/${unit}`)) facts.fail("control_scope_identity_changed");
    let pids; try { pids = facts.readGroup(values.ControlGroup).pids; } catch (e) { if (e.code === "ENOENT") return; throw e; }
    if (pids.length) try { await exec("systemctl", ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit], { timeout: 2000, maxBuffer: 16384 }); }
    catch (error) { try { if (facts.readGroup(values.ControlGroup).pids.length) throw error; } catch (e) { if (e.code !== "ENOENT") throw e; } }
    await boundedUntil(() => { try { return facts.readGroup(values.ControlGroup).pids.length === 0; } catch (e) { return e.code === "ENOENT"; } });
  }
  ownsGeneration(generationId) { return STATE.get(this).records.has(generationId); }
  async runControlChild(file, args, options = {}) {
    const s = STATE.get(this);
    if (!s.proof || s.closed) facts.fail("containment_unavailable");
    const ids = { projectId: "control-plane", generationId: s.controlGeneration, operationId: crypto.randomBytes(12).toString("hex") };
    const unitName = createControlUnitBase(ids);
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    const record = { resourceClass: "control", abort, options: { encoding: "utf8", ...controlOptions(options, 30000), signal } };
    s.pending.set(unitName, record);
    try {
      record.done = s.controller.runControlChild({ ...ids, unitName, command: file, args, signal });
      const output = await record.done;
      return { stdout: output.result.stdout, stderr: output.result.stderr };
    } finally { s.pending.delete(unitName); }
  }
  runControlChildSync(file, args, options = {}) {
    const s = STATE.get(this);
    if (!s.proof || s.closed) facts.fail("containment_unavailable");
    const limiter = s.controller.controlLimiter;
    if (limiter.active >= limiter.limit) facts.fail("control_capacity_exhausted");
    const ids = { projectId: "control-plane", generationId: s.controlGeneration, operationId: crypto.randomBytes(12).toString("hex") };
    const invocation = buildControlScopeInvocation({ ...ids, unitName: createControlUnitBase(ids), controlClassName: "quadwork-control.slice", command: file, args });
    options = controlOptions(options, 10000);
    invocation.args.splice(invocation.args.indexOf("--"), 0, "-p", `RuntimeMaxSec=${Math.ceil(options.timeout / 1000) + 5}s`);
    const action = () => {
    this._verifyControlClass();
    limiter.active += 1;
    try { return execFileSync(invocation.file, invocation.args, options); }
    finally {
      try {
        const unit = `${invocation.ids.unitName}.scope`;
        let raw;
        try { raw = execFileSync("systemctl", ["--user", "show", unit, "--property=LoadState,ActiveState,ControlGroup"], { encoding: "utf8", timeout: 2000, maxBuffer: 16384 }); }
        catch (e) { raw = absentUnitOutput(e); }
        const props = unitProperties(raw);
        if (props.ControlGroup) {
          if (!props.ControlGroup.endsWith(`/${unit}`)) facts.fail("control_scope_identity_changed");
          let live = false;
          try { live = facts.readGroup(props.ControlGroup).pids.length !== 0; } catch (e) { if (e.code !== "ENOENT") throw e; }
          if (live) try { execFileSync("systemctl", ["--user", "stop", unit], { timeout: 3000, maxBuffer: 16384 }); }
          catch (error) { try { if (facts.readGroup(props.ControlGroup).pids.length) throw error; } catch (e) { if (e.code !== "ENOENT") throw e; } }
          try { if (facts.readGroup(props.ControlGroup).pids.length) facts.fail("control_cleanup_incomplete"); } catch (e) { if (e.code !== "ENOENT") throw e; }
        } else if (props.LoadState !== "not-found" && !["inactive", "failed"].includes(props.ActiveState)) facts.fail("control_cleanup_unproven");
      } catch (e) { s.proof = false; s.cleanupFailed = true; throw e; }
      finally { limiter.active -= 1; }
    }
    };
    for (let slot = 0; slot < s.policy.control.max_concurrent_children; slot += 1) {
      let entered = false;
      try { return lockFiles.withWriterLock(path.join(runtimeDirectory(), `control-slot-${slot}`), () => { entered = true; return action(); }); }
      catch (e) { if (entered || e.code !== "resource_locked") throw e; }
    }
    facts.fail("control_capacity_exhausted");
  }
  async shutdown() {
    const s = STATE.get(this); s.closed = true;
    const controls = [...s.pending.values()].filter((record) => record.resourceClass === "control");
    for (const record of controls) record.abort.abort();
    const generations = [...s.records.values()];
    const results = await Promise.allSettled(generations.map((record) => this.stopGeneration(record.generationId)));
    await Promise.allSettled([...controls, ...generations].map((record) => record.done));
    if (s.preparing) await s.preparing;
    return { ok: results.every((row) => row.status === "fulfilled") && !s.cleanupFailed, owned_generations: generations.length };
  }
}
module.exports = { LinuxResourceLauncher, boundedUntil, dataRecords, checkProcessSet };

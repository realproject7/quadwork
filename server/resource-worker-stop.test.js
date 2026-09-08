"use strict";

// #1093: actual launcher and native Node PTY/descendant, controlled OS facts.
// This tests cleanup authority and ordering, not positive Linux containment.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const util = require("node:util");
const nativePty = require("node-pty");
const realFacts = require("./resource-linux-facts");
const modulePath = require.resolve("./resource-linux-launcher");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scenario(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-worker-stop-"));
  const originalLoad = Module._load, originalRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  let term, childPid, nativeExited = false, temp, parentName, group, launched = false, stopCalls = 0, killCalls = 0;
  const unitFiles = new Map(), signalError = new Error("Failed to send signal SIGKILL to auxiliary processes: Invalid argument");
  const fakeFs = {
    realpathSync: (p) => p, lstatSync: (p) => ({ uid: process.getuid(), ino: unitFiles.get(p)?.ino || 1 }),
    mkdirSync() {},
    writeFileSync(p, bytes) { unitFiles.set(p, { ino: 10, bytes }); parentName = path.basename(p); },
    unlinkSync(p) { assert.ok(nativeExited); unitFiles.delete(p); },
    readdirSync(p) { return p.endsWith(`/${parentName}`) ? [{ name: "nested.scope", isDirectory: () => true, isSymbolicLink: () => false }] : []; },
  };
  const fakeExec = function () { throw new Error("unexpected callback exec"); };
  fakeExec[util.promisify.custom] = async (_file, args) => {
    if (args.includes("show")) {
      const unit = args[args.indexOf("show") + 1];
      const id = mode === "changed-parent" && launched ? "foreign.slice" : unit;
      return { stdout: `Id=${id}\nLoadState=loaded\nActiveState=active\nControlGroup=/owned/${unit}\n` };
    }
    if (args.includes("kill")) {
      killCalls++;
      assert.equal(args.at(-1), path.posix.basename(group));
      assert.ok(args.includes("--kill-whom=all") && args.includes("--signal=SIGKILL"));
      if (mode !== "live-native") {
        term.kill("SIGKILL");
        if (mode !== "remaining-descendant") process.kill(childPid, "SIGKILL");
      }
      throw signalError;
    }
    if (args.includes("stop")) { assert.equal(args.at(-1), parentName); stopCalls++; }
    return { stdout: "", stderr: "" };
  };
  const mocks = {
    fs: fakeFs,
    "child_process": { execFile: fakeExec, execFileSync() { throw new Error("unexpected sync command"); } },
    "node-pty": { spawn() {
      const script = 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}); console.log("CHILD="+c.pid); setInterval(()=>{},1000);';
      term = nativePty.spawn(process.execPath, ["-e", script], { name: "xterm", cols: 80, rows: 24, cwd: root, env: { ...process.env } });
      let output = "";
      term.onData((data) => { output += data; const found = /CHILD=(\d+)/.exec(output); if (found) childPid = Number(found[1]); });
      term.onExit(() => { nativeExited = true; });
      return new Proxy(term, { get(target, key) {
        if (key === "onExit" && mode === "unknown-exit") return () => ({ dispose() {} });
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    } },
    "./resource-preflight": { runResourcePreflight: () => ({ ok: true }), createReadOnlyProbes: () => ({}) },
    "./resource-temp": {
      inspectTempRoot: () => ({ available: true }),
      createGenerationTemp({ generationId }) { temp = path.join(root, generationId); fs.mkdirSync(temp); fs.writeFileSync(path.join(temp, "owned"), "owned"); return { path: temp }; },
      reclaimGenerationTemp() { assert.ok(nativeExited); assert.notEqual(mode, "remaining-descendant"); assert.notEqual(mode, "changed-parent"); fs.rmSync(temp, { recursive: true }); },
    },
    "./durable-store-files": { createDurableStoreFiles: () => ({ ensureDirectories() {}, withAsyncWriterLock: (_p, fn) => fn() }) },
    "./resource-linux-facts": {
      ...realFacts,
      readProcess: (pid) => ({ pid, startTime: "owned-native-identity", cgroup: "/api" }),
      scopeGroup(unit) { if (launched && mode === "changed-scope") return `/foreign/${unit}`; return group = `/owned/${parentName}/${unit}`; },
      verifyWorkerGroup() {},
      readGroup: (p) => ({ pids: p === group && !nativeExited ? [term.pid] : [], events: { oom_kill: 0 } }),
      text: (p) => mode === "remaining-descendant" && p.endsWith("/nested.scope/cgroup.procs") ? `${childPid}\n` : "",
    },
  };
  Module._load = function (request, parent, main) {
    if (parent?.filename === modulePath && Object.hasOwn(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, main);
  };
  delete require.cache[modulePath];
  try {
    const { LinuxResourceLauncher } = require(modulePath);
    const launcher = new LinuxResourceLauncher({ temp_root: root, temp_min_free_mib: 1, max_worker_scopes: 3, api: { memory_max_mib: 640 }, worker: { memory_high_mib: 96, memory_max_mib: 128, swap_max_mib: 16 }, control: { memory_max_mib: 256, max_concurrent_children: 2 } });
    await launcher.spawnPty({ projectId: "stop-test", generationId: "stop-generation", probe: true, command: process.execPath, args: [], cwd: root, env: {} });
    const deadline = Date.now() + 3000;
    while (!childPid && Date.now() < deadline) await pause(10);
    assert.ok(childPid, "actual owned native descendant started");
    launched = true;
    const attempts = await Promise.allSettled([launcher.stopGeneration("stop-generation"), launcher.stopGeneration("stop-generation")]);
    assert.equal(killCalls, mode === "changed-scope" ? 0 : 1, "joined stop attempts never signal twice or signal a changed scope");
    if (mode === "confirmed-exit") {
      for (const result of attempts) { assert.equal(result.status, "fulfilled"); assert.deepEqual(result.value, { ok: true, owned: true }); }
      assert.equal(nativeExited, true);
      assert.equal(fs.existsSync(temp), false);
      assert.equal(unitFiles.size, 0);
      assert.equal(stopCalls, 1);
    } else {
      for (const result of attempts) assert.equal(result.status, "rejected");
      assert.equal(attempts[0].reason, attempts[1].reason, "joined callers retain the same failure");
      if (mode !== "changed-scope") assert.equal(attempts[0].reason.cause, signalError, "failed observation retains signal-command evidence");
      assert.equal(fs.existsSync(temp), true, "uncertainty retains generation temp even on automatic native exit");
      assert.equal(unitFiles.size, 1);
      assert.equal(stopCalls, 0);
      assert.equal(await launcher.prepare(), false);
    }
    console.log(`PASS worker stop ${mode}: real PTY/descendant, exact ownership, joined attempts and recursive cleanup`);
  } finally {
    Module._load = originalLoad; delete require.cache[modulePath];
    if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = originalRuntime;
    if (term && !nativeExited) term.kill("SIGKILL");
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    const deadline = Date.now() + 3000;
    while (term && !nativeExited && Date.now() < deadline) await pause(10);
    assert.ok(!term || nativeExited);
    fs.rmSync(root, { recursive: true });
  }
}
(async () => { for (const mode of ["confirmed-exit", "remaining-descendant", "changed-scope", "changed-parent", "unknown-exit", "live-native"]) await scenario(mode); })().catch((e) => { console.error(e); process.exitCode = 1; });

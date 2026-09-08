"use strict";

// #1082: actual launcher + real native PTY child, with controlled systemd/proc
// observations. This proves cleanup ordering, not Linux containment support.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const util = require("node:util");
const nativePty = require("node-pty");
const realFacts = require("./resource-linux-facts");
const modulePath = require.resolve("./resource-linux-launcher");

async function scenario(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-early-cleanup-"));
  const originalLoad = Module._load, originalRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  let term, nativeExited = false, temp, parentName, stopCalls = [], nativeSignals = [];
  const unitFiles = new Map();
  const fakeFs = {
    realpathSync: (p) => p, lstatSync: (p) => ({ uid: process.getuid(), ino: unitFiles.get(p)?.ino || 1 }),
    mkdirSync() {},
    writeFileSync(p, bytes) { unitFiles.set(p, { ino: 10, bytes }); parentName = path.basename(p); },
    unlinkSync(p) { assert.ok(nativeExited, "unit cleanup follows actual native exit"); unitFiles.delete(p); },
    readdirSync(p) { return mode === "parent-descendant" && !p.endsWith("/nested.scope") ? [{ name: "nested.scope", isDirectory: () => true, isSymbolicLink: () => false }] : []; },
  };
  const fakeExec = function () { throw new Error("callback exec is outside this scenario"); };
  fakeExec[util.promisify.custom] = async (_file, args) => {
    if (args.includes("show")) {
      const unit = args[args.indexOf("show") + 1];
      if (mode === "ambiguous-scope" && unit.endsWith(".scope")) { const e = new Error("observation denied"); e.code = "EACCES"; throw e; }
      if (unit.endsWith(".scope")) return { stdout: `Id=${unit}\nLoadState=not-found\nActiveState=inactive\nControlGroup=\n` };
      return { stdout: `Id=${unit}\nLoadState=loaded\nActiveState=active\nControlGroup=/owned/${unit}\n` };
    }
    if (args.includes("stop")) stopCalls.push(args.at(-1));
    return { stdout: "", stderr: "" };
  };
  const mocks = {
    fs: fakeFs,
    "child_process": { execFile: fakeExec, execFileSync() { throw new Error("unexpected sync command"); } },
    "node-pty": { spawn() {
      term = nativePty.spawn(process.execPath, ["-e", "process.exit(17)"], { name: "xterm", cols: 80, rows: 24, cwd: root, env: { ...process.env } });
      term.onExit(() => { nativeExited = true; });
      const realOnExit = term.onExit.bind(term), realKill = term.kill.bind(term);
      return new Proxy(term, { get(target, key) {
        if (key === "onExit") return mode === "missing-native-exit" ? () => ({ dispose() {} }) : realOnExit;
        if (key === "kill") return (signal) => { nativeSignals.push([term.pid, signal]); return realKill(signal); };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    } },
    "./resource-preflight": { runResourcePreflight: () => ({ ok: true }), createReadOnlyProbes: () => ({}) },
    "./resource-temp": {
      inspectTempRoot: () => ({ available: true }),
      createGenerationTemp({ generationId }) { temp = path.join(root, generationId); fs.mkdirSync(temp); fs.writeFileSync(path.join(temp, "owned"), "owned"); return { path: temp }; },
      reclaimGenerationTemp() { assert.ok(nativeExited, "temp reclaim follows actual native exit"); fs.rmSync(temp, { recursive: true }); },
    },
    "./durable-store-files": { createDurableStoreFiles: () => ({ ensureDirectories() {}, withAsyncWriterLock: (_p, fn) => fn() }) },
    "./resource-linux-facts": {
      ...realFacts,
      readProcess: (pid) => { if (nativeExited) { const e = new Error("native child exited"); e.code = "ENOENT"; throw e; } return { pid, startTime: "controlled-native-identity", cgroup: "/api" }; },
      scopeGroup() { throw new Error("scope never appeared"); },
      text: (p) => mode === "parent-descendant" && p.includes("nested.scope") ? `${term.pid}\n` : "",
    },
  };
  Module._load = function (request, parent, main) {
    if (parent?.filename === modulePath && Object.hasOwn(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, main);
  };
  delete require.cache[modulePath];
  try {
    const { LinuxResourceLauncher } = require(modulePath);
    const launcher = new LinuxResourceLauncher({ temp_root: root, temp_min_free_mib: 1, worker: { memory_high_mib: 96, memory_max_mib: 128, swap_max_mib: 16 }, control: { max_concurrent_children: 2 } });
    const launched = launcher.spawnPty({ projectId: "early-test", generationId: "early-generation", probe: true, command: process.execPath, args: [], cwd: root, env: {} });
    await assert.rejects(launched);
    if (mode === "absent-scope") {
      assert.deepEqual(await launcher.stopGeneration("early-generation"), { ok: true, owned: true });
      assert.equal(nativeExited, true);
      assert.equal(fs.existsSync(temp), false);
      assert.deepEqual(stopCalls, [parentName]);
      assert.equal(unitFiles.size, 0);
    } else {
      await assert.rejects(launcher.stopGeneration("early-generation"));
      assert.equal(fs.existsSync(temp), true, "uncertainty preserves generation temp");
      assert.equal(unitFiles.size, 1, "uncertainty preserves exact unit ownership");
      assert.equal(await launcher.prepare(), false, "uncertain cleanup fences future readiness");
      assert.equal((await launcher.shutdown()).ok, false);
    }
    assert.ok(nativeSignals.every(([pid, signal]) => pid === term.pid && signal === "SIGKILL"));
    console.log(`PASS early cleanup ${mode}: real child exit, exact unit/temp ownership and fail-closed observations`);
  } finally {
    Module._load = originalLoad; delete require.cache[modulePath];
    if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = originalRuntime;
    if (term && !nativeExited) term.kill("SIGKILL");
    const deadline = Date.now() + 3000;
    while (term && !nativeExited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!term || nativeExited, "test-owned native child must exit before test cleanup");
    fs.rmSync(root, { recursive: true });
  }
}
(async () => { for (const mode of ["absent-scope", "ambiguous-scope", "parent-descendant", "missing-native-exit"]) await scenario(mode); })().catch((e) => { console.error(e); process.exitCode = 1; });

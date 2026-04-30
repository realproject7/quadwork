// #629: patchCrashTimeout tests. Plain node:assert — run with
// `node server/install-agentchattr.patchCrashTimeout.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { patchCrashTimeout } = require("./install-agentchattr");

const UNPATCHED_APP_PY = [
  "import time",
  "",
  "# Crash timeout: if a wrapper hasn't heartbeated for 60s,",
  "# consider it dead and deregister.",
  "_CRASH_TIMEOUT = 15",
  "",
  "def check_heartbeats():",
  "    now = time.time()",
  "    for name, last_seen in list(_heartbeats.items()):",
  "        if last_seen > 0 and now - last_seen > _CRASH_TIMEOUT:",
  '            log.info(f"Crash timeout: deregistering {name} (no heartbeat for {_CRASH_TIMEOUT}s)")',
].join("\n");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qw-test-629-"));

function setup(content) {
  const dir = fs.mkdtempSync(path.join(tmpDir, "ac-"));
  if (content !== undefined) {
    fs.writeFileSync(path.join(dir, "app.py"), content);
  }
  return dir;
}

// 1) Patches _CRASH_TIMEOUT from 15 to 120
{
  const dir = setup(UNPATCHED_APP_PY);
  patchCrashTimeout(dir);
  const result = fs.readFileSync(path.join(dir, "app.py"), "utf-8");
  assert.ok(result.includes("_CRASH_TIMEOUT = 120"), "timeout patched to 120");
  assert.ok(!result.includes("_CRASH_TIMEOUT = 15"), "old value removed");
  assert.ok(result.includes("heartbeated for 120s"), "comment updated");
  assert.ok(!result.includes("heartbeated for 60s"), "old comment removed");
}

// 2) Idempotent — already-patched file is untouched
{
  const dir = setup(UNPATCHED_APP_PY.replace("_CRASH_TIMEOUT = 15", "_CRASH_TIMEOUT = 120")
    .replace("heartbeated for 60s", "heartbeated for 120s"));
  const before = fs.readFileSync(path.join(dir, "app.py"), "utf-8");
  patchCrashTimeout(dir);
  const after = fs.readFileSync(path.join(dir, "app.py"), "utf-8");
  assert.equal(before, after, "already-patched file unchanged");
}

// 3) No app.py — no crash
{
  const dir = setup();
  patchCrashTimeout(dir);
  assert.ok(!fs.existsSync(path.join(dir, "app.py")), "no file created");
}

// 4) Null/undefined dir — no crash
{
  patchCrashTimeout(null);
  patchCrashTimeout(undefined);
}

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("patchCrashTimeout: all tests passed");

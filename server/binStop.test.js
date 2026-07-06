// #972: `quadwork stop` PID handling. The old stopPid did
// `process.kill(parseInt(raw))` with no validation, so a corrupt "0" PID file
// meant process.kill(0) — which signals the CALLER's whole process group, i.e.
// `quadwork stop` would try to kill itself. And the unlink ran outside the try,
// so one failed delete aborted the rest of cmdStop. This locks in the guard.
//
// Plain node:assert script — run with `node server/binStop.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `bin-stop-${process.pid}-${Date.now()}`);
const CONFIG_DIR = path.join(TMP, ".quadwork");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

// bin/quadwork.js computes CONFIG_DIR from os.homedir() at require time — point
// it at the temp dir before requiring. (The CLI dispatch is behind a
// require.main guard, so requiring the module just exposes the helpers.)
const origHome = os.homedir;
os.homedir = () => TMP;
process.on("exit", () => { os.homedir = origHome; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const { sanitizePid, stopPid } = require("../bin/quadwork");

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log(`  PASS: ${m}`); };
const writePid = (name, content) => fs.writeFileSync(path.join(CONFIG_DIR, name), content);
const pidExists = (name) => fs.existsSync(path.join(CONFIG_DIR, name));

// ── sanitizePid: the actual guard ────────────────────────────────────────────
ok(sanitizePid("0") === null, "sanitizePid rejects 0 (process.kill(0) signals the caller's group)");
ok(sanitizePid("-1") === null, "sanitizePid rejects negatives (kill(-n) targets a process group)");
ok(sanitizePid("abc") === null, "sanitizePid rejects non-numeric");
ok(sanitizePid("") === null, "sanitizePid rejects empty");
ok(sanitizePid("   ") === null, "sanitizePid rejects whitespace-only");
ok(sanitizePid("12.5") === null, "sanitizePid rejects non-integers");
ok(sanitizePid(" 4242 ") === 4242, "sanitizePid accepts a positive integer (trimmed)");

// ── stopPid: never signal on a corrupt PID; always clean the file ────────────
const killed = [];
const realKill = process.kill;
process.kill = (pid, sig) => { killed.push({ pid, sig }); }; // record, never actually signal

// corrupt "0"
writePid("server.pid", "0");
let r = stopPid("Server", "server.pid");
ok(killed.length === 0, "corrupt PID (0) → process.kill is NEVER called");
ok(!pidExists("server.pid"), "corrupt PID file is deleted");
ok(r === false, "corrupt PID → stopPid returns false (nothing stopped)");

// garbage "abc"
writePid("server.pid", "abc\n");
stopPid("Server", "server.pid");
ok(killed.length === 0, "garbage PID (abc) → still no process.kill, no group signal");
ok(!pidExists("server.pid"), "garbage PID file is deleted");

// valid PID → SIGTERM attempted, file removed
writePid("server.pid", "4242");
r = stopPid("Server", "server.pid");
ok(killed.some((k) => k.pid === 4242 && k.sig === "SIGTERM"), "valid PID → process.kill(pid, SIGTERM) called");
ok(!pidExists("server.pid"), "valid PID file removed after stop");
ok(r === true, "valid PID → stopPid returns true");

// missing file → no-op
killed.length = 0;
r = stopPid("Server", "does-not-exist.pid");
ok(r === false && killed.length === 0, "missing PID file → returns false, no kill");

process.kill = realKill;
console.log(`\n${passed} passed`);
console.log("server/binStop.test.js: all assertions passed");
process.exit(0);

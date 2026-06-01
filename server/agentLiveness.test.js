"use strict";

// #910: isPtyAlive is the watchdog's liveness probe — it must report a session
// whose process has exited as dead so the dashboard never shows a stale
// `running`. QUADWORK_SKIP_LISTEN + a temp HOME let us require the server module
// for the exported helper without starting the server (see #905).

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_HOME = path.join(os.tmpdir(), `quadwork-liveness-test-${process.pid}`);
process.env.HOME = TMP_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";
fs.mkdirSync(path.join(TMP_HOME, ".quadwork"), { recursive: true });
fs.writeFileSync(path.join(TMP_HOME, ".quadwork", "config.json"), JSON.stringify({ projects: [] }));

const { isPtyAlive } = require("./index");

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

// A live process — our own pid — is alive.
assert(isPtyAlive({ pid: process.pid }) === true, "isPtyAlive: own pid → alive");

// A pid that does not exist → dead (process.kill throws ESRCH).
assert(isPtyAlive({ pid: 2147483646 }) === false, "isPtyAlive: nonexistent pid → dead");

// Defensive: no term / no pid → not alive (so a registration-failed session
// isn't treated as running).
assert(isPtyAlive(null) === false, "isPtyAlive: null term → not alive");
assert(isPtyAlive({}) === false, "isPtyAlive: term without pid → not alive");

try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

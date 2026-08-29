// Package entrypoint contract for the local-first review gate.
// Plain node:assert script — run with `node server/local-review-entrypoint.test.js`.

"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const entry = fs.readFileSync(path.join(ROOT, "bin", "quadwork.js"), "utf8");

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  PASS: ${message}`);
}

ok(pkg.bin?.quadwork === "./bin/quadwork.js", "the published `quadwork` bin routes through the compatibility entrypoint");
ok(entry.includes('process.argv[2] === "review"'), "the entrypoint recognizes the local-review command without changing the legacy CLI parser");
ok(entry.includes('require("../server/local-review")'), "the review command reaches the exact-SHA gate module");
ok(entry.includes("installProtocolOverlay()"), "every normal CLI/start invocation migrates the managed role protocol first");
ok(entry.includes("Module.runMain()") && entry.includes("quadwork-legacy.js"), "non-review commands execute the existing CLI in-process");
ok(!entry.includes("spawn(") && !entry.includes("spawnSync("), "the wrapper does not leave a second long-lived process around `quadwork start`");
ok(pkg.files.includes("docs/local-first-review.md"), "the npm package ships the operator-facing protocol documentation");

const imported = require(path.join(ROOT, "bin", "quadwork.js"));
ok(typeof imported.sanitizePid === "function" && typeof imported.stopPid === "function", "requiring the wrapper preserves the legacy helper exports");

const probeHome = fs.mkdtempSync(path.join(require("os").tmpdir(), "quadwork-entrypoint-probe-"));
const legacyProbe = spawnSync(process.execPath, [path.join(ROOT, "bin", "quadwork.js"), "__quadwork_wrapper_probe__"], {
  encoding: "utf8",
  env: { ...process.env, HOME: probeHome },
});
try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch {}
ok(legacyProbe.status !== 0 && legacyProbe.stdout.includes("Usage: quadwork <command>"), "a non-review command is dispatched through the real legacy main program");

console.log(`\n${passed} passed`);
console.log("server/local-review-entrypoint.test.js: all assertions passed");

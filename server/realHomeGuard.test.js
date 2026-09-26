"use strict";

// #1188: the runner guard itself. A copy of server/run-tests.js and its preload
// runs fixture test files against a fake operator HOME whose ~/.quadwork holds
// a config. Every offending fixture swallows its error and exits 0; the runner
// must still fail it, name what it touched, and leave the config unchanged.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.platform === "win32") {
  console.log("  SKIP: POSIX stand-in gh and POSIX paths in the runner output (not run on Windows)");
  console.log("\n0 passed, 0 failed\n");
  process.exit(0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-real-home-guard-")));
process.on("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
const serverDir = path.join(root, "server");
fs.mkdirSync(path.join(serverDir, "__tests__"), { recursive: true });
fs.copyFileSync(path.join(__dirname, "run-tests.js"), path.join(serverDir, "run-tests.js"));
fs.copyFileSync(path.join(__dirname, "__tests__", "real-home-guard.js"), path.join(serverDir, "__tests__", "real-home-guard.js"));

const operatorHome = path.join(root, "operator-home");
const operatorConfig = path.join(operatorHome, ".quadwork", "config.json");
fs.mkdirSync(path.dirname(operatorConfig), { recursive: true });
fs.writeFileSync(operatorConfig, "{\"operator\":true}\n");
const before = fs.statSync(operatorConfig).mtimeMs;

const swallow = "const t = (fn) => { try { fn(); } catch {} };";
const GH_TOKEN_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const fixtures = {
  // The ambient HOME is the runner's throwaway one: outside the runner it is
  // the operator's. Its .quadwork is absent and must stay absent.
  "1-ambient": `${swallow} const fs = require("fs"), path = require("path"), q = path.join(require("os").homedir(), ".quadwork");
    t(() => fs.mkdirSync(path.join(q, "p"), { recursive: true })); t(() => fs.readFileSync(path.join(q, "config.json")));`,
  // A refused promisified call rejects the way a failed call does; it does not
  // throw (that would exit 3).
  "2-gh": `${swallow} const cp = require("child_process");
    t(() => cp.execFileSync("gh", ["api", "rate_limit"])); t(() => cp.execSync("gh from-shell", { stdio: "ignore" }));
    try { require("util").promisify(cp.execFile)("gh", ["promisified"]).catch(() => {}); } catch { process.exitCode = 3; }`,
  // A gh call recorded after its file exited is still charged to that file.
  "3-late": `require("child_process").spawn("sh", ["-c", "sleep 0.3; gh late"], { detached: true, stdio: "ignore" }).unref();`,
  // Files run in name order. Besides its own checks, this file's timer keeps
  // the run going until 3-late's delayed gh has run, before the final sweep.
  "4-operator": `${swallow} const fs = require("fs"), file = process.env.QW_GUARD_OPERATOR_CONFIG;
    t(() => fs.writeFileSync(file, "{}")); t(() => fs.rmSync(require("path").dirname(file), { recursive: true }));
    fs.promises.readFile(file).catch(() => {}); setTimeout(() => {}, 1000);`,
  // A sibling name is not the guarded directory.
  "5-clean": `require("fs").readFileSync(__filename);
    require("child_process").spawnSync("true", [require("path").join(require("os").homedir(), ".quadwork-sibling")]);`,
  // A shell the preload cannot load into creates ~/.quadwork in the HOME.
  "6-shell": `require("child_process").execFileSync("sh", ["-c", "mkdir \\"$HOME/.quadwork\\""]);`,
  // The runner's gh tokens never reach a test, and gh's config dir is in the
  // throwaway HOME whatever the runner had.
  "7-env": `const inHome = String(process.env.GH_CONFIG_DIR).startsWith(require("os").homedir() + require("path").sep);
    process.exit(${JSON.stringify(GH_TOKEN_ENV)}.some((key) => key in process.env) || !inHome ? 1 : 0);`,
};
for (const [name, source] of Object.entries(fixtures)) fs.writeFileSync(path.join(serverDir, `${name}.test.js`), source);

const run = spawnSync(process.execPath, [path.join(serverDir, "run-tests.js")], {
  cwd: root,
  encoding: "utf8",
  timeout: 30_000,
  env: {
    ...process.env,
    ...Object.fromEntries([...GH_TOKEN_ENV, "GH_CONFIG_DIR"].map((key) => [key, "fixture"])),
    HOME: operatorHome,
    USERPROFILE: operatorHome,
    QW_GUARD_OPERATOR_CONFIG: operatorConfig,
  },
});
const out = run.stdout;
const verdict = (name) => out.split("\n").filter((line) => line.startsWith(`▶ server/${name}.test.js … `));

assert.equal(run.status, 1, out + run.stderr);
assert.match(verdict("1-ambient")[0], /FAIL \(exit 0; guard: 2 /);
assert.match(out, /#1188 refused fs\.mkdirSync ~\/\.quadwork\/p\n/);
assert.match(out, /#1188 refused fs\.readFileSync ~\/\.quadwork\/config\.json\n/);
const ambientDetails = out.slice(out.indexOf("▼ server/1-ambient.test.js"), out.indexOf("▼ server/", out.indexOf("▼ server/1-ambient.test.js") + 1));
assert.doesNotMatch(ambientDetails, /created ~\/\.quadwork/, "the absent ambient .quadwork stays absent");

assert.match(verdict("2-gh")[0], /FAIL \(exit 0; guard: 3 /);
assert.match(out, /#1188 refused child_process\.execFileSync \(gh\) \S+\/gh api rate_limit\n/);
assert.match(out, /#1188 ran gh from-shell\n/);
assert.match(out, /#1188 refused child_process\.execFile \(gh\) \S+\/gh promisified\n/);
assert.deepEqual(verdict("3-late").map((line) => line.replace(/.* … /, "")), ["PASS", "FAIL (guard: 1 finding(s) after the file exited)"]);
assert.match(out, /#1188 ran gh late\n/);
assert.match(verdict("6-shell")[0], /FAIL \(exit 0; guard: 1 /);
assert.match(out, /#1188 created ~\/\.quadwork\n/);

assert.match(verdict("4-operator")[0], /FAIL \(exit 0; guard: 3 /);
for (const op of ["fs.writeFileSync", "fs.promises.readFile"]) assert.ok(out.includes(`#1188 refused ${op} ${operatorConfig}\n`), op);
assert.ok(out.includes(`#1188 refused fs.rmSync ${path.dirname(operatorConfig)}\n`));
assert.equal(fs.readFileSync(operatorConfig, "utf8"), "{\"operator\":true}\n", "the operator config bytes are unchanged");
assert.equal(fs.statSync(operatorConfig).mtimeMs, before, "the operator config was never written");

assert.deepEqual(verdict("5-clean"), ["▶ server/5-clean.test.js … PASS"]);
assert.deepEqual(verdict("7-env"), ["▶ server/7-env.test.js … PASS"]);
console.log("realHomeGuard.test.js: PASS (refused and charged: ambient HOME, operator HOME, gh, promisified gh, late gh, shell-made ~/.quadwork; clean file and sibling name pass; gh tokens stripped, gh config dir in HOME)");

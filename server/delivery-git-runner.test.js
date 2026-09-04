"use strict";

// #1066: the fixed Git runner server/index.js injects into the Delivery
// Candidate chain.  Fixed program and argv with no shell, stdin fed then
// closed, a real bounded child timeout, failure resolved rather than thrown,
// and a loop that keeps turning while a call runs.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES, runDeliveryGit } = require("./delivery-git-runner");

function git(cwd, args, input) { return execFileSync("git", args, { cwd, encoding: "utf8", input, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }).trim(); }
function request(cwd, args, extra = {}) { return { version: 1, cwd, args, timeout_ms: 5000, ...extra }; }
function throwsInvalid(fn) { assert.throws(fn, (error) => error instanceof TypeError && /delivery Git runner/.test(error.message)); }

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-delivery-git-runner-"));
  const repository = path.join(directory, "web");
  try {
    fs.mkdirSync(repository);
    git(repository, ["init", "-q", "-b", "main"]);
    git(repository, ["config", "user.email", "quadwork@example.test"]);
    git(repository, ["config", "user.name", "QuadWork Test"]);
    fs.writeFileSync(path.join(repository, "a.js"), "module.exports = 1;\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-q", "-m", "base"]);
    const head = git(repository, ["rev-parse", "HEAD"]);
    const treeSha = git(repository, ["rev-parse", "HEAD^{tree}"]);

    // Fixed program and argv, no shell: shell metacharacters reach git as one
    // literal argument and cannot run anything; argv outside the allowed
    // object operations, another program, or an unknown field never spawn.
    assert.deepEqual(await runDeliveryGit(request(repository, ["rev-parse", "--verify", "HEAD"])), { ok: true, output: `${head}\n` });
    const marker = path.join(directory, "injected");
    for (const args of [["rev-parse", "--verify", `HEAD; touch ${marker}`], ["rev-parse", `$(touch ${marker})`], ["ls-tree", `${treeSha} && touch ${marker}`]]) {
      assert.deepEqual(await runDeliveryGit(request(repository, args)), { ok: false, output: "" });
    }
    assert.equal(fs.existsSync(marker), false, "no shell interpreted an argument");
    for (const args of [["push"], ["remote", "add", "x", "y"], ["-c", "alias.x=!true", "x"], ["show", head], ["--exec-path"], [], ["mktree", "a\0b"]]) {
      throwsInvalid(() => runDeliveryGit(request(repository, args)));
    }
    throwsInvalid(() => runDeliveryGit({ ...request(repository, ["rev-parse", "HEAD"]), command: "sh" }));
    throwsInvalid(() => runDeliveryGit({ ...request(repository, ["rev-parse", "HEAD"]), shell: true }));
    throwsInvalid(() => runDeliveryGit(request("relative/path", ["rev-parse", "HEAD"])));
    throwsInvalid(() => runDeliveryGit({ ...request(repository, ["rev-parse", "HEAD"]), version: 2 }));
    const source = fs.readFileSync(path.join(__dirname, "delivery-git-runner.js"), "utf8");
    assert.equal((source.match(/execFile\(/g) || []).length, 1);
    assert.match(source, /execFile\("git", /);
    assert.doesNotMatch(source, /shell\s*:|\bexec\(|spawn\(|execSync|execFileSync|fork\(/);
    // The production seam: server/index.js injects this exact function into
    // the Delivery Candidate Git-object adapter, not a copy of it.
    const server = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
    assert.match(server, /const \{ runDeliveryGit \} = require\("\.\/delivery-git-runner"\);/);
    assert.match(server, /createDeliveryGitObjectAdapter\(\{[\s\S]*?run_git: runDeliveryGit,[\s\S]*?read_delivery_source:/);
    console.log("  PASS: the runner spawns only git with an allowed literal argv and no shell, and index.js injects this exact function");

    // stdin: an input string is written then closed; with no input the child
    // sees EOF at once (an empty mktree is the empty tree object).
    const made = await runDeliveryGit(request(repository, ["mktree"], { input: `100644 blob ${git(repository, ["rev-parse", "HEAD:a.js"])}\ta.js\n` }));
    assert.deepEqual(made, { ok: true, output: `${treeSha}\n` });
    assert.deepEqual(await runDeliveryGit(request(repository, ["mktree"])), { ok: true, output: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n" });
    throwsInvalid(() => runDeliveryGit(request(repository, ["mktree"], { input: Buffer.from("x") })));
    console.log("  PASS: stdin carries the input string and is closed either way");

    // Failure resolves, never rejects: a failing command, a missing cwd, and
    // output beyond the bounded buffer all resolve `{ ok: false }`.
    assert.deepEqual(await runDeliveryGit(request(repository, ["rev-parse", "--verify", `${"0".repeat(40)}^{commit}`])), { ok: false, output: "" });
    assert.deepEqual(await runDeliveryGit(request(path.join(directory, "missing"), ["rev-parse", "HEAD"])), { ok: false, output: "" });
    const bigBlob = git(repository, ["hash-object", "-w", "--stdin"], "x".repeat(MAX_OUTPUT_BYTES + 1024));
    const small = await runDeliveryGit(request(repository, ["show", "-s", git(repository, ["rev-parse", "HEAD:a.js"])]));
    assert.equal(small.ok, true);
    assert.deepEqual(await runDeliveryGit(request(repository, ["show", "-s", bigBlob])), { ok: false, output: "" });
    console.log("  PASS: process failure, a missing cwd, and oversized output resolve closed instead of throwing");

    // The child timeout is the caller's value under the fixed ceiling: a
    // status that blocks in a slow fsmonitor hook is killed at timeout_ms,
    // not at the hook's own duration, and out-of-range timeouts never spawn.
    assert.equal(MAX_TIMEOUT_MS, 5000);
    for (const timeout_ms of [0, -1, 1.5, "5000", MAX_TIMEOUT_MS + 1, undefined]) throwsInvalid(() => runDeliveryGit(request(repository, ["rev-parse", "HEAD"], { timeout_ms })));
    const hook = path.join(directory, "slow-fsmonitor.sh");
    fs.writeFileSync(hook, "#!/bin/sh\nexec sleep 3 </dev/null >/dev/null 2>&1\n", { mode: 0o755 });
    git(repository, ["config", "core.fsmonitor", hook]);
    let ticks = 0, marker2 = false;
    const interval = setInterval(() => { ticks += 1; }, 1);
    const started = Date.now();
    const pending = runDeliveryGit(request(repository, ["status", "--porcelain", "--untracked-files=all"], { timeout_ms: 150 }));
    setImmediate(() => { marker2 = true; });
    const timedOut = await pending;
    const elapsed = Date.now() - started;
    clearInterval(interval);
    assert.deepEqual(timedOut, { ok: false, output: "" });
    assert.ok(elapsed >= 150 && elapsed < 1500, `the child was killed at its timeout (${elapsed}ms), not after the 3s hook`);
    assert.ok(marker2 && ticks > 0, `the loop turned ${ticks} times while the call ran`);
    assert.equal(fs.existsSync(path.join(repository, ".git", "index.lock")), false);
    git(repository, ["config", "--unset", "core.fsmonitor"]);
    assert.equal((await runDeliveryGit(request(repository, ["status", "--porcelain"], { timeout_ms: 5000 }))).ok, true);
    console.log(`  PASS: the child timeout is the caller's bound (${elapsed}ms) and the loop keeps turning while git runs`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

let finished = false;
process.on("exit", (code) => { if (!finished && code === 0) { console.error("delivery-git-runner.test.js: did not run to completion"); process.exitCode = 1; } });
main().then(() => { finished = true; console.log("delivery-git-runner.test.js: all assertions passed"); }, (error) => { console.error(error); process.exit(1); });

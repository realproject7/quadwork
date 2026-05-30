#!/usr/bin/env node
// #836: cross-platform test runner. Discovers every `*.test.js` file under
// `server/` via fs.readdirSync recursion (no shell glob — must work on
// Windows) and runs each one in its own `node <file>` child process. The
// per-file process isolates any residual module state (#836 root cause: the
// shared routes.js module pollers used to pin the loop across files in
// `node --test server/*.test.js`, hanging the whole suite). Aggregate exit
// code is non-zero if any child fails or times out.
//
// Out of scope for #836: the two Jest-style tests under server/__tests__/
// (bridge-auto-stop-guard, rate-limit-handling) use `describe`/`expect` and
// can't run under plain node yet. They're explicitly skipped here with a
// clear log line so a future rewrite is obvious work.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SERVER_DIR = __dirname;
const ROOT = path.resolve(SERVER_DIR, "..");
const PER_FILE_TIMEOUT_MS = 60_000;

// Skip-list keyed by absolute path so the runner stays Windows-friendly.
const SKIP = new Set([
  path.join(SERVER_DIR, "__tests__", "bridge-auto-stop-guard.test.js"),
  path.join(SERVER_DIR, "__tests__", "rate-limit-handling.test.js"),
]);

function discover(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...discover(full));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

function runOne(file) {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PER_FILE_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ file, code, signal, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ file, code: -1, signal: null, stdout, stderr: stderr + String(err), timedOut: false });
    });
  });
}

function indent(text, marker) {
  if (!text) return "";
  return text.split("\n").map((l) => `  ${marker} ${l}`).join("\n");
}

(async () => {
  const allFiles = discover(SERVER_DIR).sort();
  const runnable = allFiles.filter((f) => !SKIP.has(f));
  const skipped = allFiles.filter((f) => SKIP.has(f));

  console.log(`\nDiscovered ${allFiles.length} test files (${skipped.length} skipped, ${runnable.length} to run).\n`);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const file of runnable) {
    const rel = path.relative(ROOT, file);
    process.stdout.write(`▶ ${rel} … `);
    const r = await runOne(file);
    if (r.timedOut) {
      console.log(`TIMEOUT (>${PER_FILE_TIMEOUT_MS / 1000}s)`);
      failed++;
      failures.push({ file: rel, reason: `timed out after ${PER_FILE_TIMEOUT_MS / 1000}s`, stdout: r.stdout, stderr: r.stderr });
    } else if (r.code === 0) {
      console.log("PASS");
      passed++;
    } else {
      console.log(`FAIL (exit ${r.code}${r.signal ? `, signal ${r.signal}` : ""})`);
      failed++;
      failures.push({ file: rel, reason: `exit ${r.code}${r.signal ? `, signal ${r.signal}` : ""}`, stdout: r.stdout, stderr: r.stderr });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped.length} skipped.`);

  if (skipped.length) {
    console.log("\nSkipped (Jest-style — out of #836 scope; rewrite separately):");
    for (const f of skipped) console.log(`  - ${path.relative(ROOT, f)}`);
  }

  if (failures.length) {
    console.log("\nFailure details:\n");
    for (const f of failures) {
      console.log(`▼ ${f.file} (${f.reason})`);
      if (f.stdout) console.log(indent(f.stdout.replace(/\n$/, ""), "|"));
      if (f.stderr) console.log(indent(f.stderr.replace(/\n$/, ""), "!"));
      console.log("");
    }
  }

  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("test runner crashed:", err);
  process.exit(2);
});

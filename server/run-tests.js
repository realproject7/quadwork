#!/usr/bin/env node
"use strict";

// #836: cross-platform test runner (wired as `npm test`).
//
// Discovers every `*.test.js` under server/ via fs recursion — NO shell
// glob or `find`, so it works identically on Windows, macOS, and Linux —
// and runs each file in its own child process. Per-file isolation means
// residual module state (e.g. a required ./routes singleton) can't leak
// between files, and a single hanging/failing file can't take down the
// rest of the sweep. Exits non-zero if any file fails or times out.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname; // server/
const PER_FILE_TIMEOUT_MS = 60_000;

// Jest-global suites (`describe`/`expect`) — not runnable under plain
// `node`, and there is no Jest configured. Migrating them to node:assert
// is explicitly out of scope for #836 (tracked separately). Skip so the
// sweep stays green. Paths are relative to ROOT, posix-normalized.
const SKIP = new Set([
  "__tests__/rate-limit-handling.test.js",
  "__tests__/bridge-auto-stop-guard.test.js",
]);

function findTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

const files = findTestFiles(ROOT)
  .filter((f) => !SKIP.has(rel(f)))
  .sort();

let failed = 0;
for (const file of files) {
  const name = rel(file);
  process.stdout.write(`\n▶ ${name}\n`);
  const res = spawnSync(process.execPath, [file], {
    stdio: "inherit",
    timeout: PER_FILE_TIMEOUT_MS,
  });
  if (res.error) {
    const why =
      res.error.code === "ETIMEDOUT"
        ? `TIMEOUT after ${PER_FILE_TIMEOUT_MS}ms`
        : res.error.message;
    console.error(`✗ ${why}: ${name}`);
    failed++;
  } else if (res.status !== 0) {
    const sig = res.signal ? `, signal ${res.signal}` : "";
    console.error(`✗ FAILED (exit ${res.status}${sig}): ${name}`);
    failed++;
  }
}

const total = files.length;
console.log(
  `\n${total - failed}/${total} test files passed${failed ? `, ${failed} FAILED` : ""}.`
);
process.exit(failed ? 1 : 0);

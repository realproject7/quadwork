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
const os = require("os");
const path = require("path");

const SERVER_DIR = __dirname;
const ROOT = path.resolve(SERVER_DIR, "..");
const PER_FILE_TIMEOUT_MS = 60_000;

// #1188: no test may read or write the real ~/.quadwork, run the real `gh`, or
// use the operator's gh auth. Each child gets a fresh throwaway HOME, a `gh` on
// PATH that only records the call (POSIX), and the real-home-guard preload
// (NODE_OPTIONS, so Node grandchildren load it too). The guard refuses and
// records any access under the real ~/.quadwork and under the throwaway HOME's
// .quadwork: a test that reaches the ambient HOME's .quadwork would reach the
// real one outside this runner. Detection is per test process, never "the real
// directory changed", so a live QuadWork server writing it cannot trip it.
const GUARD = path.join(SERVER_DIR, "__tests__", "real-home-guard.js");
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-test-run-"));
const GH_BIN = path.join(RUN_DIR, "bin");
const GH_LOG = path.join(RUN_DIR, "gh-calls.log");

// The real ~/.quadwork under HOME, the passwd home and their realpaths, plus
// whatever a parent runner already guards (a nested runner keeps its parent's
// guard). The guard compares paths as text, so another alias of the home
// directory is not covered.
function realQuadworkDirs() {
  const homes = [os.homedir()];
  try { homes.push(os.userInfo().homedir); } catch { /* no passwd entry */ }
  for (const home of [...homes]) { try { homes.push(fs.realpathSync(home)); } catch { /* absent HOME */ } }
  let inherited = [];
  try { inherited = JSON.parse(process.env.QUADWORK_TEST_GUARDED_DIRS || "[]"); } catch { /* none */ }
  return [...(Array.isArray(inherited) ? inherited : []), ...homes.filter(Boolean).map((home) => path.join(home, ".quadwork"))];
}
const REAL_QUADWORK_DIRS = realQuadworkDirs();

// Tests inherit this environment without gh's auth variables, so a gh that a
// test still reaches (a real one, after this runner removed the stand-in) has
// no operator auth to use. The throwaway HOME already hides the gh config.
const TEST_ENV = { ...process.env };
for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR"]) delete TEST_ENV[key];

// The stand-in gh records the call in the calling file's report (inherited
// env), so a call from a process that outlives its file is still charged to it.
// A Node spawn of gh itself is refused by the preload at spawn time when it
// resolves to the stand-in or to a real gh found on this PATH (BLOCKED_GH). A
// shell (exec, execSync, sh -c) runs the stand-in instead, which records it.
const BLOCKED_GH = [];
if (process.platform !== "win32") {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    try { if (path.isAbsolute(dir)) BLOCKED_GH.push(fs.realpathSync(path.join(dir, "gh"))); } catch { /* no gh here */ }
  }
  fs.mkdirSync(GH_BIN);
  const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(path.join(GH_BIN, "gh"), [
    "#!/bin/sh",
    `fallback=${quote(GH_LOG)}`,
    `printf 'ran gh %s\\n' "$*" >> "\${QUADWORK_TEST_GUARD_REPORT:-$fallback}"`,
    `echo "run-tests: the real gh is not available to tests (#1188)" >&2`,
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  BLOCKED_GH.push(fs.realpathSync(path.join(GH_BIN, "gh")));
}

function readLines(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; }
}

// Guard findings from report lines: refused accesses (JSON from the preload)
// and gh calls (text from the stand-in gh), counted once per distinct entry.
// The throwaway HOME is shown as `~`: outside this runner it is the real one.
function describe(lines, home) {
  const show = (p) => (home && typeof p === "string" && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);
  const counts = new Map();
  for (const line of lines) {
    let key = line;
    try { const e = JSON.parse(line); key = `refused ${e.op} ${show(e.path)}`; } catch { /* a gh call */ }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([key, n]) => (n > 1 ? `${key} (x${n})` : key));
}

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

function runOne(file, index) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(RUN_DIR, `home-${index}-`)));
  const report = path.join(RUN_DIR, `guard-${index}.jsonl`);
  const guardedDirs = [...new Set([...REAL_QUADWORK_DIRS, path.join(home, ".quadwork")])];
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(process.execPath, [file], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      // The compatibility facade is intentionally available only to these
      // isolated test children, never to normal runtime imports.
      env: {
        ...TEST_ENV,
        QUADWORK_TEST_RUNTIME: "1",
        HOME: home,
        USERPROFILE: home,
        ...(process.platform === "win32" ? {} : { PATH: `${GH_BIN}${path.delimiter}${process.env.PATH || ""}` }),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(GUARD)}`].filter(Boolean).join(" "),
        QUADWORK_TEST_GUARDED_DIRS: JSON.stringify(guardedDirs),
        QUADWORK_TEST_BLOCKED_GH: JSON.stringify([...new Set(BLOCKED_GH)]),
        QUADWORK_TEST_GUARD_REPORT: report,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PER_FILE_TIMEOUT_MS);
    const finish = (result) => {
      clearTimeout(killer);
      const lines = readLines(report);
      const guard = describe(lines, home);
      // A .quadwork in the throwaway HOME was made by a process the preload
      // could not load into (sh, git, a child with a replaced NODE_OPTIONS).
      if (fs.existsSync(path.join(home, ".quadwork"))) guard.push("created ~/.quadwork");
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* removed with RUN_DIR */ }
      resolve({ ...result, guard, graded: lines.length, home });
    };
    child.on("close", (code, signal) => {
      finish({ file, code, signal, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      finish({ file, code: -1, signal: null, stdout, stderr: stderr + String(err), timedOut: false });
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
  const graded = [];

  for (const [index, file] of runnable.entries()) {
    const rel = path.relative(ROOT, file);
    process.stdout.write(`▶ ${rel} … `);
    const r = await runOne(file, index);
    graded[index] = { rel, lines: r.graded, home: r.home, passed: false };
    const guardNote = r.guard.length ? `; guard: ${r.guard.length} real-home or gh finding(s)` : "";
    if (r.timedOut) {
      console.log(`TIMEOUT (>${PER_FILE_TIMEOUT_MS / 1000}s)${guardNote}`);
      failed++;
      failures.push({ file: rel, reason: `timed out after ${PER_FILE_TIMEOUT_MS / 1000}s${guardNote}`, stdout: r.stdout, stderr: r.stderr, guard: r.guard });
    } else if (r.code === 0 && r.guard.length === 0) {
      console.log("PASS");
      passed++;
      graded[index].passed = true;
    } else {
      const reason = `${r.code === 0 ? "exit 0" : `exit ${r.code}`}${r.signal ? `, signal ${r.signal}` : ""}${guardNote}`;
      console.log(`FAIL (${reason})`);
      failed++;
      failures.push({ file: rel, reason, stdout: r.stdout, stderr: r.stderr, guard: r.guard });
    }
  }

  // #1188: a process that outlived its file (a background refresh, an orphaned
  // child) can record a finding after the file was graded. Charge it now.
  for (const [index, g] of graded.entries()) {
    const late = describe(readLines(path.join(RUN_DIR, `guard-${index}.jsonl`)).slice(g.lines), g.home);
    if (late.length === 0) continue;
    console.log(`▶ ${g.rel} … FAIL (guard: ${late.length} finding(s) after the file exited)`);
    if (g.passed) { passed--; failed++; }
    failures.push({ file: g.rel, reason: "guard findings recorded after the file exited", guard: late });
  }
  const unattributed = readLines(GH_LOG);
  if (unattributed.length) {
    console.log(`▶ (no test file) … FAIL (guard: ${unattributed.length} gh call(s) from a process without the test environment)`);
    failed++;
    failures.push({ file: "(no test file)", reason: "gh called without the runner's environment", guard: describe(unattributed) });
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
      if (f.guard && f.guard.length) console.log(indent(f.guard.join("\n"), "#1188"));
      console.log("");
    }
  }

  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("test runner crashed:", err);
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(2);
});

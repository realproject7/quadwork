/**
 * #549: QA verification for v1.11.0 security hardening.
 *
 * Covers PRs #543, #546, #547, #548:
 *  - #543: execFileSync refactor (no shell interpolation)
 *  - #546: Next.js upgrade to 16.2.4
 *  - #547: File/directory permission hardening (0o700/0o600)
 *  - #548: WebSocket resize input validation
 *
 * Integration-level items (wizard flow, browser open, AC start,
 * multi-tab WS) require a live server and are verified by code-path
 * analysis in the PR description.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
  }
}

const ROOT = path.resolve(__dirname, "../..");
const SERVER_DIR = path.resolve(__dirname, "..");

console.log("\n#549 QA — v1.11.0 security hardening\n");

// ============================================================================
// PR #543 — execFileSync refactor
// ============================================================================

console.log("--- PR #543: execFileSync refactor ---\n");

test("bin/quadwork.js has no execSync import", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin/quadwork.js"), "utf-8");
  // execFileSync is OK, execSync is not
  const lines = src.split("\n");
  const badLines = lines.filter(
    (l) => /\bexecSync\b/.test(l) && !/execFileSync/.test(l)
  );
  assert.strictEqual(badLines.length, 0, `Found execSync: ${badLines[0]}`);
});

test("server/index.js has no execSync import", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf-8");
  const lines = src.split("\n");
  const badLines = lines.filter(
    (l) => /\bexecSync\b/.test(l) && !/execFileSync/.test(l)
  );
  assert.strictEqual(badLines.length, 0, `Found execSync: ${badLines[0]}`);
});

test("server/install-agentchattr.js has no execSync import", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "install-agentchattr.js"), "utf-8");
  const lines = src.split("\n");
  const badLines = lines.filter(
    (l) => /\bexecSync\b/.test(l) && !/execFileSync/.test(l)
  );
  assert.strictEqual(badLines.length, 0, `Found execSync: ${badLines[0]}`);
});

test("scripts/e2e-per-project.js has no execSync import", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/e2e-per-project.js"), "utf-8");
  const lines = src.split("\n");
  const badLines = lines.filter(
    (l) => /\bexecSync\b/.test(l) && !/execFileSync/.test(l)
  );
  assert.strictEqual(badLines.length, 0, `Found execSync: ${badLines[0]}`);
});

test("bin/quadwork.js run() uses execFileSync with array args", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin/quadwork.js"), "utf-8");
  assert(src.includes("function run(cmd, args = [], opts = {})"), "run() signature should accept array args");
  assert(src.includes("execFileSync(cmd, args,"), "run() should call execFileSync with cmd, args");
});

test("bin/quadwork.js which() uses run() with array args", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin/quadwork.js"), "utf-8");
  assert(src.includes('run("which", [cmd])'), "which() should use array args");
});

test("bin/quadwork.js browser-open uses execFileSync (no shell)", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin/quadwork.js"), "utf-8");
  // Windows path: cmd /c start
  assert(src.includes('execFileSync("cmd", ["/c", "start"'), "Windows browser open should use execFileSync");
  // macOS/Linux: open or xdg-open
  assert(src.includes('execFileSync(process.platform === "darwin" ? "open" : "xdg-open"'), "macOS/Linux browser open should use execFileSync");
});

test("server/index.js isCliInstalled uses execFileSync", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf-8");
  assert(src.includes('execFileSync("which", [cmd]'), "isCliInstalled should use execFileSync");
});

test("server/index.js killProcessOnPort uses execFileSync", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf-8");
  assert(src.includes('execFileSync("lsof", ["-ti"'), "killProcessOnPort should use execFileSync");
});

// ============================================================================
// PR #546 — Next.js upgrade
// ============================================================================

console.log("\n--- PR #546: Next.js upgrade ---\n");

test("package.json specifies Next.js >= 16.2.4 (not vulnerable 16.2.1-16.2.3)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const nextVersion = pkg.dependencies?.next || "";
  // Strip leading ^ or ~ for comparison
  const bare = nextVersion.replace(/^[~^]+/, "");
  const [major, minor, patch] = bare.split(".").map(Number);
  assert(
    major > 16 || (major === 16 && minor > 2) || (major === 16 && minor === 2 && patch >= 4),
    `Expected next >= 16.2.4, got ${nextVersion}`
  );
});

test("package-lock.json has Next.js 16.2.4+ (resolved version)", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf-8"));
  const nextPkg = lock.packages?.["node_modules/next"];
  assert(nextPkg, "next should be in package-lock.json");
  const version = nextPkg.version;
  const [major, minor, patch] = version.split(".").map(Number);
  assert(
    major > 16 || (major === 16 && minor > 2) || (major === 16 && minor === 2 && patch >= 4),
    `Expected >= 16.2.4, got ${version}`
  );
});

test("next build succeeds (runs build from scratch)", () => {
  // Actually run the build to verify Next.js 16.2.4 works.
  const { execFileSync } = require("child_process");
  try {
    execFileSync("npx", ["next", "build"], {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 120000,
    });
  } catch (e) {
    assert.fail(`next build failed: ${e.stderr?.toString().slice(-500) || e.message}`);
  }
  const outIndex = path.join(ROOT, "out", "index.html");
  assert(fs.existsSync(outIndex), "out/index.html should exist after build");
});

// ============================================================================
// PR #547 — File/directory permission hardening
// ============================================================================

console.log("\n--- PR #547: File/directory permission hardening ---\n");

test("server/config.js exports ensureSecureDir", () => {
  const config = require(path.join(SERVER_DIR, "config.js"));
  assert(typeof config.ensureSecureDir === "function", "ensureSecureDir should be exported");
});

test("server/config.js exports writeSecureFile", () => {
  const config = require(path.join(SERVER_DIR, "config.js"));
  assert(typeof config.writeSecureFile === "function", "writeSecureFile should be exported");
});

test("server/config.js exports writeConfig", () => {
  const config = require(path.join(SERVER_DIR, "config.js"));
  assert(typeof config.writeConfig === "function", "writeConfig should be exported");
});

test("ensureSecureDir creates dir with 0o700", () => {
  const { ensureSecureDir } = require(path.join(SERVER_DIR, "config.js"));
  const tmpDir = path.join(require("os").tmpdir(), `qw-qa-test-${Date.now()}`);
  try {
    ensureSecureDir(tmpDir);
    const stat = fs.statSync(tmpDir);
    assert(stat.isDirectory(), "should be a directory");
    assert.strictEqual(stat.mode & 0o777, 0o700, `expected 0o700, got ${(stat.mode & 0o777).toString(8)}`);
  } finally {
    try { fs.rmdirSync(tmpDir); } catch {}
  }
});

test("writeSecureFile creates file with 0o600", () => {
  const { writeSecureFile } = require(path.join(SERVER_DIR, "config.js"));
  const tmpFile = path.join(require("os").tmpdir(), `qw-qa-test-${Date.now()}.txt`);
  try {
    writeSecureFile(tmpFile, "test content");
    const stat = fs.statSync(tmpFile);
    assert(stat.isFile(), "should be a file");
    assert.strictEqual(stat.mode & 0o777, 0o600, `expected 0o600, got ${(stat.mode & 0o777).toString(8)}`);
    assert.strictEqual(fs.readFileSync(tmpFile, "utf-8"), "test content");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("server/index.js imports ensureSecureDir and writeSecureFile", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf-8");
  assert(src.includes("ensureSecureDir"), "should import ensureSecureDir");
  assert(src.includes("writeSecureFile"), "should import writeSecureFile");
  assert(src.includes("writeConfig"), "should import writeConfig");
});

test("server/routes.js imports ensureSecureDir and writeSecureFile", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "routes.js"), "utf-8");
  assert(src.includes("ensureSecureDir"), "should import ensureSecureDir");
  assert(src.includes("writeSecureFile"), "should import writeSecureFile");
  assert(src.includes("writeConfig"), "should import writeConfig");
});

test("no raw mkdirSync without mode in server files", () => {
  const files = ["index.js", "routes.js", "config.js"];
  for (const file of files) {
    const src = fs.readFileSync(path.join(SERVER_DIR, file), "utf-8");
    const lines = src.split("\n");
    const badLines = lines.filter(
      (l) =>
        /fs\.mkdirSync\(/.test(l) &&
        !l.includes("mode:") &&
        !l.includes("ensureSecureDir") &&
        !l.trim().startsWith("//")
    );
    assert.strictEqual(
      badLines.length,
      0,
      `${file} has raw mkdirSync without mode: ${badLines[0]}`
    );
  }
});

test("bin/quadwork.js uses ensureSecureDir for directory creation", () => {
  const src = fs.readFileSync(path.join(ROOT, "bin/quadwork.js"), "utf-8");
  assert(src.includes("ensureSecureDir"), "bin/quadwork.js should use ensureSecureDir");
});

test("install-agentchattr.js uses mode: 0o700 for mkdirSync", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "install-agentchattr.js"), "utf-8");
  const lines = src.split("\n");
  const mkdirLines = lines.filter((l) => /fs\.mkdirSync\(/.test(l) && !l.trim().startsWith("//"));
  for (const line of mkdirLines) {
    assert(line.includes("mode: 0o700"), `Missing mode: 0o700 in: ${line.trim()}`);
  }
});

test("install-agentchattr.js uses mode: 0o600 for writeFileSync (security-sensitive files)", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "install-agentchattr.js"), "utf-8");
  const lines = src.split("\n");
  const writeLines = lines.filter(
    (l) =>
      /fs\.writeFileSync\(/.test(l) &&
      !l.trim().startsWith("//") &&
      // CSS/JS patches are non-sensitive (cosmetic overrides to AC UI)
      !l.includes("cssPath") &&
      !l.includes("jsPath")
  );
  for (const line of writeLines) {
    assert(line.includes("mode: 0o600"), `Missing mode: 0o600 in: ${line.trim()}`);
  }
});

// ============================================================================
// PR #548 — WebSocket resize validation
// ============================================================================

console.log("\n--- PR #548: WebSocket resize validation ---\n");

test("server/index.js has typeof number check for resize cols", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf-8");
  assert(src.includes('typeof parsed.cols === "number"'), "should check typeof cols");
});

test("server/index.js has typeof number check for resize rows", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf-8");
  assert(src.includes('typeof parsed.rows === "number"'), "should check typeof rows");
});

test("server/index.js validates Number.isFinite for resize", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf-8");
  assert(src.includes("Number.isFinite(parsed.cols)"), "should validate isFinite for cols");
  assert(src.includes("Number.isFinite(parsed.rows)"), "should validate isFinite for rows");
});

test("server/index.js bounds-checks resize to 1-500", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf-8");
  assert(src.includes("parsed.cols >= 1"), "should lower-bound cols");
  assert(src.includes("parsed.cols <= 500"), "should upper-bound cols");
  assert(src.includes("parsed.rows >= 1"), "should lower-bound rows");
  assert(src.includes("parsed.rows <= 500"), "should upper-bound rows");
});

test("resize validation is inside the resize handler block", () => {
  const src = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf-8");
  // Verify the validation is between 'parsed.type === "resize"' and 'session.term.resize'
  const resizeIdx = src.indexOf('parsed.type === "resize"');
  const termResizeIdx = src.indexOf("session.term.resize(parsed.cols, parsed.rows)");
  const typeofIdx = src.indexOf('typeof parsed.cols === "number"');
  assert(resizeIdx > 0 && termResizeIdx > resizeIdx && typeofIdx > resizeIdx && typeofIdx < termResizeIdx,
    "validation should be between resize type check and term.resize call");
});

// ============================================================================

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);

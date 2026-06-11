"use strict";

// #957: unit tests for the stale backend-temp sweep. All filesystem work
// happens inside a throwaway fixture dir; uid/now/tmpRoot are injected so
// nothing touches the real /tmp/claude-{uid}.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { sweepBackendTemp, cleanupSettings, DEFAULT_MAX_AGE_HOURS } = require("./temp-cleanup");

let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed epoch for determinism

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-tempclean-test-"));
  const claudeDir = path.join(root, "claude-1234");
  fs.mkdirSync(claudeDir);
  return { root, claudeDir };
}

function touch(p, ageHours, { dir = false, content = "x" } = {}) {
  if (dir) {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "inner.txt"), content);
  } else {
    fs.writeFileSync(p, content);
  }
  const t = new Date(NOW - ageHours * HOUR);
  // utimes sets atime+mtime; ctime can't be set, but lstat ctime of a fresh
  // fixture file is "now" in REAL time, far in the past relative to our fake
  // NOW — so the injected-now cutoff is still decided by atime/mtime here.
  fs.utimesSync(p, t, t);
}

// ── stale vs fresh entries under claude-{uid} ──
{
  const { root, claudeDir } = makeFixture();
  touch(path.join(claudeDir, "old-file"), 100);
  touch(path.join(claudeDir, "old-dir"), 100, { dir: true });
  touch(path.join(claudeDir, "fresh-file"), 1);
  // utimes on the dir AFTER writing inner.txt so the dir's own mtime is old
  fs.utimesSync(path.join(claudeDir, "old-dir"), new Date(NOW - 100 * HOUR), new Date(NOW - 100 * HOUR));

  const r = sweepBackendTemp({ tmpRoot: root, uid: 1234, now: NOW, maxAgeHours: 72 });
  ok(!fs.existsSync(path.join(claudeDir, "old-file")), "stale file under claude-{uid} is removed");
  ok(!fs.existsSync(path.join(claudeDir, "old-dir")), "stale directory is removed recursively");
  ok(fs.existsSync(path.join(claudeDir, "fresh-file")), "fresh file is spared");
  ok(fs.existsSync(claudeDir), "the claude-{uid} dir itself is kept");
  ok(r.removed.length === 2 && r.kept === 1 && r.errors.length === 0, "result counts removed=2 kept=1 errors=0");
  fs.rmSync(root, { recursive: true, force: true });
}

// ── gemini crash dumps at the temp root ──
{
  const { root } = makeFixture();
  touch(path.join(root, "gemini-client-error-Turn.run-2026-06-03T00-28-55-388Z.json"), 100);
  touch(path.join(root, "gemini-client-error-fresh.json"), 1);
  touch(path.join(root, "unrelated-old-file.json"), 100);

  const r = sweepBackendTemp({ tmpRoot: root, uid: 1234, now: NOW, maxAgeHours: 72 });
  ok(!fs.existsSync(path.join(root, "gemini-client-error-Turn.run-2026-06-03T00-28-55-388Z.json")), "stale gemini crash dump is removed");
  ok(fs.existsSync(path.join(root, "gemini-client-error-fresh.json")), "fresh gemini crash dump is spared");
  ok(fs.existsSync(path.join(root, "unrelated-old-file.json")), "non-gemini file at temp root is NEVER touched, even when old");
  ok(r.removed.length === 1, "only the stale gemini dump counts as removed");
  fs.rmSync(root, { recursive: true, force: true });
}

// ── missing claude dir / no uid → graceful no-op ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-tempclean-test-"));
  const r1 = sweepBackendTemp({ tmpRoot: root, uid: 9999, now: NOW });
  ok(r1.removed.length === 0 && r1.errors.length === 0, "missing claude-{uid} dir → clean no-op");
  const r2 = sweepBackendTemp({ tmpRoot: root, uid: null, now: NOW });
  ok(r2.removed.length === 0 && r2.errors.length === 0, "uid null (Windows) → claude sweep skipped without error");
  fs.rmSync(root, { recursive: true, force: true });
}

// ── sweep never throws even on a bogus tmpRoot ──
{
  const r = sweepBackendTemp({ tmpRoot: "/nonexistent/qw-nope", uid: 1, now: NOW });
  ok(Array.isArray(r.removed) && r.removed.length === 0, "bogus tmpRoot → no-op result, no throw");
}

// ── cleanupSettings: defaults + opt-out + custom age ──
ok(cleanupSettings({}).enabled === true, "settings default: enabled");
ok(cleanupSettings({}).maxAgeHours === DEFAULT_MAX_AGE_HOURS, `settings default: ${DEFAULT_MAX_AGE_HOURS}h`);
ok(cleanupSettings({ temp_cleanup: { enabled: false } }).enabled === false, "temp_cleanup.enabled:false opts out");
ok(cleanupSettings({ temp_cleanup: { max_age_hours: 24 } }).maxAgeHours === 24, "custom max_age_hours respected");
ok(cleanupSettings({ temp_cleanup: { max_age_hours: -5 } }).maxAgeHours === DEFAULT_MAX_AGE_HOURS, "invalid max_age_hours falls back to default");
ok(cleanupSettings(null).enabled === true, "null config → defaults, no throw");

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall temp-cleanup assertions passed");

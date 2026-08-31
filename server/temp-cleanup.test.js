"use strict";

// #957: unit tests for the stale backend-temp sweep. All filesystem work
// happens inside a throwaway fixture dir; uid/now/tmpRoot are injected so
// nothing ever touches the real /tmp/claude-{uid}. Plain node:assert script —
// auto-discovered by the #836 runner. Run with `node server/temp-cleanup.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sweepBackendTemp, cleanupSettings, DEFAULT_MAX_AGE_HOURS } = require("./temp-cleanup");

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed epoch for determinism (no Date.now())

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-957-tempclean-"));
  const claudeDir = path.join(root, "claude-1234");
  fs.mkdirSync(claudeDir);
  return { root, claudeDir };
}

// Create a file or dir and stamp its atime/mtime to `ageHours` before NOW.
function touch(p, ageHours, { dir = false } = {}) {
  if (dir) {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "inner.txt"), "x");
  } else {
    fs.writeFileSync(p, "x");
  }
  const t = new Date(NOW - ageHours * HOUR);
  fs.utimesSync(p, t, t);
}

// ── stale vs a live session's fresh entries under claude-{uid} ────────────
{
  const { root, claudeDir } = makeFixture();
  touch(path.join(claudeDir, "old-file"), 100);
  touch(path.join(claudeDir, "old-dir"), 100, { dir: true });
  // inner.txt written above bumps the dir mtime to real-now; restamp old.
  fs.utimesSync(path.join(claudeDir, "old-dir"), new Date(NOW - 100 * HOUR), new Date(NOW - 100 * HOUR));
  touch(path.join(claudeDir, "live-session-file"), 1); // a live agent just wrote this

  const r = sweepBackendTemp({ tmpRoot: root, uid: 1234, now: NOW, maxAgeHours: 72 });

  assert.ok(!fs.existsSync(path.join(claudeDir, "old-file")), "stale file under claude-{uid} removed");
  assert.ok(!fs.existsSync(path.join(claudeDir, "old-dir")), "stale directory removed recursively");
  assert.ok(fs.existsSync(path.join(claudeDir, "live-session-file")), "live session's fresh file PRESERVED");
  assert.ok(fs.existsSync(claudeDir), "the claude-{uid} dir itself is kept");
  assert.equal(r.removed.length, 2, "removed count = 2");
  assert.equal(r.kept, 1, "kept count = 1 (the live file)");
  assert.equal(r.errors.length, 0, "no errors");
  fs.rmSync(root, { recursive: true, force: true });
}

// ── gemini crash dumps at the temp root ──────────────────────────────────
{
  const { root } = makeFixture();
  const staleDump = path.join(root, "gemini-client-error-Turn.run-2026-06-03T00-28-55-388Z.json");
  touch(staleDump, 100);
  touch(path.join(root, "gemini-client-error-fresh.json"), 1);
  touch(path.join(root, "unrelated-old-file.json"), 100);

  const r = sweepBackendTemp({ tmpRoot: root, uid: 1234, now: NOW, maxAgeHours: 72 });

  assert.ok(!fs.existsSync(staleDump), "stale gemini crash dump removed");
  assert.ok(fs.existsSync(path.join(root, "gemini-client-error-fresh.json")), "fresh gemini dump spared");
  assert.ok(fs.existsSync(path.join(root, "unrelated-old-file.json")), "non-gemini root file NEVER touched, even when old");
  assert.equal(r.removed.length, 1, "only the stale gemini dump counts as removed");
  fs.rmSync(root, { recursive: true, force: true });
}

// ── missing claude dir / null uid (Windows) → graceful no-op ─────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-957-tempclean-"));
  const r1 = sweepBackendTemp({ tmpRoot: root, uid: 9999, now: NOW });
  assert.equal(r1.removed.length, 0, "missing claude-{uid} dir → nothing removed");
  assert.equal(r1.errors.length, 0, "missing claude-{uid} dir → no error");

  const r2 = sweepBackendTemp({ tmpRoot: root, uid: null, now: NOW });
  assert.equal(r2.removed.length, 0, "uid null → claude sweep skipped");
  assert.equal(r2.errors.length, 0, "uid null → no error");
  fs.rmSync(root, { recursive: true, force: true });
}

// ── never throws, even on a bogus tmpRoot ────────────────────────────────
{
  const r = sweepBackendTemp({ tmpRoot: "/nonexistent/qw-nope", uid: 1, now: NOW });
  assert.ok(Array.isArray(r.removed) && r.removed.length === 0, "bogus tmpRoot → no-op, no throw");
}

// ── symlink confinement: never enumerate or delete an external target ────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-957-tempclean-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "qw-957-external-"));
  const victim = path.join(external, "must-survive");
  touch(victim, 100);
  fs.symlinkSync(external, path.join(root, "claude-1234"), "dir");

  const r = sweepBackendTemp({ tmpRoot: root, uid: 1234, now: NOW, maxAgeHours: 72 });
  assert.ok(fs.existsSync(victim), "symlinked claude directory target is never enumerated or deleted");
  assert.equal(r.removed.length, 0);
  assert.equal(r.errors.length, 1, "refusal is observable");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(external, { recursive: true, force: true });
}

// ── nested symlink cleanup unlinks the alias, not the external target ────
{
  const { root, claudeDir } = makeFixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "qw-957-external-"));
  const survivor = path.join(external, "must-survive");
  fs.writeFileSync(survivor, "safe");
  const staleDir = path.join(claudeDir, "stale-with-link");
  fs.mkdirSync(staleDir);
  fs.symlinkSync(external, path.join(staleDir, "external-link"), "dir");
  fs.utimesSync(staleDir, new Date(NOW - 100 * HOUR), new Date(NOW - 100 * HOUR));

  const r = sweepBackendTemp({ tmpRoot: root, uid: 1234, now: NOW, maxAgeHours: 72 });
  assert.ok(!fs.existsSync(staleDir), "owned stale directory removed");
  assert.equal(fs.readFileSync(survivor, "utf8"), "safe", "nested symlink target survives");
  assert.equal(r.removed.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(external, { recursive: true, force: true });
}

// ── cleanupSettings: defaults + opt-out + custom/invalid age + null cfg ───
{
  assert.equal(cleanupSettings({}).enabled, true, "default: enabled");
  assert.equal(cleanupSettings({}).maxAgeHours, DEFAULT_MAX_AGE_HOURS, `default: ${DEFAULT_MAX_AGE_HOURS}h`);
  assert.equal(cleanupSettings({ temp_cleanup: { enabled: false } }).enabled, false, "enabled:false opts out");
  assert.equal(cleanupSettings({ temp_cleanup: { max_age_hours: 24 } }).maxAgeHours, 24, "custom max_age_hours honored");
  assert.equal(cleanupSettings({ temp_cleanup: { max_age_hours: -5 } }).maxAgeHours, DEFAULT_MAX_AGE_HOURS, "invalid age → default");
  assert.equal(cleanupSettings(null).enabled, true, "null config → defaults, no throw");
}

console.log("temp-cleanup.test.js: all assertions passed");

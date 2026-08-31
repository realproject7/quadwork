"use strict";

// #957: lifecycle-aware cleanup of agent backend temp dirs.
//
// Claude Code overrides TMPDIR to /tmp/claude-{uid} and never cleans it up.
// On Linux hosts where /tmp carries a per-user quota (usrquota), that dir
// accumulates until the quota is exhausted — at which point EVERY Claude bash
// call fails silently (exit 1, no output) because Claude can't write its
// temp/sandbox-setup files before exec. Gemini similarly strands
// /tmp/gemini-client-error-*.json crash dumps. Codex keeps its state under
// ~/.codex (not /tmp) so it needs no sweep here.
//
// Design constraints (the #957 "never delete a live session's temp" invariant):
// - /tmp/claude-{uid} is SHARED by every claude agent of this user, so a
//   teardown of one agent must never delete another live agent's files.
//   Per-entry ownership isn't resolvable at the dir level, so deletion is
//   strictly age-based ("stale entries only") — the same sweep is therefore
//   safe from any call site, teardown OR timer.
// - Age uses max(mtime, atime, ctime) like systemd-tmpfiles, so anything a
//   live session still touches stays "fresh" and is spared.
// - Never throws: a cleanup bug must not break agent teardown or the server
//   boot path. Errors are collected and reported in the result.
// - Cross-platform no-op where it doesn't apply: Windows has no
//   process.getuid → the claude dir is skipped; the gemini glob simply
//   matches nothing where those files don't exist.

const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { removeConfinedPath } = require("./resource-temp");

const DEFAULT_MAX_AGE_HOURS = 72;

// Newest of mtime/atime/ctime — "last time anything observed this entry".
function newestTimeMs(st) {
  return Math.max(st.mtimeMs || 0, st.atimeMs || 0, st.ctimeMs || 0);
}

// Remove `entry` (file or dir) if its newest timestamp is older than the
// cutoff. Returns "removed" | "kept" | "error".
function removeIfStale(root, entry, cutoffMs, result, quarantineName = null, alreadyQuarantined = false, expectedUid = null) {
  let st;
  try {
    st = fs.lstatSync(entry);
  } catch {
    return "kept"; // raced away — already gone
  }
  if (newestTimeMs(st) >= cutoffMs) {
    result.kept += 1;
    return "kept";
  }
  if (alreadyQuarantined && expectedUid !== null && Number(st.uid) !== expectedUid) {
    result.errors.push(`${entry}: quarantine ownership mismatch`);
    return "error";
  }
  try {
    if (alreadyQuarantined) {
      fs.rmSync(entry, { recursive: true, force: true, maxRetries: 2 });
    } else {
      removeConfinedPath(root, entry, fs, quarantineName);
    }
    result.removed.push(entry);
    return "removed";
  } catch (err) {
    result.errors.push(`${entry}: ${err.message}`);
    return "error";
  }
}

// Sweep stale backend temp entries. Options (all injectable for tests):
//   maxAgeHours - entries with no mtime/atime/ctime newer than this are removed
//   tmpRoot     - temp root (default os.tmpdir())
//   uid         - numeric uid for the claude-{uid} dir (default process.getuid)
//   now         - epoch ms (default Date.now())
// Returns { removed: string[], kept: number, errors: string[] }.
function sweepBackendTemp(opts = {}) {
  const result = { removed: [], kept: 0, errors: [] };
  try {
    const maxAgeHours = Number.isFinite(opts.maxAgeHours) && opts.maxAgeHours > 0
      ? opts.maxAgeHours
      : DEFAULT_MAX_AGE_HOURS;
    const tmpRoot = opts.tmpRoot || os.tmpdir();
    const now = typeof opts.now === "number" ? opts.now : Date.now();
    const cutoffMs = now - maxAgeHours * 60 * 60 * 1000;

    // Claude: entries directly under /tmp/claude-{uid}. The dir itself is
    // kept (claude recreates it anyway; deleting it while a session spawns
    // would be a race for no benefit).
    const uid = typeof opts.uid === "number"
      ? opts.uid
      : (typeof process.getuid === "function" ? process.getuid() : null);
    let canonicalRoot = null;
    try {
      canonicalRoot = fs.realpathSync(tmpRoot);
    } catch {
      canonicalRoot = null;
    }

    if (uid !== null && canonicalRoot) {
      const claudeDir = path.join(canonicalRoot, `claude-${uid}`);
      let entries = [];
      try {
        const claudeStat = fs.lstatSync(claudeDir);
        // A symlink here used to let the sweep enumerate and delete entries in
        // an arbitrary external directory. Never traverse it.
        if (claudeStat.isDirectory() && !claudeStat.isSymbolicLink()) {
          entries = fs.readdirSync(claudeDir);
        } else if (claudeStat.isSymbolicLink()) {
          result.errors.push(`${claudeDir}: refusing symlinked claude temp directory`);
        }
      } catch {
        entries = []; // no dir → nothing to do
      }
      for (const name of entries) {
        removeIfStale(canonicalRoot, path.join(claudeDir, name), cutoffMs, result);
      }
    }

    // Gemini: stray crash dumps written directly to the temp root.
    let rootEntries = [];
    try {
      rootEntries = canonicalRoot ? fs.readdirSync(canonicalRoot) : [];
    } catch {
      rootEntries = [];
    }
    for (const name of rootEntries) {
      const quarantineMatch = name.match(/^gemini-client-error-quadwork-quarantine-(nouid|\d+)-([a-f0-9]{32})\.json$/);
      if (quarantineMatch) {
        if ((uid === null && quarantineMatch[1] === "nouid")
          || (uid !== null && Number(quarantineMatch[1]) === uid)) {
          removeIfStale(canonicalRoot, path.join(canonicalRoot, name), cutoffMs, result, null, true, uid);
        }
        continue;
      }
      if (name.startsWith("gemini-client-error-") && name.endsWith(".json")) {
        const owner = uid === null ? "nouid" : String(uid);
        const quarantineName = `gemini-client-error-quadwork-quarantine-${owner}-${crypto.randomBytes(16).toString("hex")}.json`;
        removeIfStale(canonicalRoot, path.join(canonicalRoot, name), cutoffMs, result, quarantineName);
      }
    }
  } catch (err) {
    result.errors.push(String(err && err.message ? err.message : err));
  }
  return result;
}

// Resolve {enabled, maxAgeHours} from config.json's optional top-level
// `temp_cleanup` block. Defaults: enabled, 72h. `enabled: false` opts out.
function cleanupSettings(cfg) {
  const tc = (cfg && cfg.temp_cleanup) || {};
  return {
    enabled: tc.enabled !== false,
    maxAgeHours: Number.isFinite(tc.max_age_hours) && tc.max_age_hours > 0
      ? tc.max_age_hours
      : DEFAULT_MAX_AGE_HOURS,
  };
}

module.exports = {
  sweepBackendTemp,
  cleanupSettings,
  DEFAULT_MAX_AGE_HOURS,
};

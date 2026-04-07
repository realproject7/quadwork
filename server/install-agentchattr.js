// Shared AgentChattr install helper used by both the CLI wizard
// (bin/quadwork.js) and the web setup route (server/routes.js).
//
// Extracted as part of #185 (Phase 2D of master #181) so the web UI
// can clone AgentChattr per-project without duplicating the locking,
// idempotency, and cleanup-safety logic that #183 + #187 added.
//
// Public API:
//   findAgentChattr(dir)               → string|null
//   installAgentChattr(dir)            → string|null  (.lastError on failure)
//   chattrSpawnArgs(dir, extraArgs)    → { command, spawnArgs, cwd } | null
//   AGENTCHATTR_REPO                   → upstream URL constant
//
// Self-contained — depends only on Node built-ins so it's safe to require
// from anywhere in the project (CLI bin, server routes, future tests).

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const AGENTCHATTR_REPO = "https://github.com/bcurts/agentchattr.git";

// Stale-lock thresholds for installAgentChattr().
// Lock files older than this OR whose owning pid is no longer alive are
// treated as crashed and reclaimed. Tuned to comfortably exceed the longest
// step (pip install of agentchattr requirements, ~120s timeout).
const INSTALL_LOCK_STALE_MS = 10 * 60 * 1000; // 10 min
const INSTALL_LOCK_WAIT_TOTAL_MS = 30 * 1000;  // wait up to 30s for a peer
const INSTALL_LOCK_POLL_MS = 500;

function _run(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim(); }
  catch { return null; }
}

function _isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

function _readLock(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, "utf-8").trim();
    const [pidStr, tsStr] = raw.split(":");
    return { pid: parseInt(pidStr, 10), ts: parseInt(tsStr, 10) || 0 };
  } catch { return null; }
}

function _isLockStale(lockFile) {
  const info = _readLock(lockFile);
  if (!info) return true;
  if (Date.now() - info.ts > INSTALL_LOCK_STALE_MS) return true;
  if (!_isPidAlive(info.pid)) return true;
  return false;
}

/**
 * Check if AgentChattr is fully installed (cloned + venv ready) at `dir`.
 * Returns the directory path if both run.py and .venv/bin/python exist, or null.
 * Caller must pass an explicit `dir` — there is no default.
 */
function findAgentChattr(dir) {
  if (!dir) return null;
  if (fs.existsSync(path.join(dir, "run.py")) && fs.existsSync(path.join(dir, ".venv", "bin", "python"))) return dir;
  return null;
}

/**
 * Clone AgentChattr and set up its venv at `dir`. Idempotent — safe to
 * re-run on the same path, and safe to call repeatedly with different
 * paths in the same process. Designed to support per-project clones (#181).
 *
 * Behavior on re-run:
 *   - Fully-installed path → no-op (skips clone, skips venv create, skips pip)
 *   - Missing run.py        → clones (only after refusing to overwrite
 *                             unrelated content; see safety rules below)
 *   - Missing venv          → creates venv and reinstalls requirements
 *
 * Safety rules — never accidentally clean up unrelated directories:
 *   - Empty dir                                  → safe to remove
 *   - Git repo whose origin contains "agentchattr" → safe to remove
 *   - Anything else                              → refuse, return null
 *
 * Concurrency: a per-target lock at `${dir}.install.lock` serializes
 * concurrent installs to the same path. Stale locks (dead pid OR older
 * than 10 min) are reclaimed atomically via rename → unlink. Live
 * peers are polled for up to 30s; after that, returns null with a
 * clear lastError.
 *
 * On failure, returns null and stores a human-readable reason on
 * `installAgentChattr.lastError` so callers can surface it without
 * changing the return shape.
 */
function installAgentChattr(dir) {
  if (!dir) {
    installAgentChattr.lastError = "installAgentChattr: dir is required";
    return null;
  }
  installAgentChattr.lastError = null;
  const setError = (msg) => { installAgentChattr.lastError = msg; return null; };

  // --- Per-target lock ---
  const lockFile = `${dir}.install.lock`;
  try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); }
  catch (e) { return setError(`Cannot create parent of ${dir}: ${e.message}`); }

  let acquired = false;
  const deadline = Date.now() + INSTALL_LOCK_WAIT_TOTAL_MS;
  while (!acquired) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}:${Date.now()}`, { flag: "wx" });
      acquired = true;
    } catch (e) {
      if (e.code !== "EEXIST") return setError(`Cannot create install lock ${lockFile}: ${e.message}`);
      if (_isLockStale(lockFile)) {
        const sideline = `${lockFile}.stale.${process.pid}.${Date.now()}`;
        try {
          fs.renameSync(lockFile, sideline);
          try { fs.unlinkSync(sideline); } catch {}
        } catch (renameErr) {
          if (renameErr.code !== "ENOENT") {
            return setError(`Cannot reclaim stale lock ${lockFile}: ${renameErr.message}`);
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        const info = _readLock(lockFile) || { pid: "?", ts: 0 };
        return setError(`Another install is in progress at ${dir} (pid ${info.pid}); timed out after ${INSTALL_LOCK_WAIT_TOTAL_MS}ms. Re-run after it finishes, or remove ${lockFile} if stale.`);
      }
      try { execSync(`sleep ${INSTALL_LOCK_POLL_MS / 1000}`); }
      catch { /* sleep interrupted; loop will recheck */ }
    }
  }

  try {
    return _installAgentChattrLocked(dir, setError);
  } finally {
    try { fs.unlinkSync(lockFile); } catch {}
  }
}
installAgentChattr.lastError = null;

function _installAgentChattrLocked(dir, setError) {
  const runPy = path.join(dir, "run.py");
  const venvPython = path.join(dir, ".venv", "bin", "python");
  let venvJustCreated = false;

  // 1. Clone if run.py is missing.
  if (!fs.existsSync(runPy)) {
    if (fs.existsSync(dir)) {
      let entries;
      try { entries = fs.readdirSync(dir); }
      catch (e) { return setError(`Cannot read ${dir}: ${e.message}`); }
      const isEmpty = entries.length === 0;
      if (isEmpty) {
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e) { return setError(`Cannot remove empty dir ${dir}: ${e.message}`); }
      } else if (fs.existsSync(path.join(dir, ".git"))) {
        const remote = _run(`git -C "${dir}" remote get-url origin 2>/dev/null`);
        if (remote && remote.includes("agentchattr")) {
          try { fs.rmSync(dir, { recursive: true, force: true }); }
          catch (e) { return setError(`Cannot remove failed clone at ${dir}: ${e.message}`); }
        } else {
          return setError(`Refusing to overwrite ${dir}: contains a non-AgentChattr git repo`);
        }
      } else {
        return setError(`Refusing to overwrite ${dir}: directory exists with unrelated content`);
      }
    }
    try { fs.mkdirSync(path.dirname(dir), { recursive: true }); }
    catch (e) { return setError(`Cannot create parent of ${dir}: ${e.message}`); }
    const cloneResult = _run(`git clone "${AGENTCHATTR_REPO}" "${dir}" 2>&1`, { timeout: 60000 });
    if (cloneResult === null) return setError(`git clone of ${AGENTCHATTR_REPO} into ${dir} failed`);
    if (!fs.existsSync(runPy)) return setError(`Clone completed but run.py missing at ${dir}`);
  }

  // 2. Create venv if missing.
  if (!fs.existsSync(venvPython)) {
    const venvResult = _run(`python3 -m venv "${path.join(dir, ".venv")}" 2>&1`, { timeout: 60000 });
    if (venvResult === null) return setError(`python3 -m venv failed at ${dir}/.venv (is python3 installed?)`);
    if (!fs.existsSync(venvPython)) return setError(`venv created but ${venvPython} missing`);
    venvJustCreated = true;
  }

  // 3. Install requirements only when the venv was just (re)created.
  if (venvJustCreated) {
    const reqFile = path.join(dir, "requirements.txt");
    if (fs.existsSync(reqFile)) {
      const pipResult = _run(`"${venvPython}" -m pip install -r "${reqFile}" 2>&1`, { timeout: 120000 });
      if (pipResult === null) return setError(`pip install -r ${reqFile} failed`);
    }
  }
  return dir;
}

/**
 * Get spawn args for launching AgentChattr from its cloned directory.
 * Returns { command, spawnArgs, cwd } or null if not fully installed.
 * Requires .venv/bin/python — never falls back to bare python3.
 */
function chattrSpawnArgs(dir, extraArgs) {
  if (!dir) return null;
  const venvPython = path.join(dir, ".venv", "bin", "python");
  if (!fs.existsSync(path.join(dir, "run.py")) || !fs.existsSync(venvPython)) return null;
  return { command: venvPython, spawnArgs: ["run.py", ...(extraArgs || [])], cwd: dir };
}

module.exports = {
  AGENTCHATTR_REPO,
  findAgentChattr,
  installAgentChattr,
  chattrSpawnArgs,
};

"use strict";

// #1172: model-id validation + per-CLI model discovery.
//
// Validation: MODEL_ID_PATTERN (src/lib/modelId.js, shared with the UI) is the
// one accepted model-id shape, enforced by the agent-models PUT route, the
// config write routes and by buildAgentArgs at spawn.
//
// Discovery: asks an installed CLI which models it offers, so a new model is
// selectable without a QuadWork release. Only CLIs with a model listing have a
// source (codex: `codex debug models`, JSON, entries with visibility "list";
// grok: `grok models`, the "Available models:" list); every other backend
// (claude, gemini) uses the shipped list. Discovery is
// fetched by the Settings page and the Agent Models modal when they open —
// never by the spawn path — is bounded by DISCOVERY_TIMEOUT_MS, and cached for
// DISCOVERY_CACHE_MS. Any failure (CLI missing, not logged in, offline,
// timeout, changed command or output format) only drops that backend from the
// result, so callers fall back to the shipped list. The CLI runs
// non-interactively with stdin closed, so it can't sit on a login / trust /
// consent prompt; QuadWork itself never reads provider auth files.
//
// #1176: discovery runs resolved executables (discoveryTargets), found by the
// resolver the spawn path and /api/cli-status use, not a bare name on PATH.
// An agent with an absolute-path command gets that executable's models. The
// cache is per resolved executable.

const { spawn } = require("child_process");
const os = require("os");

const { MODEL_ID_PATTERN, isValidModelId } = require("../src/lib/modelId.js");
const { cliBaseFromCommand } = require("../src/lib/injectMode.js");

// `<project id>/<agent id>` for every agent in a config write body whose
// non-empty model fails MODEL_ID_PATTERN (the PUT and PATCH /api/config
// handlers reject the write when this is non-empty).
function invalidAgentModelRefs(projects) {
  return (Array.isArray(projects) ? projects : []).flatMap((project) =>
    Object.entries((project && project.agents) || {})
      .filter(([, agent]) => agent && agent.model !== undefined && agent.model !== null && agent.model !== "" && !isValidModelId(agent.model))
      .map(([agentId]) => `${project.id}/${agentId}`));
}

// `codex debug models` → { models: [{ slug, visibility, ... }] }. Hidden
// (visibility "hide") entries are internal and not offered in the CLI picker.
function parseCodexModels(stdout) {
  let data;
  try { data = JSON.parse(stdout); } catch { data = null; }
  if (!data || !Array.isArray(data.models)) throw new Error("unexpected `codex debug models` output");
  return data.models
    .filter((m) => m && m.visibility === "list" && isValidModelId(m.slug))
    .map((m) => m.slug);
}

// `grok models` (grok 0.2.118) prints, logged in or not, e.g.:
//   Default model: grok-4.5
//
//   Available models:
//     * grok-4.5 (default)
// Only the "* <id>" rows under "Available models:" are read; a missing header
// or a row of any other shape means the format changed.
function parseGrokModels(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "Available models:");
  if (start < 0) throw new Error("unexpected `grok models` output");
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") {
      if (ids.length > 0) break;
      continue;
    }
    const m = /^\s*\*\s+(\S+)(?: \(default\))?\s*$/.exec(line);
    if (!m) throw new Error("unexpected `grok models` output");
    if (isValidModelId(m[1])) ids.push(m[1]);
  }
  return ids;
}

// Keyed by command basename (cliBaseFromCommand), the same key as the rest of
// the model catalog; discoveryTargets resolves each key as a bare CLI name.
// `command` is the CLI name a "not found" error reports.
const DISCOVERY_SOURCES = {
  codex: { name: "codex debug models", command: "codex", args: ["debug", "models"], parse: parseCodexModels },
  grok: { name: "grok models", command: "grok", args: ["models"], parse: parseGrokModels },
};
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_CACHE_MS = 5 * 60 * 1000;
// `codex debug models` prints ~400 KB today (per-model instructions included).
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// The CLI runs in its own process group (detached → setsid on POSIX), so a
// timeout kills the whole group: a helper process the CLI spawned can't be
// left running after QuadWork gave up on it.
function killGroup(child) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

// #1176: runs `executable` (a resolved path; no shell) with the source's fixed
// arguments.
function runSource(source, executable, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, stdout) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(stdout);
    };
    // stdin: a pipe closed at once (EOF — an interactive prompt can't wait for
    // input); stderr is never read — it can carry account details.
    const child = spawn(executable, source.args, {
      cwd: os.tmpdir(),
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", (d) => {
      bytes += d.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        killGroup(child);
        return finish(new Error("output too large"));
      }
      chunks.push(d);
    });
    // Short fixed reasons only, never text from the CLI.
    child.on("error", (err) => finish(new Error(err.code === "ENOENT" ? `${source.command} not found` : "failed to run")));
    child.on("close", (code) => {
      if (code === 0) finish(null, Buffer.concat(chunks).toString("utf8"));
      else finish(new Error(code === null ? "failed to run" : `exited with code ${code}`));
    });
    const timer = setTimeout(() => {
      if (child.pid) killGroup(child);
      finish(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

// One run of one executable → its listed ids. Throws a short fixed message.
async function listExecutableModels(source, executable, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  const stdout = await runSource(source, executable, timeoutMs);
  let parsed;
  // A fixed message: never text derived from the CLI's output.
  try { parsed = source.parse(stdout); } catch { throw new Error(`unexpected \`${source.name}\` output`); }
  const list = [...new Set(parsed)];
  if (list.length === 0) throw new Error("no models listed");
  return list;
}

// #1176: what discovery runs, one { backend, executable } per resolved
// executable: each source's bare CLI name first (the CLI /api/cli-status
// reports), then every configured agent command that has a source. `resolve`
// is resolveCliExecutable (server/cli-executable.js), the resolver the spawn
// path uses.
function discoveryTargets(commands, resolve, sources = DISCOVERY_SOURCES) {
  const targets = new Map();
  for (const command of [...Object.keys(sources), ...commands]) {
    const backend = cliBaseFromCommand(command);
    const executable = sources[backend] ? resolve(command) : null;
    if (executable && !targets.has(executable)) targets.set(executable, { backend, executable });
  }
  return [...targets.values()];
}

// → { models: { [backend]: string[] }, errors: { [backend]: string } }. Never
// rejects: each backend either lists at least one model or reports an error.
// #1176: a backend lists the union of its targets' models (target order), else
// reports its first error, or "<cli> not found" when nothing resolved.
async function discoverAgentModels({ targets, sources = DISCOVERY_SOURCES, timeoutMs = DISCOVERY_TIMEOUT_MS,
  list = (source, executable) => listExecutableModels(source, executable, timeoutMs) }) {
  const results = await Promise.all(targets.map(async ({ backend, executable }) => {
    try {
      return { backend, models: await list(sources[backend], executable) };
    } catch (err) {
      return { backend, error: (err && err.message) || String(err) };
    }
  }));
  const models = {};
  const errors = {};
  for (const [backend, source] of Object.entries(sources)) {
    const own = results.filter((r) => r.backend === backend);
    const listed = [...new Set(own.flatMap((r) => r.models || []))];
    if (listed.length > 0) models[backend] = listed;
    else errors[backend] = (own.find((r) => r.error) || {}).error || `${source.command} not found`;
  }
  return { models, errors };
}

// #1176: discovery cached per resolved executable. Concurrent callers share
// one run, and a result (including a failed one) is reused for ttlMs.
function createModelCatalogCache({ list = listExecutableModels, ttlMs = DISCOVERY_CACHE_MS, now = Date.now } = {}) {
  const runs = new Map();
  const cachedList = (source, executable) => {
    const run = runs.get(executable);
    if (run && (run.at === null || now() - run.at < ttlMs)) return run.result;
    const next = { at: null, result: Promise.resolve().then(() => list(source, executable)) };
    next.result.catch(() => {}).then(() => { next.at = now(); });
    runs.set(executable, next);
    return next.result;
  };
  return function getModelCatalog(targets) {
    return discoverAgentModels({ targets, list: cachedList });
  };
}

module.exports = {
  MODEL_ID_PATTERN,
  isValidModelId,
  invalidAgentModelRefs,
  parseCodexModels,
  parseGrokModels,
  DISCOVERY_SOURCES,
  DISCOVERY_TIMEOUT_MS,
  discoveryTargets,
  discoverAgentModels,
  createModelCatalogCache,
};

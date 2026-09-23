"use strict";

// #1172: model-id validation + per-CLI model discovery.
//
// Validation: MODEL_ID_PATTERN is the one accepted model-id shape, enforced by
// the agent-models PUT route and by buildAgentArgs at spawn. It mirrors
// src/lib/agentModels.ts (Node can't load that .ts in production and the
// package doesn't ship src/lib/agentModels.ts); server/agentModels.test.js
// asserts the two patterns are identical.
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

const { execFile } = require("child_process");
const os = require("os");

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

function isValidModelId(id) {
  return typeof id === "string" && MODEL_ID_PATTERN.test(id);
}

// `codex debug models` → { models: [{ slug, visibility, ... }] }. Hidden
// (visibility "hide") entries are internal and not offered in the CLI picker.
function parseCodexModels(stdout) {
  const data = JSON.parse(stdout);
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
// the model catalog.
const DISCOVERY_SOURCES = {
  codex: { command: "codex", args: ["debug", "models"], parse: parseCodexModels },
  grok: { command: "grok", args: ["models"], parse: parseGrokModels },
};
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_CACHE_MS = 5 * 60 * 1000;
// `codex debug models` prints ~400 KB today (per-model instructions included).
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function runSource(source, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(source.command, source.args, {
      cwd: os.tmpdir(),
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    }, (err, stdout) => {
      if (!err) return resolve(stdout);
      // Short reasons only — never echo the CLI's stderr (it can carry account
      // details) back to the dashboard.
      if (err.killed && typeof err.code !== "string") return reject(new Error(`timed out after ${timeoutMs}ms`));
      if (err.code === "ENOENT") return reject(new Error(`${source.command} not found`));
      if (typeof err.code === "number") return reject(new Error(`exited with code ${err.code}`));
      reject(new Error(err.code || "failed to run"));
    });
    // No TTY and EOF on stdin: an interactive prompt can't wait for input.
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end();
    }
  });
}

// → { models: { [backend]: string[] }, errors: { [backend]: string } }. Never
// rejects: each backend either lists at least one model or reports an error.
async function discoverAgentModels({ sources = DISCOVERY_SOURCES, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  const models = {};
  const errors = {};
  await Promise.all(Object.entries(sources).map(async ([backend, source]) => {
    try {
      const list = [...new Set(source.parse(await runSource(source, timeoutMs)))];
      if (list.length === 0) throw new Error("no models listed");
      models[backend] = list;
    } catch (err) {
      errors[backend] = (err && err.message) || String(err);
    }
  }));
  return { models, errors };
}

// Cached, de-duplicated discovery: concurrent callers share one run, and a
// result (including a failed one) is reused for ttlMs.
function createModelCatalogCache({ discover = discoverAgentModels, ttlMs = DISCOVERY_CACHE_MS, now = Date.now } = {}) {
  let cached = null;
  let inflight = null;
  return function getModelCatalog() {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.result);
    if (!inflight) {
      inflight = Promise.resolve()
        .then(() => discover())
        .catch((err) => ({ models: {}, errors: { discovery: (err && err.message) || String(err) } }))
        .then((result) => {
          cached = { at: now(), result };
          inflight = null;
          return result;
        });
    }
    return inflight;
  };
}

module.exports = {
  MODEL_ID_PATTERN,
  isValidModelId,
  parseCodexModels,
  parseGrokModels,
  DISCOVERY_SOURCES,
  DISCOVERY_TIMEOUT_MS,
  discoverAgentModels,
  createModelCatalogCache,
};

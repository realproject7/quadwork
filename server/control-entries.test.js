// #1210: server/control-entries.js is the one definition of the entries
// QuadWork keeps directly under ~/.quadwork. Project cleanup and every new-id
// check in setup use it. The names below are spelled out here, not read from
// the module, so dropping an entry there fails this file.
//
// Run through `npm test` (server/run-tests.js), never directly.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { namesControlEntry } = require("./control-entries");

// The names for which namesControlEntry does not answer `expected`.
function wrong(names, expected) {
  return names.filter((name) => namesControlEntry(name) !== expected);
}

test("every entry QuadWork keeps directly under ~/.quadwork is covered", () => {
  assert.deepEqual(wrong([
    // Files
    ".env", "agentchattr.pid", "config.json", "config.lock", "reseed-state.json",
    "resource-state.json", "reviewer-token", "server.pid", "tg-bridge.pid",
    // Directories
    "agentchattr", "batch-request-watchers", "delivery-candidates", "head-control-audit",
    "head-control-work-task-domain", "task-review-rounds", "tmp", "work-task-pipelines",
    // Names made from a project id or from random characters
    "agentchattr-my-app.pid", "tg-bridge-cursor-my-app.json", "tg-bridge-offset-my-app.json",
    "telegram-bridge-cursor-my-app.json", "dc-bridge-cursor-my-app.json",
    "discord-bridge-cursor-my-app.json", `stop-${"0a".repeat(16)}.sock`,
    `.resource-exchange-probe-${"0a".repeat(12)}-a`, `.resource-exchange-probe-${"0a".repeat(12)}-b`,
    // The lock, temporary and recovery files QuadWork makes next to an entry
    "config.json.4242.tmp", `.config.json.resource-install-4242-${"0a".repeat(12)}.recovery`,
    "config.lock.4242.0b9e8f2c-5a1d-4c3b-9e7f-1a2b3c4d5e6f.tmp", ".resource-state.json.previous",
    "server.pid.lock", `server.pid.4242.${"0a".repeat(16)}.tmp`,
  ], true), []);
});

test("a name that differs from an entry only in case names that entry", () => {
  assert.deepEqual(wrong([
    "Config.json", "CONFIG.JSON", "AgentChattr", "Server.PID", "TMP", "Work-Task-Pipelines",
    // LONG S folds to "s" and KELVIN SIGN to "k".
    "ſerver.pid", "reviewer-toKen",
  ], true), []);
});

test("a project name close to an entry is not an entry", () => {
  assert.deepEqual(wrong([
    "my-app", "My Project", "agentchattr-fork", "agentchattr2", "config", "configjson",
    "x.config.json", "server", "stop-motion", "tg-bridge", "reviewer-tokens", "tmp-project",
    "tmpl", "work-task-pipelines-v2",
    // An entry's name with a suffix that QuadWork never makes. mktemp -d names
    // a folder tmp.XXXXXXXXXX.
    "tmp.tdyHjGd4cU", "agentchattr.io", "delivery-candidates.v2",
  ], false), []);
});

test("a value that is not a string is not an entry", () => {
  assert.deepEqual([undefined, null, 7, {}, ["config.json"]].filter((value) => namesControlEntry(value)), []);
});

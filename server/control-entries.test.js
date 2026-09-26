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
    ".env", "config.json", "config.lock", "reseed-state.json", "resource-state.json",
    "reviewer-token", "server.pid", "tg-bridge.pid",
    // Directories
    "agentchattr", "batch-request-watchers", "delivery-candidates", "head-control-audit",
    "head-control-work-task-domain", "task-review-rounds", "tmp", "work-task-pipelines",
    // Names made from a project id, a PID or a random part
    "agentchattr-my-app.pid", "tg-bridge-cursor-my-app.json", "tg-bridge-offset-my-app.json",
    "telegram-bridge-cursor-my-app.json", "dc-bridge-cursor-my-app.json",
    "discord-bridge-cursor-my-app.json", `stop-${"0".repeat(32)}.sock`,
    `.resource-exchange-probe-${"0".repeat(24)}-a`,
    // Lock, temporary and recovery files made from an entry's name
    "agentchattr.pid", "server.pid.lock", "server.pid.123.0a1b.tmp", "tg-bridge.pid.lock",
    "config.json.123.tmp", "config.lock.123.token.tmp", ".resource-state.json.previous",
    ".config.json.resource-install-123-0a1b.recovery",
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
  ], false), []);
});

test("a value that is not a string is not an entry", () => {
  assert.deepEqual([undefined, null, 7, {}, ["config.json"]].filter((value) => namesControlEntry(value)), []);
});

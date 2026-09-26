"use strict";

// #1210: the entries QuadWork keeps directly under ~/.quadwork, beside the
// project directories that are named by project id, and the lock, temporary
// and recovery files it makes next to some of them. A new project id may not
// name one of them, and project cleanup refuses them.
//
// A "*" stands for the part of a name that varies: a project id, a PID,
// random characters, or a PID and random characters.
const CONTROL_ENTRIES = Object.freeze([
  ".env",
  ".resource-exchange-probe-*-a",
  ".resource-exchange-probe-*-b",
  "agentchattr",
  "agentchattr-*.pid",
  "agentchattr.pid",
  "batch-request-watchers",
  "config.json",
  "config.json.*.tmp",
  ".config.json.resource-install-*.recovery",
  "config.lock",
  "config.lock.*.tmp",
  "dc-bridge-cursor-*.json",
  "delivery-candidates",
  "discord-bridge-cursor-*.json",
  "head-control-audit",
  "head-control-work-task-domain",
  "reseed-state.json",
  "resource-state.json",
  ".resource-state.json.previous",
  "reviewer-token",
  "server.pid",
  "server.pid.*.tmp",
  "server.pid.lock",
  "stop-*.sock",
  "task-review-rounds",
  "telegram-bridge-cursor-*.json",
  "tg-bridge-cursor-*.json",
  "tg-bridge-offset-*.json",
  "tg-bridge.pid",
  // The resource temp root that the VPS guide proposes (docs/install-vps.md).
  "tmp",
  "work-task-pipelines",
]);

// Compared case-insensitively, with Unicode simple case folding: on a
// case-insensitive file system, such as the macOS default, "Config.json"
// opens config.json.
const CONTROL_ENTRY_PATTERNS = CONTROL_ENTRIES.map((entry) => new RegExp(
  `^${entry.replace(/\./g, "\\.").replace(/\*/g, ".+")}$`, "iu"));

function namesControlEntry(name) {
  return typeof name === "string" && CONTROL_ENTRY_PATTERNS.some((pattern) => pattern.test(name));
}

module.exports = { namesControlEntry };

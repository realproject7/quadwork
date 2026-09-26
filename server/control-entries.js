"use strict";

// #1210: the entries QuadWork keeps directly under ~/.quadwork, beside the
// project directories that are named by project id. A new project id may not
// name one of them, and project cleanup refuses them.
//
// A "*" stands for a variable part: a project id, a PID or a random suffix.
// Each entry also covers the same name with a leading dot or with a trailing
// dot and suffix, the forms QuadWork uses for lock, temporary and recovery
// files.
const CONTROL_ENTRIES = Object.freeze([
  ".env",
  ".resource-exchange-probe-*",
  "agentchattr",
  "agentchattr-*.pid",
  "batch-request-watchers",
  "config.json",
  "config.lock",
  "dc-bridge-cursor-*.json",
  "delivery-candidates",
  "discord-bridge-cursor-*.json",
  "head-control-audit",
  "head-control-work-task-domain",
  "reseed-state.json",
  "resource-state.json",
  "reviewer-token",
  "server.pid",
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
// case-insensitive file system (the macOS and Windows default) "Config.json"
// opens config.json.
const CONTROL_ENTRY_PATTERNS = CONTROL_ENTRIES.map((entry) => new RegExp(
  `^\\.?${entry.replace(/\./g, "\\.").replace(/\*/g, ".+")}(?:\\..*)?$`, "iu"));

function namesControlEntry(name) {
  return typeof name === "string" && CONTROL_ENTRY_PATTERNS.some((pattern) => pattern.test(name));
}

module.exports = { namesControlEntry };

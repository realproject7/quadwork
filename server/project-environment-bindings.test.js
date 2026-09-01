"use strict";

const assert = require("node:assert/strict");
const {
  ENVIRONMENT_CLASSES,
  ProjectEnvironmentBindingError,
  normalizeProjectEnvironmentSettings,
  validateProjectEnvironmentSettings,
  disableWatcherForArchive,
  disableWatcherForUnarchive,
  hasRegisteredPeerBinding,
  buildProjectEnvironmentsMap,
  renderProjectEnvironmentsMap,
} = require("./project-environment-bindings");

const CURRENT_INSTALLATION = "installation_current_123456";
const PEER_INSTALLATION = "installation_peer_123456789";
const SECOND_PEER_INSTALLATION = "installation_second_123456";

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function resolver(calls) {
  return (project, key) => {
    calls.push({ project_id: project.id, key });
    if (key === "coord") return "Acme/Control";
    if (key === "ops") return "Acme/Operations";
    return null;
  };
}

function project(overrides = {}) {
  return {
    id: "control",
    name: "Control Plane",
    unrelated: { preserve: ["yes", 7] },
    working_dir: "/operator/private/control",
    host: "10.0.0.7",
    token: "never-export",
    capabilities: ["browser", "native"],
    live_session: { pid: 99 },
    repositories: [{ key: "coord", repo: "Wrong/Do-Not-Read", working_dir: "/operator/private/repo" }],
    coordination_repo_key: "coord",
    watch_batch_requests: true,
    environment_bindings: [{
      installation_id: PEER_INSTALLATION,
      project_id: "control",
      label: "  Mac Pro 16  ",
      environment_class: "local",
    }],
    ...overrides,
  };
}

function input(projectValue, calls = []) {
  return {
    installation_id: CURRENT_INSTALLATION,
    project: projectValue,
    resolveCanonicalRepository: resolver(calls),
  };
}

// Identity is immutable routing data; display edits normalize independently and
// preserve unrelated project data without mutating the caller's input.
{
  const calls = [];
  const source = deepFreeze(project({ environment_bindings: [
    {
      installation_id: PEER_INSTALLATION,
      project_id: "control",
      label: "  Mac Pro 16  ",
      environment_class: "local",
    },
    {
      installation_id: SECOND_PEER_INSTALLATION,
      project_id: "worker",
      label: "Hetzner",
      environment_class: "vps",
    },
  ] }));
  const normalized = normalizeProjectEnvironmentSettings(input(source, calls));
  const peer = normalized.project.environment_bindings[0];
  ok(peer.installation_id === PEER_INSTALLATION && peer.project_id === "control", "peer identity is exactly installation_id plus project_id");
  ok(peer.label === "Mac Pro 16" && peer.environment_class === "local", "display metadata is normalized without becoming identity");
  ok(normalized.project.environment_bindings.map((binding) => binding.label).join(",") === "Mac Pro 16,Hetzner", "peer display order is preserved exactly");
  ok(normalized.project.unrelated.preserve[1] === 7 && normalized.project !== source, "normalized project preserves unrelated fields without mutating input");
  ok(calls.length === 1 && calls[0].key === "coord" && normalized.coordination_repository.canonical_repository === "Acme/Control", "coordination repository is obtained only through the injected accessor");

  const edited = project({ environment_bindings: [{
    installation_id: PEER_INSTALLATION,
    project_id: "control",
    label: "Hetzner",
    environment_class: "vps",
  }] });
  const afterDisplayEdit = normalizeProjectEnvironmentSettings(input(edited));
  ok(afterDisplayEdit.project.environment_bindings[0].installation_id === peer.installation_id &&
     afterDisplayEdit.project.environment_bindings[0].project_id === peer.project_id &&
     afterDisplayEdit.project.environment_bindings[0].label === "Hetzner", "label/class edits never retarget peer identity");
}

// Identity, shape, self-binding, and metadata failures all surface typed,
// actionable result codes for a later authenticated Settings boundary.
{
  const duplicate = project({ environment_bindings: [
    { installation_id: PEER_INSTALLATION, project_id: "control", label: "Mac", environment_class: "local" },
    { installation_id: PEER_INSTALLATION, project_id: "control", label: "Renamed", environment_class: "vps" },
  ] });
  const duplicateResult = validateProjectEnvironmentSettings(input(duplicate));
  ok(!duplicateResult.ok && duplicateResult.error.code === "duplicate_environment_binding", "duplicate peer identity is rejected even when labels differ");

  const self = project({ environment_bindings: [{
    installation_id: CURRENT_INSTALLATION,
    project_id: "control",
    label: "This machine",
    environment_class: "local",
  }] });
  const selfResult = validateProjectEnvironmentSettings(input(self));
  ok(!selfResult.ok && selfResult.error.code === "environment_binding_self", "current installation/project cannot be stored as a peer");

  const malformed = project({ environment_bindings: [{
    installation_id: "short",
    project_id: "bad id with spaces",
    label: "line\nbreak",
    environment_class: "cloud",
  }] });
  const malformedResult = validateProjectEnvironmentSettings(input(malformed));
  ok(!malformedResult.ok && malformedResult.error.code === "invalid_installation_id" &&
     malformedResult.error.field === "environment_bindings[0].installation_id", "malformed peer identity is rejected with a typed field error");
  assert.throws(() => normalizeProjectEnvironmentSettings(input(malformed)), ProjectEnvironmentBindingError);
  ok(true, "throwing API exposes the typed environment-binding error class");
  ok(ENVIRONMENT_CLASSES.join(",") === "local,vps,other", "only the three coarse environment classes are accepted");
}

// A watcher is local state. It cannot be enabled without a currently resolved
// repository key and an accessor never derives a second repository authority.
{
  const removed = project({ coordination_repo_key: "removed" });
  const removedResult = validateProjectEnvironmentSettings(input(removed));
  ok(!removedResult.ok && removedResult.error.code === "coordination_repository_not_found" &&
     removedResult.error.field === "coordination_repo_key", "removed coordination repository key blocks watcher enablement");

  const missing = project({ coordination_repo_key: undefined });
  delete missing.coordination_repo_key;
  const missingResult = validateProjectEnvironmentSettings(input(missing));
  ok(!missingResult.ok && missingResult.error.code === "coordination_repository_required", "watcher enablement requires a selected registered repository");

  const inactive = project({ watch_batch_requests: false });
  delete inactive.coordination_repo_key;
  const inactiveResult = normalizeProjectEnvironmentSettings(input(inactive));
  ok(inactiveResult.project.watch_batch_requests === false && inactiveResult.coordination_repository === null, "disabled watcher may remain unset without inventing repository authority");
}

// Lifecycle helpers are immutable: archival disables immediately and unarchive
// never revives a subscription without a later explicit settings action.
{
  const source = deepFreeze(project());
  const archived = disableWatcherForArchive(source);
  const unarchived = disableWatcherForUnarchive({ ...source, archived: false });
  ok(archived.watch_batch_requests === false && source.watch_batch_requests === true, "archive disables only the local watcher without mutating source");
  ok(unarchived.watch_batch_requests === false && source.watch_batch_requests === true && unarchived.environment_bindings.length === 1 &&
     unarchived.unrelated.preserve[0] === "yes", "unarchive preserves disabled watcher and unrelated project data");
}

// The map is constructed from an explicit allow-list, not a spread of project
// input. It uses the accessor's canonical repository and excludes every
// incidental path, host, credential, live-state, or capability field.
{
  const calls = [];
  const source = project({ environment_bindings: [{
    installation_id: SECOND_PEER_INSTALLATION,
    project_id: "worker",
    label: "Emi's Mac",
    environment_class: "other",
  }] });
  const built = buildProjectEnvironmentsMap(input(source, calls));
  assert.equal(built.ok, true);
  assert.deepEqual(built.payload, {
    current: { installation_id: CURRENT_INSTALLATION, project_id: "control" },
    peers: [{
      installation_id: SECOND_PEER_INSTALLATION,
      project_id: "worker",
      label: "Emi's Mac",
      environment_class: "other",
    }],
    coordination_repository: { key: "coord", canonical_repository: "Acme/Control" },
    watch_batch_requests: true,
  });
  ok(Object.keys(built.payload).sort().join(",") === "coordination_repository,current,peers,watch_batch_requests", "map root is an explicit allow-list with no future project-field spread");
  const serialized = JSON.stringify(built.payload);
  ok(!/operator\/private|10\.0\.0\.7|never-export|browser|native|pid|Wrong\/Do-Not-Read/.test(serialized), "sanitized map excludes all non-allow-listed project input");
  ok(calls.length === 1 && built.payload.coordination_repository.canonical_repository === "Acme/Control", "map serializes only accessor-derived canonical repository identity");

  const rendered = renderProjectEnvironmentsMap(input(source));
  ok(rendered.ok && JSON.stringify(JSON.parse(rendered.content)) === JSON.stringify(rendered.payload), "renderer emits only the sanitized map payload");
}

// Removing a binding affects only future identity validation; it does not reach
// outside the local record or imply a remote deletion.
{
  const registered = input(project());
  ok(hasRegisteredPeerBinding({ ...registered, peer: { installation_id: PEER_INSTALLATION, project_id: "control" } }), "registered peer identity can be recognized locally");
  const removed = input(project({ environment_bindings: [] }));
  ok(!hasRegisteredPeerBinding({ ...removed, peer: { installation_id: PEER_INSTALLATION, project_id: "control" } }), "removed peer identity cannot validate a new request");
}

console.log(`\n${passed} passed`);
console.log("server/project-environment-bindings.test.js: all assertions passed");

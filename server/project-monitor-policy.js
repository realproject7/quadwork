"use strict";

// V2 Project Monitor's policy is deliberately pure.  It accepts only a
// narrow, server-derived observation shape and returns immutable condition
// records.  In particular, it never receives chat prose, a recipient, or a
// caller-selected cadence.  Delivery is owned by trusted-event-transport.

const crypto = require("crypto");

const MONITOR_POLICY_VERSION = 1;
const MONITOR_MODES = Object.freeze(["enabled", "suspended", "archived"]);
const MONITOR_MODE_SET = new Set(MONITOR_MODES);
const MONITOR_EVENT_KINDS = Object.freeze([
  "terminal_red_check",
  "draft_passing_dev_action",
  "worker_exit_before_status",
  "blocked",
  "waiting_overdue",
  "head_action_overdue",
  "merged_not_advanced",
  "next_loaded_unassigned",
]);
const MONITOR_EVENT_KIND_SET = new Set(MONITOR_EVENT_KINDS);

// These are fixed server policy constants, not an operator-facing interval.
// The timer is armed only while a concrete unresolved condition exists.
const FIRST_PROGRESS_GRACE_MS = 20 * 60 * 1000;
const WAITING_OVERDUE_MS = 60 * 60 * 1000;
const STRUCTURED_CHAT_SENDERS = new Set(["head"]);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,191}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === "string" && IDENTIFIER_RE.test(value) ? value : null;
}

function projectIdentifier(value) {
  return typeof value === "string" && PROJECT_ID_RE.test(value) ? value : null;
}

function finiteEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function normalizeAssignment(value) {
  if (!isPlainObject(value)) return null;
  const assignmentKey = identifier(value.assignment_key);
  const subjectKey = identifier(value.subject_key);
  if (!assignmentKey || !subjectKey) return null;
  const out = {
    assignment_key: assignmentKey,
    subject_key: subjectKey,
  };
  for (const field of ["cycle_id", "sha", "admission_generation", "session_generation", "installation_id", "repo_key"]) {
    const normalized = identifier(value[field]);
    if (normalized) out[field] = normalized;
  }
  return Object.freeze(out);
}

function exactKeys(value, permitted) {
  return Object.keys(value).every((key) => permitted.has(key));
}

// Structured markers are produced by the authenticated #1033 server path.
// A quoted/pasted marker is intentionally inert: it must begin the complete
// message and its JSON payload must have no unrecognised fields.
function parseQualifiedChatMarker(record) {
  if (!isPlainObject(record) || record.authenticated !== true || !STRUCTURED_CHAT_SENDERS.has(record.sender)) return null;
  if (record.type && record.type !== "message") return null;
  if (typeof record.text !== "string") return null;

  let marker = null;
  let encoded = null;
  if (record.text.startsWith("[ASSIGN] ")) {
    marker = "ASSIGN";
    encoded = record.text.slice("[ASSIGN] ".length);
  } else if (record.text.startsWith("[STATUS] ")) {
    marker = "STATUS";
    encoded = record.text.slice("[STATUS] ".length);
  } else {
    return null;
  }
  if (!encoded || encoded !== encoded.trim()) return null;

  let payload;
  try { payload = JSON.parse(encoded); } catch { return null; }
  if (!isPlainObject(payload)) return null;

  const assignment = normalizeAssignment(payload);
  if (!assignment) return null;
  const observedAt = finiteEpoch(payload.observed_at);
  if (marker === "ASSIGN") {
    if (!exactKeys(payload, new Set(["assignment_key", "subject_key", "cycle_id", "sha", "admission_generation", "session_generation", "installation_id", "repo_key", "observed_at"]))) return null;
    return Object.freeze({ marker, assignment, observed_at: observedAt });
  }

  if (!exactKeys(payload, new Set(["assignment_key", "subject_key", "cycle_id", "sha", "admission_generation", "session_generation", "installation_id", "repo_key", "status", "waiting_name", "observed_at"]))) return null;
  const status = typeof payload.status === "string" ? payload.status : null;
  if (!new Set(["BLOCKED", "WAITING", "PROGRESS", "DONE"]).has(status)) return null;
  const waitingName = identifier(payload.waiting_name);
  if (payload.waiting_name !== undefined && !waitingName) return null;
  return Object.freeze({ marker, assignment, status, waiting_name: waitingName, observed_at: observedAt });
}

function normalizeCi(value) {
  if (!isPlainObject(value)) return Object.freeze({ required_state: "unknown", draft: false, dev_action_pending: false });
  const state = ["red", "passing", "pending", "unknown"].includes(value.required_state)
    ? value.required_state : "unknown";
  return Object.freeze({
    required_state: state,
    draft: value.draft === true,
    dev_action_pending: value.dev_action_pending === true,
  });
}

function normalizeRuntime(value) {
  if (!isPlainObject(value)) return Object.freeze({ process_exited: false, status_confirmed: false });
  return Object.freeze({
    process_exited: value.process_exited === true,
    status_confirmed: value.status_confirmed === true,
  });
}

function normalizeProgression(value) {
  if (!isPlainObject(value)) return Object.freeze({ merged_not_advanced: false, next_loaded_unassigned: false });
  return Object.freeze({
    merged_not_advanced: value.merged_not_advanced === true,
    next_loaded_unassigned: value.next_loaded_unassigned === true,
  });
}

function normalizeHeadAction(value) {
  if (!isPlainObject(value)) return Object.freeze({ outstanding: false, due_at: null });
  return Object.freeze({
    outstanding: value.outstanding === true,
    due_at: finiteEpoch(value.due_at),
  });
}

function normalizeProgress(value) {
  if (!isPlainObject(value)) return Object.freeze({ first_progress_at: null, last_progress_at: null });
  return Object.freeze({
    first_progress_at: finiteEpoch(value.first_progress_at),
    last_progress_at: finiteEpoch(value.last_progress_at),
  });
}

function normalizeObservation(input) {
  if (!isPlainObject(input)) throw new TypeError("monitor_observation_invalid");
  const projectId = projectIdentifier(input.project_id);
  if (!projectId) throw new TypeError("monitor_project_invalid");
  const mode = MONITOR_MODE_SET.has(input.mode) ? input.mode : "suspended";
  const markers = Array.isArray(input.chat_records)
    ? input.chat_records.map(parseQualifiedChatMarker).filter(Boolean)
    : [];
  return Object.freeze({
    project_id: projectId,
    mode,
    readiness: input.readiness === true,
    assignment: normalizeAssignment(input.assignment),
    ci: normalizeCi(input.ci),
    runtime: normalizeRuntime(input.runtime),
    progression: normalizeProgression(input.progression),
    head_action: normalizeHeadAction(input.head_action),
    progress: normalizeProgress(input.progress),
    markers: Object.freeze(markers),
  });
}

function condition(kind, assignment, source, options = {}) {
  if (!MONITOR_EVENT_KIND_SET.has(kind)) throw new TypeError("monitor_kind_invalid");
  const anchorSeed = { kind, assignment, source, threshold: options.threshold_generation || null };
  const anchors = {
    project_id: options.project_id,
    assignment_key: assignment.assignment_key,
    subject_key: assignment.subject_key,
    event_generation: canonicalHash(anchorSeed).slice(0, 32),
  };
  for (const field of ["cycle_id", "sha", "admission_generation", "session_generation", "installation_id", "repo_key"]) {
    if (assignment[field]) anchors[field] = assignment[field];
  }
  if (options.threshold_generation) anchors.threshold_generation = options.threshold_generation;
  const key = `${kind}:${canonicalHash(anchors).slice(0, 32)}`;
  return Object.freeze({
    key,
    kind,
    anchors: Object.freeze(anchors),
    due_at: options.due_at ?? null,
    immediate: options.immediate === true,
  });
}

function uniqueConditions(conditions) {
  return Object.freeze([...new Map(conditions.map((item) => [item.key, item])).values()]);
}

function evaluateMonitorPolicy(input, options = {}) {
  const now = finiteEpoch(options.now) ?? Date.now();
  const observation = normalizeObservation(input);
  const observationHash = canonicalHash(observation);
  const result = {
    policy_version: MONITOR_POLICY_VERSION,
    observation,
    observation_hash: observationHash,
    conditions: Object.freeze([]),
    stall_state: "not_applicable",
  };
  if (observation.mode !== "enabled" || observation.readiness !== true || !observation.assignment) {
    return Object.freeze(result);
  }

  const assignment = observation.assignment;
  const conditions = [];
  const immediate = (kind, source) => conditions.push(condition(kind, assignment, source, {
    project_id: observation.project_id,
    immediate: true,
  }));
  const delayed = (kind, source, dueAt) => {
    const thresholdGeneration = canonicalHash({ kind, source, due_at: dueAt }).slice(0, 24);
    conditions.push(condition(kind, assignment, source, {
      project_id: observation.project_id,
      due_at: dueAt,
      threshold_generation: thresholdGeneration,
      immediate: dueAt <= now,
    }));
  };

  if (observation.ci.required_state === "red") immediate("terminal_red_check", { ci: "red" });
  if (observation.ci.required_state === "passing" && observation.ci.draft && observation.ci.dev_action_pending) {
    immediate("draft_passing_dev_action", { ci: "passing_draft" });
  }
  if (observation.runtime.process_exited && !observation.runtime.status_confirmed) {
    immediate("worker_exit_before_status", { runtime: "exit_before_status" });
  }
  if (observation.progression.merged_not_advanced) immediate("merged_not_advanced", { progression: "merged_not_advanced" });
  if (observation.progression.next_loaded_unassigned) immediate("next_loaded_unassigned", { progression: "next_loaded_unassigned" });
  if (observation.head_action.outstanding && observation.head_action.due_at !== null) {
    delayed("head_action_overdue", { due_at: observation.head_action.due_at }, observation.head_action.due_at);
  }

  for (const marker of observation.markers) {
    if (marker.marker !== "STATUS" || marker.assignment.assignment_key !== assignment.assignment_key
      || marker.assignment.subject_key !== assignment.subject_key) continue;
    if (marker.status === "BLOCKED") immediate("blocked", { marker: "BLOCKED", observed_at: marker.observed_at });
    if (marker.status === "WAITING" && marker.waiting_name && marker.observed_at !== null) {
      delayed("waiting_overdue", {
        marker: "WAITING",
        waiting_name: marker.waiting_name,
        observed_at: marker.observed_at,
      }, marker.observed_at + WAITING_OVERDUE_MS);
    }
  }

  // Progress-stall is deliberately not a generic wake.  These states make the
  // grace/suspension rule explicit for callers and tests without creating an
  // unspecified pulse event.
  if (observation.ci.required_state === "pending") result.stall_state = "suspended_nonterminal_ci";
  else if (observation.progress.first_progress_at !== null && now - observation.progress.first_progress_at < FIRST_PROGRESS_GRACE_MS) {
    result.stall_state = "first_progress_grace";
  } else if (observation.progress.last_progress_at !== null) result.stall_state = "observed";

  result.conditions = uniqueConditions(conditions);
  return Object.freeze(result);
}

module.exports = {
  MONITOR_POLICY_VERSION,
  MONITOR_MODES,
  MONITOR_EVENT_KINDS,
  FIRST_PROGRESS_GRACE_MS,
  WAITING_OVERDUE_MS,
  canonicalHash,
  normalizeObservation,
  parseQualifiedChatMarker,
  evaluateMonitorPolicy,
};

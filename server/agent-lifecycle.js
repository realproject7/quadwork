"use strict";

// V2 agent lifecycle governor. This is deliberately a small, server-owned
// state machine rather than a general job runner: it owns one current record
// per project/role, bounded recovery evidence, and an atomic reservation.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LIFECYCLE_VERSION = 1;
const LIFECYCLE_FILENAME = "agent-lifecycle-state.json";
const ROLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LIFECYCLE_STATES = Object.freeze([
  "rejected", "reserved", "launch_failed", "spawned", "verified",
  "exited", "unresponsive", "timed_out", "resource_killed", "stopped",
]);
const LIFECYCLE_STATE_SET = new Set(LIFECYCLE_STATES);
const AUTOMATIC_SOURCES = new Set(["startup_restore", "watchdog", "self_heal", "head_recovery", "reseed"]);
const OPERATOR_SOURCES = new Set(["operator_start", "operator_restart", "operator_reset", "operator_recovery"]);
const HEAD_RECOVERY_SOURCE = "head_recovery";
const MAX_AUTOMATIC_EARLY_EXIT_RETRIES = 1;
// #1073: Head may take at most this many circuit trials per assignment, over
// every failure signature that assignment's circuits open with.  The budget
// resets only when the circuit belongs to a different assignment identity or
// when an operator's trial clears the circuit; Head's own post never resets it.
const MAX_HEAD_TRIALS_PER_ASSIGNMENT = 1;
const HEAD_TRIAL_BUDGET_SIGNATURE = "head_trial";

class AgentLifecycleError extends Error {
  constructor(code) {
    super(code);
    this.name = "AgentLifecycleError";
    this.code = code;
  }
}

function identifier(value, field) {
  if (typeof value !== "string" || !ROLE_ID_RE.test(value)) {
    throw new AgentLifecycleError(`invalid_${field}`);
  }
  return value;
}

function timestamp(now) {
  const value = now();
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AgentLifecycleError("invalid_clock");
  return parsed.toISOString();
}

function randomId(randomUUID, field) {
  const value = randomUUID();
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) {
    throw new AgentLifecycleError(`invalid_${field}`);
  }
  return value;
}

// The circuit's loss correlation anchors (project, role, work identity,
// failure signature).  It is echoed back by an explicit trial, so it must
// stay within the persisted bound regardless of the assignment key's size.
function lossCorrelationFor(projectId, role, record, signature) {
  const identity = record?.expected_assignment?.assignment_key || `${projectId}/${role}`;
  return `${crypto.createHash("sha256").update(`${projectId}\n${role}\n${identity}`).digest("hex").slice(0, 32)}:${signature}`;
}

function projectStatePath(homeDir, projectId) {
  return path.join(homeDir, ".quadwork", identifier(projectId, "project"), LIFECYCLE_FILENAME);
}

function initialState() {
  return { version: LIFECYCLE_VERSION, roles: Object.create(null) };
}

function safeAssignment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const assignmentKey = typeof value.assignment_key === "string" && value.assignment_key.length <= 512
    ? value.assignment_key
    : null;
  const attempt = typeof value.assignment_attempt === "string" && value.assignment_attempt.length <= 512
    ? value.assignment_attempt
    : null;
  const digest = typeof value.issue_contract_digest === "string" && /^[a-f0-9]{64}$/i.test(value.issue_contract_digest)
    ? value.issue_contract_digest.toLowerCase()
    : null;
  if (assignmentKey === null && attempt === null && digest === null) return null;
  return Object.freeze({ assignment_key: assignmentKey, assignment_attempt: attempt, issue_contract_digest: digest });
}

function safeCircuit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const open = value.open === true;
  const reason = typeof value.reason === "string" && value.reason.length <= 128 ? value.reason : null;
  const automaticRetries = Number.isSafeInteger(value.automatic_retries) && value.automatic_retries >= 0
    && value.automatic_retries <= MAX_AUTOMATIC_EARLY_EXIT_RETRIES
    ? value.automatic_retries
    : 0;
  const lossCorrelation = typeof value.loss_correlation === "string" && value.loss_correlation.length <= 128
    ? value.loss_correlation
    : null;
  const trialOperationId = typeof value.trial_operation_id === "string" && value.trial_operation_id.length <= 64
    ? value.trial_operation_id
    : null;
  const expectedGeneration = typeof value.expected_generation === "string" && value.expected_generation.length <= 64
    ? value.expected_generation
    : null;
  const headTrialOperationId = typeof value.head_trial_operation_id === "string" && value.head_trial_operation_id.length <= 64
    ? value.head_trial_operation_id
    : null;
  const headTrialAssignment = typeof value.head_trial_assignment === "string" && value.head_trial_assignment.length <= 128
    ? value.head_trial_assignment
    : null;
  const headTrials = Number.isSafeInteger(value.head_trials) && value.head_trials >= 0
    && value.head_trials <= MAX_HEAD_TRIALS_PER_ASSIGNMENT
    ? value.head_trials
    : 0;
  return Object.freeze({
    open,
    reason,
    automatic_retries: automaticRetries,
    loss_correlation: lossCorrelation,
    expected_generation: expectedGeneration,
    trial_operation_id: trialOperationId,
    head_trial_operation_id: headTrialOperationId,
    head_trial_assignment: headTrialAssignment,
    head_trials: headTrials,
  });
}

function safeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.operation_id !== "string" || value.operation_id.length > 64
    || typeof value.generation_id !== "string" || value.generation_id.length > 64
    || !LIFECYCLE_STATE_SET.has(value.state)) return null;
  const observation = value.last_observation && typeof value.last_observation === "object"
    && typeof value.last_observation.at === "string" && typeof value.last_observation.health === "string"
    ? { at: value.last_observation.at, health: value.last_observation.health }
    : null;
  return {
    operation_id: value.operation_id,
    generation_id: value.generation_id,
    state: value.state,
    source: typeof value.source === "string" && value.source.length <= 64 ? value.source : "unknown",
    expected_assignment: safeAssignment(value.expected_assignment),
    circuit: safeCircuit(value.circuit),
    last_observation: observation,
    unresolved_loss: typeof value.unresolved_loss === "string" && value.unresolved_loss.length <= 128 ? value.unresolved_loss : null,
  };
}

function serializableRecord(record) {
  return {
    operation_id: record.operation_id,
    generation_id: record.generation_id,
    state: record.state,
    source: record.source,
    expected_assignment: record.expected_assignment,
    circuit: record.circuit,
    last_observation: record.last_observation,
    unresolved_loss: record.unresolved_loss,
  };
}

function redactedRecord(record) {
  if (!record) return null;
  return Object.freeze({
    operation_id: record.operation_id,
    generation_id: record.generation_id,
    state: record.state,
    verification_state: record.state === "verified" ? "verified" : "unconfirmed",
    last_observation: record.last_observation,
    circuit: record.circuit ? Object.freeze({
      open: record.circuit.open,
      reason: record.circuit.reason,
      automatic_retries: record.circuit.automatic_retries,
      loss_correlation: record.circuit.loss_correlation,
      expected_generation: record.circuit.expected_generation,
      trial_operation_id: record.circuit.trial_operation_id,
      head_trial_operation_id: record.circuit.head_trial_operation_id,
      head_trial_assignment: record.circuit.head_trial_assignment,
      head_trials: record.circuit.head_trials,
    }) : null,
  });
}

function stateFromDisk(fsImpl, filePath, projectId) {
  let stat;
  try { stat = fsImpl.lstatSync(filePath); }
  catch (error) {
    if (error && error.code === "ENOENT") return initialState();
    throw new AgentLifecycleError("lifecycle_state_unreadable");
  }
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
    || (expectedUid !== null && stat.uid !== expectedUid)) {
    throw new AgentLifecycleError("lifecycle_state_unsafe");
  }
  let raw;
  try { raw = fsImpl.readFileSync(filePath, "utf8"); }
  catch { throw new AgentLifecycleError("lifecycle_state_unreadable"); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new AgentLifecycleError("lifecycle_state_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.version !== LIFECYCLE_VERSION || !parsed.roles || typeof parsed.roles !== "object" || Array.isArray(parsed.roles)) {
    throw new AgentLifecycleError("lifecycle_state_invalid");
  }
  const out = initialState();
  for (const [role, rawRecord] of Object.entries(parsed.roles)) {
    identifier(role, "role");
    const record = safeRecord(rawRecord);
    if (!record) throw new AgentLifecycleError("lifecycle_state_invalid");
    // A circuit persisted before the digest-bounded correlation kept the raw
    // `${assignment_key}:<reason>`, which safeCircuit drops as over-length and
    // so left an open circuit that no trial could ever name.  Re-derive the
    // same digest a fresh opening writes.  Only an open circuit with no
    // surviving correlation is touched, so this is idempotent and can neither
    // invent a correlation for a closed circuit nor replace a present one.
    if (record.circuit?.open && record.circuit.loss_correlation === null && record.circuit.reason) {
      record.circuit = Object.freeze({
        ...record.circuit,
        loss_correlation: lossCorrelationFor(projectId, role, record, record.circuit.reason),
      });
    }
    out.roles[role] = record;
  }
  return out;
}

function persistState(fsImpl, filePath, state) {
  const directory = path.dirname(filePath);
  try {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dirStat = fsImpl.lstatSync(directory);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()
      || (expectedUid !== null && dirStat.uid !== expectedUid)) throw new Error("unsafe lifecycle directory");
    const data = JSON.stringify({
      version: LIFECYCLE_VERSION,
      roles: Object.fromEntries(Object.entries(state.roles).map(([role, record]) => [role, serializableRecord(record)])),
    });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`;
    const fd = fsImpl.openSync(temporary, "wx", 0o600);
    try {
      fsImpl.writeFileSync(fd, data, "utf8");
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    fsImpl.renameSync(temporary, filePath);
    try { fsImpl.chmodSync(filePath, 0o600); } catch {}
  } catch (error) {
    if (error instanceof AgentLifecycleError) throw error;
    throw new AgentLifecycleError("lifecycle_state_persist_failed");
  }
}

function resourceDecision(platform, snapshot, reservations, containedLaunch) {
  if (platform !== "linux") return { ok: true, capacity: null };
  if (!snapshot || typeof snapshot !== "object") return { ok: false, reason: "containment_unavailable", facts: null };
  const pressure = snapshot.pressure && typeof snapshot.pressure === "object" ? snapshot.pressure : null;
  const capacity = snapshot.scope_capacity && typeof snapshot.scope_capacity === "object" ? snapshot.scope_capacity : null;
  if (snapshot.status !== "ready" || !pressure || pressure.status !== "ready" || !capacity || containedLaunch !== true) {
    // candidate_pending_staging and any malformed/unknown observation are
    // deliberately one stable admission result. No caller may convert a
    // capability string into permission to use an uncontained node-pty child.
    const reason = pressure?.reason === "capacity_exhausted" ? "capacity_exhausted" : "containment_unavailable";
    return { ok: false, reason, facts: null };
  }
  const admitted = capacity.admitted_worker_scopes;
  const maximum = capacity.reserved_worker_scopes;
  if (!Number.isSafeInteger(admitted) || !Number.isSafeInteger(maximum) || admitted < 0 || maximum <= 0) {
    return { ok: false, reason: "containment_unavailable", facts: null };
  }
  if (admitted + reservations >= maximum) {
    return { ok: false, reason: "capacity_exhausted", facts: { admitted_worker_scopes: admitted, reserved_worker_scopes: maximum } };
  }
  return { ok: true, capacity: { admitted_worker_scopes: admitted, reserved_worker_scopes: maximum } };
}

class AgentLifecycleGovernor {
  constructor(options = {}) {
    this.fs = options.fsImpl || fs;
    this.homeDir = options.homeDir || os.homedir();
    this.platform = options.platform || process.platform;
    this.now = options.now || (() => new Date());
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.resourceSnapshot = options.resourceSnapshot || (() => null);
    this.currentWork = options.currentWork || (async () => ({ current: false, assignment: null }));
    this.projectEligible = options.projectEligible || (() => true);
    this.testOverrideFor = options.testOverrideFor || null;
    this._tail = Promise.resolve();
    this._reservations = new Set();
  }

  _serial(fn) {
    const run = this._tail.catch(() => {}).then(fn);
    this._tail = run.catch(() => {});
    return run;
  }

  _read(projectId) {
    return stateFromDisk(this.fs, projectStatePath(this.homeDir, projectId), projectId);
  }

  _write(projectId, state) {
    persistState(this.fs, projectStatePath(this.homeDir, projectId), state);
  }

  _rejected(reason, record = null, facts = null) {
    return Object.freeze({ status: "rejected", reason, operation: redactedRecord(record), facts });
  }

  async reserve(input = {}) {
    return this._serial(async () => {
      const projectId = identifier(input.projectId, "project");
      const role = identifier(input.role, "role");
      const source = typeof input.source === "string" ? input.source : "unknown";
      const assignment = safeAssignment(input.assignment);
      const isAutomatic = AUTOMATIC_SOURCES.has(source);
      const isOperator = OPERATOR_SOURCES.has(source);
      if (!isAutomatic && !isOperator) return this._rejected("source_not_authorized");
      if (this.projectEligible(projectId) !== true) return this._rejected("project_unavailable");
      if (isOperator && input.operatorAuthorized !== true) return this._rejected("operator_authorization_required");

      const work = await this.currentWork(projectId, role);
      const current = work && work.current === true;
      const expectedAssignment = assignment || safeAssignment(work && work.assignment);
      const manualHeadIntake = isOperator && role === "head" && input.allowHeadIntake === true;
      const manualFullReset = source === "operator_reset" && input.fullReset === true;
      const manualExactRole = isOperator && input.explicitRole === true;
      if ((isAutomatic || (role !== "head" && !manualFullReset && !manualExactRole)) && !current) {
        return this._rejected("no_current_assignment");
      }
      if (role === "head" && !current && !manualHeadIntake && !manualFullReset) {
        return this._rejected("no_current_assignment");
      }

      const state = this._read(projectId);
      let previous = state.roles[role] || null;
      if (input.operationId && previous && previous.operation_id === input.operationId) {
        return Object.freeze({ status: previous.state, idempotent: true, operation: redactedRecord(previous) });
      }
      const priorCircuit = previous && previous.circuit ? previous.circuit : null;
      // #1044: the server-assigned `head_recovery` source keeps every bounded
      // automatic-retry rule, and may additionally take the one explicit
      // circuit trial. Watchdog/startup/self-heal/reseed never can.
      const headTrial = source === HEAD_RECOVERY_SOURCE && priorCircuit?.open === true;
      const headTrialBudget = headTrial ? lossCorrelationFor(projectId, role, previous, HEAD_TRIAL_BUDGET_SIGNATURE) : null;
      if (isAutomatic && priorCircuit?.open && !headTrial) return this._rejected("circuit_open", previous);
      if (priorCircuit?.open && (isOperator || headTrial)) {
        const authorizedTrial = typeof input.lossCorrelation === "string"
          && input.lossCorrelation === priorCircuit.loss_correlation
          && typeof input.expectedGeneration === "string"
          && input.expectedGeneration === priorCircuit.expected_generation;
        if (!authorizedTrial) return this._rejected(headTrial ? "circuit_open" : "circuit_trial_authorization_required", previous);
        // Retrying the same authorized request while the one trial is still
        // live is an observation of its existing operation, never another
        // process reservation. This check is intentionally before stale-PTY
        // reconciliation: a dashboard/MCP duplicate has no kill authority.
        if (priorCircuit.trial_operation_id && ["reserved", "spawned", "verified"].includes(previous.state)) {
          return Object.freeze({ status: previous.state, idempotent: true, operation: redactedRecord(previous) });
        }
        // A failed Head-initiated trial cannot be chained by Head; only a
        // fresh human Operator action may authorize another single trial.
        // #1073: the same holds when Head's trial posted and then crashed.
        // Its post cleared the circuit, so consumed trials are budgeted per
        // assignment identity (the same anchor every loss correlation is
        // derived from, whichever failure signature re-opened the circuit).
        if (headTrial && (priorCircuit.head_trial_operation_id
          || (priorCircuit.head_trial_assignment === headTrialBudget
            && priorCircuit.head_trials >= MAX_HEAD_TRIALS_PER_ASSIGNMENT))) {
          return this._rejected("head_trial_consumed", previous);
        }
      } else if (input.expectedGeneration && (!previous || previous.generation_id !== input.expectedGeneration)) {
        return this._rejected("stale_expected_generation", previous);
      }
      if (previous && ["reserved", "spawned", "verified"].includes(previous.state)) {
        if (input.liveSession === true) {
          return Object.freeze({ status: previous.state, idempotent: true, operation: redactedRecord(previous) });
        }
        // A state file can outlive the server process. Reservations are never
        // blindly replayed: without the caller's current PTY observation the
        // old generation is only an unknown terminal observation, then a fresh
        // admission rechecks Current Batch and capacity.
        previous = {
          ...previous,
          state: "exited",
          last_observation: { at: timestamp(this.now), health: "unknown" },
        };
        state.roles[role] = previous;
        this._write(projectId, state);
      }
      if (isAutomatic && !headTrial && priorCircuit && priorCircuit.automatic_retries >= MAX_AUTOMATIC_EARLY_EXIT_RETRIES) {
        const circuit = {
          ...priorCircuit,
          open: true,
          reason: "early_exit",
          loss_correlation: priorCircuit.loss_correlation || lossCorrelationFor(projectId, role, previous, "early_exit"),
          expected_generation: previous.generation_id,
          trial_operation_id: null,
          head_trial_operation_id: null,
        };
        state.roles[role] = { ...previous, state: "rejected", circuit, last_observation: { at: timestamp(this.now), health: "unknown" } };
        this._write(projectId, state);
        return this._rejected("circuit_open", state.roles[role]);
      }

      const testOverride = typeof this.testOverrideFor === "function"
        ? this.testOverrideFor(input.testFixture)
        : null;
      const runtimePlatform = testOverride?.runtimePlatform === "linux" || testOverride?.runtimePlatform === "darwin"
        ? testOverride.runtimePlatform
        : this.platform;
      const snapshotReader = typeof testOverride?.resourceSnapshot === "function"
        ? testOverride.resourceSnapshot
        : this.resourceSnapshot;
      let snapshot = null;
      try { snapshot = snapshotReader(); } catch {}
      const resource = resourceDecision(runtimePlatform, snapshot, this._reservations.size, input.containedLaunch);
      if (!resource.ok) return this._rejected(resource.reason, previous, resource.facts);

      const operationId = input.operationId || randomId(this.randomUUID, "operation_id");
      const generationId = randomId(this.randomUUID, "generation_id");
      const circuit = priorCircuit ? {
        ...priorCircuit,
        open: priorCircuit.open,
        // The explicit trial is not an automatic retry; the bounded counter
        // stays within its policy constant so persistence cannot reset it.
        automatic_retries: isAutomatic && !headTrial ? priorCircuit.automatic_retries + 1 : priorCircuit.automatic_retries,
        expected_generation: priorCircuit.expected_generation,
        trial_operation_id: priorCircuit.open ? operationId : null,
        head_trial_operation_id: headTrial ? operationId : priorCircuit.head_trial_operation_id,
        head_trial_assignment: headTrial ? headTrialBudget : priorCircuit.head_trial_assignment,
        head_trials: headTrial
          ? (priorCircuit.head_trial_assignment === headTrialBudget ? priorCircuit.head_trials : 0) + 1
          : priorCircuit.head_trials,
      } : {
        open: false,
        reason: null,
        automatic_retries: isAutomatic ? 1 : 0,
        loss_correlation: null,
        expected_generation: null,
        trial_operation_id: null,
        head_trial_operation_id: null,
        head_trial_assignment: null,
        head_trials: 0,
      };
      const record = {
        operation_id: operationId,
        generation_id: generationId,
        state: "reserved",
        source,
        expected_assignment: expectedAssignment,
        circuit,
        last_observation: { at: timestamp(this.now), health: "unknown" },
        unresolved_loss: priorCircuit?.loss_correlation || null,
      };
      state.roles[role] = record;
      this._write(projectId, state);
      this._reservations.add(`${projectId}/${role}/${operationId}`);
      return Object.freeze({ status: "reserved", operation: redactedRecord(record), capacity: resource.capacity });
    });
  }

  async transition(input = {}) {
    return this._serial(() => {
      const projectId = identifier(input.projectId, "project");
      const role = identifier(input.role, "role");
      const next = input.status;
      if (!LIFECYCLE_STATE_SET.has(next)) throw new AgentLifecycleError("invalid_lifecycle_status");
      const state = this._read(projectId);
      const previous = state.roles[role];
      if (!previous || previous.operation_id !== input.operationId || previous.generation_id !== input.generationId) {
        return this._rejected("stale_generation", previous || null);
      }
      const circuit = previous.circuit
        ? { ...previous.circuit }
        : {
          open: false,
          reason: null,
          automatic_retries: 0,
          loss_correlation: null,
          expected_generation: null,
          trial_operation_id: null,
          head_trial_operation_id: null,
          head_trial_assignment: null,
          head_trials: 0,
        };
      let unresolvedLoss = previous.unresolved_loss;
      if (next === "resource_killed") {
        unresolvedLoss = input.lossCorrelation || lossCorrelationFor(projectId, role, previous, "resource_killed");
        circuit.open = true;
        circuit.reason = "resource_killed";
        circuit.loss_correlation = unresolvedLoss;
        circuit.expected_generation = previous.generation_id;
        circuit.trial_operation_id = null;
      } else if (next === "verified" && circuit.trial_operation_id === previous.operation_id && input.structuredStatus === true) {
        // The trial clears only on the runtime's structured confirmation: an
        // action authenticated with this generation's own shim token, never
        // the first PTY bytes, which a banner-then-crash also produces.
        // #1073: a post-then-crash clears too, so Head's per-assignment
        // budget is kept; only an operator's clearing trial resets it.
        if (circuit.head_trial_operation_id !== previous.operation_id) {
          circuit.head_trial_assignment = null;
          circuit.head_trials = 0;
        }
        circuit.open = false;
        circuit.reason = null;
        circuit.loss_correlation = null;
        circuit.expected_generation = null;
        circuit.trial_operation_id = null;
        circuit.head_trial_operation_id = null;
        circuit.automatic_retries = 0;
        unresolvedLoss = null;
      } else if (circuit.open && circuit.trial_operation_id === previous.operation_id
        && ["launch_failed", "exited", "timed_out", "resource_killed", "stopped"].includes(next)) {
        // A failed trial remains an open circuit, but its generation becomes
        // the next human authorization anchor. Automatic sources never pass
        // this gate, and a duplicate cannot chain another process.
        circuit.expected_generation = previous.generation_id;
        circuit.trial_operation_id = null;
      }
      const record = {
        ...previous,
        state: next,
        circuit,
        unresolved_loss: unresolvedLoss,
        last_observation: { at: timestamp(this.now), health: input.health || (next === "verified" ? "running" : "unknown") },
      };
      state.roles[role] = record;
      this._write(projectId, state);
      this._reservations.delete(`${projectId}/${role}/${previous.operation_id}`);
      return Object.freeze({ status: next, operation: redactedRecord(record) });
    });
  }

  async launch(input = {}) {
    const reservation = await this.reserve(input);
    if (reservation.idempotent) return reservation;
    if (reservation.status !== "reserved") return reservation;
    const operation = reservation.operation;
    try {
      const launched = await input.launch({ operation_id: operation.operation_id, generation_id: operation.generation_id });
      if (!launched || launched.ok !== true) {
        const terminal = await this.transition({
          projectId: input.projectId,
          role: input.role,
          operationId: operation.operation_id,
          generationId: operation.generation_id,
          status: launched?.code === "project_archived" ? "rejected" : "launch_failed",
        });
        // Lifecycle state says this generation was rejected; the public
        // response retains the authoritative admission barrier rather than
        // mislabelling an archive race as a generic launch failure.
        if (launched?.code === "project_archived") {
          return Object.freeze({ status: "rejected", reason: "project_archived", operation: terminal.operation || null });
        }
        return terminal;
      }
      const spawned = await this.transition({ projectId: input.projectId, role: input.role, operationId: operation.operation_id, generationId: operation.generation_id, status: "spawned", health: "unknown" });
      return Object.freeze({ ...spawned, pid: Number.isSafeInteger(launched.pid) ? launched.pid : null });
    } catch {
      return this.transition({ projectId: input.projectId, role: input.role, operationId: operation.operation_id, generationId: operation.generation_id, status: "launch_failed" });
    }
  }

  snapshot(projectId, role) {
    const state = this._read(identifier(projectId, "project"));
    return redactedRecord(state.roles[identifier(role, "role")] || null);
  }

  async cancelProject(projectId) {
    return this._serial(() => {
      const project = identifier(projectId, "project");
      const state = this._read(project);
      for (const [role, record] of Object.entries(state.roles)) {
        if (record.state === "reserved") {
          state.roles[role] = { ...record, state: "stopped", last_observation: { at: timestamp(this.now), health: "unknown" } };
          this._reservations.delete(`${project}/${role}/${record.operation_id}`);
        }
      }
      this._write(project, state);
    });
  }
}

module.exports = {
  LIFECYCLE_VERSION,
  LIFECYCLE_FILENAME,
  LIFECYCLE_STATES,
  MAX_AUTOMATIC_EARLY_EXIT_RETRIES,
  MAX_HEAD_TRIALS_PER_ASSIGNMENT,
  AgentLifecycleError,
  AgentLifecycleGovernor,
  createAgentLifecycleGovernor: (options) => new AgentLifecycleGovernor(options),
  projectStatePath,
};

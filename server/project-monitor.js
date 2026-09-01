"use strict";

// Event-driven Project Monitor controller.  It owns only concrete unresolved
// condition deadlines; there is deliberately no project heartbeat, generic
// queue pulse, assignment, restart, or merge operation in this module.

const { evaluateMonitorPolicy } = require("./project-monitor-policy");
const { cloneMonitorState } = require("./project-monitor-state");

const MAX_TIMER_DELAY_MS = 0x7fffffff;

class ProjectMonitorController {
  constructor(options = {}) {
    if (!options.stateStore || typeof options.stateStore.load !== "function" || typeof options.stateStore.save !== "function") {
      throw new TypeError("monitor_state_store_required");
    }
    if (!options.transport || typeof options.transport.recordAll !== "function"
      || typeof options.transport.publish !== "function" || typeof options.transport.resume !== "function") {
      throw new TypeError("monitor_transport_required");
    }
    this.stateStore = options.stateStore;
    this.transport = options.transport;
    this.now = options.now || Date.now;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this._states = new Map();
    this._timers = new Map();
  }

  _stateFor(projectId) {
    if (this._states.has(projectId)) return this._states.get(projectId);
    const state = cloneMonitorState(this.stateStore.load(projectId));
    this._states.set(projectId, state);
    return state;
  }

  _save(projectId, state) {
    const saved = cloneMonitorState(this.stateStore.save(projectId, state));
    this._states.set(projectId, saved);
    return saved;
  }

  _timerKey(projectId, conditionKey) {
    return `${projectId}\u0000${conditionKey}`;
  }

  _clearProjectTimers(projectId) {
    const prefix = `${projectId}\u0000`;
    let removed = 0;
    for (const [key, timer] of this._timers) {
      if (!key.startsWith(prefix)) continue;
      this.clearTimeout(timer);
      this._timers.delete(key);
      removed += 1;
    }
    return removed;
  }

  _schedule(projectId, condition) {
    if (!condition || !Number.isSafeInteger(condition.due_at) || condition.due_at < 0) return;
    const key = this._timerKey(projectId, condition.key);
    const existing = this._timers.get(key);
    if (existing) {
      this.clearTimeout(existing);
      this._timers.delete(key);
    }
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, condition.due_at - this.now()));
    const handle = this.setTimeout(() => {
      this._timers.delete(key);
      this._onDeadline(projectId, condition.key, condition.due_at).catch(() => {
        // A failed event delivery remains durably recorded/appended and is
        // retried only on explicit recovery, never by a generic pulse.
      });
    }, delay);
    if (handle && typeof handle.unref === "function") handle.unref();
    this._timers.set(key, handle);
  }

  _reschedule(projectId, state) {
    this._clearProjectTimers(projectId);
    if (state.mode !== "enabled") return;
    for (const condition of Object.values(state.unresolved)) this._schedule(projectId, condition);
  }

  async _onDeadline(projectId, conditionKey, dueAt) {
    const current = this._states.get(projectId);
    if (!current || current.mode !== "enabled") return { ok: true, changed: false };
    const condition = current.unresolved[conditionKey];
    if (!condition || condition.due_at !== dueAt) return { ok: true, changed: false };
    if (this.now() < dueAt) {
      this._schedule(projectId, condition);
      return { ok: true, changed: false };
    }
    const next = cloneMonitorState(current);
    delete next.unresolved[conditionKey];
    // Never durably retire a deadline on its own.  The closed transport
    // records its correlation-keyed delivery receipt using this same state
    // snapshot, so the receipt and retirement become visible together before
    // any chat/PTY side effect.  If that durable write never happens, the old
    // unresolved deadline survives and recovery schedules it again; if it
    // does happen, `resumePending` owns exactly-once delivery recovery.
    const prepared = await this.transport.recordAll({
      project_id: projectId,
      events: [{ kind: condition.kind, anchors: condition.anchors }],
      state: next,
    });
    let state = cloneMonitorState(prepared.state);
    this._states.set(projectId, state);
    const delivered = await this.transport.publish({
      project_id: projectId,
      kind: condition.kind,
      anchors: condition.anchors,
      state,
    });
    state = cloneMonitorState(delivered.state);
    this._states.set(projectId, state);
    return { ok: delivered.ok === true, changed: true, delivery: delivered };
  }

  start(projectId) {
    const current = this._stateFor(projectId);
    if (current.mode === "archived") throw new Error("monitor_unarchive_required");
    const next = cloneMonitorState(current);
    next.mode = "enabled";
    next.observation_hash = null;
    next.unresolved = Object.create(null);
    // A fresh explicit start deliberately does not reuse an interrupted old
    // event.  Correlation is still globally idempotent at the append boundary.
    next.deliveries = Object.create(null);
    const state = this._save(projectId, next);
    this._reschedule(projectId, state);
    return state;
  }

  suspend(projectId) {
    const current = this._stateFor(projectId);
    const next = cloneMonitorState(current);
    next.mode = "suspended";
    next.observation_hash = null;
    next.unresolved = Object.create(null);
    const state = this._save(projectId, next);
    this._reschedule(projectId, state);
    return state;
  }

  archive(projectId) {
    const current = this._stateFor(projectId);
    const next = cloneMonitorState(current);
    next.mode = "archived";
    next.observation_hash = null;
    next.unresolved = Object.create(null);
    next.deliveries = Object.create(null);
    const state = this._save(projectId, next);
    this._reschedule(projectId, state);
    return state;
  }

  // Lifecycle restore is intentionally distinct from start: restoration only
  // makes the monitor suspended.  A subsequent explicit operator start is the
  // sole path that can re-enable observation/delivery.
  unarchive(projectId) {
    const current = this._stateFor(projectId);
    const next = cloneMonitorState(current);
    next.mode = "suspended";
    next.observation_hash = null;
    next.unresolved = Object.create(null);
    next.deliveries = Object.create(null);
    const state = this._save(projectId, next);
    this._reschedule(projectId, state);
    return state;
  }

  // Batch terminal state is a compacting boundary, not a periodic condition.
  // It retires deadlines and undelivered monitor receipts without assigning,
  // merging, or waking a replacement worker.
  clearTerminal(projectId) {
    const current = this._stateFor(projectId);
    const next = cloneMonitorState(current);
    next.observation_hash = null;
    next.unresolved = Object.create(null);
    next.deliveries = Object.create(null);
    const state = this._save(projectId, next);
    this._reschedule(projectId, state);
    return state;
  }

  async observe(input) {
    // Lifecycle owns the monitor mode.  Observations cannot turn monitoring on
    // (or resurrect an archive) by supplying a mode field of their own.
    const projectId = input && typeof input.project_id === "string" ? input.project_id : null;
    const current = this._stateFor(projectId);
    const evaluation = evaluateMonitorPolicy({ ...input, mode: current.mode }, { now: this.now() });

    // This is the critical no-op fast path.  A repeated exact fact set neither
    // reads/writes durable state nor calls transport/cache/chat/PTY children.
    if (current.observation_hash === evaluation.observation_hash && current.mode === evaluation.observation.mode) {
      return Object.freeze({ changed: false, state: current, evaluation, deliveries: Object.freeze([]) });
    }

    const next = cloneMonitorState(current);
    next.mode = evaluation.observation.mode;
    next.observation_hash = evaluation.observation_hash;
    next.unresolved = Object.create(null);
    if (next.mode === "archived") {
      next.deliveries = Object.create(null);
    } else if (next.mode === "enabled" && evaluation.observation.readiness && evaluation.observation.assignment) {
      for (const condition of evaluation.conditions) {
        if (!condition.immediate && condition.due_at !== null) {
          next.unresolved[condition.key] = {
            key: condition.key,
            kind: condition.kind,
            anchors: cloneMonitorState(condition.anchors),
            due_at: condition.due_at,
          };
        }
      }
    }
    const immediate = evaluation.conditions.filter((condition) => condition.immediate);
    // Persist all immediate delivery authorities in the same state write as
    // the observation/deadlines.  Recording one then acting before recording
    // the next would leave a later immediate condition crash-lost.
    let state;
    if (immediate.length > 0) {
      const prepared = await this.transport.recordAll({
        project_id: projectId,
        events: immediate.map((condition) => ({ kind: condition.kind, anchors: condition.anchors })),
        state: next,
      });
      state = cloneMonitorState(prepared.state);
      this._states.set(projectId, state);
    } else {
      state = this._save(projectId, next);
    }
    this._reschedule(projectId, state);

    const deliveries = [];
    if (state.mode === "enabled" && evaluation.observation.readiness && evaluation.observation.assignment) {
      for (const condition of immediate) {
        const result = await this.transport.publish({
          project_id: projectId,
          kind: condition.kind,
          anchors: condition.anchors,
          state,
        });
        state = cloneMonitorState(result.state);
        this._states.set(projectId, state);
        deliveries.push(result);
      }
    }
    return Object.freeze({ changed: true, state, evaluation, deliveries: Object.freeze(deliveries) });
  }

  async resumePending(projectId) {
    const current = this._stateFor(projectId);
    const result = await this.transport.resume(projectId, current);
    const state = cloneMonitorState(result.state);
    this._states.set(projectId, state);
    // Recovery also reinstates the only permitted reconciliation handles.  A
    // timer whose initial durable receipt cut did not complete therefore gets
    // another deadline attempt, rather than being silently lost on restart.
    this._reschedule(projectId, state);
    return { ...result, state };
  }

  shutdown(projectId) {
    const timers = this._clearProjectTimers(projectId);
    this._states.delete(projectId);
    return { ok: true, resources: { monitor_timers: timers }, cleanup_errors: [] };
  }
}

function createProjectMonitorController(options) {
  return new ProjectMonitorController(options);
}

module.exports = {
  MAX_TIMER_DELAY_MS,
  ProjectMonitorController,
  createProjectMonitorController,
};

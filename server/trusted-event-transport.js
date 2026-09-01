"use strict";

// Closed, server-only delivery bridge for Project Monitor.  This module has no
// generic `send(text, recipients)` API by design: event text, recipient and
// correlation are all constructed from a tiny fixed registry.

const crypto = require("crypto");
const { MONITOR_EVENT_KINDS } = require("./project-monitor-policy");
const { cloneMonitorState } = require("./project-monitor-state");

const TRANSPORT_VERSION = 1;
const KIND_SET = new Set(MONITOR_EVENT_KINDS);
const RECIPIENTS = Object.freeze(["head"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,191}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const ALLOWED_ANCHORS = new Set([
  "project_id", "assignment_key", "subject_key", "event_generation",
  "cycle_id", "sha", "threshold_generation", "admission_generation",
  "session_generation", "installation_id", "repo_key",
]);

class TrustedEventTransportError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function identifier(value, pattern = ID_RE) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function normalizeAnchors(projectId, value) {
  if (!identifier(projectId, PROJECT_ID_RE) || !isPlainObject(value)) throw new TrustedEventTransportError("trusted_event_anchors_invalid");
  const entries = Object.entries(value);
  if (entries.length < 4 || entries.length > ALLOWED_ANCHORS.size) throw new TrustedEventTransportError("trusted_event_anchors_invalid");
  const out = Object.create(null);
  for (const [key, raw] of entries) {
    if (!ALLOWED_ANCHORS.has(key) || !identifier(raw)) throw new TrustedEventTransportError("trusted_event_anchors_invalid");
    out[key] = raw;
  }
  if (out.project_id !== projectId || !out.assignment_key || !out.subject_key || !out.event_generation) {
    throw new TrustedEventTransportError("trusted_event_anchors_invalid");
  }
  return Object.freeze(out);
}

function correlationFor(kind, anchors) {
  return hash({ version: TRANSPORT_VERSION, kind, anchors });
}

function fixedText(kind, anchors) {
  // All interpolated values have passed the identifier grammar.  The text is
  // therefore a compact receipt, not caller-controlled prose.
  return `@head [QW-MONITOR:${kind}] assignment=${anchors.assignment_key} subject=${anchors.subject_key} event=${anchors.event_generation}`;
}

function envelopeFor(projectId, kind, anchors) {
  if (!KIND_SET.has(kind)) throw new TrustedEventTransportError("trusted_event_kind_invalid");
  const safeAnchors = normalizeAnchors(projectId, anchors);
  const correlationId = correlationFor(kind, safeAnchors);
  return Object.freeze({
    version: TRANSPORT_VERSION,
    correlation_id: correlationId,
    kind,
    project_id: projectId,
    recipients: RECIPIENTS,
    anchors: safeAnchors,
    sender: "system",
    type: "trusted_event",
    text: fixedText(kind, safeAnchors),
  });
}

function deliveryFromEnvelope(envelope) {
  return {
    kind: envelope.kind,
    phase: "recorded",
    anchors: cloneMonitorState(envelope.anchors),
    anchor_hash: hash(envelope.anchors),
    chat_event_id: null,
    delivery_generation: null,
  };
}

function normalizeChatEventId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return identifier(value, /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,255}$/);
}

class TrustedEventTransport {
  constructor(options = {}) {
    if (!options.stateStore || typeof options.stateStore.save !== "function") {
      throw new TypeError("trusted_event_state_store_required");
    }
    this.stateStore = options.stateStore;
    this.appendTrustedEventOnce = typeof options.appendTrustedEventOnce === "function" ? options.appendTrustedEventOnce : null;
    this.wakeTrustedRecipient = typeof options.wakeTrustedRecipient === "function" ? options.wakeTrustedRecipient : null;
    this.currentTrustedRecipientGeneration = typeof options.currentTrustedRecipientGeneration === "function"
      ? options.currentTrustedRecipientGeneration : null;
    this.isProjectAdmitted = typeof options.isProjectAdmitted === "function" ? options.isProjectAdmitted : (() => false);
  }

  _save(projectId, state) {
    return cloneMonitorState(this.stateStore.save(projectId, state));
  }

  _admitted(projectId, anchors) {
    try { return this.isProjectAdmitted(projectId, anchors) === true; }
    catch { return false; }
  }

  _currentRecipientGeneration(projectId, envelope) {
    if (!this.currentTrustedRecipientGeneration) return null;
    try {
      const generation = this.currentTrustedRecipientGeneration(Object.freeze({ project_id: projectId, envelope }));
      return normalizeChatEventId(generation);
    } catch {
      return null;
    }
  }

  _persistDelivery(projectId, state, correlationId, delivery) {
    const next = cloneMonitorState(state);
    next.deliveries[correlationId] = delivery;
    return this._save(projectId, next);
  }

  async _deliver(projectId, state, envelope) {
    const correlationId = envelope.correlation_id;
    let working = state;
    let delivery = working.deliveries[correlationId] || null;
    if (!delivery) {
      delivery = deliveryFromEnvelope(envelope);
      // This write intentionally precedes every chat/PTY action.  A crash
      // after it can recover the same correlation without inventing a second
      // event identity.
      working = this._persistDelivery(projectId, working, correlationId, delivery);
      delivery = working.deliveries[correlationId];
    }
    if (delivery.kind !== envelope.kind || delivery.anchor_hash !== hash(envelope.anchors)) {
      throw new TrustedEventTransportError("trusted_event_correlation_collision");
    }
    if (delivery.phase === "woken") return { ok: true, duplicate: true, state: working, envelope };
    if (!this._admitted(projectId, envelope.anchors)) {
      return { ok: false, code: "project_not_admitted", state: working, envelope };
    }

    if (delivery.phase === "recorded") {
      if (!this.appendTrustedEventOnce) {
        return { ok: false, code: "trusted_event_append_unavailable", state: working, envelope };
      }
      let appendResult;
      try { appendResult = await this.appendTrustedEventOnce(envelope); }
      catch { return { ok: false, code: "trusted_event_append_failed", state: working, envelope }; }
      const chatEventId = normalizeChatEventId(appendResult?.id ?? appendResult?.chat_event_id);
      if (!appendResult || appendResult.ok !== true || !chatEventId) {
        return { ok: false, code: "trusted_event_append_failed", state: working, envelope };
      }
      delivery = { ...delivery, phase: "appended", chat_event_id: chatEventId };
      working = this._persistDelivery(projectId, working, correlationId, delivery);
      delivery = working.deliveries[correlationId];
    }

    // Recheck after the durable append.  Archive/reassignment may win while a
    // file write awaited; an already-recorded event is never permission to wake.
    if (!this._admitted(projectId, envelope.anchors)) {
      return { ok: false, code: "project_not_admitted", state: working, envelope };
    }
    if (!this.wakeTrustedRecipient) {
      return { ok: false, code: "trusted_event_wake_unavailable", state: working, envelope };
    }
    // A deferred dispatcher result only means this correlation was queued for
    // a verified Head generation; it is not evidence that a PTY write landed.
    // Do not enqueue it twice for that same generation. A later verified Head
    // generation is intentionally eligible to receive the exact same receipt.
    const currentGeneration = this._currentRecipientGeneration(projectId, envelope);
    if (currentGeneration && delivery.delivery_generation === currentGeneration) {
      return { ok: true, duplicate: true, queued: true, state: working, envelope };
    }
    let wakeResult;
    try {
      wakeResult = await this.wakeTrustedRecipient(Object.freeze({
        project_id: projectId,
        recipient: "head",
        envelope,
      }));
    } catch {
      return { ok: false, code: "trusted_event_wake_failed", state: working, envelope };
    }
    if (!wakeResult || wakeResult.ok !== true) {
      return { ok: false, code: "trusted_event_wake_failed", state: working, envelope };
    }
    const deliveryGeneration = normalizeChatEventId(wakeResult.delivery_generation ?? wakeResult.session_generation);
    if ((wakeResult.delivery_generation !== undefined || wakeResult.session_generation !== undefined) && !deliveryGeneration) {
      return { ok: false, code: "trusted_event_wake_failed", state: working, envelope };
    }
    if (wakeResult.deferred === true) {
      // `delivery_generation` is a queued target only. It must never be read as
      // proof that the shared coalescer/deferred PTY write has completed.
      delivery = { ...delivery, phase: "appended", delivery_generation: deliveryGeneration };
      working = this._persistDelivery(projectId, working, correlationId, delivery);
      return { ok: true, duplicate: false, queued: true, retried: true, state: working, envelope };
    }
    delivery = { ...delivery, phase: "woken", delivery_generation: deliveryGeneration };
    working = this._persistDelivery(projectId, working, correlationId, delivery);
    return { ok: true, duplicate: false, retried: true, state: working, envelope };
  }

  async publish(input = {}) {
    if (!isPlainObject(input) || !Object.keys(input).every((key) => new Set(["project_id", "kind", "anchors", "state"]).has(key))) {
      throw new TrustedEventTransportError("trusted_event_input_invalid");
    }
    const projectId = identifier(input.project_id, PROJECT_ID_RE);
    if (!projectId) throw new TrustedEventTransportError("trusted_event_project_invalid");
    if (!isPlainObject(input.state)) throw new TrustedEventTransportError("trusted_event_state_invalid");
    const envelope = envelopeFor(projectId, input.kind, input.anchors);
    const state = cloneMonitorState(input.state);
    if (!state || state.mode !== "enabled") return { ok: false, code: "monitor_not_enabled", state, envelope };
    return this._deliver(projectId, state, envelope);
  }

  async resume(projectId, state) {
    const working = cloneMonitorState(state);
    if (working.mode !== "enabled") return { ok: true, resumed: 0, state: working };
    let current = working;
    let resumed = 0;
    for (const [correlationId, delivery] of Object.entries(current.deliveries)) {
      if (delivery.phase === "woken") continue;
      const envelope = envelopeFor(projectId, delivery.kind, delivery.anchors);
      if (envelope.correlation_id !== correlationId) throw new TrustedEventTransportError("trusted_event_correlation_collision");
      const result = await this._deliver(projectId, current, envelope);
      current = result.state;
      if (result.retried === true) resumed += 1;
    }
    return { ok: true, resumed, state: current };
  }
}

function createTrustedEventTransport(options) {
  return new TrustedEventTransport(options);
}

module.exports = {
  TRANSPORT_VERSION,
  TRUSTED_MONITOR_RECIPIENTS: RECIPIENTS,
  TrustedEventTransportError,
  TrustedEventTransport,
  createTrustedEventTransport,
  correlationFor,
  envelopeFor,
};

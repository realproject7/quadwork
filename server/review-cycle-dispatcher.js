"use strict";

// Narrow server-owned orchestration for #1048.  This knows only durable cycle
// facts and fixed event plans.  It does not read chat, poll GitHub, execute
// commands, choose recipients, or interpret review prose.

const { assertDerivedTarget, ReviewCycleError } = require("./review-cycle");

const CI_STATES = new Set([
  "unknown", "pending", "pass", "product_failure", "control_plane_failure",
  "cancelled", "missing_required", "missing_policy", "ci_less_pending", "ci_less_pass",
]);

class ReviewCycleDispatcherError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isPlainObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  if (!isPlainObject(value)) throw new ReviewCycleDispatcherError("review_cycle_dispatch_invalid");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ReviewCycleDispatcherError("review_cycle_dispatch_invalid");
  }
}

function publicHandoff(cycle) {
  if (!cycle || cycle.state !== "current") return null;
  // Deliberately no review prose, findings, review body, nonce, path, or
  // generic chat content.  The UI/replay consumer gets the exact identity and
  // orthogonal facts only.
  return Object.freeze({
    target_kind: cycle.target.target_kind,
    installation_id: cycle.target.installation_id,
    repo_key: cycle.target.repo_key,
    issue: cycle.target.work_item.number,
    contract_revision: cycle.target.contract_revision,
    pr_number: cycle.target.pr_number,
    exact_sha: cycle.target.exact_sha,
    policy_version: cycle.target.policy_version,
    cycle_id: cycle.cycle_id,
    target_identity_digest: cycle.target_identity_digest,
    readiness: cycle.readiness,
    ci: cycle.ci_state,
    review: cycle.review_state,
    mergeable: cycle.mergeable,
    head_gate_due: cycle.head_gate_due,
    dev_fix_owner: cycle.review_state === "changes_requested" || cycle.ci_state === "product_failure",
  });
}

class ReviewCycleDispatcher {
  constructor(options = {}) {
    if (!options.store || typeof options.store.reconcile !== "function") {
      throw new TypeError("review_cycle_store_required");
    }
    this.store = options.store;
  }

  // Returns durable plans only.  The route composition boundary can append
  // them through #1036's private transport after it rechecks archive/current
  // admission; this intentional split makes crash/restart tests deterministic.
  observe(input) {
    exactKeys(input, ["project_id", "target", "ci_state", "archived"]);
    if (typeof input.project_id !== "string" || !CI_STATES.has(input.ci_state) || typeof input.archived !== "boolean") {
      throw new ReviewCycleDispatcherError("review_cycle_dispatch_invalid");
    }
    try { assertDerivedTarget(input.target); }
    catch (error) {
      if (error instanceof ReviewCycleError) throw new ReviewCycleDispatcherError(error.code);
      throw new ReviewCycleDispatcherError("review_cycle_dispatch_invalid");
    }
    if (input.target.identity.project_id !== input.project_id) throw new ReviewCycleDispatcherError("review_cycle_cross_project");
    if (input.archived) return Object.freeze({ archived: true, cycle: null, handoff: null, plans: Object.freeze([]) });

    const reconciled = this.store.reconcile(input.project_id, input.target);
    const cycle = this.store.setCiState(input.project_id, input.target, input.ci_state);
    const plans = [];
    if (reconciled.invalidated?.contract_change) {
      plans.push(Object.freeze({ cycle: reconciled.invalidated.cycle, plan: reconciled.invalidated.contract_change }));
    }
    const request = this.store.planReviewRequest(input.project_id, input.target);
    if (request) plans.push(Object.freeze({ cycle, plan: request }));
    // Each call is idempotent.  A completed role never gets a new reminder;
    // the store determines whether the persisted measured lease is due.
    for (const role of ["re1", "re2"]) {
      const reminder = this.store.planReviewReminder(input.project_id, input.target, role);
      if (reminder) plans.push(Object.freeze({ cycle, plan: reminder }));
    }
    const gate = this.store.planHeadGate(input.project_id, input.target);
    if (gate) plans.push(Object.freeze({ cycle, plan: gate }));
    const latest = this.store.current(input.project_id, input.target);
    return Object.freeze({
      archived: false,
      cycle: latest,
      handoff: publicHandoff(latest),
      plans: Object.freeze(plans),
    });
  }

  // The only append hook accepted here is the sealed private file-chat seam.
  // It receives `{ project_id, cycle, plan }`, never prose or recipients.
  deliver(projectId, observation, appendTrustedEventOnce, { archived = false } = {}) {
    if (archived === true || observation?.archived === true) return Object.freeze([]);
    if (typeof appendTrustedEventOnce !== "function" || !observation?.cycle || !Array.isArray(observation.plans)) {
      throw new ReviewCycleDispatcherError("review_cycle_delivery_invalid");
    }
    return Object.freeze(observation.plans.map((delivery) => {
      const isCurrent = typeof this.store.isCurrentCycle === "function" &&
        this.store.isCurrentCycle(projectId, delivery.cycle?.cycle_id, delivery.cycle?.target_identity_digest);
      // A contract-change record belongs to the immediately invalidated cycle
      // and is deliberately the sole historical delivery.  All other stale
      // snapshots fail closed instead of waking a reviewer/Head after retip.
      if (!isCurrent && !(delivery.plan?.kind === "contract_changed" && delivery.cycle?.state === "invalidated")) {
        return Object.freeze({ ok: false, code: "review_cycle_stale_delivery" });
      }
      return appendTrustedEventOnce(Object.freeze({
        project_id: projectId,
        cycle: delivery.cycle,
        plan: delivery.plan,
      }));
    }));
  }
}

module.exports = {
  ReviewCycleDispatcher,
  ReviewCycleDispatcherError,
  publicHandoff,
};

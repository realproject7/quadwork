"use strict";

// #1070-B: the single project-scope WorkTask archive transition.
//
// Archiving a project persists the durable configuration barrier and revokes
// admission, but the WorkTask pipeline and its open review rounds are separate
// durable authorities.  Without this transition they stay `archived:false` and
// `current` after the barrier, so a late build, candidate, review, receipt, or
// correction still reads a live batch.
//
// This module is deliberately NOT a generic pipeline or review-round API.  It
// exposes exactly one project-scoped operation, and every identity it uses is
// bound server-side: a caller supplies a project id and nothing else, the
// installation identity comes from the injected live-configuration reader
// (which takes no argument, so no caller can name another installation), the
// archive event id is derived from that identity plus the frozen manifest
// digest, and the cancellation cause is the fixed `project_archived`.  There
// is no path here to reach `set_archived` or `cancelFromTrustedState` with
// caller-chosen values.
//
// It never touches candidates, worktrees, receipts, or audit.  Task slot state
// is left exactly as it was, cancellation is limited to rounds still
// `current`, and a released or already-cancelled round keeps its sealed
// record.  Every failure is typed and retryable while the configuration
// barrier stays committed; a retry re-derives the same event id and completes
// whatever the previous attempt left undone.

const crypto = require("node:crypto");
const { planWorkTaskPipelineEvent } = require("./work-task-pipeline");
const { createWorkTaskPipelineStore } = require("./work-task-pipeline-store");
const { createTaskReviewRoundStore, MAX_ROUNDS_PER_PROJECT } = require("./task-review-round-store");

const VERSION = 1;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CODE_RE = /^[a-z][a-z0-9_]{2,63}$/;
const CANCELLATION_CAUSE = "project_archived";
const CANCELLATION_REASON = "project archived by the server lifecycle controller";
const PIPELINE_RESOURCE = "work_task_pipeline";
const ROUND_RESOURCE = "task_review_round";

class ProjectArchiveTransitionError extends Error {
  constructor(code, message = code) { super(message); this.name = "ProjectArchiveTransitionError"; this.code = code; }
}

function fail(code, message) { throw new ProjectArchiveTransitionError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has unknown or missing fields");
  }
}
function transitionOptions(value) {
  const code = "invalid_project_archive_transition_options";
  exact(value, ["config_dir", "fs", "resolve_installation_id", "now"], code);
  if (typeof value.config_dir !== "string" || value.config_dir.length === 0 || !value.fs) {
    fail(code, "durable storage dependencies are invalid");
  }
  if (typeof value.resolve_installation_id !== "function" || typeof value.now !== "function") {
    fail(code, "identity and clock accessors are required");
  }
  return value;
}
// A store error carries a bounded machine code; anything else becomes the
// caller-visible fallback so an internal message never leaks through a code.
function storeCode(error, fallback) {
  const code = error && typeof error.code === "string" ? error.code : "";
  return CODE_RE.test(code) ? code : fallback;
}
// Derived solely from the immutable identity of the batch being archived, so
// a retry after a crash re-derives the same event id instead of appending a
// second archive transition.
function archiveEventId(owner, manifestDigest) {
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify(["project-archive", VERSION, owner.installation_id, owner.project_id, manifestDigest]), "utf8")
    .digest("hex");
  return `parch_${digest.slice(0, 48)}`;
}

function createProjectArchiveTransition(value) {
  const options = transitionOptions(value);
  const pipelineStore = createWorkTaskPipelineStore({ config_dir: options.config_dir, fs: options.fs });
  const roundStore = createTaskReviewRoundStore({ rootDir: options.config_dir, fsImpl: options.fs });

  function record(result, resource, code, message) {
    result.cleanup_errors.push({ resource, code, message });
  }
  function count(result, name, amount) {
    if (amount > 0) result.resources[name] = (result.resources[name] || 0) + amount;
  }
  // The project id is the id the lifecycle controller is archiving; the
  // installation id is read from live configuration here.  Neither can be
  // supplied by a caller as another project's or installation's scope.
  function resolveOwner(projectId) {
    if (typeof projectId !== "string" || !PROJECT_RE.test(projectId)) {
      fail("invalid_project_archive_scope", "project id is invalid");
    }
    let installationId;
    try { installationId = options.resolve_installation_id(); }
    catch { fail("project_archive_identity_unavailable", "installation identity could not be read"); }
    if (typeof installationId !== "string" || !INSTALLATION_RE.test(installationId)) {
      fail("project_archive_identity_unavailable", "installation identity is not registered");
    }
    return Object.freeze({ installation_id: installationId, project_id: projectId });
  }
  function timestamp() {
    let now;
    try { now = options.now(); }
    catch { fail("project_archive_clock_unavailable", "clock is unavailable"); }
    const at = now instanceof Date ? now : new Date(typeof now === "string" || typeof now === "number" ? now : NaN);
    if (Number.isNaN(at.getTime())) fail("project_archive_clock_unavailable", "clock returned an invalid instant");
    return at.toISOString();
  }

  // Step one: mark the active pipeline archived through its own CAS.  A
  // missing store means this project never had a durable batch, or its batch
  // was already retired, so there is nothing to archive and nothing to retry.
  function archivePipeline(result, owner) {
    let snapshot;
    try { snapshot = pipelineStore.readRecoverySnapshot(owner); }
    catch (error) {
      const code = storeCode(error, "work_task_pipeline_unavailable");
      if (code === "work_task_pipeline_store_missing") return;
      record(result, PIPELINE_RESOURCE, code, "archived project pipeline could not be read");
      return;
    }
    if (snapshot.pipeline.archived === true) return;
    const event_id = archiveEventId(owner, snapshot.manifest.manifest_digest);
    try {
      const plan = planWorkTaskPipelineEvent(snapshot.pipeline, {
        version: VERSION, kind: "set_archived", event_id, archived: true,
      });
      pipelineStore.applyPlan({
        expected: {
          installation_id: owner.installation_id,
          project_id: owner.project_id,
          manifest_digest: snapshot.manifest.manifest_digest,
          pipeline_digest: snapshot.pipeline.pipeline_digest,
        },
        plan,
        terminal_disposition: { kind: "archive", event_id, archived: true },
      });
    } catch (error) {
      record(result, PIPELINE_RESOURCE, storeCode(error, "work_task_pipeline_archive_failed"),
        "archived project pipeline transition was rejected");
      return;
    }
    count(result, "work_task_pipelines_archived", 1);
  }

  // Step two: cancel every review round that is still current for this
  // project, with the fixed trusted archive cause.  A receipt racing this
  // sweep is serialized by the same project writer lock: it either seals
  // before the cancellation and stays in the immutable record, or it is
  // rejected because the round is cancelled.
  function cancelCurrentRounds(result, owner) {
    let anchors;
    try { anchors = roundStore.listCurrentRoundAnchors(owner); }
    catch (error) {
      record(result, ROUND_RESOURCE, storeCode(error, "task_review_round_unavailable"),
        "archived project review rounds could not be listed");
      return;
    }
    if (anchors.length > MAX_ROUNDS_PER_PROJECT) {
      record(result, ROUND_RESOURCE, "task_review_round_over_bound", "archived project exceeds its review-round bound");
      return;
    }
    let at;
    try { at = timestamp(); }
    catch (error) {
      record(result, ROUND_RESOURCE, storeCode(error, "project_archive_clock_unavailable"),
        "archived project cancellation has no trusted instant");
      return;
    }
    let cancelled = 0;
    for (const anchor of anchors) {
      try {
        roundStore.cancelFromTrustedState({
          version: VERSION,
          review_round_ref: anchor.review_round_ref,
          candidate_digest: anchor.candidate_digest,
          cause: CANCELLATION_CAUSE,
          reason: CANCELLATION_REASON,
          at,
        });
        cancelled += 1;
      } catch (error) {
        record(result, ROUND_RESOURCE, storeCode(error, "task_review_round_cancel_failed"),
          "archived project review round could not be cancelled");
      }
    }
    count(result, "task_review_rounds_cancelled", cancelled);
    // Re-read rather than trusting the sweep: a round that a concurrent writer
    // left current must keep this cleanup partial and retryable instead of
    // being reported as quiesced.
    try {
      if (roundStore.listCurrentRoundAnchors(owner).length !== 0) {
        record(result, ROUND_RESOURCE, "task_review_round_still_current",
          "archived project still has a current review round");
      }
    } catch (error) {
      record(result, ROUND_RESOURCE, storeCode(error, "task_review_round_unavailable"),
        "archived project review rounds could not be re-read");
    }
  }

  // Synchronous by construction.  The lifecycle controller calls this in the
  // same turn that follows barrier persistence and admission revocation, so no
  // await can open a window where the config is archived but the batch is not.
  function archiveProjectRuntimeState(projectId) {
    const result = { ok: false, resources: {}, cleanup_errors: [] };
    let owner;
    try { owner = resolveOwner(projectId); }
    catch (error) {
      record(result, "project", storeCode(error, "project_archive_identity_unavailable"),
        "archived project identity is unavailable");
      return result;
    }
    archivePipeline(result, owner);
    // Rounds are only swept once the pipeline barrier itself is in place.  If
    // the pipeline could not be archived, removing review authority would
    // leave the batch looking live but unreviewable; the typed error above
    // keeps the whole transition retryable instead.
    if (result.cleanup_errors.length === 0) cancelCurrentRounds(result, owner);
    result.ok = result.cleanup_errors.length === 0;
    return result;
  }

  return Object.freeze({ archiveProjectRuntimeState });
}

module.exports = {
  VERSION,
  CANCELLATION_CAUSE,
  ProjectArchiveTransitionError,
  archiveEventId,
  createProjectArchiveTransition,
};

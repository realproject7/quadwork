"use strict";

// #1060 M4: the closed, Head-bound bridge from one initialized Delivery
// Candidate record to its deterministic composition proof.  It owns neither
// repository access nor persistence: both remain narrow injected contracts.
// In particular, this service has no publication, process, transport, or
// generic action-dispatch capability.
//
// #1066: composition awaits each repository observation, so Head
// authorization is re-proven and the one composition deadline is checked
// around every observation and again immediately before the durable write.

const {
  DeliveryCandidateError,
  assertDeliveryCandidateRef,
  deliveryCandidateKey,
  assertDeliveryManifest,
} = require("./delivery-candidate");
const {
  DeliveryComposerError,
  composeDeliveryCandidate,
} = require("./delivery-composer");
const {
  DeliveryCandidateStoreError,
  assertDeliveryCandidateStoreState,
} = require("./delivery-candidate-store");

const VERSION = 1;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const REPOSITORY_OPERATIONS = [
  "readCommit",
  "readTree",
  "readReviewedTask",
  "readCandidatePatch",
  "readDeliveryPatch",
  "applyPatch",
];

class DeliveryCompositionServiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DeliveryCompositionServiceError";
    this.code = code;
  }
}

function fail(code, message) { throw new DeliveryCompositionServiceError(code, message); }
function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value, fields, code) {
  if (!plain(value)) fail(code, "value must be a plain object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, "value has an unknown or missing field");
  }
}
function clone(value) {
  return Array.isArray(value) ? value.map(clone) : plain(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function stable(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_delivery_composition_input", "number is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  fail("invalid_delivery_composition_input", "value is invalid");
}
function same(left, right) { return stable(left) === stable(right); }
function identifier(value, code) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) fail(code, "operation identity is invalid");
  return value;
}
function revision(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, "revision is invalid");
  return value;
}
function headBinding(value, code) {
  exact(value, ["installation_id", "project_id", "role", "generation"], code);
  if (typeof value.installation_id !== "string" || !INSTALLATION_RE.test(value.installation_id) ||
      typeof value.project_id !== "string" || !PROJECT_RE.test(value.project_id) ||
      value.role !== "head" || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    fail(code, "Head binding is invalid");
  }
  return {
    installation_id: value.installation_id,
    project_id: value.project_id,
    role: "head",
    generation: value.generation,
  };
}
function sameBinding(left, right) {
  return left.installation_id === right.installation_id && left.project_id === right.project_id &&
    left.role === right.role && left.generation === right.generation;
}
function candidateRef(value, code) {
  try { return clone(assertDeliveryCandidateRef(value, code)); }
  catch (error) {
    if (error instanceof DeliveryCandidateError) fail(code, "delivery candidate reference is invalid");
    throw error;
  }
}
function manifest(value, code) {
  try { return clone(assertDeliveryManifest(value)); }
  catch (error) {
    if (error instanceof DeliveryCandidateError) fail(code, "delivery manifest is invalid");
    throw error;
  }
}
function sameRef(left, right) {
  try { return deliveryCandidateKey(left) === deliveryCandidateKey(right); }
  catch { return false; }
}
function store(value) {
  exact(value, ["readSnapshot", "initialize", "recordComposed"], "invalid_delivery_composition_service_options");
  for (const name of Object.keys(value)) {
    if (typeof value[name] !== "function") fail("invalid_delivery_composition_service_options", "candidate_store operation is required");
  }
  return value;
}
function repositoryObjects(value) {
  exact(value, REPOSITORY_OPERATIONS, "invalid_delivery_composition_service_options");
  for (const name of REPOSITORY_OPERATIONS) {
    if (typeof value[name] !== "function") fail("invalid_delivery_composition_service_options", "repository object operation is required");
  }
  return value;
}
function authorizationResolver(value) {
  if (typeof value !== "function") fail("invalid_delivery_composition_service_options", "Head authorization resolver is required");
  return value;
}
function authorizationFact(value, owner, caller, ref) {
  exact(value, ["version", "head_binding", "archived"], "delivery_composition_authorization_invalid");
  if (value.version !== VERSION || typeof value.archived !== "boolean") {
    fail("delivery_composition_authorization_invalid", "Head authorization fact is invalid");
  }
  const current = headBinding(value.head_binding, "delivery_composition_authorization_invalid");
  if (!sameBinding(current, owner) || !sameBinding(current, caller) ||
      current.installation_id !== ref.installation_id || current.project_id !== ref.project_id) {
    fail("delivery_composition_head_denied", "current Head does not own this delivery candidate");
  }
  if (value.archived) fail("delivery_composition_archived", "archived projects cannot compose delivery candidates");
  return freeze({ version: VERSION, head_binding: freeze(clone(current)), archived: false });
}
function projectRef(ref, caller) {
  if (ref.installation_id !== caller.installation_id || ref.project_id !== caller.project_id) {
    fail("delivery_composition_head_denied", "Head does not own this delivery candidate");
  }
}
function operationRecord(snapshot, kind, replayed) {
  const proof = snapshot.composition_proof;
  return freeze({
    version: VERSION,
    kind,
    replayed,
    record: freeze({
      delivery_candidate_ref: freeze(clone(snapshot.delivery_candidate_ref)),
      revision: snapshot.revision,
      lifecycle: snapshot.lifecycle.status,
      delivery_manifest_digest: snapshot.delivery_manifest.delivery_manifest_digest,
      composition_proof_digest: proof === null ? null : proof.composition_proof_digest,
    }),
  });
}
function snapshot(value, ref) {
  try { return freeze(clone(assertDeliveryCandidateStoreState(value, ref))); }
  catch (error) {
    if (error instanceof DeliveryCandidateStoreError || error instanceof DeliveryCandidateError || error instanceof DeliveryComposerError) {
      fail("delivery_candidate_store_unavailable", "delivery candidate state is invalid");
    }
    throw error;
  }
}
function mapStoreFailure(error) {
  if (!(error instanceof DeliveryCandidateStoreError)) {
    fail("delivery_candidate_store_unavailable", "delivery candidate store is unavailable");
  }
  if (error.code === "delivery_candidate_store_missing") return "missing";
  if (error.code === "stale_delivery_candidate_store_revision") return "stale";
  if (error.code === "delivery_candidate_store_manifest_mismatch") return "manifest";
  if (error.code === "delivery_candidate_store_idempotency_collision") return "collision";
  if (error.code === "delivery_candidate_store_already_composed") return "composed";
  if (error.code === "delivery_candidate_store_already_initialized") return "initialized";
  fail("delivery_candidate_store_unavailable", "delivery candidate store is unavailable");
}

function createDeliveryCompositionService(options) {
  exact(options, ["binding", "candidate_store", "resolve_head_authorization", "repository_objects", "deadline"], "invalid_delivery_composition_service_options");
  const owner = freeze(headBinding(options.binding, "invalid_delivery_composition_service_options"));
  const candidateStore = store(options.candidate_store);
  const resolveAuthorization = authorizationResolver(options.resolve_head_authorization);
  const objects = repositoryObjects(options.repository_objects);
  const deadline = options.deadline;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) fail("invalid_delivery_composition_service_options", "composition deadline is invalid");

  function authorize(operation, caller, ref) {
    if (!sameBinding(caller, owner)) fail("delivery_composition_head_denied", "Head binding does not match this service");
    projectRef(ref, caller);
    const request = freeze({
      version: VERSION,
      operation,
      head_binding: freeze(clone(caller)),
      delivery_candidate_ref: freeze(clone(ref)),
    });
    let observed;
    try { observed = resolveAuthorization(request); }
    catch (error) {
      if (error instanceof DeliveryCompositionServiceError) throw error;
      fail("delivery_composition_authorization_unavailable", "Head authorization cannot be re-proven");
    }
    return authorizationFact(observed, owner, caller, ref);
  }
  function readSnapshotOrFail(ref) {
    try { return snapshot(candidateStore.readSnapshot(freeze(clone(ref))), ref); }
    catch (error) {
      if (error instanceof DeliveryCompositionServiceError) throw error;
      if (mapStoreFailure(error) === "missing") fail("delivery_candidate_missing", "delivery candidate is not initialized");
      fail("delivery_candidate_store_unavailable", "delivery candidate store is unavailable");
    }
  }
  function withinDeadline(message) {
    if (Date.now() >= deadline) fail("delivery_composition_deadline_exceeded", message);
  }
  function guardedObjects(caller, ref) {
    return Object.fromEntries(REPOSITORY_OPERATIONS.map((name) => [name, (request) => {
      authorize("compose_candidate", caller, ref);
      withinDeadline("composition deadline passed before a repository observation");
      return objects[name](request);
    }]));
  }
  function initializationInput(value) {
    exact(value, ["head_binding", "delivery_candidate_ref", "delivery_manifest"], "invalid_delivery_candidate_initialization");
    const caller = headBinding(value.head_binding, "invalid_delivery_candidate_initialization");
    const ref = candidateRef(value.delivery_candidate_ref, "invalid_delivery_candidate_initialization");
    const deliveryManifest = manifest(value.delivery_manifest, "invalid_delivery_candidate_initialization");
    if (!sameRef(ref, deliveryManifest.delivery_candidate_ref)) {
      fail("delivery_candidate_manifest_mismatch", "delivery manifest does not match the requested candidate");
    }
    return { caller, ref, delivery_manifest: deliveryManifest };
  }
  function compositionInput(value) {
    exact(value, ["head_binding", "delivery_candidate_ref", "expected_revision", "correlation_id", "idempotency_key"], "invalid_delivery_candidate_composition");
    return {
      caller: headBinding(value.head_binding, "invalid_delivery_candidate_composition"),
      ref: candidateRef(value.delivery_candidate_ref, "invalid_delivery_candidate_composition"),
      expected_revision: revision(value.expected_revision, "invalid_delivery_candidate_composition"),
      correlation_id: identifier(value.correlation_id, "invalid_delivery_candidate_composition"),
      idempotency_key: identifier(value.idempotency_key, "invalid_delivery_candidate_composition"),
    };
  }
  function initializeCandidate(value) {
    const input = initializationInput(value);
    authorize("initialize_candidate", input.caller, input.ref);
    let existing = null;
    try { existing = readSnapshotOrFail(input.ref); }
    catch (error) {
      if (!(error instanceof DeliveryCompositionServiceError) || error.code !== "delivery_candidate_missing") throw error;
    }
    if (existing !== null) {
      if (!same(existing.delivery_manifest, input.delivery_manifest)) {
        fail("delivery_candidate_manifest_mismatch", "delivery candidate is already bound to another manifest");
      }
      return operationRecord(existing, "delivery_candidate_initialized", true);
    }
    // A project archived between the missing-state read and this first durable
    // write cannot gain a new candidate record.
    authorize("initialize_candidate", input.caller, input.ref);
    let initialized;
    try {
      initialized = snapshot(candidateStore.initialize(freeze({
        expected: freeze({ delivery_candidate_ref: freeze(clone(input.ref)), revision: null }),
        delivery_manifest: freeze(clone(input.delivery_manifest)),
      })), input.ref);
    } catch (error) {
      if (!(error instanceof DeliveryCompositionServiceError)) {
        const mapped = mapStoreFailure(error);
        if (mapped === "initialized") {
          const recovered = readSnapshotOrFail(input.ref);
          if (!same(recovered.delivery_manifest, input.delivery_manifest)) {
            fail("delivery_candidate_manifest_mismatch", "delivery candidate is already bound to another manifest");
          }
          return operationRecord(recovered, "delivery_candidate_initialized", true);
        }
        fail("delivery_candidate_store_unavailable", "delivery candidate store could not initialize state");
      }
      throw error;
    }
    if (initialized.revision !== 0 || initialized.lifecycle.status !== "pending_composition" ||
        !same(initialized.delivery_manifest, input.delivery_manifest)) {
      fail("delivery_candidate_store_unavailable", "candidate store did not initialize the requested manifest");
    }
    return operationRecord(initialized, "delivery_candidate_initialized", false);
  }
  async function composeCandidate(value) {
    const input = compositionInput(value);
    // Authentication happens before the durable lookup and is repeated around
    // each object observation and the final state transition below.
    authorize("compose_candidate", input.caller, input.ref);
    const current = readSnapshotOrFail(input.ref);
    if (input.expected_revision !== 0 || current.revision !== 0) {
      if (current.lifecycle.status === "composed" && input.expected_revision === 0) {
        const accepted = current.lifecycle.accepted_operation;
        if (accepted.correlation_id === input.correlation_id && accepted.idempotency_key === input.idempotency_key &&
            accepted.expected_revision === 0) {
          return operationRecord(current, "delivery_candidate_composed", true);
        }
        if (accepted.correlation_id === input.correlation_id || accepted.idempotency_key === input.idempotency_key) {
          fail("delivery_composition_identity_collision", "composition identity is already bound to another candidate result");
        }
        fail("delivery_candidate_already_composed", "delivery candidate already has a composition proof");
      }
      fail("stale_delivery_candidate_revision", "composition must compare and set pending revision zero");
    }
    if (current.lifecycle.status !== "pending_composition" || current.composition_proof !== null) {
      fail("delivery_candidate_store_unavailable", "pending delivery candidate state is inconsistent");
    }
    let compositionProof;
    try {
      compositionProof = await composeDeliveryCandidate(current.delivery_manifest, guardedObjects(input.caller, input.ref));
    } catch (error) {
      if (error instanceof DeliveryCompositionServiceError) throw error;
      // The composer reports every accessor failure as unavailability, which
      // hides a Head fact or deadline refused inside a guarded observation.
      // Re-prove both here so their own code dominates.
      authorize("compose_candidate", input.caller, input.ref);
      withinDeadline("composition deadline passed during repository observation");
      if (error instanceof DeliveryComposerError || error instanceof DeliveryCandidateError) {
        fail("delivery_composition_rejected", "delivery composition proof could not be established");
      }
      fail("delivery_composition_unavailable", "delivery composition object access failed");
    }
    // A changed or archived Head after the last repository observation cannot
    // commit a proof produced under the earlier authorization fact, and a
    // proof that arrives after the deadline is never recorded.
    authorize("compose_candidate", input.caller, input.ref);
    withinDeadline("composition deadline passed before the durable write");
    let written;
    try {
      written = candidateStore.recordComposed(freeze({
        expected: freeze({ delivery_candidate_ref: freeze(clone(input.ref)), revision: 0 }),
        delivery_manifest: freeze(clone(current.delivery_manifest)),
        composition_proof: freeze(clone(compositionProof)),
        correlation_id: input.correlation_id,
        idempotency_key: input.idempotency_key,
      }));
    } catch (error) {
      const mapped = mapStoreFailure(error);
      if (mapped === "stale") fail("stale_delivery_candidate_revision", "delivery candidate changed before composition could be recorded");
      if (mapped === "manifest") fail("delivery_candidate_manifest_mismatch", "delivery candidate manifest changed before composition could be recorded");
      if (mapped === "collision") fail("delivery_composition_identity_collision", "composition identity is already bound to another candidate result");
      if (mapped === "composed") fail("delivery_candidate_already_composed", "delivery candidate already has a composition proof");
      fail("delivery_candidate_store_unavailable", "delivery candidate store could not record composition");
    }
    exact(written, ["snapshot", "persisted"], "delivery_candidate_store_unavailable");
    if (typeof written.persisted !== "boolean") fail("delivery_candidate_store_unavailable", "candidate store composition receipt is invalid");
    const recorded = snapshot(written.snapshot, input.ref);
    if (recorded.lifecycle.status !== "composed" || recorded.revision !== 1 ||
        !same(recorded.delivery_manifest, current.delivery_manifest) ||
        !same(recorded.composition_proof, compositionProof)) {
      fail("delivery_candidate_store_unavailable", "candidate store did not retain the exact composition proof");
    }
    return operationRecord(recorded, "delivery_candidate_composed", !written.persisted);
  }

  return freeze({
    initializeCandidate,
    composeCandidate,
    binding: freeze(clone(owner)),
  });
}

module.exports = {
  VERSION,
  DeliveryCompositionServiceError,
  createDeliveryCompositionService,
};

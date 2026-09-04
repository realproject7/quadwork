"use strict";

// #1060 M6: server-owned Git-object authority for a Delivery Candidate.  It
// never accepts a caller path, branch, remote, or result SHA.  The registered
// base clone supplies the only result identity (its clean current HEAD), and
// composition is confined to unattached tree objects made with `git mktree`.
// In particular, this adapter never checks out, stages, resets, commits,
// moves a ref, pushes, or creates/removes a worktree.

const crypto = require("node:crypto");
const path = require("node:path");
const { assertDeliveryCandidateRef, expectedCandidateBase } = require("./delivery-candidate");
const { workTaskKey } = require("./work-task-manifest");
const {
  buildRepositoryWorktreePlan,
  canonicalRepositoryFromRemote,
} = require("./repository-provisioning");

const VERSION = 1;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const INSTALLATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PATH_RE = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.(?:\/|$))(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/@+~=-]{1,240}$/;
const MODE_RE = /^(100644|100755|120000)$/;
const PATCH_FORMAT = "git_full_index_binary_v1";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TREE_ENTRIES = 16384;
const MAX_PATCH_FILES = 1024;

class DeliveryGitObjectAdapterError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DeliveryGitObjectAdapterError";
    this.code = code;
  }
}

function fail(code, message) { throw new DeliveryGitObjectAdapterError(code, message); }
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
  return Array.isArray(value) ? "[" + value.map(stable).join(",") + "]" : plain(value)
    ? "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}"
    : JSON.stringify(value);
}
function hash(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function same(left, right) { return stable(left) === stable(right); }
function sha(value, code) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(code, "Git object ID is invalid");
  return value;
}
function repository(value, code) {
  if (typeof value !== "string" || !REPOSITORY_RE.test(value)) fail(code, "repository is invalid");
  return value.toLowerCase();
}
function canonicalPath(authority, value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.length > 1024 || /[\u0000\r\n]/.test(value)) {
    fail(code, "path is invalid");
  }
  let result;
  try { result = authority(freeze({ version: VERSION, path: value })); }
  catch { fail("delivery_git_canonical_path_unavailable", "canonical path authority failed"); }
  if (typeof result !== "string" || !path.isAbsolute(result) || result.length > 1024 || /[\u0000\r\n]/.test(result)) {
    fail("delivery_git_canonical_path_invalid", "canonical path authority returned an invalid path");
  }
  const normalized = path.posix.normalize(result);
  if (normalized === "/" || normalized !== result || normalized.endsWith("/")) {
    fail("delivery_git_canonical_path_invalid", "canonical path is not normalized");
  }
  return normalized;
}
function binding(value, code) {
  exact(value, ["installation_id", "project_id", "role", "generation"], code);
  if (!INSTALLATION_RE.test(value.installation_id) || !PROJECT_RE.test(value.project_id) || value.role !== "head" ||
      !Number.isSafeInteger(value.generation) || value.generation < 0) {
    fail(code, "Head binding is invalid");
  }
  return { installation_id: value.installation_id, project_id: value.project_id, role: "head", generation: value.generation };
}
function candidateRef(value, code) {
  try { return clone(assertDeliveryCandidateRef(value, code)); }
  catch { fail(code, "delivery candidate reference is invalid"); }
}
function gitResult(value, code) {
  exact(value, ["ok", "output"], code);
  if (typeof value.ok !== "boolean" || typeof value.output !== "string" || Buffer.byteLength(value.output, "utf8") > MAX_OUTPUT_BYTES) {
    fail(code, "Git observation is invalid");
  }
  return value;
}
function taskKey(value, code) {
  try { return workTaskKey(value); }
  catch { fail(code, "work task reference is invalid"); }
}
function treeEntry(value, code) {
  exact(value, ["path", "mode", "blob_sha"], code);
  if (!PATH_RE.test(value.path) || !MODE_RE.test(value.mode) || !SHA_RE.test(value.blob_sha)) {
    fail(code, "tree entry is invalid");
  }
  return { path: value.path, mode: value.mode, blob_sha: value.blob_sha };
}
function side(value, pathValue, code) {
  if (value === null) return null;
  const entry = treeEntry({ path: pathValue, mode: value.mode, blob_sha: value.blob_sha }, code);
  return entry;
}
function outputEntry(entry) { return { path: entry.path, mode: entry.mode, blob_sha: entry.blob_sha }; }
function changedFiles(base, result) {
  const before = new Map(base.entries.map((entry) => [entry.path, entry]));
  const after = new Map(result.entries.map((entry) => [entry.path, entry]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((entryPath) => ({
    path: entryPath,
    before: before.has(entryPath) ? outputEntry(before.get(entryPath)) : null,
    after: after.has(entryPath) ? outputEntry(after.get(entryPath)) : null,
  })).filter((entry) => !same(entry.before, entry.after));
}
function patchPayload(patch) {
  return {
    version: patch.version,
    format: patch.format,
    scope: patch.scope,
    base_sha: patch.base_sha,
    result_sha: patch.result_sha,
    base_tree_sha: patch.base_tree_sha,
    result_tree_sha: patch.result_tree_sha,
    source_worktree_path: patch.source_worktree_path,
    files: patch.files.map(clone),
  };
}
function patchEnvelope(patch, file) {
  // The composer carries object facts separately and never sends this payload
  // to `git apply`. This envelope deliberately pins the full-index object
  // transition, so a later object-level `mktree` application cannot treat a
  // file fact as an unbound textual diff.
  return "GIT binary patch\nliteral " + hash({
    version: VERSION,
    format: PATCH_FORMAT,
    scope: patch.scope,
    base_sha: patch.base_sha,
    result_sha: patch.result_sha,
    base_tree_sha: patch.base_tree_sha,
    result_tree_sha: patch.result_tree_sha,
    path: file.path,
    before: file.before,
    after: file.after,
  }) + "\n";
}
function patchFromTrees(scope, baseSha, resultSha, baseTree, resultTree, sourceWorktreePath) {
  const seed = {
    version: VERSION,
    format: PATCH_FORMAT,
    scope,
    base_sha: baseSha,
    result_sha: resultSha,
    base_tree_sha: baseTree.tree_sha,
    result_tree_sha: resultTree.tree_sha,
    source_worktree_path: sourceWorktreePath,
  };
  const files = changedFiles(baseTree, resultTree).map((file) => ({
    ...file,
    binary_delta: patchEnvelope(seed, file),
  }));
  if (files.length === 0 || files.length > MAX_PATCH_FILES) fail("delivery_git_patch_invalid", "Git object transition has no bounded change set");
  const patch = { ...seed, files };
  return freeze({ ...patch, patch_digest: hash(patchPayload(patch)) });
}

function source(value, owner, code) {
  exact(value, ["version", "registered_repository", "frozen_batch_manifest", "delivery_mode", "cut_id", "base_sha", "staged_tasks", "deferred_exclusions"], code);
  if (value.version !== VERSION || !plain(value.registered_repository) || !plain(value.frozen_batch_manifest) ||
      value.registered_repository.installation_id !== owner.installation_id || value.registered_repository.project_id !== owner.project_id ||
      !REPOSITORY_KEY_RE.test(value.registered_repository.repository_key) || repository(value.registered_repository.repository, code) === "" ||
      !SHA_RE.test(value.base_sha) || !["integrated", "isolated"].includes(value.delivery_mode) ||
      typeof value.cut_id !== "string" || !/^[a-z][a-z0-9_-]{2,95}$/.test(value.cut_id) || !Array.isArray(value.staged_tasks) ||
      value.staged_tasks.length === 0 || !Array.isArray(value.deferred_exclusions) ||
      value.frozen_batch_manifest.installation_id !== owner.installation_id || value.frozen_batch_manifest.project_id !== owner.project_id ||
      !SHA_RE.test(value.frozen_batch_manifest.manifest_digest) || !Array.isArray(value.frozen_batch_manifest.tasks)) {
    fail(code, "delivery source is invalid");
  }
  return clone(value);
}
function sourceStage(deliverySource, ref, request, code) {
  if (deliverySource.registered_repository.repository_key !== ref.repository_key ||
      deliverySource.frozen_batch_manifest.manifest_digest !== ref.batch_manifest_digest ||
      deliverySource.delivery_mode !== ref.delivery_mode || deliverySource.cut_id !== ref.cut_id || deliverySource.base_sha !== ref.base_sha) {
    fail(code, "delivery source changed outside this candidate");
  }
  const requestedKey = taskKey(request.work_task_ref, code);
  const stage = deliverySource.staged_tasks.find((entry) => plain(entry) && plain(entry.candidate) &&
    taskKey(entry.candidate.work_task_ref, code) === requestedKey);
  if (!stage || !plain(stage.candidate) || !plain(stage.terminal_review) ||
      stage.candidate.candidate_digest !== request.candidate_digest ||
      (Object.hasOwn(request, "base_sha") && stage.candidate.base_sha !== request.base_sha) ||
      (Object.hasOwn(request, "candidate_sha") && stage.candidate.candidate_sha !== request.candidate_sha) ||
      !plain(stage.candidate.managed_worktree) ||
      typeof stage.candidate.managed_worktree.canonical_path !== "string") {
    fail(code, "reviewed task provenance changed");
  }
  return clone(stage);
}

function createDeliveryGitObjectAdapter(options) {
  exact(options, ["repositories", "primary_agent_cwds", "repository_worktrees", "canonicalize_path", "run_git", "read_delivery_source"], "invalid_delivery_git_object_adapter_options");
  if (typeof options.canonicalize_path !== "function" || typeof options.run_git !== "function" || typeof options.read_delivery_source !== "function") {
    fail("invalid_delivery_git_object_adapter_options", "Git object authorities are required");
  }
  let planned;
  try {
    planned = buildRepositoryWorktreePlan(options.repositories, {
      primaryAgentCwds: options.primary_agent_cwds,
      repositoryWorktrees: options.repository_worktrees,
    });
  } catch {
    fail("invalid_delivery_git_object_adapter_options", "registered repository plan is invalid");
  }
  const repositories = new Map(planned.map((entry) => [entry.key, freeze({
    key: entry.key,
    repository: entry.canonical_repo,
    base_path: canonicalPath(options.canonicalize_path, entry.working_dir, "invalid_delivery_git_object_adapter_options"),
  })]));

  function run(repositoryRecord, args, input = null) {
    let observed;
    try {
      observed = options.run_git(freeze({
        version: VERSION,
        cwd: repositoryRecord.base_path,
        args: freeze([...args]),
        ...(input === null ? {} : { input }),
      }));
    } catch {
      fail("delivery_git_unavailable", "Git object observation failed");
    }
    return gitResult(observed, "delivery_git_observation_invalid");
  }
  function command(repositoryRecord, args, code, input = null) {
    const observed = run(repositoryRecord, args, input);
    if (!observed.ok) fail(code, "registered Git object operation failed");
    return observed.output.trim();
  }
  function rawCommand(repositoryRecord, args, code) {
    const observed = run(repositoryRecord, args);
    if (!observed.ok) fail(code, "registered Git object operation failed");
    return observed.output;
  }
  function registered(ref, code) {
    const record = repositories.get(ref.repository_key);
    if (!record) fail(code, "repository is not registered");
    return record;
  }
  function assertCurrentClone(record, ref, code) {
    const topLevel = canonicalPath(options.canonicalize_path,
      command(record, ["rev-parse", "--show-toplevel"], `${code}_top_level_unavailable`), `${code}_top_level_invalid`);
    if (topLevel !== record.base_path) fail(`${code}_top_level_mismatch`, "registered base path is not its Git worktree");
    const origin = canonicalRepositoryFromRemote(command(record, ["remote", "get-url", "origin"], `${code}_origin_unavailable`));
    if (origin !== record.repository) fail(`${code}_origin_mismatch`, "registered base origin changed");
    if (command(record, ["status", "--porcelain", "--untracked-files=all"], `${code}_status_unavailable`) !== "") {
      fail(`${code}_dirty`, "registered base clone has uncommitted changes");
    }
    const head = command(record, ["rev-parse", "--verify", "HEAD"], `${code}_head_unavailable`);
    if (!SHA_RE.test(head)) fail(`${code}_head_invalid`, "registered base HEAD is invalid");
    if (ref !== null && head !== ref.result_sha) fail(`${code}_result_changed`, "registered base HEAD changed from Delivery Candidate result");
    return head;
  }
  function readCommit(record, expectedRepository, value, code) {
    const objectId = sha(value, code);
    const commitId = command(record, ["rev-parse", "--verify", `${objectId}^{commit}`], code);
    if (commitId !== objectId) fail(code, "commit object identity is not exact");
    const treeSha = command(record, ["show", "-s", "--format=%T", objectId], code);
    if (!SHA_RE.test(treeSha)) fail(code, "commit tree identity is invalid");
    return freeze({ version: VERSION, repository: expectedRepository, sha: objectId, tree_sha: treeSha });
  }
  function readTree(record, expectedRepository, value, code) {
    const treeSha = sha(value, code);
    const verified = command(record, ["rev-parse", "--verify", `${treeSha}^{tree}`], code);
    if (verified !== treeSha) fail(code, "tree object identity is not exact");
    const raw = rawCommand(record, ["ls-tree", "-r", "-z", "--full-tree", treeSha], code);
    const records = raw === "" ? [] : raw.split("\0").slice(0, -1);
    if (records.length > MAX_TREE_ENTRIES || (raw !== "" && !raw.endsWith("\0"))) fail(code, "tree output is invalid");
    const entries = records.map((line) => {
      const match = line.match(/^(100644|100755|120000) blob ((?:[a-f0-9]{40}|[a-f0-9]{64}))\t(.+)$/);
      if (!match || !PATH_RE.test(match[3])) fail(code, "tree contains an unsupported entry");
      return { path: match[3], mode: match[1], blob_sha: match[2] };
    });
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length || !same(entries.map((entry) => entry.path), [...entries.map((entry) => entry.path)].sort())) {
      fail(code, "tree paths are not canonical");
    }
    return freeze({ version: VERSION, repository: expectedRepository, tree_sha: treeSha, entries });
  }
  function freshSource(owner, ref, code) {
    let observed;
    try {
      observed = options.read_delivery_source(freeze({
        version: VERSION,
        installation_id: owner.installation_id,
        project_id: owner.project_id,
        repository_key: ref.repository_key,
      }));
    } catch {
      fail(code, "durable Delivery Candidate source is unavailable");
    }
    return source(observed, owner, code);
  }
  function expectedBoundary(deliverySource, code) {
    const keys = new Set(deliverySource.staged_tasks.map((stage) => {
      if (!plain(stage) || !plain(stage.candidate)) fail(code, "staged candidate is invalid");
      return taskKey(stage.candidate.work_task_ref, code);
    }));
    // A dependent may declare its predecessor's path again; the cut boundary
    // is the declared path set, exactly as the manifest evidence pins it.
    const paths = [...new Set(deliverySource.frozen_batch_manifest.tasks
      .filter((entry) => plain(entry) && keys.has(taskKey(entry.ref, code)))
      .flatMap((entry) => Array.isArray(entry.contract?.file_boundary) ? entry.contract.file_boundary : []))]
      .sort();
    if (paths.length === 0 || !paths.every((entry) => PATH_RE.test(entry))) {
      fail(code, "frozen delivery boundary is invalid");
    }
    return paths;
  }
  function createObjects(owner, ref) {
    const record = registered(ref, "delivery_git_repository_unregistered");
    if (owner.installation_id !== ref.installation_id || owner.project_id !== ref.project_id) {
      fail("delivery_git_candidate_owner_mismatch", "Delivery Candidate is outside this Head project");
    }
    const requireCurrent = (code) => {
      assertCurrentClone(record, ref, code);
      return record;
    };
    const sourceForCandidate = (request, code) => sourceStage(freshSource(owner, ref, code), ref, request, code);
    function writeTreeFromEntries(current, entries, code) {
      const root = { files: [], directories: new Map() };
      for (const entry of entries) {
        const segments = entry.path.split("/");
        let cursor = root;
        for (const segment of segments.slice(0, -1)) {
          if (!cursor.directories.has(segment)) cursor.directories.set(segment, { files: [], directories: new Map() });
          cursor = cursor.directories.get(segment);
        }
        cursor.files.push({ name: segments.at(-1), entry });
      }
      function writeNode(node) {
        const records = [];
        for (const file of node.files) records.push({ name: file.name, mode: file.entry.mode, type: "blob", sha: file.entry.blob_sha });
        for (const [name, child] of node.directories) records.push({ name, mode: "040000", type: "tree", sha: writeNode(child) });
        records.sort((left, right) => left.name.localeCompare(right.name));
        if (records.length === 0 || new Set(records.map((entry) => entry.name)).size !== records.length) {
          fail(code, "composed tree hierarchy is invalid");
        }
        const objectInput = records.map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.name}\n`).join("");
        const treeSha = command(current, ["mktree"], code, objectInput);
        if (!SHA_RE.test(treeSha)) fail(code, "Git did not return a tree object");
        return treeSha;
      }
      return writeNode(root);
    }
    function assertRepositoryRequest(request, fields, code) {
      exact(request, fields, code);
      if (request.version !== VERSION || repository(request.repository, code) !== record.repository) fail(code, "repository request is not registered");
    }
    function objectPatch(scope, request, code) {
      const current = requireCurrent(code);
      const resultSha = scope === "candidate" ? request.candidate_sha : request.result_sha;
      const baseCommit = readCommit(current, record.repository, request.base_sha, code);
      const resultCommit = readCommit(current, record.repository, resultSha, code);
      const baseTree = readTree(current, record.repository, baseCommit.tree_sha, code);
      const resultTree = readTree(current, record.repository, resultCommit.tree_sha, code);
      return patchFromTrees(scope, request.base_sha, resultSha, baseTree, resultTree, request.source_worktree_path);
    }
    return freeze({
      readCommit(request) {
        assertRepositoryRequest(request, ["version", "repository", "sha"], "delivery_git_commit_request_invalid");
        return readCommit(requireCurrent("delivery_git_commit"), record.repository, request.sha, "delivery_git_commit_invalid");
      },
      readTree(request) {
        assertRepositoryRequest(request, ["version", "repository", "tree_sha"], "delivery_git_tree_request_invalid");
        return readTree(requireCurrent("delivery_git_tree"), record.repository, request.tree_sha, "delivery_git_tree_invalid");
      },
      readReviewedTask(request) {
        assertRepositoryRequest(request, ["version", "repository", "delivery_candidate_ref", "delivery_manifest_digest", "sequence", "work_task_ref", "candidate_digest"], "delivery_git_reviewed_task_request_invalid");
        const requestedRef = candidateRef(request.delivery_candidate_ref, "delivery_git_reviewed_task_request_invalid");
        if (!same(requestedRef, ref) || !SHA_RE.test(request.delivery_manifest_digest) || !Number.isSafeInteger(request.sequence) || request.sequence < 1 || !SHA_RE.test(request.candidate_digest)) {
          fail("delivery_git_reviewed_task_request_invalid", "reviewed task request is invalid");
        }
        const stage = sourceForCandidate({ work_task_ref: request.work_task_ref, candidate_digest: request.candidate_digest }, "delivery_git_reviewed_task_stale");
        return freeze({
          version: VERSION,
          work_task_ref: clone(stage.candidate.work_task_ref),
          candidate_digest: stage.candidate.candidate_digest,
          base_sha: stage.candidate.base_sha,
          candidate_sha: stage.candidate.candidate_sha,
          terminal_review: clone(stage.terminal_review),
          source_worktree_path: stage.candidate.managed_worktree.canonical_path,
        });
      },
      readCandidatePatch(request) {
        assertRepositoryRequest(request, ["version", "repository", "delivery_candidate_ref", "delivery_manifest_digest", "sequence", "work_task_ref", "candidate_digest", "base_sha", "candidate_sha", "base_tree_sha", "candidate_tree_sha", "source_worktree_path"], "delivery_git_candidate_patch_request_invalid");
        const requestedRef = candidateRef(request.delivery_candidate_ref, "delivery_git_candidate_patch_request_invalid");
        if (!same(requestedRef, ref) || !SHA_RE.test(request.delivery_manifest_digest) || !Number.isSafeInteger(request.sequence) || request.sequence < 1 ||
            !SHA_RE.test(request.candidate_digest) || !SHA_RE.test(request.base_sha) || !SHA_RE.test(request.candidate_sha) ||
            !SHA_RE.test(request.base_tree_sha) || !SHA_RE.test(request.candidate_tree_sha) || typeof request.source_worktree_path !== "string") {
          fail("delivery_git_candidate_patch_request_invalid", "candidate patch request is invalid");
        }
        const stage = sourceForCandidate(request, "delivery_git_candidate_patch_stale");
        if (stage.candidate.managed_worktree.canonical_path !== request.source_worktree_path) {
          fail("delivery_git_candidate_patch_stale", "candidate worktree provenance changed");
        }
        const patch = objectPatch("candidate", request, "delivery_git_candidate_patch");
        if (patch.base_tree_sha !== request.base_tree_sha || patch.result_tree_sha !== request.candidate_tree_sha) {
          fail("delivery_git_candidate_patch_stale", "candidate tree provenance changed");
        }
        return patch;
      },
      readDeliveryPatch(request) {
        assertRepositoryRequest(request, ["version", "repository", "delivery_candidate_ref", "delivery_manifest_digest", "base_sha", "result_sha", "base_tree_sha", "result_tree_sha"], "delivery_git_delivery_patch_request_invalid");
        const requestedRef = candidateRef(request.delivery_candidate_ref, "delivery_git_delivery_patch_request_invalid");
        if (!same(requestedRef, ref) || !SHA_RE.test(request.delivery_manifest_digest) || request.base_sha !== ref.base_sha ||
            request.result_sha !== ref.result_sha || !SHA_RE.test(request.base_tree_sha) || !SHA_RE.test(request.result_tree_sha)) {
          fail("delivery_git_delivery_patch_request_invalid", "delivery patch request is invalid");
        }
        const patch = objectPatch("delivery", { ...request, source_worktree_path: null }, "delivery_git_delivery_patch");
        if (patch.base_tree_sha !== request.base_tree_sha || patch.result_tree_sha !== request.result_tree_sha) {
          fail("delivery_git_delivery_patch_stale", "delivery tree provenance changed");
        }
        return patch;
      },
      applyPatch(request) {
        assertRepositoryRequest(request, ["version", "repository", "scope", "delivery_candidate_ref", "delivery_manifest_digest", "sequence", "work_task_ref", "input_tree_sha", "expected_result_tree_sha", "patch", "predecessor_handoffs"], "delivery_git_apply_request_invalid");
        const requestedRef = candidateRef(request.delivery_candidate_ref, "delivery_git_apply_request_invalid");
        if (!same(requestedRef, ref) || !["delivery_verification", "candidate_verification", "composition"].includes(request.scope) ||
            !SHA_RE.test(request.delivery_manifest_digest) || !Number.isSafeInteger(request.sequence) || request.sequence < 0 ||
            (request.work_task_ref !== null && !plain(request.work_task_ref)) || !SHA_RE.test(request.input_tree_sha) ||
            (request.expected_result_tree_sha !== null && !SHA_RE.test(request.expected_result_tree_sha)) || !plain(request.patch) ||
            !Array.isArray(request.predecessor_handoffs)) {
          fail("delivery_git_apply_request_invalid", "object patch application request is invalid");
        }
        const current = requireCurrent("delivery_git_apply");
        const input = readTree(current, record.repository, request.input_tree_sha, "delivery_git_apply_input_tree_invalid");
        const patch = request.patch;
        const expectedPatchScope = request.scope === "delivery_verification" ? "delivery" : "candidate";
        if (patch.version !== VERSION || patch.format !== PATCH_FORMAT || patch.scope !== expectedPatchScope ||
            !Array.isArray(patch.files) || patch.files.length === 0 || patch.files.length > MAX_PATCH_FILES || !SHA_RE.test(patch.patch_digest) ||
            patch.patch_digest !== hash(patchPayload(patch))) {
          fail("delivery_git_apply_patch_invalid", "object patch is invalid");
        }
        const entries = new Map(input.entries.map((entry) => [entry.path, outputEntry(entry)]));
        for (const file of patch.files) {
          if (!plain(file) || !PATH_RE.test(file.path) || typeof file.binary_delta !== "string" || !file.binary_delta.startsWith("GIT binary patch\n")) {
            fail("delivery_git_apply_patch_invalid", "object patch file is invalid");
          }
          const before = side(file.before, file.path, "delivery_git_apply_patch_invalid");
          const after = side(file.after, file.path, "delivery_git_apply_patch_invalid");
          const actual = entries.has(file.path) ? entries.get(file.path) : null;
          if (!same(actual, before)) fail("delivery_git_apply_not_clean", "object patch does not apply to the exact input tree");
          if (after === null) entries.delete(file.path);
          else entries.set(file.path, { path: file.path, ...after });
        }
        const outputEntries = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
        if (outputEntries.length > MAX_TREE_ENTRIES) fail("delivery_git_apply_tree_limit", "composed tree exceeds its entry bound");
        const treeSha = writeTreeFromEntries(current, outputEntries, "delivery_git_apply_unavailable");
        if (request.expected_result_tree_sha !== null && treeSha !== request.expected_result_tree_sha) {
          fail("delivery_git_apply_not_clean", "object patch did not produce its pinned result tree");
        }
        return freeze({ version: VERSION, scope: request.scope, status: "applied", input_tree_sha: input.tree_sha,
          result_tree_sha: treeSha, applied_patch_digest: patch.patch_digest });
      },
    });
  }

  function readDeliveryEvidence(request) {
    exact(request, ["version", "head_binding", "delivery_source"], "invalid_delivery_git_evidence_request");
    if (request.version !== VERSION) fail("invalid_delivery_git_evidence_request", "evidence request version is invalid");
    const owner = binding(request.head_binding, "invalid_delivery_git_evidence_request");
    const staged = source(request.delivery_source, owner, "invalid_delivery_git_evidence_request");
    const record = repositories.get(staged.registered_repository.repository_key);
    if (!record || record.repository !== repository(staged.registered_repository.repository, "invalid_delivery_git_evidence_request")) {
      fail("delivery_git_repository_unregistered", "delivery repository is not registered");
    }
    const resultSha = assertCurrentClone(record, null, "delivery_git_evidence");
    if (resultSha === staged.base_sha) fail("delivery_git_result_unchanged", "registered result HEAD has not advanced beyond the delivery base");
    const base = readCommit(record, record.repository, staged.base_sha, "delivery_git_evidence_base_invalid");
    const result = readCommit(record, record.repository, resultSha, "delivery_git_evidence_result_invalid");
    if (!run(record, ["merge-base", "--is-ancestor", staged.base_sha, resultSha]).ok) {
      fail("delivery_git_evidence_base_mismatch", "delivery base is not an ancestor of registered result");
    }
    const baseTree = readTree(record, record.repository, base.tree_sha, "delivery_git_evidence_base_tree_invalid");
    const resultTree = readTree(record, record.repository, result.tree_sha, "delivery_git_evidence_result_tree_invalid");
    if (baseTree.tree_sha === resultTree.tree_sha) fail("delivery_git_result_unchanged", "registered result tree has not changed");
    // #1065: a root candidate descends from the frozen base; a same-repository
    // dependent descends from its predecessor's exact candidate, which is its base.
    const candidates = staged.staged_tasks.map((stage) => plain(stage) && plain(stage.candidate) ? stage.candidate
      : fail("delivery_git_evidence_candidate_invalid", "staged candidate provenance is invalid"));
    for (const candidate of candidates) {
      let expectedBase;
      try { expectedBase = expectedCandidateBase(staged.frozen_batch_manifest.tasks, candidates, candidate, staged.base_sha); }
      catch { fail("delivery_git_evidence_candidate_invalid", "staged candidate provenance is invalid"); }
      if (candidate.base_sha !== expectedBase || !SHA_RE.test(candidate.candidate_sha)) {
        fail("delivery_git_evidence_candidate_invalid", "staged candidate provenance is invalid");
      }
      readCommit(record, record.repository, candidate.candidate_sha, "delivery_git_evidence_candidate_invalid");
      if (!run(record, ["merge-base", "--is-ancestor", candidate.base_sha, candidate.candidate_sha]).ok) {
        fail("delivery_git_evidence_candidate_invalid", "staged candidate does not descend from its base");
      }
    }
    const patch = patchFromTrees("delivery", staged.base_sha, resultSha, baseTree, resultTree, null);
    const paths = expectedBoundary(staged, "delivery_git_evidence_boundary_invalid");
    return freeze({
      version: VERSION,
      installation_id: owner.installation_id,
      project_id: owner.project_id,
      repository_key: record.key,
      result_sha: resultSha,
      evidence: freeze({
        boundary: freeze({ paths, boundary_digest: hash({ version: VERSION, paths }) }),
        patch: freeze({ base_sha: staged.base_sha, result_sha: resultSha, patch_digest: patch.patch_digest }),
        tree: freeze({ base_tree_sha: baseTree.tree_sha, result_tree_sha: resultTree.tree_sha,
          tree_digest: hash({ version: VERSION, base_tree_sha: baseTree.tree_sha, result_tree_sha: resultTree.tree_sha }) }),
      }),
    });
  }
  function repositoryObjectsFor(request) {
    exact(request, ["version", "head_binding", "delivery_candidate_ref"], "invalid_delivery_git_objects_request");
    if (request.version !== VERSION) fail("invalid_delivery_git_objects_request", "object request version is invalid");
    return createObjects(binding(request.head_binding, "invalid_delivery_git_objects_request"),
      candidateRef(request.delivery_candidate_ref, "invalid_delivery_git_objects_request"));
  }
  return freeze({ readDeliveryEvidence, repositoryObjectsFor });
}

module.exports = {
  VERSION,
  DeliveryGitObjectAdapterError,
  createDeliveryGitObjectAdapter,
};

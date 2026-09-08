"use strict";
require("./__tests__/resource-executor-fixture").installResourceExecutorFixture();

// Exercise the production routes/stores/dispatcher and file-chat transport.
// Only GitHub I/O and the already-tested composed-candidate store reader are
// fixtures; no workflow, Git mutation, worker, or real credential is used.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const util = require("node:util");
const { buildBatchManifest, freezeBatchManifest } = require("./work-task-manifest");
const { buildWorkTaskCandidate } = require("./work-task-candidate");
const { openTaskReviewRound, submitTaskReviewReceipt } = require("./task-review-round");
const { buildDeliveryManifest } = require("./delivery-candidate");

const installation_id = "installation_final_review_01", project_id = "quadwork";
const base_sha = "a".repeat(40), candidate_sha = "b".repeat(40), result_sha = "c".repeat(40);
const owner = { installation_id, project_id, role: "head", generation: 3 };
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) { return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value); }
function digest(value) { return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex"); }
function manifest() {
  const batch = freezeBatchManifest(buildBatchManifest({ version: 1, installation_id, project_id, delivery_mode: "integrated", tasks: [{ task_key: "final", repository_key: "web", work_item: { repoKey: "web", repo: "Owner/Web", number: 1061, kind: "issue" }, goal: "admit final review", file_boundary: ["server/final.js"], validation: ["node-test"], dependencies: [] }] }, {
    resolveRegisteredIdentity(input) { return { ...input, work_item: copy(input.work_item), issue_body_revision: "d".repeat(64) }; },
  }), "2026-09-02T09:00:00.000Z");
  const candidate = buildWorkTaskCandidate({ version: 1, work_task_ref: copy(batch.tasks[0].ref), base_sha, candidate_sha, branch: "task/final", worktree: { repository_key: "web", worktree_id: "wt_web_final", path: "/private/var/quadwork/final" } }, {
    canonicalizePath(input) { return { version: 1, canonical_path: input.path }; },
    inspectManagedWorktree(input) { return { version: 1, registered: true, readable: true, repository_key: "web", worktree_id: "wt_web_final", canonical_path: input.expected.canonical_path, branch: input.expected.branch, base_sha, head_sha: candidate_sha, dirty: false, occupancy: "vacant" }; },
    readCanonicalInstalledState() { return { version: 1, installation_id, project_id, v1_state: "present" }; },
  });
  const opened = openTaskReviewRound({ version: 1, candidate, attempt: "attempt_final", round: 1, opened_at: "2026-09-02T09:01:00.000Z" }, { version: 1, reviewers: [{ reviewer_role: "re1", reviewer_generation: 1 }, { reviewer_role: "re2", reviewer_generation: 1 }] });
  const receipt = (role) => { const payload = { version: 1, review_round_ref: copy(opened.review_round_ref), receipt_id: `receipt_${role}_final`, verdict: "approve", findings: [] }; return { ...payload, receipt_digest: digest(payload) }; };
  const first = submitTaskReviewReceipt(opened, receipt("re1"), { version: 1, reviewer_role: "re1", reviewer_generation: 1, received_at: "2026-09-02T09:02:00.000Z" });
  const released = submitTaskReviewReceipt(first.round, receipt("re2"), { version: 1, reviewer_role: "re2", reviewer_generation: 1, received_at: "2026-09-02T09:03:00.000Z" }).round;
  const ref = { version: 1, installation_id, project_id, repository_key: "web", batch_manifest_digest: batch.manifest_digest, delivery_mode: "integrated", base_sha, result_sha, cut_id: "cut_final_review" };
  const paths = ["server/final.js"];
  return buildDeliveryManifest({ version: 1, delivery_candidate_ref: ref, frozen_batch_manifest: batch, staged_tasks: [{ candidate, review_round: released }], deferred_exclusions: [], evidence: { boundary: { paths, boundary_digest: digest({ version: 1, paths }) }, patch: { base_sha, result_sha, patch_digest: "e".repeat(64) }, tree: { base_tree_sha: "f".repeat(40), result_tree_sha: "1".repeat(40), tree_digest: digest({ version: 1, base_tree_sha: "f".repeat(40), result_tree_sha: "1".repeat(40) }) } } }, {
    resolveRegisteredRepository() { return { version: 1, installation_id, project_id, repository_key: "web", repository: "Owner/Web" }; },
  });
}


const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "qw-local-verification-"));
const originalHome = os.homedir, originalExec = childProcess.execFile;
os.homedir = () => testHome;
const configDir = path.join(testHome, ".quadwork");
fs.mkdirSync(configDir, { mode: 0o700 });
const { deriveCiPolicyIdentity, evaluateCiEvidence } = require("./ci-evidence-policy");
const localPolicy = { version: 1, mode: "ci-less", evidence_keys: ["unit"] };
let selectedPolicy = localPolicy;
function writeConfig() {
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ installation_id, projects: [{
    id: project_id, name: "Local verification", repositories: [{ key: "web", repo: "Owner/Web", working_dir: testHome, primary: true, ci_policy: selectedPolicy }],
  }] }), { mode: 0o600 });
}
writeConfig();
let pull = { number: 1062, state: "open", draft: false, mergeable: true, head: { sha: result_sha }, base: { sha: base_sha } };
let candidate = manifest(), candidateMissing = false, checksUnavailable = true;
const commands = [], reviewRows = new Map();
function fakeExec(command, args, options, callback) {
  const done = typeof options === "function" ? options : callback;
  commands.push({ command, args });
  const endpoint = args[1];
  let data;
  try {
    assert.equal(command, "gh"); assert.equal(args[0], "api");
    assert(!args.some((arg) => ["POST", "PATCH", "PUT", "DELETE"].includes(arg)), "GitHub writes are forbidden in this fixture");
    if (/\/(check-runs|status)(?:\?|$)/.test(endpoint)) {
      if (checksUnavailable) throw new Error("check API unavailable");
      data = endpoint.includes("check-runs") ? { check_runs: [{ id: 1, name: "unit", head_sha: result_sha, status: "completed", conclusion: "failure" }] } : { statuses: [] };
    } else if (endpoint === "repos/owner/web/pulls/1062") data = pull;
    else if (/\/reviews\/\d+$/.test(endpoint)) data = reviewRows.get(Number(endpoint.split("/").at(-1)));
    else if (endpoint.includes("pulls?state=open")) data = [pull];
    else if (endpoint.includes("/reviews?") || endpoint.includes("issues?") || endpoint.includes("pulls?state=closed")) data = [];
    else throw new Error(`unexpected endpoint ${endpoint}`);
    const stdout = (args.includes("-i") ? "HTTP/2 200 OK\r\nEtag: test\r\n\r\n" : "") + JSON.stringify(data);
    process.nextTick(() => done(null, stdout, ""));
  } catch (error) { process.nextTick(() => done(error, "", "")); }
}
fakeExec[util.promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
  fakeExec(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
childProcess.execFile = fakeExec;
const candidateStoreModule = require("./delivery-candidate-store");
const originalStore = candidateStoreModule.createDeliveryCandidateStore;
candidateStoreModule.createDeliveryCandidateStore = () => ({ readSnapshot() {
  if (candidateMissing) throw new Error("candidate unavailable");
  return { delivery_candidate_ref: candidate.delivery_candidate_ref, lifecycle: { status: "composed" }, delivery_manifest: candidate, composition_proof: { sealed: true } };
} });
const routes = require("./routes");
const fileChat = require("./file-chat");
const { ReviewCycleStore } = require("./review-cycle");
const { captureProjectAdmission } = require("./project-lifecycle");
const cycles = new ReviewCycleStore({ rootDir: configDir });
fileChat.initProject(project_id);
for (const role of ["head", "dev", "re1", "re2"]) fileChat.registerShimToken(project_id, role, `${role}-local-token`);
function currentCycle() { return Object.values(cycles.load(project_id).cycles).find((row) => row.state === "current"); }
function gateMessages() { return fileChat.readMessages(project_id, { limit: 100 }).filter((row) => row.text.includes("DELIVERY MERGE GATE DUE")); }
async function invoke(route, role, body) {
  const layer = routes.stack.find((entry) => entry.route?.path === route && entry.route.methods.post);
  assert(layer, route);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await layer.route.stack.at(-1).handle({ headers: { "x-chat-token": `${role}-local-token` }, query: {}, body }, response);
  return response;
}
function evidenceBody(extra = {}) {
  return { delivery_candidate_ref: candidate.delivery_candidate_ref, delivery_manifest_digest: candidate.delivery_manifest_digest,
    pr_number: 1062, exact_sha: result_sha, base_sha, policy_version: 1, policy_digest: deriveCiPolicyIdentity(localPolicy).policy_digest,
    verification: { environment: "Node 24 Linux x64", scope: "npm test" },
    results: [{ key: "unit", outcome: "pass", exit_code: 0, evidence_ref: "sha256:local-test-log" }], ...extra };
}
(async () => {
  assert.equal(routes.repositoryUsesLocalVerification("owner/web"), true);
  const fetched = await routes.githubStateFetcher("owner/web");
  assert.equal(fetched.status, "ok");
  assert.equal(fetched.data.prs[0].checkEvidence, null);
  assert.equal(commands.some((row) => /check-runs|\/status(?:\?|$)/.test(row.args[1])), false, "local-mode refresh reads no check/status API");
  const opened = await invoke("/api/delivery-candidate/final-review", "head", { delivery_candidate_ref: candidate.delivery_candidate_ref, pr_number: 1062 });
  assert.equal(opened.statusCode, 200, JSON.stringify(opened.body));
  assert.equal(currentCycle().ci_state, "ci_less_pending");
  for (const [index, role] of ["re1", "re2"].entries()) {
    const target_identity_digest = currentCycle().target_identity_digest;
    const nonce = await invoke("/api/review-cycle-nonce", role, { target_identity_digest });
    assert.equal(nonce.statusCode, 200, JSON.stringify(nonce.body));
    const review_id = index + 1;
    reviewRows.set(review_id, { id: review_id, state: "APPROVED", commit_id: result_sha, pull_request_url: "https://api.github.com/repos/owner/web/pulls/1062", submitted_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), body: nonce.body.nonce });
    const receipt = await invoke("/api/review-cycle-receipt", role, { target_identity_digest, review_id, nonce: nonce.body.nonce });
    assert.equal(receipt.statusCode, 200, JSON.stringify(receipt.body));
  }
  assert.equal(gateMessages().length, 0);
  const submitted = await invoke("/api/delivery-candidate/ci-evidence", "dev", evidenceBody());
  assert.equal(submitted.statusCode, 200, JSON.stringify(submitted.body));
  assert.equal(currentCycle().ci_state, "ci_less_pass");
  assert.equal(gateMessages().length, 1, "passing receipt advances the already-open cycle exactly once");
  // #1060 uses the real existing owner, not a synthetic approval boolean.
  // GitHub uses second precision, while durable receipt timestamps normalize
  // to milliseconds; equivalent instants must retain native standing.
  const deliveryEvidence = routes.createDeliveryReviewEvidenceService(project_id);
  assert.match(currentCycle().receipts.re1.submitted_at, /\.000Z$/);
  const sealed = await deliveryEvidence.read_merge_gate(candidate.delivery_candidate_ref, 1062);
  assert.equal(sealed.ready, true); assert.equal(sealed.verification.record_id, submitted.body.record.record_id);
  assert.equal(commands.some((row) => /check-runs|\/status(?:\?|$)/.test(row.args[1])), false, "premerge local proof never reads hosted check/status APIs");
  const originalReview = { ...reviewRows.get(1) };
  reviewRows.get(1).state = "DISMISSED";
  await assert.rejects(() => deliveryEvidence.revalidate_sealed_reviews(sealed), (error) => error.code === "delivery_review_integrity_lost");
  reviewRows.set(1, originalReview);
  await deliveryEvidence.revalidate_sealed_reviews(sealed);
  const repeated = await invoke("/api/delivery-candidate/ci-evidence", "dev", evidenceBody());
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.body.record.record_id, submitted.body.record.record_id);
  assert.equal(gateMessages().length, 1, "retry causes no duplicate Head wake");
  assert.equal(commands.some((row) => /check-runs|\/status(?:\?|$)/.test(row.args[1])), false);
  await routes.refreshRepoRest("owner/web", [captureProjectAdmission(project_id)], async () => ({ status: "error", data: null }));
  assert.equal(currentCycle().ci_state, "unknown", "a failed current PR refresh removes passing evidence standing");
  assert.equal(currentCycle().mergeable, false);
  await routes.refreshRepoRest("owner/web", [captureProjectAdmission(project_id)]);
  assert.equal(currentCycle().ci_state, "ci_less_pass");
  assert.equal(gateMessages().length, 1, "re-observing the same current evidence does not repeat the gate notice");
  for (const patch of [{ state: "closed" }, { draft: true }, { head: { sha: "9".repeat(40) } }, { base: { sha: "9".repeat(40) } }]) {
    const before = pull; pull = { ...pull, ...patch };
    const result = await invoke("/api/delivery-candidate/ci-evidence", "dev", evidenceBody());
    assert.notEqual(result.statusCode, 200, JSON.stringify(patch));
    pull = before;
  }
  for (const patch of [{ delivery_manifest_digest: "9".repeat(64) }, { policy_digest: "9".repeat(64) }]) {
    const result = await invoke("/api/delivery-candidate/ci-evidence", "dev", evidenceBody(patch));
    assert.notEqual(result.statusCode, 200);
  }
  candidateMissing = true;
  assert.notEqual((await invoke("/api/delivery-candidate/ci-evidence", "dev", evidenceBody())).statusCode, 200);
  candidateMissing = false;
  pull = { ...pull, base: { sha: "9".repeat(40) } };
  await routes.refreshRepoRest("owner/web", [captureProjectAdmission(project_id)]);
  assert.equal(currentCycle(), undefined, "successful PR refresh retires base-drift review standing");
  assert.equal(gateMessages().length, 1);
  pull = { ...pull, base: { sha: base_sha } };
  const withoutHead = await invoke("/api/delivery-candidate/ci-evidence", "dev", evidenceBody());
  assert.equal(withoutHead.statusCode, 200);
  assert.equal(currentCycle(), undefined, "Dev receipt alone cannot open a new Head-owned final review");
  // A terminalized old cycle retains its immutable proof for MERGED facts;
  // sealed review validation does not call the OPEN-only context reader.
  pull = { ...pull, state: "closed", merged_at: new Date().toISOString(), base: { sha: "8".repeat(40) } };
  await deliveryEvidence.revalidate_sealed_reviews(sealed);
  pull = { ...pull, state: "open", merged_at: null, base: { sha: base_sha } };
  selectedPolicy = { version: 1, mode: "github-checks", registration_grace_seconds: 0, same_sha_retry_budget: 0, checks: [{ name: "unit", required: true, kind: "product" }] };
  writeConfig(); checksUnavailable = false;
  const external = await routes.githubStateFetcher("owner/web");
  const check = external.data.prs[0].checkEvidence;
  assert(commands.some((row) => row.args[1].includes("check-runs")), "explicit external policy still reads checks");
  assert.equal(evaluateCiEvidence({ policy: selectedPolicy, exact_sha: result_sha, observed_at: check.observed_at, first_observed_at: check.observed_at, source_status: check.source_status, check_runs: check.check_runs }).state, "product_failure");
  console.log("routes.localVerification.test.js: authenticated delivery receipts, fresh PR/base guards, no-check local mode, deduplicated gates and external policy controls passed");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  childProcess.execFile = originalExec; candidateStoreModule.createDeliveryCandidateStore = originalStore; os.homedir = originalHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

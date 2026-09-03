// #1050: legacy numeric terminal caches are never Current Batch authority;
// in-memory rendered rows remain an observation-keyed performance cache.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const realRead = fs.readFileSync;
let cfgJson = JSON.stringify({ projects: [{ id: "terminal-proj", repo: "o/r", idle: false }] });
let queueText = "";
let snapshotJson = null;
let deletedSnapshots = 0;
let holdIssueLookup = false;
let releaseIssueLookup = null;

const realExecFile = cp.execFile;
cp.execFile = function execStub(file, args, options, callback) {
  const done = typeof options === "function" ? options : callback;
  if (file !== "gh" || typeof done !== "function") return realExecFile.apply(this, arguments);
  const target = args.find((arg) => typeof arg === "string" && arg === "repos/o/r/issues/10");
  if (holdIssueLookup && target) {
    releaseIssueLookup = () => done(new Error("held lookup released"), "", "transient");
    return undefined;
  }
  setImmediate(() => done(new Error("unexpected test gh call"), "", "test"));
  return undefined;
};

fs.readFileSync = function readStub(file, ...rest) {
  if (file === CONFIG_PATH) return cfgJson;
  if (typeof file === "string" && file.endsWith("OVERNIGHT-QUEUE.md")) return queueText;
  if (typeof file === "string" && file.endsWith("batch-progress-cache.json")) {
    if (snapshotJson !== null) return snapshotJson;
    const error = new Error("missing snapshot"); error.code = "ENOENT"; throw error;
  }
  if (typeof file === "string" && file.endsWith("GITHUB.md")) {
    const error = new Error("missing board"); error.code = "ENOENT"; throw error;
  }
  return realRead.call(this, file, ...rest);
};
fs.writeFileSync = function writeStub(file, data) {
  if (typeof file === "string" && file.endsWith("batch-progress-cache.json")) snapshotJson = String(data);
};
fs.mkdirSync = () => {};
fs.statSync = () => ({ mode: 0o700, isDirectory: () => true });
fs.unlinkSync = (file) => {
  if (typeof file === "string" && file.endsWith("batch-progress-cache.json")) {
    deletedSnapshots += 1;
    snapshotJson = null;
  }
};

const {
  getOrComputeBatchProgress,
  readLiveBatchContext,
  _batchProgressCache,
  _batchProgressRefreshes,
  _graphqlCache,
  cancelProjectBackground,
} = require("./routes");

function liveQueue() {
  return "# Queue\n\n## Active Batch\n\n**Batch:** 950\n\n- #10 live\n";
}

function openSnapshot(ts = Date.now()) {
  _graphqlCache.set("o/r", {
    ts,
    issues: [{ number: 10, title: "live 10", state: "OPEN", url: "https://x/i/10" }],
    prs: [], closedIssues: [], mergedPrs: [],
    openPrsWindowComplete: true,
    closedPrsWindowComplete: true,
    closedPrIssueNums: [],
  });
}

(async () => {
  queueText = liveQueue();
  snapshotJson = JSON.stringify({
    batchNumber: 950,
    issueNumbers: [10],
    terminalItems: { 10: { issue_number: 10, status: "merged", progress: 100, label: "Merged" } },
  });
  deletedSnapshots = 0;
  _batchProgressCache.clear();
  _graphqlCache.clear();
  openSnapshot();

  let data = await getOrComputeBatchProgress("terminal-proj");
  assert.equal(data.items[0].status, "queued", "ambiguous legacy terminal row cannot override live evidence");
  assert.equal(snapshotJson, null, "first live observation retires the non-composite legacy snapshot");
  assert.equal(deletedSnapshots, 1);

  // A stale rendered payload is still safe to serve because it is keyed by the
  // exact live observation fingerprint and admission generation.
  _batchProgressCache.clear();
  _batchProgressRefreshes.clear();
  openSnapshot(Date.now() + 1);
  _batchProgressCache.set("terminal-proj", {
    ts: Date.now() - 60_000,
    fingerprint: readLiveBatchContext("terminal-proj").fingerprint,
    admission_generation: 0,
    data: {
      active: true,
      admission_generation: 0,
      batch_number: 950,
      items: [{ issue_number: 10, status: "queued" }],
      summary: "1 queued",
      complete: false,
      completeConfirmed: false,
      batch_type: "code",
    },
  });
  data = await getOrComputeBatchProgress("terminal-proj");
  assert.equal(data._stale, true);
  assert.equal(data._refreshing, true);
  assert.equal(_batchProgressRefreshes.size, 1, "one background refresh owns the stale observation");
  await _batchProgressRefreshes.get("terminal-proj").promise;
  assert.equal(_batchProgressRefreshes.size, 0);

  // A durable clear invalidates both memory and persistent presentation state.
  snapshotJson = JSON.stringify({ batchNumber: 950, issueNumbers: [10] });
  queueText = "## Active Batch\n\n(none)\n\n## Done\n- #10 complete\n";
  data = await getOrComputeBatchProgress("terminal-proj");
  assert.equal(data.active, false);
  assert.equal(data.batch_number, null);
  assert.deepEqual(data.items, []);
  assert.equal(snapshotJson, null);
  assert.equal(_batchProgressCache.has("terminal-proj"), false);

  // Archive/removal cleanup also retires a restart-surviving file when there
  // is no corresponding in-memory entry to hint that it exists.
  snapshotJson = JSON.stringify({ batchNumber: 950, issueNumbers: [10] });
  _batchProgressCache.clear();
  await cancelProjectBackground("terminal-proj");
  assert.equal(snapshotJson, null, "lifecycle cleanup deletes a cold durable Current Batch cache");

  // A computation that began on live assignment A cannot republish A after a
  // durable clear wins while its GitHub lookup is in flight. Its own response
  // also converges to the canonical empty projection.
  queueText = liveQueue();
  _batchProgressCache.clear();
  _graphqlCache.set("o/r", {
    ts: Date.now() + 2,
    issues: [], prs: [], closedIssues: [], mergedPrs: [],
    openPrsWindowComplete: false,
    closedPrsWindowComplete: false,
    closedPrIssueNums: [],
  });
  holdIssueLookup = true;
  const staleCompute = getOrComputeBatchProgress("terminal-proj");
  while (typeof releaseIssueLookup !== "function") await new Promise((resolve) => setImmediate(resolve));
  snapshotJson = JSON.stringify({ batchNumber: 950, issueNumbers: [10] });
  queueText = "## Active Batch\n\n(none)\n";
  const clearData = await getOrComputeBatchProgress("terminal-proj");
  assert.equal(clearData.active, false);
  releaseIssueLookup();
  const staleData = await staleCompute;
  assert.equal(staleData._stale_observation, true);
  assert.equal(staleData.active, false);
  assert.equal(staleData.batch_number, null);
  assert.deepEqual(staleData.items, []);
  assert.equal(snapshotJson, null, "late A cannot restore durable presentation after clear");
  assert.equal(_batchProgressCache.has("terminal-proj"), false, "late A cannot restore memory presentation after clear");
  holdIssueLookup = false;

  console.log("routes.batchProgressTerminalCache.test.js: all assertions passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

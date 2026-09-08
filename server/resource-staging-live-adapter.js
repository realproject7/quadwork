"use strict";

// Closed live coordinator. All targets, units, processes and observations are
// created/read here. There is no adapter factory, signer, callback or PASS input.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { execFile } = require("child_process");
const { promisify } = require("util");
const WebSocket = require("ws");
const { ensureTempRoot } = require("./resource-temp");
const { parseProcMeminfo } = require("./resource-preflight");
const { createWorkerUnitBase } = require("./resource-unit");
const F = require("./resource-linux-facts");
const { boundedUntil, checkProcessSet } = require("./resource-linux-launcher");
const { pressureObservations, controlMarker, controlObservationReady, controlFilterSource } = require("./resource-staging-observation");
const exec = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function sourceManifest() {
  const root = path.dirname(__dirname), files = {}, queue = ["server", "package.json"];
  if (fs.existsSync(path.join(root, "package-lock.json"))) queue.push("package-lock.json");
  let total = 0;
  while (queue.length) {
    const relative = queue.shift(), absolute = path.join(root, relative), before = fs.lstatSync(absolute);
    if (before.isDirectory()) { queue.push(...fs.readdirSync(absolute).sort().map((name) => path.join(relative, name))); continue; }
    if (!before.isFile() || before.isSymbolicLink() || Object.keys(files).length >= 4096 || (total += before.size) > 64 * 1024 * 1024) F.fail("source_manifest_unavailable");
    const bytes = fs.readFileSync(absolute), after = fs.lstatSync(absolute);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) F.fail("source_changed");
    files[relative] = sha(bytes);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en")));
}
function vmOomKills() { const m = /^oom_kill (\d+)$/m.exec(F.text("/proc/vmstat")); if (!m) F.fail("vm_counter_unavailable"); return Number(m[1]); }
async function run(file, args, options = {}) { return (await exec(file, args, { timeout: 5000, maxBuffer: 1024 * 1024, ...options })).stdout.trim(); }
async function ephemeralPort() { const s = net.createServer(); await new Promise((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", resolve); }); const port = s.address().port; await new Promise((resolve) => s.close(resolve)); return port; }
async function request(origin, endpoint, { token, body, timeout = 2000 } = {}) {
  const response = await fetch(`${origin}${endpoint}`, { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { "x-session-token": token } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new Error("product_http_failed");
    error.check = "product_http_failed";
    error.httpFailure = { endpoint, status: response.status,
      code: typeof body?.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(body.code) ? body.code : null };
    throw error;
  }
  const result = await response.json();
  return result;
}
async function connectTerminal(origin, project, token) {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws/terminal?project=${project}&agent=dev&token=${encodeURIComponent(token)}`, { origin });
  const stream = { socket, records: [], pending: "", closed: false, lastHeartbeat: 0, sequence: null, discontinuity: false };
  socket.on("close", () => { stream.closed = true; }); socket.on("error", () => { stream.closed = true; });
  socket.on("message", (bytes) => {
    stream.pending = (stream.pending + bytes.toString()).slice(-65536);
    for (;;) {
      const start = stream.pending.indexOf("QW_RESOURCE:"), end = stream.pending.indexOf("\n", start);
      if (start < 0 || end < 0) break;
      try {
        const row = JSON.parse(stream.pending.slice(start + 12, end).trim());
        if (stream.records.length < 4096) stream.records.push(row);
        if (row.kind === "heartbeat") {
          if (stream.sequence !== null && row.sequence !== stream.sequence + 1) stream.discontinuity = true;
          stream.sequence = row.sequence; stream.lastHeartbeat = Date.now();
        }
      } catch {}
      stream.pending = stream.pending.slice(end + 1);
    }
  });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("terminal timeout")), 2000); socket.once("open", () => { clearTimeout(timer); resolve(); }); socket.once("error", (e) => { clearTimeout(timer); reject(e); }); });
  return stream;
}
function journalRows(value) { return value.trim().split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { F.fail("kernel_journal_invalid"); } }); }
async function journalAnchor(bootId) {
  const rows = journalRows(await run("journalctl", ["-k", "-b", bootId, "-n", "1", "-o", "json", "--no-pager"]));
  if (rows.length !== 1 || rows[0]._BOOT_ID !== bootId || typeof rows[0].__CURSOR !== "string") F.fail("kernel_journal_unavailable");
  return rows[0].__CURSOR;
}
function parentOom(group) { return F.readGroup(path.posix.dirname(group)).events.oom_kill; }
function publicError(error) { return typeof error?.check === "string" && /^[a-z_]+$/.test(error.check) ? error.check : "live_phase_failed"; }

async function runClosedStagingMatrix(options) {
  if (!options || Object.keys(options).some((k) => !["acknowledgement", "runPressure", "json"].includes(k)) || process.platform !== "linux" || options.runPressure !== true || process.env.NODE_OPTIONS || process.env.NODE_PATH) F.fail("disposable_gate_refused");
  let machineId;
  try { machineId = F.text("/etc/machine-id").trim(); } catch { F.fail("disposable_gate_refused"); }
  if (!/^[a-f0-9]{32}$/.test(machineId) || options.acknowledgement !== `DISPOSABLE-STAGING:${machineId}`) F.fail("disposable_gate_refused");
  const memory = parseProcMeminfo(F.text("/proc/meminfo"));
  if (memory.totalMib < 3800 || memory.totalMib > 4352 || memory.swapTotalMib < 64 || memory.availableMib < 2816) F.fail("staging_capacity_unavailable");
  const runId = crypto.randomBytes(12).toString("hex"), apiUnit = `qwproof-${runId}-api.service`;
  const bootId = F.text("/proc/sys/kernel/random/boot_id").trim().replaceAll("-", "");
  const anchor = await journalAnchor(bootId); // permission/completeness before creating workloads
  // A fresh owned home is the only product config/credential directory.
  const root = fs.mkdtempSync(path.join(os.homedir(), ".quadwork-proof-"));
  let workloadAttempted = false;
  try {
  fs.chmodSync(root, 0o700);
  const configDirectory = path.join(root, ".quadwork"), tempRoot = path.join(root, "tmp");
  fs.mkdirSync(configDirectory, { mode: 0o700 }); ensureTempRoot({ tempRoot });
  const policy = { version: 1, mode: "systemd-user-v1", temp_root: tempRoot, host_reserve_mib: 1536, max_worker_scopes: 3, api: { memory_low_mib: 128, memory_max_mib: 640 }, worker: { memory_high_mib: 96, memory_max_mib: 128, swap_max_mib: 16 }, control: { memory_max_mib: 256, swap_max_mib: 32, max_concurrent_children: 2 }, temp_min_free_mib: 64 };
  const port = await ephemeralPort(), origin = `http://127.0.0.1:${port}`;
  const projects = ["proof-pressure", "proof-survivor"].map((id) => {
    const cwd = path.join(root, id); fs.mkdirSync(cwd, { mode: 0o700 });
    return { id, name: id, workingDir: cwd, chat_mode: "file", agents: { dev: { command: path.join(__dirname, "resource-staging-worker.js"), cwd, mcp_inject: "none", auto_approve: false } } };
  });
  fs.writeFileSync(path.join(configDirectory, "config.json"), JSON.stringify({ port, file_chat_switchover_done: true, projects, runtime_resources: policy }), { mode: 0o600, flag: "wx" });
  // Throwaway Git inputs exercise the actual recovery facts path. The clean
  // filter stays held until real identity/concurrency/queue observations
  // release it. A bounded deadline fails instead of guessing a sampling delay.
  const controlMarkers = path.join(root, "control-observations"); fs.mkdirSync(controlMarkers, { mode: 0o700 });
  const controlRelease = path.join(root, "control-release");
  fs.writeFileSync(controlRelease, "release", { mode: 0o600 });
  const filter = path.join(root, "control-filter.cjs");
  fs.writeFileSync(filter, controlFilterSource(controlMarkers, controlRelease), { mode: 0o600 });
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const pressureRepo = projects[0].agents.dev.cwd;
  await run("git", ["init", "-q", "-b", "main"], { cwd: pressureRepo });
  await run("git", ["config", "filter.observer.clean", `${quote(process.execPath)} ${quote(filter)}`], { cwd: pressureRepo });
  fs.writeFileSync(path.join(pressureRepo, ".gitattributes"), "tracked.txt filter=observer\n");
  fs.writeFileSync(path.join(pressureRepo, "tracked.txt"), "unchanged\n");
  await run("git", ["add", ".gitattributes", "tracked.txt"], { cwd: pressureRepo });
  const staleTime = new Date(Date.now() - 300000); fs.utimesSync(path.join(pressureRepo, "tracked.txt"), staleTime, staleTime);
  for (const name of fs.readdirSync(controlMarkers)) fs.unlinkSync(path.join(controlMarkers, name));
  fs.unlinkSync(controlRelease);
  const owned = { apiUnit, workers: [], tempRoot, runId };
  fs.writeFileSync(path.join(root, "ownership.json"), JSON.stringify(owned), { mode: 0o600, flag: "wx" });
  const childEnv = { HOME: root, PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, TMPDIR: tempRoot, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` };
  const result = { ok: false, reason: "proof_failed", started_phases: [], primitive: {}, integrated: {}, cleanup: { ok: false }, provider_startup: "unavailable_not_installed_or_not_exercised", provider_model_turns: "unproved_no_credentials", source_files: sourceManifest(), versions: { node: process.version, kernel: os.release(), systemd: F.command("systemctl", ["--version"]).split("\n")[0] }, limits_mib: { ...policy, temp_root: undefined } };
  result.source_digest = sha(JSON.stringify(result.source_files));
  let token = null, apiStarted = false, monitorStop = false, monitoring = null, monitorFailure = null, pressureStarted = null;
  const sockets = [], protectedGroups = [], samples = [];
  let signalReceived = false;
  const onSignal = () => { signalReceived = true; monitorFailure = "proof_interrupted"; };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  async function stopPressure() {
    const worker = owned.workers.find((w) => w.project === "proof-pressure");
    if (!worker?.group) return;
    try { if (F.scopeGroup(worker.unit) !== worker.group) F.fail("scope_identity_changed"); }
    catch (e) { if (e.code === "ENOENT" || /scope_identity/.test(e.check || "")) throw e; return; }
    await run("systemctl", ["--user", "kill", "--signal=SIGKILL", "--kill-whom=all", worker.unit]);
  }
  try {
    workloadAttempted = true; apiStarted = true;
    await run("systemd-run", ["--user", "--collect", "--quiet", `--unit=${apiUnit}`, "--service-type=exec", "-p", "MemoryMax=640M", "-p", "MemoryLow=128M", "-p", "OOMPolicy=continue", "-p", "RuntimeMaxSec=120", ...Object.entries(childEnv).map(([k, v]) => `--setenv=${k}=${v}`), "--", process.execPath, path.join(__dirname, "index.js")]);
    await boundedUntil(async () => { try { return (await request(origin, "/api/health")).status === "ok"; } catch { return false; } }, 15000);
    token = (await request(origin, "/api/session-token")).token;
    if (typeof token !== "string" || token.length < 16) F.fail("local_session_unavailable");
    const apiGroup = F.scopeGroup(apiUnit); protectedGroups.push(apiGroup, F.readProcess(process.pid).cgroup);
    const apiBefore = F.readGroup(apiGroup).events.oom_kill;
    result.started_phases.push("non_pressure_pty_descendants_temp");
    for (const project of projects) {
      const launched = await request(origin, `/api/agents/${project.id}/dev/start`, { token, body: {}, timeout: 25000 });
      if (!launched.ok || typeof launched.lifecycle?.generation_id !== "string") F.fail("ordinary_worker_launch_unavailable");
      const generation = launched.lifecycle.generation_id;
      const unit = `${createWorkerUnitBase({ projectId: project.id, generationId: generation })}.scope`;
      const stream = await connectTerminal(origin, project.id, token); sockets.push(stream);
      const ready = await boundedUntil(() => stream.records.find((r) => r.kind === "ready"));
      const group = F.scopeGroup(unit);
      F.verifyWorkerGroup(group, { memoryHighMib: 96, memoryMaxMib: 128, swapMaxMib: 16 }, protectedGroups);
      const main = checkProcessSet(ready, group);
      const temp = F.verifyTempFile(ready.temp_file, path.join(tempRoot, `generation-${generation}`));
      const record = { project: project.id, generation, unit, group, main, temp, ready, stream };
      owned.workers.push(record);
      fs.writeFileSync(path.join(root, "ownership.json"), JSON.stringify({ apiUnit, workers: owned.workers.map(({ project, generation, unit, group }) => ({ project, generation, unit, group })) }), { mode: 0o600 });
    }
    let pressure = owned.workers[0]; const survivor = owned.workers[1];
    protectedGroups.push(survivor.group);
    pressure.stream.socket.send(JSON.stringify({ type: "resize", cols: 101, rows: 35 }));
    await boundedUntil(() => pressure.stream.records.find((r) => r.kind === "resize" && r.columns === 101 && r.rows === 35));
    process.kill(pressure.main.pid, "SIGUSR1");
    await boundedUntil(() => pressure.stream.records.find((r) => r.kind === "signal"));
    result.primitive = { pty_controlling_terminal: true, resize: true, signal: true, descendants: 6, node_test_git_detached: true, actual_temp_write: true, provider_substitute: false };
    // An actual terminal exit creates the ordinary recovery-facts trigger.
    pressure.stream.socket.send(`${JSON.stringify({ kind: "exit", challenge: pressure.ready.challenge })}\n`);
    await boundedUntil(() => { try { F.readProcess(pressure.main.pid); return false; } catch (e) { return e.code === "ENOENT"; } });
    pressure.stream.socket.close();
    // Physical exit precedes the governor's retained terminal fact and
    // recursive cleanup. Recovery must start from the actual exited state.
    await boundedUntil(async () => {
      const old = (await request(origin, "/api/agents"))["proof-pressure/dev"];
      return old?.generation_id === pressure.generation && old.state === "exited" && old.last_exit;
    });
    const recoveries = Array.from({ length: 3 }, () => fetch(`${origin}/api/agents/proof-pressure/dev/start`, { method: "POST", headers: { "content-type": "application/json", "x-session-token": token }, body: "{}", signal: AbortSignal.timeout(30000) }).then((r) => r.json()));
    let recoveryDone = false, recoveryError = null;
    const recovered = Promise.all(recoveries).catch((e) => { recoveryError = e; return []; }).finally(() => { recoveryDone = true; });
    let maxControl = 0, maxQueued = 0; const controlPids = new Set();
    while (!recoveryDone) {
      const snapshot = await request(origin, "/api/resources");
      maxControl = Math.max(maxControl, snapshot.counts?.active_control_children || 0);
      maxQueued = Math.max(maxQueued, snapshot.resource_usage?.control?.queued_children || snapshot.counts?.queued_control_children || 0);
      if (maxControl > 2) F.fail("control_child_limit_exceeded");
      for (const name of fs.readdirSync(controlMarkers)) {
        if (!/^\d+$/.test(name)) F.fail("control_observation_invalid");
        try {
          const observed = F.readProcess(Number(name));
          const marker = path.join(controlMarkers, name), stat = fs.lstatSync(marker);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 16384 || (stat.mode & 0o777) !== 0o600) F.fail("control_observation_invalid");
          controlPids.add(controlMarker(F.text(marker), observed));
        } catch (e) { if (e.code !== "ENOENT" && e.check !== "process_identity_changed") throw e; }
      }
      if (controlObservationReady(maxControl, maxQueued, controlPids) && !fs.existsSync(controlRelease)) fs.writeFileSync(controlRelease, "release", { mode: 0o600, flag: "wx" });
      await wait(50);
    }
    const recoveryResults = await recovered;
    if (recoveryError) throw recoveryError;
    const launched = recoveryResults.find((entry) => entry.ok === true && entry.lifecycle?.generation_id !== pressure.generation);
    if (!launched || !launched.repository?.available || !controlObservationReady(maxControl, maxQueued, controlPids)) F.fail("control_child_path_unproven");
    const generation = launched.lifecycle.generation_id;
    const unit = `${createWorkerUnitBase({ projectId: "proof-pressure", generationId: generation })}.scope`;
    const stream = await connectTerminal(origin, "proof-pressure", token); sockets.push(stream);
    const ready = await boundedUntil(() => stream.records.find((row) => row.kind === "ready"));
    const group = F.scopeGroup(unit); const main = checkProcessSet(ready, group);
    F.verifyWorkerGroup(group, { memoryHighMib: 96, memoryMaxMib: 128, swapMaxMib: 16 }, protectedGroups);
    F.verifyTempFile(ready.temp_file, path.join(tempRoot, `generation-${generation}`));
    pressure = { project: "proof-pressure", generation, unit, group, main, ready, stream };
    owned.workers[0] = pressure;
    fs.writeFileSync(path.join(root, "ownership.json"), JSON.stringify({ apiUnit, workers: owned.workers.map(({ project, generation, unit, group }) => ({ project, generation, unit, group })) }), { mode: 0o600 });
    result.primitive.control = { real_git_recovery: true, observed_children: controlPids.size, maximum_concurrent: maxControl, observed_queued: maxQueued, configured_limit: 2 };
    const survivorBefore = parentOom(survivor.group), workerBefore = parentOom(pressure.group), vmBefore = vmOomKills();
    // Every sample is an actual product roundtrip and the original live WS.
    let sequence = 0;
    const sample = async () => {
      const started = Date.now();
      const health = await request(origin, "/api/health");
      const message = `containment sample ${++sequence} ${runId}`;
      const posted = await request(origin, "/api/chat?project=proof-survivor", { body: { text: message } });
      const messages = await request(origin, "/api/chat?project=proof-survivor&limit=10");
      const found = messages.find((m) => m.text === message && (posted.id === undefined || m.id === posted.id));
      if (health.status !== "ok" || !found || survivor.stream.closed || survivor.stream.discontinuity || Date.now() - survivor.stream.lastHeartbeat > 2000 || !F.sameProcess(survivor.main, F.readProcess(survivor.main.pid))) F.fail("continuous_monitor_failed");
      samples.push({ at: started, latency_ms: Date.now() - started });
    };
    await sample();
    monitoring = (async () => {
      while (!monitorStop) {
        const began = Date.now();
        try { if (signalReceived) F.fail("proof_interrupted"); await sample(); }
        catch (e) { monitorFailure = publicError(e); await stopPressure().catch(() => {}); break; }
        await wait(Math.max(1, 250 - (Date.now() - began)));
      }
    })();
    await boundedUntil(() => samples.length >= 3);
    if (monitorFailure) F.fail(monitorFailure);
    F.verifyWorkerGroup(pressure.group, { memoryHighMib: 96, memoryMaxMib: 128, swapMaxMib: 16 }, protectedGroups);
    if (!F.sameProcess(pressure.main, F.readProcess(pressure.main.pid))) F.fail("process_identity_changed");
    if (F.readGroup(path.posix.dirname(pressure.group)).pids.length !== 0) F.fail("parent_slice_has_foreign_process");
    const tids = fs.readdirSync(`/proc/${pressure.main.pid}/task`).map(Number).sort((a, b) => a-b);
    let poolThreads = 0;
    for (const tid of tids) {
      if (!Number.isSafeInteger(tid) || tid < 1 || F.readProcess(tid).cgroup !== pressure.group) F.fail("allocation_thread_uncontained");
      if (F.text(`/proc/${pressure.main.pid}/task/${tid}/comm`).trim() === "libuv-worker") poolThreads++;
    }
    if (poolThreads !== 16 || pressure.ready.pool_size !== 16 || JSON.stringify(pressure.ready.tids) !== JSON.stringify(tids)) F.fail("allocation_pool_unproven");
    pressure.threadIds = tids;
    result.started_phases.push("integrated_bounded_worker_oom");
    const pressureStart = Date.now(); pressureStarted = pressureStart;
    pressure.stream.socket.send(`${JSON.stringify({ kind: "pressure", challenge: pressure.ready.challenge })}\n`);
    await boundedUntil(() => pressure.stream.records.some((r) => r.kind === "allocation_threads_after"), 3000);
    result.pressure_workload = pressureObservations(pressure.stream.records, pressure.main.pid, tids);
    await boundedUntil(() => parentOom(pressure.group) > workerBefore, 45000);
    const pressureEnd = Date.now();
    result.pressure_observation = { oom_deadline_ms: 45000, elapsed_ms: pressureEnd - pressureStart };
    await boundedUntil(() => { try { return F.readGroup(pressure.group).pids.length === 0; } catch (e) { return e.code === "ENOENT"; } });
    await sample();
    result.pressure_workload = pressureObservations(pressure.stream.records, pressure.main.pid, tids);
    monitorStop = true; await monitoring;
    if (monitorFailure) F.fail(monitorFailure);
    const gaps = samples.slice(1).map((r, i) => r.at - samples[i].at);
    if (!samples.some((s) => s.at > pressureStart && s.at < pressureEnd) || Math.max(...gaps) > 2000 || Math.max(...samples.map((s) => s.latency_ms)) > 2000) F.fail("monitor_interval_missing");
    if (F.readGroup(apiGroup).events.oom_kill !== apiBefore || parentOom(survivor.group) !== survivorBefore) F.fail("protected_oom_counter_changed");
    const anchorAgain = journalRows(await run("journalctl", ["-k", "-b", bootId, `--cursor=${anchor}`, "-n", "1", "-o", "json", "--no-pager"]));
    if (anchorAgain[0]?.__CURSOR !== anchor) F.fail("kernel_journal_cursor_lost");
    const journal = journalRows(await run("journalctl", ["-k", "-b", bootId, `--after-cursor=${anchor}`, "-o", "json", "--no-pager"]));
    const kernel = F.parseKernelInterval(journal, { bootId, ownedGroup: pressure.group, vmKills: vmOomKills() - vmBefore });
    result.integrated = { ordinary_http_launch: true, worker_memcg_oom: true, api_health: true, primary_chat_roundtrip: true, terminal_websocket: true, unrelated_worker: true, ...kernel, samples: samples.length, maximum_gap_ms: Math.max(...gaps), worst_latency_ms: Math.max(...samples.map((s) => s.latency_ms)), pressure_window_ms: pressureEnd - pressureStart, observation_resolution_ms: 250 };
    if (sha(JSON.stringify(sourceManifest())) !== result.source_digest) F.fail("source_changed");
    result.ok = true; result.reason = "proof_passed";
  } catch (error) {
    if (pressureStarted !== null) result.pressure_observation = { oom_deadline_ms: 45000, elapsed_ms: Date.now() - pressureStarted };
    const pressure = owned.workers.find((w) => w.project === "proof-pressure");
    if (pressure?.threadIds) {
      try { result.pressure_workload = pressureObservations(pressure.stream.records, pressure.main.pid, pressure.threadIds); } catch {}
    }
    result.check = publicError(error);
    if (error.httpFailure) result.failed_request = error.httpFailure;
    if (apiStarted) {
      try { result.resource_diagnostic = await request(origin, "/api/resources"); } catch {}
    }
  }
  finally {
    fs.writeFileSync(controlRelease, "release", { mode: 0o600 });
    monitorStop = true; if (monitoring) await monitoring.catch(() => {});
    for (const stream of sockets) stream.socket.close();
    const failures = [];
    for (const worker of owned.workers) {
      try {
        await request(origin, `/api/agents/${worker.project}/dev/stop`, { token, body: {}, timeout: 10000 });
        try { if (F.readGroup(worker.group).pids.length !== 0) F.fail("worker_cleanup_incomplete"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      } catch { failures.push("worker_cleanup_incomplete"); }
    }
    if (apiStarted) {
      try { if (F.scopeGroup(apiUnit).endsWith(`/${apiUnit}`)) await run("systemctl", ["--user", "stop", apiUnit]); }
      catch { failures.push("api_cleanup_unproven"); }
    }
    try { if (fs.readdirSync(tempRoot).some((name) => name.startsWith("generation-"))) failures.push("generation_temp_remaining"); } catch { failures.push("temp_cleanup_unproven"); }
    result.cleanup = { ok: failures.length === 0, failures };
    if (failures.length) { result.ok = false; result.reason = "cleanup_incomplete"; result.ownership_directory = root; }
    else fs.rmSync(root, { recursive: true });
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  }
  return result;
  } catch (error) {
    // Before any launch only this fresh directory exists. Once a launch has
    // been attempted, an unexpected cleanup failure preserves exact ownership.
    if (!workloadAttempted) { fs.rmSync(root, { recursive: true }); throw error; }
    return { ok: false, reason: "cleanup_incomplete", check: publicError(error), started_phases: [], cleanup: { ok: false, failures: ["ownership_cleanup_unproven"] }, ownership_directory: root };
  }
}
module.exports = { runClosedStagingMatrix };

"use strict";

// Validation and exact local observations for the closed disposable coordinator.
// None of these observations grant runtime readiness or an OOM/support PASS.
const fs = require("node:fs");
const path = require("node:path");
const F = require("./resource-linux-facts");
const BUFFER_BYTES = 8 * 1024 * 1024;
function pressureObservations(records, pid, expectedTids) {
  const rows = records.filter((r) => r.kind?.startsWith("allocation") || r.kind === "pressure_refused");
  if (rows.length < 1 || rows.length > 23 || new Set(expectedTids).size !== expectedTids.length || expectedTids.length < 17 || expectedTids.length > 64) F.fail("allocation_observation_invalid");
  const [armed, ...remaining] = rows;
  const sameThreads = (ids) => Array.isArray(ids) && ids.length === expectedTids.length && ids.every((id, i) => Number.isSafeInteger(id) && id > 0 && id === expectedTids[i]);
  if (rows.some((r) => r.pid !== pid) || armed.kind !== "allocation_armed" || armed.pool_size !== 16 || armed.buffers !== 20 || armed.buffer_bytes !== BUFFER_BYTES || armed.bytes !== 20 * BUFFER_BYTES || !sameThreads(armed.tids)) F.fail("allocation_observation_invalid");
  let after = null;
  const indices = new Set(), reads = [];
  for (const row of remaining) {
    if (row.kind === "allocation_threads_after" && !after && indices.size === 0) {
      if (row.pool_size !== 16 || row.requested_buffers !== 20 || !sameThreads(row.tids)) F.fail("allocation_observation_invalid");
      after = row; continue;
    }
    if (row.kind === "allocation_cap_reached" && row === remaining.at(-1) && indices.size === 20) continue;
    if (row.kind !== "allocation" || !Number.isInteger(row.index) || row.index < 0 || row.index >= 20 || indices.has(row.index) || row.bytes !== BUFFER_BYTES || row.mib !== (indices.size + 1) * 8) F.fail("allocation_observation_invalid");
    indices.add(row.index); reads.push({ index: row.index, bytes: row.bytes });
  }
  return { pool_size: 16, reserved_buffers: 20, reserved_bytes: 20 * BUFFER_BYTES, threads_armed: armed.tids,
    submitted_buffers: after ? 20 : null, threads_after: after?.tids ?? null,
    read_completions: reads, completed_bytes: reads.length * BUFFER_BYTES };
}
// Reads only the exact already-owned generation. This is neither runtime
// readiness authority nor OOM proof; the closed coordinator owns the release.
function verifyPressureRelease(pressure, protectedGroups, workerBefore) {
  const observation = pressureObservations(pressure.stream.records, pressure.main.pid, pressure.threadIds);
  if (observation.submitted_buffers !== null || observation.read_completions.length) F.fail("allocation_before_release");
  F.verifyWorkerGroup(pressure.group, { memoryHighMib: 96, memoryMaxMib: 128, swapMaxMib: 16 }, protectedGroups);
  if (!F.sameProcess(pressure.main, F.readProcess(pressure.main.pid))) F.fail("process_identity_changed");
  const tids = fs.readdirSync(`/proc/${pressure.main.pid}/task`).map(Number).sort((a, b) => a-b);
  let poolThreads = 0;
  for (const tid of tids) {
    if (!Number.isSafeInteger(tid) || tid < 1 || F.readProcess(tid).cgroup !== pressure.group) F.fail("allocation_thread_uncontained");
    if (F.text(`/proc/${pressure.main.pid}/task/${tid}/comm`).trim() === "libuv-worker") poolThreads++;
  }
  if (poolThreads !== 16 || JSON.stringify(tids) !== JSON.stringify(pressure.threadIds)) F.fail("allocation_pool_unproven");
  const parent = F.readGroup(path.posix.dirname(pressure.group));
  if (parent.pids.length !== 0) F.fail("parent_slice_has_foreign_process");
  if (parent.events.oom_kill !== workerBefore) F.fail("oom_before_release");
  if (!F.sameProcess(pressure.main, F.readProcess(pressure.main.pid))) F.fail("process_identity_changed");
  return observation;
}
function controlMarker(raw, observed) {
  let row; try { row = JSON.parse(raw); } catch { F.fail("control_observation_invalid"); }
  const original = { ...F.parseProcStat(row.stat), cgroup: F.parseCgroup(row.cgroup) };
  if (row.pid !== original.pid || !F.sameProcess(original, observed) || !observed.cgroup.includes("/quadwork-control.slice/") || !/\/quadwork-control-[a-f0-9]{40}\.scope$/.test(observed.cgroup)) F.fail("control_child_uncontained");
  return observed.pid;
}
function controlObservationReady(active, queued, observedPids) {
  if (!Number.isSafeInteger(active) || active < 0 || active > 2 || !Number.isSafeInteger(queued) || queued < 0) F.fail("control_child_limit_exceeded");
  return active === 2 && queued >= 1 && observedPids.size >= 2;
}
function controlFilterSource(markerRoot, releaseFile) {
  return `const fs=require("fs");
const root=${JSON.stringify(markerRoot)}, release=${JSON.stringify(releaseFile)};
const staging=root+"-"+process.pid+".tmp";
fs.writeFileSync(staging, JSON.stringify({pid:process.pid,stat:fs.readFileSync("/proc/self/stat","utf8"),cgroup:fs.readFileSync("/proc/self/cgroup","utf8")}), {mode:384,flag:"wx"});
fs.renameSync(staging,root+"/"+process.pid);
process.stdin.pipe(process.stdout);
const deadline=Date.now()+15000;
const hold=setInterval(()=>{if(fs.existsSync(release)){clearInterval(hold);}else if(Date.now()>=deadline){clearInterval(hold);process.exitCode=2;}},25);
`;
}
module.exports = { pressureObservations, verifyPressureRelease, controlMarker, controlObservationReady, controlFilterSource };

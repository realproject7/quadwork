"use strict";

// Pure validation/code generation for the closed disposable coordinator.
// None of these observations grant runtime readiness or an OOM/support PASS.
const F = require("./resource-linux-facts");
const BUFFER_BYTES = 8 * 1024 * 1024;
function pressureObservations(records, pid, expectedTids) {
  const rows = records.filter((r) => r.kind?.startsWith("allocation") || r.kind === "pressure_refused");
  if (rows.length < 4 || rows.length > 25 || new Set(expectedTids).size !== expectedTids.length || expectedTids.length < 17 || expectedTids.length > 64) F.fail("allocation_observation_invalid");
  const [start, before, reserved, after, ...completions] = rows;
  const sameThreads = (ids) => Array.isArray(ids) && ids.length === expectedTids.length && ids.every((id, i) => Number.isSafeInteger(id) && id > 0 && id === expectedTids[i]);
  if (rows.some((r) => r.pid !== pid) || start.kind !== "allocation_start" || before.kind !== "allocation_threads_before" || before.pool_size !== 16 || before.max_buffers !== 20 || before.buffer_bytes !== BUFFER_BYTES || !sameThreads(before.tids) || reserved.kind !== "allocation_reserved" || reserved.buffers !== 20 || reserved.bytes !== 20 * BUFFER_BYTES || after.kind !== "allocation_threads_after" || after.pool_size !== 16 || after.requested_buffers !== 20 || !sameThreads(after.tids)) F.fail("allocation_observation_invalid");
  const indices = new Set(), reads = [];
  for (const row of completions) {
    if (row.kind === "allocation_cap_reached" && row === completions.at(-1) && indices.size === 20) continue;
    if (row.kind !== "allocation" || !Number.isInteger(row.index) || row.index < 0 || row.index >= 20 || indices.has(row.index) || row.bytes !== BUFFER_BYTES || row.mib !== (indices.size + 1) * 8) F.fail("allocation_observation_invalid");
    indices.add(row.index); reads.push({ index: row.index, bytes: row.bytes });
  }
  return { pool_size: 16, reserved_buffers: 20, reserved_bytes: 20 * BUFFER_BYTES, threads_before: before.tids, threads_after: after.tids, read_completions: reads, completed_bytes: reads.length * BUFFER_BYTES };
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
fs.writeFileSync(root+"/"+process.pid, JSON.stringify({pid:process.pid,stat:fs.readFileSync("/proc/self/stat","utf8"),cgroup:fs.readFileSync("/proc/self/cgroup","utf8")}), {mode:384,flag:"wx"});
process.stdin.pipe(process.stdout);
const deadline=Date.now()+15000;
const hold=setInterval(()=>{if(fs.existsSync(release)){clearInterval(hold);}else if(Date.now()>=deadline){clearInterval(hold);process.exitCode=2;}},25);
`;
}
module.exports = { pressureObservations, controlMarker, controlObservationReady, controlFilterSource };

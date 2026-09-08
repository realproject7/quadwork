"use strict";

// Direct OS observations shared by the closed launcher and disposable proof.
// Parsers are exported for tests; caller-provided parser results never enter
// the live coordinator or grant launch authority.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const MIB = 1024 * 1024;
const CGROUP_ROOT = "/sys/fs/cgroup";

function fail(check) { const e = new Error(check); e.code = "containment_unavailable"; e.check = check; throw e; }
function text(file, maximum = 65536) {
  const value = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(value) > maximum || value.includes("\0")) fail("os_fact_invalid");
  return value;
}
function command(file, args) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function parseProcStat(value) {
  const match = /^(\d+) \((.*)\) ([A-Z]) (.*)$/.exec(String(value).trim());
  if (!match) fail("process_stat_invalid");
  const fields = match[4].split(" ");
  const integer = (index) => { if (!/^-?\d+$/.test(fields[index] || "")) fail("process_stat_invalid"); return Number(fields[index]); };
  const result = { pid: Number(match[1]), state: match[3], ppid: integer(0), pgrp: integer(1), session: integer(2), tty: integer(3), startTime: fields[18] };
  if (!Number.isSafeInteger(result.pid) || result.pid <= 0 || !/^\d+$/.test(result.startTime || "")) fail("process_stat_invalid");
  return result;
}
function parseCgroup(value) {
  const rows = String(value).trim().split("\n").filter((row) => row.startsWith("0::"));
  if (rows.length !== 1) fail("cgroup_identity_invalid");
  const group = rows[0].slice(3);
  if (!group.startsWith("/") || group.includes("\0") || group.split("/").some((p) => p === "." || p === "..") || path.posix.normalize(group) !== group) fail("cgroup_identity_invalid");
  return group;
}
function parseEvents(value) {
  const result = {};
  for (const row of String(value).trim().split("\n")) {
    const match = /^([a-z_]+) (\d+)$/.exec(row);
    if (!match || Object.hasOwn(result, match[1])) fail("cgroup_events_invalid");
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count)) fail("cgroup_events_invalid");
    result[match[1]] = count;
  }
  if (!Object.hasOwn(result, "oom_kill")) fail("cgroup_events_invalid");
  return result;
}
function parsePids(value) {
  if (!String(value).trim()) return [];
  const pids = String(value).trim().split("\n").map((s) => /^\d+$/.test(s) ? Number(s) : NaN);
  if (pids.some((n) => !Number.isSafeInteger(n) || n <= 0) || new Set(pids).size !== pids.length) fail("cgroup_processes_invalid");
  return pids;
}
function readProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail("process_identity_invalid");
  const before = parseProcStat(text(`/proc/${pid}/stat`));
  const cgroup = parseCgroup(text(`/proc/${pid}/cgroup`));
  const after = parseProcStat(text(`/proc/${pid}/stat`));
  if (before.startTime !== after.startTime || before.pid !== pid || after.state === "Z") fail("process_identity_changed");
  return { ...after, cgroup };
}
function sameProcess(prior, current) { return prior.pid === current.pid && prior.startTime === current.startTime && prior.cgroup === current.cgroup; }
function cgroupPath(group) { return path.join(CGROUP_ROOT, parseCgroup(`0::${group}`)); }
function scopeGroup(unit) {
  if (!/^(?:quadwork-worker-[a-f0-9]{40}|qwproof-[a-f0-9-]+)\.(?:scope|service|slice)$/.test(unit)) fail("foreign_unit");
  const group = command("systemctl", ["--user", "show", unit, "--property=ControlGroup", "--value"]);
  if (!group.endsWith(`/${unit}`)) fail("scope_identity_changed");
  return parseCgroup(`0::${group}`);
}
function limit(value) {
  if (value.trim() === "max") return null;
  if (!/^\d+$/.test(value.trim())) fail("cgroup_limit_invalid");
  const n = Number(value.trim());
  if (!Number.isSafeInteger(n) || n < 0) fail("cgroup_limit_invalid");
  return n;
}
function readGroup(group) {
  const root = cgroupPath(group);
  return { group, pids: parsePids(text(path.join(root, "cgroup.procs"))), events: parseEvents(text(path.join(root, "memory.events"))), localEvents: parseEvents(text(path.join(root, "memory.events.local"))), memoryMax: limit(text(path.join(root, "memory.max"))), memoryHigh: limit(text(path.join(root, "memory.high"))), swapMax: limit(text(path.join(root, "memory.swap.max"))), oomGroup: text(path.join(root, "memory.oom.group")).trim() === "1" };
}
function verifyWorkerGroup(group, limits, protectedGroups = []) {
  const observed = readGroup(group);
  if (observed.memoryMax !== limits.memoryMaxMib * MIB || observed.memoryHigh !== limits.memoryHighMib * MIB || observed.swapMax !== limits.swapMaxMib * MIB || !observed.oomGroup) fail("worker_limits_unproven");
  for (const protectedGroup of protectedGroups) {
    if (group === protectedGroup || protectedGroup.startsWith(`${group}/`) || group.startsWith(`${protectedGroup}/`)) fail("worker_not_separate");
  }
  // An ancestor may tighten the class; it must never make the observer/API
  // share a worker-sized failure domain. Verify every finite ancestor budget.
  for (let parent = path.posix.dirname(group); parent !== "/"; parent = path.posix.dirname(parent)) {
    const cap = limit(text(path.join(cgroupPath(parent), "memory.max")));
    if (cap !== null && cap < limits.memoryMaxMib * MIB) fail("ancestor_limit_too_small");
  }
  return observed;
}
function verifyTempFile(file, generationRoot) {
  const root = fs.realpathSync(generationRoot);
  const stat = fs.lstatSync(file);
  const actual = fs.realpathSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || !actual.startsWith(`${root}${path.sep}`) || actual !== path.resolve(file)) fail("temp_boundary_failed");
  const type = BigInt.asUintN(32, BigInt(fs.statfsSync(actual, { bigint: true }).type));
  if (type === 0x01021994n || type === 0x858458f6n) fail("temp_memory_backed");
  return { device: String(stat.dev), inode: String(stat.ino), bytes: stat.size };
}
function parseKernelInterval(entries, { bootId, ownedGroup, vmKills }) {
  if (!Array.isArray(entries) || entries.length === 0 || typeof bootId !== "string") fail("kernel_interval_unavailable");
  let kills = 0, ownedContext = false;
  for (const row of entries) {
    if (row._BOOT_ID !== bootId || typeof row.__CURSOR !== "string" || typeof row.MESSAGE !== "string") fail("kernel_interval_incomplete");
    const message = row.MESSAGE;
    if (/oom-kill:/.test(message)) {
      if (!message.includes("constraint=CONSTRAINT_MEMCG") || /(?:^|,)oom_memcg=([^,\s]+)/.exec(message)?.[1] !== ownedGroup) fail("global_or_unclassified_oom");
      ownedContext = true;
    }
    if (/(?:Out of memory|Memory cgroup out of memory): Killed process \d+/.test(message)) {
      if (!ownedContext || !message.startsWith("Memory cgroup out of memory:")) fail("global_or_unclassified_oom");
      kills += 1;
    }
  }
  if (!ownedContext || kills === 0 || kills !== vmKills) fail("kernel_oom_count_mismatch");
  return { classified_memcg_kills: kills, global_oom_observed: false };
}
module.exports = { MIB, fail, text, command, parseProcStat, parseCgroup, parseEvents, parsePids, readProcess, sameProcess, cgroupPath, scopeGroup, readGroup, verifyWorkerGroup, verifyTempFile, parseKernelInterval };

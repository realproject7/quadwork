#!/usr/bin/env node
"use strict";

// A real bounded diagnostic workload, never a provider/model substitute.
// Pressure requires a live owner challenge AND independent local cgroup caps.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { readProcess, verifyWorkerGroup } = require("./resource-linux-facts");

if (process.argv[2] === "--held-child") {
  setTimeout(() => process.exit(0), 90000);
} else {
  const descendantEnv = { ...process.env };
  process.env.UV_THREADPOOL_SIZE = "16";
  let poolReady = false;
  const challenge = crypto.randomBytes(24).toString("hex");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-diagnostic-"));
  const file = path.join(directory, "written.bin");
  const fd = fs.openSync(file, "wx", 0o600);
  fs.writeSync(fd, Buffer.alloc(4096, 0x51)); fs.fsyncSync(fd); fs.closeSync(fd);
  const testFile = path.join(directory, "held.test.cjs");
  fs.writeFileSync(testFile, 'const {test}=require("node:test"); test("held descendant", async()=>{await new Promise(r=>setTimeout(r,90000));});\n', { mode: 0o600 });
  const children = [
    spawn(process.execPath, ["--test", "--test-isolation=none", testFile], { stdio: "ignore", env: descendantEnv }),
    spawn("git", ["hash-object", "--stdin"], { stdio: ["pipe", "ignore", "ignore"], env: descendantEnv }),
    spawn(process.execPath, [__filename, "--held-child"], { detached: true, stdio: "ignore", env: descendantEnv }),
  ];
  for (const child of children) child.on("error", () => { process.exitCode = 1; });
  const emit = (kind, facts = {}) => process.stdout.write(`QW_RESOURCE:${JSON.stringify({ kind, pid: process.pid, ...facts })}\n`);
  let sequence = 0, input = "", allocating = false;
  const buffers = [];
  const readiness = { challenge, children: children.map((child) => child.pid), temp_file: file, tty: process.stdin.isTTY === true && process.stdout.isTTY === true, columns: process.stdout.columns, rows: process.stdout.rows };
  const heartbeat = setInterval(() => { emit("heartbeat", { sequence: ++sequence }); if (poolReady && !allocating && sequence % 5 === 0) emit("ready", readiness); }, 200);
  const finish = (code) => { clearInterval(heartbeat); for (const child of children) { try { child.kill("SIGTERM"); } catch {} } process.exit(code); };
  process.once("SIGTERM", () => finish(0));
  process.once("SIGINT", () => finish(0));
  process.on("SIGUSR1", () => emit("signal", { signal: "SIGUSR1" }));
  process.stdout.on("resize", () => emit("resize", { columns: process.stdout.columns, rows: process.stdout.rows }));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.length > 16384) finish(2);
    while (input.includes("\n")) {
      const end = input.indexOf("\n"), line = input.slice(0, end).trim(); input = input.slice(end + 1);
      let request; try { request = JSON.parse(line); } catch { continue; }
      if (request.challenge !== challenge) continue;
      if (request.kind === "ping") emit("pong", { nonce: request.nonce });
      if (request.kind === "exit") finish(23);
      if (request.kind === "pressure" && !allocating) {
        if (!poolReady) { emit("pressure_refused"); continue; }
        try { verifyWorkerGroup(readProcess(process.pid).cgroup, { memoryHighMib: 96, memoryMaxMib: 128, swapMaxMib: 16 }); }
        catch { emit("pressure_refused"); continue; }
        allocating = true;
        emit("allocation_start");
        const tids = () => fs.readdirSync("/proc/self/task").map(Number).sort((a, b) => a-b);
        emit("allocation_threads_before", { pool_size: 16, tids: tids(), max_buffers: 20, buffer_bytes: 8 * 1024 * 1024 });
        const zero = fs.openSync("/dev/zero", "r");
        let completed = 0;
        // Reserve all twenty buffers before any kernel read touches them.
        // Interleaving reservation with reads can throttle this dispatch loop.
        for (let index = 0; index < 20; index++) buffers.push(Buffer.allocUnsafe(8 * 1024 * 1024));
        emit("allocation_reserved", { buffers: buffers.length, bytes: buffers.reduce((sum, b) => sum+b.length, 0) });
        for (const [index, buffer] of buffers.entries()) {
          fs.read(zero, buffer, 0, buffer.length, null, (error, bytes) => {
            if (error || bytes !== buffer.length) { emit("allocation_failed"); finish(2); return; }
            completed++;
            emit("allocation", { index, bytes, mib: completed * 8 });
            if (completed === 20) { fs.closeSync(zero); emit("allocation_cap_reached"); }
          });
        }
        emit("allocation_threads_after", { pool_size: 16, tids: tids(), requested_buffers: buffers.length });
      }
    }
  });
  // Initialize all sixteen pool threads before the owner observes readiness.
  // The three existing descendants retain their original environment/pool.
  fs.stat(__filename, (error) => {
    if (error) { finish(2); return; }
    poolReady = true;
    readiness.pool_size = 16;
    readiness.tids = fs.readdirSync("/proc/self/task").map(Number).sort((a, b) => a-b);
    emit("ready", readiness);
  });
  setTimeout(() => finish(0), 90000);
}

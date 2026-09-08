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
  const challenge = crypto.randomBytes(24).toString("hex");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-diagnostic-"));
  const file = path.join(directory, "written.bin");
  const fd = fs.openSync(file, "wx", 0o600);
  fs.writeSync(fd, Buffer.alloc(4096, 0x51)); fs.fsyncSync(fd); fs.closeSync(fd);
  const testFile = path.join(directory, "held.test.cjs");
  fs.writeFileSync(testFile, 'const {test}=require("node:test"); test("held descendant", async()=>{await new Promise(r=>setTimeout(r,90000));});\n', { mode: 0o600 });
  const children = [
    spawn(process.execPath, ["--test", "--test-isolation=none", testFile], { stdio: "ignore", env: process.env }),
    spawn("git", ["hash-object", "--stdin"], { stdio: ["pipe", "ignore", "ignore"], env: process.env }),
    spawn(process.execPath, [__filename, "--held-child"], { detached: true, stdio: "ignore", env: process.env }),
  ];
  for (const child of children) child.on("error", () => { process.exitCode = 1; });
  const emit = (kind, facts = {}) => process.stdout.write(`QW_RESOURCE:${JSON.stringify({ kind, pid: process.pid, ...facts })}\n`);
  let sequence = 0, input = "", allocating = false;
  const buffers = [];
  const readiness = { challenge, children: children.map((child) => child.pid), temp_file: file, tty: process.stdin.isTTY === true && process.stdout.isTTY === true, columns: process.stdout.columns, rows: process.stdout.rows };
  const heartbeat = setInterval(() => { emit("heartbeat", { sequence: ++sequence }); if (!allocating && sequence % 5 === 0) emit("ready", readiness); }, 200);
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
        try { verifyWorkerGroup(readProcess(process.pid).cgroup, { memoryHighMib: 96, memoryMaxMib: 128, swapMaxMib: 16 }); }
        catch { emit("pressure_refused"); continue; }
        allocating = true;
        emit("allocation_start");
        const allocate = setInterval(() => {
          // Exactly twenty 8 MiB touched allocations, at most 160 MiB,
          // even if no OOM arrives. Never retry allocation.
          if (buffers.length === 20) { clearInterval(allocate); emit("allocation_cap_reached"); return; }
          const buffer = Buffer.alloc(8 * 1024 * 1024);
          for (let i = 0; i < buffer.length; i += 4096) buffer[i] = 0x51;
          buffers.push(buffer);
          emit("allocation", { mib: buffers.length * 8 });
        }, 100);
      }
    }
  });
  emit("ready", readiness);
  setTimeout(() => finish(0), 90000);
}

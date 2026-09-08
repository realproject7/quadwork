"use strict";

// #1088: a PID is a diagnostic, never signal authority. Only the foreground
// CLI holding this private socket can accept a stop request for its receipt.
// It invokes its own existing shutdown; clients never signal another PID.
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createDurableStoreFiles, sameFile } = require("./durable-store-files");

class StopOwnerError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
const files = createDurableStoreFiles({ fs, error: StopOwnerError, codes: Object.fromEntries([
  "options", "unreadable", "symlink_rejected", "insecure_permissions", "write_failed", "locked", "lock_unsafe", "lock_failed", "lock_acquire_changed", "lock_release_changed", "lock_release_failed",
].map((code) => [code, `cli_stop_${code}`])) });
const MAX_BYTES = 8192;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const identity = (value) => JSON.stringify(value);

function readReceipt(receiptPath) {
  let fd;
  try {
    fd = fs.openSync(receiptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size > MAX_BYTES) throw new StopOwnerError("cli_stop_receipt_unverified");
    const bytes = fs.readFileSync(fd, "utf8");
    if (!sameFile(stat, fs.lstatSync(receiptPath))) throw new StopOwnerError("cli_stop_receipt_changed");
    return { bytes, value: JSON.parse(bytes) };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function socketPathFor(receiptPath, nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new StopOwnerError("cli_stop_receipt_unverified");
  const target = path.join(path.dirname(receiptPath), `stop-${nonce}.sock`);
  // sockaddr_un reserves one byte for NUL: macOS sun_path=104, Linux=108.
  const limit = process.platform === "darwin" ? 103 : 107;
  if (Buffer.byteLength(target) > limit) throw new StopOwnerError("cli_stop_socket_path_too_long");
  return target;
}

function socketMatches(target, expected) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isSocket() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && sameFile(stat, expected);
  } catch { return false; }
}

function validReceipt(value, expectedEntry) {
  return value && Object.keys(value).sort().join(",") === "entry,instance_nonce,pid,socket,start_observation,version" &&
    value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    value.entry === expectedEntry && /^[a-f0-9]{32}$/.test(value.instance_nonce) &&
    value.start_observation && Number.isSafeInteger(value.start_observation.observed_at_ms) &&
    Number.isFinite(value.start_observation.uptime_seconds) && value.start_observation.uptime_seconds >= 0 &&
    value.socket && Number.isSafeInteger(value.socket.dev) && Number.isSafeInteger(value.socket.ino);
}

async function createCliStopOwner(receiptPath, onStop) {
  if (!["linux", "darwin"].includes(process.platform)) throw new StopOwnerError("cli_stop_platform_unsupported");
  if (typeof onStop !== "function") throw new StopOwnerError("cli_stop_invalid_callback");
  files.ensureDirectories([{ path: path.dirname(receiptPath), mode: 0o700 }]);
  const entry = fs.realpathSync(process.argv[1]);
  const nonce = crypto.randomBytes(16).toString("hex");
  const target = socketPathFor(receiptPath, nonce);
  const clients = new Set();
  let receipt, bytes, socketStat, started = false;
  const server = net.createServer((client) => {
    client.on("error", () => {});
    const timeout = setTimeout(() => client.destroy(), 2000);
    let input = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_BYTES) { client.destroy(); return; }
      if (!input.includes("\n")) return;
      client.removeAllListeners("data");
      try {
        const request = JSON.parse(input.trim());
        if (!receipt || request.op !== "stop" || Object.keys(request).sort().join(",") !== "op,receipt" || identity(request.receipt) !== identity(receipt)) throw new Error("unverified");
        files.withWriterLock(receiptPath, () => {
          if (readReceipt(receiptPath).bytes !== bytes || !socketMatches(target, socketStat)) throw new Error("changed");
        });
        clearTimeout(timeout);
        clients.add(client);
        client.once("close", () => clients.delete(client));
        client.write(JSON.stringify({ event: "accepted", receipt }) + "\n", () => {
          if (started) return;
          try {
            files.withWriterLock(receiptPath, () => {
              if (readReceipt(receiptPath).bytes !== bytes || !socketMatches(target, socketStat)) throw new Error("changed");
              started = true;
              Promise.resolve(onStop()).catch(() => client.end(JSON.stringify({ event: "complete", ok: false }) + "\n"));
            });
          } catch { client.end(JSON.stringify({ event: "refused" }) + "\n"); }
        });
      } catch { client.end(JSON.stringify({ event: "refused" }) + "\n"); }
    });
    client.once("close", () => clearTimeout(timeout));
  });
  const close = () => {
    for (const client of clients) client.destroy();
    // net.Server.close() unlinks its bound pathname even after replacement.
    // On a changed path, leave the owned descriptor to process exit instead of
    // deleting another socket. It must not keep the CLI event loop alive.
    if (socketStat && socketMatches(target, socketStat)) server.close();
    else server.unref();
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(target, () => { server.removeListener("error", reject); resolve(); });
    });
    server.on("error", () => {});
    fs.chmodSync(target, 0o600);
    socketStat = fs.lstatSync(target);
    receipt = {
      version: 1, pid: process.pid, entry, instance_nonce: nonce,
      start_observation: { observed_at_ms: Date.now(), uptime_seconds: process.uptime() },
      socket: { dev: socketStat.dev, ino: socketStat.ino },
    };
    bytes = identity(receipt) + "\n";
    files.withWriterLock(receiptPath, () => {
      // A second CLI must not replace a live instance's only stop receipt.
      try {
        const existing = readReceipt(receiptPath).value;
        if (validReceipt(existing, entry) && !processExited(existing.pid)) throw new StopOwnerError("cli_stop_existing_instance_live");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      files.writeFileAtomically(receiptPath, bytes);
    });
    process.once("exit", close);
    return {
      async reportShutdown(code) {
        await Promise.race([
          Promise.all([...clients].map((client) => new Promise((resolve) => {
            client.write(JSON.stringify({ event: "complete", ok: code === 0 }) + "\n", resolve);
          }))),
          delay(500),
        ]);
      },
      close() { process.removeListener("exit", close); close(); },
    };
  } catch (error) { close(); throw error; }
}

function processExited(pid) {
  // Signal zero is an existence probe only. PID reuse makes this conservative:
  // a replacement process keeps the result pending, never receives a signal.
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

async function requestCliStop(receiptPath, expectedEntry, timeoutMs = 10000) {
  let saved, target;
  try {
    files.assertRealDirectory(path.dirname(receiptPath), 0o700);
    saved = readReceipt(receiptPath);
    if (!validReceipt(saved.value, expectedEntry)) throw new StopOwnerError("cli_stop_receipt_unverified");
    target = socketPathFor(receiptPath, saved.value.instance_nonce);
    if (!socketMatches(target, saved.value.socket)) throw new StopOwnerError("cli_stop_socket_unverified");
  } catch (error) {
    return { status: error.code === "ENOENT" ? "missing" : "unverified", code: error.code || "cli_stop_receipt_unverified" };
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 30000) return { status: "failed", code: "cli_stop_invalid_deadline" };
  const deadline = Date.now() + timeoutMs;
  let accepted = false, completed = false, failed = false, input = "";
  const client = net.createConnection(target);
  client.setEncoding("utf8");
  client.on("error", () => { failed = true; });
  client.on("connect", () => client.write(JSON.stringify({ op: "stop", receipt: saved.value }) + "\n"));
  client.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_BYTES) { failed = true; client.destroy(); return; }
    while (input.includes("\n")) {
      const end = input.indexOf("\n");
      const line = input.slice(0, end); input = input.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.event === "accepted" && identity(event.receipt) === identity(saved.value)) accepted = true;
        else if (event.event === "complete" && accepted) { completed = event.ok === true; failed = !completed; }
        else failed = true;
      } catch { failed = true; }
    }
  });
  try {
    while (Date.now() < deadline && !failed) {
      if (accepted && completed && processExited(saved.value.pid)) {
        let removed = false;
        files.withWriterLock(receiptPath, () => {
          try {
            if (readReceipt(receiptPath).bytes === saved.bytes) {
              fs.unlinkSync(receiptPath);
              removed = true;
            }
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        });
        return { status: "stopped", code: removed ? "cli_stop_confirmed" : "cli_stop_confirmed_receipt_replaced", pid: saved.value.pid };
      }
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    return { status: failed ? "failed" : "pending", code: failed ? "cli_stop_unconfirmed" : "cli_stop_exit_pending", requested: accepted };
  } catch (error) {
    return { status: "failed", code: error.code || "cli_stop_receipt_changed", requested: accepted };
  } finally { client.destroy(); }
}

module.exports = { createCliStopOwner, requestCliStop };

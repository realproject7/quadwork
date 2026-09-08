"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// Short private fixture paths also exercise macOS's 104-byte sockaddr_un.
const root = fs.mkdtempSync("/tmp/qw-stop-");
const configDir = path.join(root, ".quadwork");
fs.mkdirSync(configDir, { mode: 0o700 });
const originalHome = os.homedir;
os.homedir = () => root;
const { stopPid, sanitizePid } = require("../bin/quadwork");
os.homedir = originalHome;
const { requestCliStop } = require("./cli-stop-owner");
const children = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = path.join(root, "owner.cjs");
const cli = fs.realpathSync(path.resolve(__dirname, "../bin/quadwork.js"));
const helper = path.resolve(__dirname, "cli-stop-owner.js");
fs.writeFileSync(fixture, `
const fs = require('fs');
const { createCliStopOwner } = require(${JSON.stringify(helper)});
(async () => {
  const [receipt, mode, marker] = process.argv.slice(2);
  const owner = await createCliStopOwner(receipt, async () => {
    fs.writeFileSync(marker, 'requested');
    if (mode === 'slow') return;
    await owner.reportShutdown(mode === 'failed' ? 1 : 0);
    if (mode === 'replace') await new Promise(r => setTimeout(r, 200));
    process.exit(mode === 'failed' ? 1 : 0);
  });
  process.send({ready:true});
})().catch(e => { process.send({error:e.code || e.message}); process.exit(1); });
`);
const childEnv = { HOME: root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: "/tmp", NODE_ENV: "test" };
function launch(entry, args, ipc = false, env = childEnv) {
  const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])] });
  children.add(child);
  child.output = "";
  child.stdout.on("data", (data) => { child.output += data; });
  child.stderr.on("data", (data) => { child.output += data; });
  child.done = new Promise((resolve) => child.once("exit", (code, signal) => { children.delete(child); resolve({ code, signal }); }));
  return child;
}
async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await delay(10); }
  throw new Error("fixture deadline exceeded");
}
async function owner(mode = "normal") {
  const dir = fs.mkdtempSync(path.join(root, "o-")); fs.chmodSync(dir, 0o700);
  const receipt = path.join(dir, "server.pid"), marker = path.join(dir, "called");
  const child = launch(fixture, [receipt, mode, marker], true);
  const ready = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("exit", () => reject(new Error(child.output))); });
  assert.equal(ready.ready, true, JSON.stringify(ready));
  return { child, receipt, marker, record: JSON.parse(fs.readFileSync(receipt)), socket: path.join(dir, `stop-${JSON.parse(fs.readFileSync(receipt)).instance_nonce}.sock`) };
}
async function rawRequest(socket, value) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket); let text = "";
    client.setTimeout(1000, () => client.destroy(new Error("fixture timeout")));
    client.on("error", reject);
    client.on("connect", () => client.write(JSON.stringify(value) + "\n"));
    client.on("data", (chunk) => { text += chunk; if (text.includes("\n")) { client.destroy(); resolve(JSON.parse(text.trim())); } });
  });
}

(async () => {
  for (const value of ["0", "-1", "abc", "", " ", "12.5"]) assert.equal(sanitizePid(value), null);
  assert.equal(sanitizePid(" 4242 "), 4242);
  const foreign = launch("-e", ["setInterval(()=>{},1000)"]);
  for (const [file, content] of [["server.pid", String(foreign.pid)], ["tg-bridge.pid", String(foreign.pid)], ["agentchattr.pid", "0"], ["agentchattr-x.pid", "{broken"]]) {
    const target = path.join(configDir, file); fs.writeFileSync(target, content, { mode: 0o600 });
    const result = await stopPid("fixture", file);
    assert.equal(result.status, "unverified");
    assert.equal(fs.readFileSync(target, "utf8"), content);
    assert.equal(foreign.exitCode, null, "real foreign child survives every legacy/malformed receipt");
    fs.unlinkSync(target);
  }
  assert.equal((await stopPid("missing", "absent.pid")).status, "missing");

  const good = await owner();
  assert.equal((await requestCliStop(good.receipt, fs.realpathSync(fixture), 2000)).status, "stopped");
  assert.equal((await good.child.done).code, 0);
  assert.equal(fs.existsSync(good.receipt), false);

  const stale = await owner();
  stale.child.kill("SIGKILL"); await stale.child.done;
  const staleBytes = fs.readFileSync(stale.receipt, "utf8");
  assert.notEqual((await requestCliStop(stale.receipt, fs.realpathSync(fixture), 200)).status, "stopped");
  assert.equal(fs.readFileSync(stale.receipt, "utf8"), staleBytes);

  const wrong = await owner();
  assert.equal((await requestCliStop(wrong.receipt, cli, 200)).status, "unverified", "a valid receipt for another entry is not QuadWork authority");
  assert.equal((await rawRequest(wrong.socket, { op: "stop", receipt: { ...wrong.record, pid: foreign.pid } })).event, "refused");
  assert.equal(foreign.exitCode, null, "a forged PID inside a structured receipt cannot target a foreign process");
  const bad = { ...wrong.record, instance_nonce: "0".repeat(32) };
  assert.equal((await rawRequest(wrong.socket, { op: "stop", receipt: bad })).event, "refused");
  assert.equal(fs.existsSync(wrong.marker), false);
  fs.writeFileSync(wrong.receipt, JSON.stringify(bad), { mode: 0o600 });
  assert.equal((await rawRequest(wrong.socket, { op: "stop", receipt: wrong.record })).event, "refused");
  assert.equal(fs.existsSync(wrong.marker), false, "replacement receipt cannot authorize the old instance");

  const swapped = await owner();
  fs.unlinkSync(swapped.socket);
  const replacement = net.createServer();
  await new Promise((resolve) => replacement.listen(swapped.socket, resolve)); fs.chmodSync(swapped.socket, 0o600);
  assert.equal((await requestCliStop(swapped.receipt, fs.realpathSync(fixture), 200)).status, "unverified");
  assert.equal(fs.existsSync(swapped.marker), false, "replacement socket never receives shutdown authority");
  swapped.child.kill("SIGTERM"); await swapped.child.done;
  assert.equal(fs.lstatSync(swapped.socket).isSocket(), true, "owner exit preserves replacement socket");
  await new Promise((resolve) => replacement.close(resolve));

  const slow = await owner("slow");
  const before = Date.now();
  const pending = await requestCliStop(slow.receipt, fs.realpathSync(fixture), 150);
  assert.equal(pending.status, "pending"); assert.equal(pending.requested, true);
  assert.ok(Date.now() - before < 1000);
  assert.equal(fs.existsSync(slow.receipt), true); assert.equal(slow.child.exitCode, null);

  const failed = await owner("failed");
  assert.equal((await requestCliStop(failed.receipt, fs.realpathSync(fixture), 1000)).status, "failed");
  assert.equal((await failed.child.done).code, 1); assert.equal(fs.existsSync(failed.receipt), true);

  const changed = await owner("replace");
  const stopping = requestCliStop(changed.receipt, fs.realpathSync(fixture), 2000);
  await waitFor(() => fs.existsSync(changed.marker));
  const successor = JSON.stringify({ ...changed.record, instance_nonce: "f".repeat(32) });
  fs.writeFileSync(changed.receipt, successor, { mode: 0o600 });
  assert.equal((await stopping).status, "stopped");
  assert.equal(fs.readFileSync(changed.receipt, "utf8"), successor, "confirmed exit never deletes a replacement receipt");

  const longDir = path.join(root, "x".repeat(100)); fs.mkdirSync(longDir, { mode: 0o700 });
  const tooLong = launch(fixture, [path.join(longDir, "server.pid"), "normal", path.join(root, "long-called")], true);
  const rejection = await new Promise((resolve) => tooLong.once("message", resolve));
  assert.equal(rejection.error, "cli_stop_socket_path_too_long"); await tooLong.done;

  // Actual shipped CLI startup/stop, normal server with no configured agents.
  // Only browser-opening commands are replaced by inert fixture executables.
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  for (const command of ["open", "xdg-open"]) fs.writeFileSync(path.join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const reserving = net.createServer(); await new Promise((resolve) => reserving.listen(0, "127.0.0.1", resolve));
  const port = reserving.address().port; await new Promise((resolve) => reserving.close(resolve));
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ port, projects: [] }), { mode: 0o600 });
  const env = { ...childEnv, PATH: `${bin}:${childEnv.PATH}` };
  const server = launch(cli, ["start"], false, env);
  await waitFor(() => fs.existsSync(path.join(configDir, "server.pid")) || server.exitCode !== null, 10000);
  assert.equal(server.exitCode, null, server.output);
  const real = JSON.parse(fs.readFileSync(path.join(configDir, "server.pid")));
  assert.equal(real.pid, server.pid); assert.equal(real.entry, cli);
  const stoppingCli = launch(cli, ["stop"], false, env);
  assert.equal((await stoppingCli.done).code, 0, stoppingCli.output);
  assert.equal((await server.done).code, 0, server.output);
  assert.match(stoppingCli.output, /Stopped Server/);
  assert.equal(fs.existsSync(path.join(configDir, "server.pid")), false);
  assert.equal(foreign.exitCode, null);
  console.log(`binStop.test.js: ${process.platform} private-instance stop, actual CLI, foreign/stale/malformed/nonce/replacement/slow/failure/path checks passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map((child) => child.done));
  fs.rmSync(root, { recursive: true, force: true });
});

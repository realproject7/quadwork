// #1194: the routes.js bridge system-line writer (Telegram/Discord connected
// and disconnected lines) logs a failed chat write instead of dropping it.
//
// Loads the real router against a temp HOME, with guard CLIs first on PATH so
// loading routes.js cannot reach the real `gh`. Plain node:assert.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `routes-emit-${process.pid}-${Date.now()}`);
const CONFIG_DIR = path.join(TMP, ".quadwork");
const SHIMS = path.join(TMP, "shims");
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(SHIMS, { recursive: true });
for (const cli of ["gh", "claude", "codex", "gemini", "grok"]) {
  const file = path.join(SHIMS, cli);
  fs.writeFileSync(file, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(file, 0o755);
}
process.env.PATH = `${SHIMS}${path.delimiter}${process.env.PATH}`;
fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({ port: 8400, projects: [{ id: "br", name: "br" }] }));

const origHome = os.homedir;
os.homedir = () => TMP;
process.on("exit", () => { os.homedir = origHome; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const fileChat = require("./file-chat");
const routes = require("./routes");

const logged = [];
const origError = console.error;
const origAppend = fileChat.appendMessage;
console.error = (...args) => { logged.push(args.join(" ")); };
try {
  // A failed write is logged once, with the project and line, and never throws.
  fileChat.appendMessage = () => { throw new Error("disk full"); };
  assert.doesNotThrow(() => routes.emitSystemMessage("br", "Telegram bridge connected"));
  const failures = logged.filter((line) => line.includes("[file-chat] br:"));
  assert.equal(failures.length, 1, "one log line per failed system-line write");
  assert.match(failures[0], /system line "Telegram bridge connected" not recorded: disk full/);

  // An error with no message still logs, and logging itself never throws.
  logged.length = 0;
  fileChat.appendMessage = () => { throw null; };
  assert.doesNotThrow(() => routes.emitSystemMessage("br", "Discord bridge disconnected"));
  assert.equal(logged.filter((line) => line.includes("[file-chat] br:")).length, 1);

  // A successful write logs nothing.
  logged.length = 0;
  const written = [];
  fileChat.appendMessage = (projectId, msg) => { written.push([projectId, msg.text]); };
  routes.emitSystemMessage("br", "Discord bridge connected");
  assert.deepEqual(written, [["br", "Discord bridge connected"]]);
  assert.equal(logged.filter((line) => line.includes("[file-chat]")).length, 0);
} finally {
  fileChat.appendMessage = origAppend;
  console.error = origError;
}
console.log("routesEmitSystemMessage tests passed");

// #971: writeConfig must be atomic — a crash mid-write must never truncate
// config.json (the old in-place writeFileSync could leave it zero bytes = total
// config loss). It writes a tmp file then renameSync's it onto the target, so a
// failure at the commit point leaves the PRIOR config fully intact. updateConfig
// is the serialization point: it re-reads the freshest config before mutating,
// so a concurrent caller can't clobber it with a stale whole-config snapshot.
//
// Plain node:assert script — run with `node server/config.atomicWrite.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = path.join(os.tmpdir(), `config-atomic-${process.pid}-${Date.now()}`);
const CONFIG_DIR = path.join(TMP, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const origHome = os.homedir;
os.homedir = () => TMP;
process.on("exit", () => { os.homedir = origHome; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const { writeConfig, readConfig, updateConfig } = require("./config");

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log(`  PASS: ${m}`); };
const tmpSiblings = () => fs.readdirSync(CONFIG_DIR).filter((f) => f.startsWith("config.json.") && f.endsWith(".tmp"));

// Baseline write.
writeConfig({ port: 8400, projects: [{ id: "p", idle: false }] });
ok(readConfig().port === 8400, "writeConfig persists config");
ok((fs.statSync(CONFIG_PATH).mode & 0o777) === 0o600, "config.json is 0600 after atomic write");
ok(tmpSiblings().length === 0, "no leftover .tmp file after a successful write");

// Atomicity: writeConfig must NOT open config.json in place — it writes a tmp
// and renames. Confirm by spying on the fs calls used.
{
  const origWrite = fs.writeFileSync;
  const origRename = fs.renameSync;
  const writeTargets = [];
  const renameCalls = [];
  fs.writeFileSync = (p, ...rest) => { writeTargets.push(String(p)); return origWrite(p, ...rest); };
  fs.renameSync = (a, b) => { renameCalls.push([String(a), String(b)]); return origRename(a, b); };
  try {
    writeConfig({ port: 9001, projects: [] });
  } finally {
    fs.writeFileSync = origWrite;
    fs.renameSync = origRename;
  }
  ok(writeTargets.every((p) => p !== CONFIG_PATH), "config.json is never written in place (only a .tmp)");
  ok(renameCalls.some(([a, b]) => a.endsWith(".tmp") && b === CONFIG_PATH), "commit is a rename(tmp → config.json)");
  ok(readConfig().port === 9001, "atomic write landed the new content");
}

// Simulated crash at the commit point: rename throws. The PRIOR config must
// remain intact and no tmp file may be left behind.
writeConfig({ port: 1234, projects: [{ id: "keep" }] });
{
  const origRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error("simulated crash (ENOSPC)"); e.code = "ENOSPC"; throw e; };
  let threw = false;
  try { writeConfig({ port: 5678, projects: [] }); } catch { threw = true; }
  fs.renameSync = origRename;
  ok(threw, "writeConfig surfaces a commit-time failure");
  ok(readConfig().port === 1234, "prior config survives a crash mid-write (not truncated)");
  ok(readConfig().projects[0].id === "keep", "prior config content fully intact");
  ok(tmpSiblings().length === 0, "the orphaned .tmp is cleaned up on failure");
}

// updateConfig re-reads the freshest config before mutating (no stale clobber).
writeConfig({ port: 8400, projects: [], flags: {} });
updateConfig((c) => { c.flags.a = 1; });
updateConfig((c) => { c.flags.b = 2; }); // must NOT lose flags.a
const after = readConfig();
ok(after.flags.a === 1 && after.flags.b === 2, "sequential updateConfig calls on different fields both persist");

// A mutator that reads a value written by a prior updateConfig sees it (fresh read).
updateConfig((c) => { c.flags.c = (c.flags.a || 0) + 10; });
ok(readConfig().flags.c === 11, "updateConfig sees the freshest on-disk state");

console.log(`\n${passed} passed`);
console.log("server/config.atomicWrite.test.js: all assertions passed");
process.exit(0);

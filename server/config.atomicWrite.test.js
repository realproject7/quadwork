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
const CONFIG_LOCK_PATH = path.join(CONFIG_DIR, "config.lock");
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

// Read-time legacy migration is serialized through the same lock and atomic
// rename path. A competing writer leaves the persisted snapshot untouched.
{
  const legacy = { port: 8400, projects: [{ id: "legacy", agents: { t1: { command: "old" } } }] };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(legacy, null, 2), { mode: 0o600 });
  const before = fs.readFileSync(CONFIG_PATH, "utf8");
  fs.writeFileSync(CONFIG_LOCK_PATH, JSON.stringify({ pid: process.pid, token: "migration-writer" }), { mode: 0o600 });
  assert.throws(() => readConfig(), (error) => error?.code === "config_write_busy");
  ok(true, "legacy migration fails closed while another configuration writer owns the transaction");
  ok(fs.readFileSync(CONFIG_PATH, "utf8") === before, "busy migration never writes config.json in place or over a concurrent writer");
  fs.unlinkSync(CONFIG_LOCK_PATH);

  const origRename = fs.renameSync;
  let renamed = false;
  fs.renameSync = (from, to) => {
    if (to === CONFIG_PATH) renamed = true;
    return origRename(from, to);
  };
  try { readConfig(); } finally { fs.renameSync = origRename; }
  const persisted = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  ok(renamed && persisted.projects[0].agents.head.command === "old" && !persisted.projects[0].agents.t1,
    "successful legacy migration persists only through atomic rename");
}

// Missing-config initialization also fails closed behind a writer rather than
// publishing a default snapshot observed before that writer acquired authority.
{
  fs.unlinkSync(CONFIG_PATH);
  fs.writeFileSync(CONFIG_LOCK_PATH, JSON.stringify({ pid: process.pid, token: "initializer-writer" }), { mode: 0o600 });
  assert.throws(() => readConfig(), (error) => error?.code === "config_write_busy");
  ok(fs.existsSync(CONFIG_PATH) === false, "busy missing-config initialization cannot overwrite another writer");
  fs.unlinkSync(CONFIG_LOCK_PATH);
  const initialized = readConfig();
  ok(initialized.port === 8400 && fs.existsSync(CONFIG_PATH), "missing config initializes after explicit lock release");
}

// A peer may finish after the optimistic read but before this process acquires
// config.lock. The locked re-read must migrate the peer's document, not publish
// the stale observation.
{
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    port: 8400,
    projects: [{ id: "legacy-race", agents: { t1: { command: "old" } } }],
  }, null, 2), { mode: 0o600 });
  const peer = {
    port: 9999,
    concurrent_field: "preserve",
    projects: [{ id: "legacy-race", agents: { t1: { command: "peer" } } }],
  };
  const origLink = fs.linkSync;
  let injected = false;
  fs.linkSync = (from, to) => {
    if (!injected && to === CONFIG_LOCK_PATH) {
      injected = true;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(peer, null, 2), { mode: 0o600 });
    }
    return origLink(from, to);
  };
  let migrated;
  try { migrated = readConfig(); } finally { fs.linkSync = origLink; }
  ok(injected && migrated.port === 9999 && migrated.concurrent_field === "preserve",
    "migration re-reads and preserves a peer transaction completed before lock acquisition");
  const persisted = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  ok(persisted.projects[0].agents.head.command === "peer" && !persisted.projects[0].agents.t1,
    "migration applies only to the peer's freshest locked document");
}

// The same completed-peer race on an initial ENOENT observation must preserve
// the peer-created V1 document instead of replacing it with defaults.
{
  fs.unlinkSync(CONFIG_PATH);
  const peer = { port: 7777, concurrent_field: "created-by-peer", projects: [{ id: "peer" }] };
  const origLink = fs.linkSync;
  let injected = false;
  fs.linkSync = (from, to) => {
    if (!injected && to === CONFIG_LOCK_PATH) {
      injected = true;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(peer, null, 2), { mode: 0o600 });
    }
    return origLink(from, to);
  };
  let observed;
  try { observed = readConfig(); } finally { fs.linkSync = origLink; }
  ok(injected && observed.port === 7777 && observed.concurrent_field === "created-by-peer",
    "missing initialization preserves a peer document created before lock acquisition");
  ok(fs.readFileSync(CONFIG_PATH, "utf8") === JSON.stringify(peer, null, 2),
    "missing initialization performs no stale default write after the peer wins");
}

console.log(`\n${passed} passed`);
console.log("server/config.atomicWrite.test.js: all assertions passed");
process.exit(0);

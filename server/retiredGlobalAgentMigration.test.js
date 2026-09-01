// The retired global-agent field is metadata-only: migration must atomically
// remove it while preserving every unrelated config value and never touching
// the former operator-owned working directory.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-retired-global-agent-"));
const CONFIG_DIR = path.join(TMP, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const FORMER_CWD = path.join(TMP, "operator-owned-notes");
const MARKER_PATH = path.join(FORMER_CWD, "nested", "keep.bin");
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
const MARKER = Buffer.from([0x00, 0x01, 0x6b, 0x65, 0x65, 0x70, 0xff]);
fs.writeFileSync(MARKER_PATH, MARKER);

const originalHome = os.homedir;
os.homedir = () => TMP;
process.on("exit", () => {
  os.homedir = originalHome;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const {
  readConfig,
  writeConfig,
  RETIRED_GLOBAL_AGENT_FIELD,
} = require("./config");

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

function isFormerCwdPath(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return false;
  const absolute = path.resolve(String(value));
  return absolute === FORMER_CWD || absolute.startsWith(`${FORMER_CWD}${path.sep}`);
}

function withFormerCwdGuard(operation) {
  const methods = [
    "readFileSync", "writeFileSync", "readdirSync", "statSync", "lstatSync",
    "realpathSync", "mkdirSync", "copyFileSync", "renameSync", "unlinkSync", "rmSync",
  ];
  const originals = new Map();
  const touched = [];
  for (const method of methods) {
    const original = fs[method];
    if (typeof original !== "function") continue;
    originals.set(method, original);
    fs[method] = function guardedFilesystemCall(...args) {
      if (args.some(isFormerCwdPath)) {
        touched.push(method);
        throw new Error(`migration touched former working directory via ${method}`);
      }
      return original.apply(this, args);
    };
  }
  try {
    return { result: operation(), touched };
  } finally {
    for (const [method, original] of originals) fs[method] = original;
  }
}

const unrelated = {
  port: 8417,
  operator_name: "operator",
  custom: { preserve: ["exact", 7] },
  projects: [{ id: "alpha", name: "Alpha", agents: { head: { command: "claude" } } }],
};
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  ...unrelated,
  [RETIRED_GLOBAL_AGENT_FIELD]: {
    cwd: FORMER_CWD,
    command: "claude",
    enabled: true,
  },
}, null, 2), { mode: 0o600 });

const originalRename = fs.renameSync;
let atomicCommits = 0;
fs.renameSync = function trackedRename(from, to, ...rest) {
  if (to === CONFIG_PATH && String(from).endsWith(".tmp")) atomicCommits += 1;
  return originalRename.call(this, from, to, ...rest);
};
let loaded;
let readGuard;
try {
  readGuard = withFormerCwdGuard(() => readConfig());
  loaded = readGuard.result;
} finally {
  fs.renameSync = originalRename;
}

ok(!Object.prototype.hasOwnProperty.call(loaded, RETIRED_GLOBAL_AGENT_FIELD), "legacy metadata is absent from the loaded configuration");
ok(!Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")), RETIRED_GLOBAL_AGENT_FIELD), "legacy metadata is absent from the atomically saved configuration");
ok(atomicCommits === 1, "read-time migration commits through one tmp-to-config rename");
ok(readGuard.touched.length === 0, "read-time migration never reads, enumerates, creates, moves, or removes former cwd content");
ok(Buffer.compare(fs.readFileSync(MARKER_PATH), MARKER) === 0, "former cwd marker remains byte-identical after migration");
ok(JSON.stringify(loaded.custom) === JSON.stringify(unrelated.custom) && loaded.projects[0].id === "alpha", "unrelated configuration survives migration unchanged");

const saveGuard = withFormerCwdGuard(() => writeConfig({
  ...loaded,
  port: 8418,
  [RETIRED_GLOBAL_AGENT_FIELD]: { cwd: FORMER_CWD },
}));
const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
ok(!Object.prototype.hasOwnProperty.call(saved, RETIRED_GLOBAL_AGENT_FIELD) && saved.port === 8418, "ordinary config save cannot re-persist retired metadata");
ok(saveGuard.touched.length === 0 && Buffer.compare(fs.readFileSync(MARKER_PATH), MARKER) === 0, "ordinary config save also leaves former cwd byte-identical and untouched");

console.log(`\n${passed} passed`);
console.log("server/retiredGlobalAgentMigration.test.js: all assertions passed");

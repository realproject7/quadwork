// #827 item 2: writeGithubFileFromSnapshot must no-op for an idle project. The
// caller (syncGithubFilesForRepo) filters idle from a config snapshot taken
// earlier, so an idle-flip racing a setup-seed/refresh could otherwise still
// author a parked project's GITHUB.md. The writer now re-checks isProjectIdle
// (reads config fresh) before touching the filesystem.
//
// routes.js holds the shared `fs` module object (const fs = require("fs")), so
// stubbing fs here controls isProjectIdle's config read AND lets us assert no
// write is attempted — without touching the real ~/.quadwork.
//
// Plain node:assert script — run with `node server/routes.idleGithubWrite.test.js`.

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

const real = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  mkdirSync: fs.mkdirSync,
  statSync: fs.statSync,
};

let cfgJson;
const fsWrites = [];
fs.readFileSync = (p, ...rest) => (p === CONFIG_PATH ? cfgJson : real.readFileSync(p, ...rest));
fs.writeFileSync = (...args) => { fsWrites.push(args[0]); };
fs.renameSync = (...args) => { fsWrites.push(args[1]); };
fs.mkdirSync = () => {};
fs.statSync = () => ({ mode: 0o700, isDirectory: () => true });

const { writeGithubFileFromSnapshot } = require("./routes");

const SNAPSHOT = { issues: [], prs: [], closedIssues: [], mergedPrs: [] };

function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // 1) Idle project → no FS write at all (early return before authoring).
  {
    cfgJson = JSON.stringify({ projects: [{ id: "proj", repo: "o/r", idle: true }] });
    fsWrites.length = 0;
    writeGithubFileFromSnapshot("proj", "Proj", "o/r", SNAPSHOT, "ok");
    ok(fsWrites.length === 0, "idle project → writeGithubFileFromSnapshot writes nothing");
  }

  // 2) Positive control: a non-idle project DOES proceed to author the file
  //    (proves the no-op above is the idle guard, not a stubbing artifact).
  {
    cfgJson = JSON.stringify({ projects: [{ id: "proj", repo: "o/r", idle: false }] });
    fsWrites.length = 0;
    writeGithubFileFromSnapshot("proj", "Proj", "o/r", SNAPSHOT, "ok");
    ok(fsWrites.some((p) => String(p).endsWith("GITHUB.md")), "active project → authors GITHUB.md (atomic tmp+rename)");
  }

  // restore
  Object.assign(fs, real);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();

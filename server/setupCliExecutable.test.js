"use strict";

// #1186: the setup wizard's CLI list (bin/quadwork.js) and the setup route's
// claude pre-trust (POST /api/setup?step=create-worktrees, #599) use the
// shared resolver (server/cli-executable.js) that /api/cli-status and spawn
// use (#1176). Temp HOME, and a PATH holding only `which`, the lookup both
// used before: a `claude` only in ~/.local/bin and a `grok` only in
// ~/.grok/bin, stand-ins that log every run to a marker file. The route's git
// is a fixed fake, and a control child runs natively only when it is a
// stand-in or `which`, so no provider CLI is ever run.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile, spawnSync } = require("child_process");

if (process.platform === "win32") {
  console.log("  SKIP: POSIX shebang stand-in CLIs (not run on Windows)");
  console.log("\n0 passed, 0 failed\n");
  process.exit(0);
}

const TMP_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-setup-cli-")));
const MARKER = path.join(TMP_HOME, "cli-runs.log");
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";

function standIn(dir, name, label) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file,
    `#!${process.execPath}\n` +
    `require("fs").appendFileSync(${JSON.stringify(MARKER)}, ${JSON.stringify(label + " ")} + process.cwd() + " " + process.argv.slice(2).join(" ") + "\\n");\n`,
    { mode: 0o755 });
  return file;
}
const HOME_CLAUDE = standIn(path.join(TMP_HOME, ".local", "bin"), "claude", "home-claude");
const HOME_GROK = standIn(path.join(TMP_HOME, ".grok", "bin"), "grok", "home-grok");
const FAKE_BIN = path.join(TMP_HOME, "bin");
fs.mkdirSync(FAKE_BIN);
const REAL_WHICH = ["/usr/bin/which", "/bin/which"].find((file) => fs.existsSync(file));
if (REAL_WHICH) fs.symlinkSync(REAL_WHICH, path.join(FAKE_BIN, "which"));
process.env.PATH = FAKE_BIN;

// The route's control children. Git answers a fresh clone's setup sequence
// and `worktree add` makes the directory. Natively, only a stand-in or `which`
// ever runs; any other command is refused.
const controlRuns = [];
function fakeGit(args) {
  const key = args.join(" ");
  const done = (stdout = "") => Promise.resolve({ stdout, stderr: "" });
  if (key === "fetch origin --prune" || /^branch worktree-\w+ HEAD$/.test(key)) return done();
  if (key === "remote get-url origin") return done("https://github.com/acme/widget.git\n");
  if (key === "rev-parse --verify HEAD") return done(`${"a".repeat(40)}\n`);
  if (args[0] === "worktree" && args[1] === "add" && args.length === 4) {
    fs.mkdirSync(args[2]);
    return done();
  }
  return Promise.reject(new Error(`git ${key}: not a fixture command`));
}
function controlChild(command, args, options = {}) {
  controlRuns.push({ command, args: [...args], cwd: options.cwd });
  if (command === "git") return fakeGit(args);
  if (command !== "which" && command !== HOME_CLAUDE && command !== HOME_GROK) {
    return Promise.reject(new Error(`${command}: not a stand-in`));
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
  });
}
require("./__tests__/resource-executor-fixture").installResourceExecutorFixture({
  preserveRuntimeOwner: true,
  runControlChild: controlChild,
});

const AGENT_CWD = path.join(TMP_HOME, "agent-cwd");
fs.mkdirSync(AGENT_CWD);
const CONFIG_PATH = path.join(TMP_HOME, ".quadwork", "config.json");
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  // Not 8400: nothing here may reach an operator's live server.
  port: 48186,
  projects: [{ id: "p1", name: "p1", working_dir: AGENT_CWD, agents: { claude_any: { command: "claude", cwd: AGENT_CWD } } }],
}));

const runtime = require("./index");
const wizard = require("../bin/quadwork");
const { resolveCliExecutable } = require("./cli-executable");

let passed = 0;
let failed = 0;
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`  PASS: ${m}`);
  } else {
    failed++;
    console.error(`  FAIL: ${m}`);
  }
};
const markerRuns = () => (fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf-8").split("\n").filter(Boolean) : []);
const whichFinds = (command) => spawnSync("which", [command], { env: { PATH: process.env.PATH } }).status === 0;

function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      method,
      path: urlPath,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
    }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString() || "null") }));
    });
    req.on("error", reject);
    req.end(payload || undefined);
  });
}

// The executable the spawn path hands to the PTY for an agent (as in
// server/cliExecutable.test.js): the injected ptySpawn records it and throws.
async function spawnedExecutable(agent) {
  let file = null;
  const release = runtime._test.installLifecycleTestFixture("p1", agent, "linux-contained");
  try {
    await runtime.spawnAgentPty("p1", agent, {
      lifecycleSource: "operator_start",
      operatorAuthorized: true,
      explicitRole: true,
      buildAgentArgs: async () => ({ args: [] }),
      ptySpawn: (launchCommand) => { file = launchCommand; throw new Error("spawn captured by the test"); },
    });
  } finally {
    release();
  }
  return file;
}

async function main() {
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    ok(!whichFinds("claude") && !whichFinds("grok"),
      "precondition: a `which` lookup on this PATH finds neither the ~/.local/bin claude nor the ~/.grok/bin grok");
    ok(resolveCliExecutable("claude") === HOME_CLAUDE && resolveCliExecutable("grok") === HOME_GROK,
      "the shared resolver finds the claude in ~/.local/bin and the grok in ~/.grok/bin");

    // Wizard: the backend list offers what Settings reports as installed.
    const status = (await request(server, "GET", "/api/cli-status")).body;
    const available = wizard.installedAgentCliBackends();
    ok(available.includes("claude") && available.includes("grok"),
      `#1186: the wizard offers the claude and the grok found only in extra install folders (${available.join(", ")})`);
    for (const backend of ["claude", "codex", "gemini", "grok"]) {
      ok(available.includes(backend) === status[backend],
        `#1186: the wizard lists ${backend} (${available.includes(backend)}) exactly when Settings reports it installed (${status[backend]})`);
    }
    const spawned = await spawnedExecutable("claude_any");
    ok(spawned === HOME_CLAUDE, `spawn runs the ~/.local/bin claude (${spawned})`);
    ok(markerRuns().length === 0, "the install check, the wizard's list and spawn never run a CLI");

    // Setup route: every Claude worktree is pre-trusted by that same claude.
    const workingDir = path.join(TMP_HOME, "work", "widget");
    fs.mkdirSync(path.join(workingDir, ".git"), { recursive: true });
    const roles = ["head", "re1", "re2", "dev"];
    const worktrees = roles.map((role) => `${workingDir}-${role}`);
    const before = controlRuns.length;
    const setup = await request(server, "POST", "/api/setup?step=create-worktrees", {
      workingDir,
      repo: "acme/widget",
      backends: { head: "claude", re1: "claude", re2: "claude", dev: "claude" },
    });
    ok(setup.status === 200 && setup.body.ok === true && JSON.stringify(setup.body.created) === JSON.stringify(roles),
      `the setup route creates the four worktrees (${JSON.stringify(setup.body)})`);
    // The routes module's `gh api rate_limit` poller shares the control child
    // (refused: not a stand-in). Every other run is the setup route's.
    const cliRuns = controlRuns.slice(before).filter((run) => run.command !== "git" && run.command !== "gh");
    const shown = cliRuns.map((run) => `${run.command === spawned ? "<spawned>" : run.command} ${run.args.join(" ")} @${path.basename(run.cwd || "")}`);
    ok(cliRuns.length === 4 && cliRuns.every((run, i) => run.command === spawned
      && JSON.stringify(run.args) === '["-p","echo ok"]' && run.cwd === worktrees[i]),
    `#1186: the setup route runs \`claude -p\` in each worktree with the executable spawn runs, not a \`which\` lookup or a bare \`claude\` (${shown.join(", ")})`);
    ok(JSON.stringify(markerRuns()) === JSON.stringify(worktrees.map((dir) => `home-claude ${dir} -p echo ok`)),
      "#1186: the ~/.local/bin claude ran once in each worktree, and nothing else ran");
  } finally {
    server.close();
  }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.error(err);
  process.exit(1);
});

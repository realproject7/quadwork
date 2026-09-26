"use strict";

// #1176: the install check (/api/cli-status), the spawn path and model
// discovery (/api/agent-model-catalog) resolve a CLI command to the same
// executable (resolveCliExecutable in index.js). Driven through the real server
// with a temp HOME and a PATH holding only stand-in CLIs: a `codex` on PATH, a
// `grok` only in ~/.grok/bin (grok's installer location, off PATH) and a
// pinned codex an agent names by absolute path. Each stand-in logs every run
// to a marker file. Spawn is observed through the injected ptySpawn, which
// records the executable and throws, so no process starts. No provider CLI is
// ever run: nothing on this PATH or under this HOME is a real one.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

if (process.platform === "win32") {
  console.log("  SKIP: POSIX shebang stand-in CLIs (not run on Windows)");
  console.log("\n0 passed, 0 failed\n");
  process.exit(0);
}

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-cli-exec-"));
const MARKER = path.join(TMP_HOME, "cli-runs.log");
const CWD = path.join(TMP_HOME, "worktree");
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";

function standIn(dir, label, stdout) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, label.split("-").pop());
  fs.writeFileSync(file,
    `#!${process.execPath}\n` +
    `require("fs").appendFileSync(${JSON.stringify(MARKER)}, ${JSON.stringify(label + " ")} + process.argv.slice(2).join(" ") + "\\n");\n` +
    `process.stdout.write(${JSON.stringify(stdout)});\n`,
    { mode: 0o755 });
  return file;
}
const codexList = (...slugs) => JSON.stringify({ models: slugs.map((slug) => ({ slug, visibility: "list" })) });
const FAKE_BIN = path.join(TMP_HOME, "bin");
const PATH_CODEX = standIn(FAKE_BIN, "path-codex", codexList("gpt-7-nova"));
const HOME_GROK = standIn(path.join(TMP_HOME, ".grok", "bin"), "home-grok",
  "Default model: grok-5\n\nAvailable models:\n  * grok-5 (default)\n");
const PINNED_CODEX = standIn(path.join(TMP_HOME, "tools"), "pinned-codex", codexList("gpt-pinned-1"));
// A reviewed-execution role's command: generic discovery must never run it.
const REVIEWED_CODEX = standIn(path.join(TMP_HOME, "reviewed"), "reviewed-codex", codexList("gpt-reviewed-1"));
// Not executable: an install check that only tests existence would report it.
fs.mkdirSync(path.join(TMP_HOME, ".local", "bin"), { recursive: true });
fs.writeFileSync(path.join(TMP_HOME, ".local", "bin", "gemini"), "not a program\n", { mode: 0o644 });
// A relative PATH entry holding a gemini, run from TMP_HOME: it would resolve
// against the server's cwd, never the agent's, so the resolver skips it.
const REL_ENTRY = "relbin";
fs.mkdirSync(path.join(TMP_HOME, REL_ENTRY));
fs.writeFileSync(path.join(TMP_HOME, REL_ENTRY, "gemini"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
// A PATH entry through a symlinked dir and `..`: the kernel follows the link
// first (sym/link -> sym/real/sub, so link/.. is sym/real), where path.join
// would fold it to sym/bin, which does not exist. The claude there prints the
// path it was run as.
const SYM = path.join(TMP_HOME, "sym");
fs.mkdirSync(path.join(SYM, "real", "sub"), { recursive: true });
fs.mkdirSync(path.join(SYM, "real", "bin"));
fs.writeFileSync(path.join(SYM, "real", "bin", "claude"), "#!/bin/sh\nprintf '%s\\n' \"$0\"\n", { mode: 0o755 });
fs.symlinkSync(path.join(SYM, "real", "sub"), path.join(SYM, "link"));
const SYM_ENTRY = `${SYM}/link/../bin`;
const SYM_CLAUDE = `${SYM_ENTRY}/claude`;
process.env.PATH = [FAKE_BIN, REL_ENTRY, SYM_ENTRY].join(path.delimiter);
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP_HOME);

fs.mkdirSync(CWD, { recursive: true });
const CONFIG_PATH = path.join(TMP_HOME, ".quadwork", "config.json");
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  // Not 8400: nothing here may reach an operator's live server.
  port: 48176,
  // An on-box reverse proxy's forwarded name (#988), trusted like loopback.
  trusted_dashboard_hosts: ["dash.example"],
  projects: [{
    id: "p1",
    name: "p1",
    working_dir: CWD,
    agents: {
      codex_path: { command: "codex", cwd: CWD },
      grok_home: { command: "grok", cwd: CWD },
      codex_pinned: { command: PINNED_CODEX, cwd: CWD },
      claude_any: { command: "claude", cwd: CWD },
      gemini_any: { command: "gemini", cwd: CWD },
      reviewed_role: { command: REVIEWED_CODEX, cwd: CWD, reviewed_execution_id: "v2_codex_readonly_v1" },
    },
  }],
}));

const runtime = require("./index");

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
const isExecutableFile = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

function get(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: urlPath, headers }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString() || "null") }));
    }).on("error", reject);
  });
}

// The executable the spawn path hands to the PTY for an agent.
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
    const status = (await get(server, "/api/cli-status")).body;
    ok(status.codex === true, "codex on PATH is reported installed");
    ok(status.grok === true, "#1023: grok installed only in ~/.grok/bin (off PATH) is reported installed");

    const spawned = {};
    for (const agent of ["codex_path", "grok_home", "codex_pinned", "claude_any", "gemini_any"]) spawned[agent] = await spawnedExecutable(agent);
    ok(spawned.codex_path === PATH_CODEX, "spawn runs the codex the install check found on PATH");
    ok(spawned.grok_home === HOME_GROK, "#1176: spawn runs the ~/.grok/bin grok the install check reported, not a bare `grok` PATH lookup");
    ok(spawned.codex_pinned === PINNED_CODEX, "an absolute-path command spawns exactly that executable");
    // Agreement for every backend, whatever else this machine has installed.
    for (const [agent, backend] of [["codex_path", "codex"], ["grok_home", "grok"], ["claude_any", "claude"], ["gemini_any", "gemini"]]) {
      const file = spawned[agent];
      const startable = typeof file === "string" && path.isAbsolute(file) && isExecutableFile(file);
      ok(status[backend] === startable,
        `#1176: ${backend} is reported installed (${status[backend]}) exactly when spawn resolves an executable (${file})`);
    }
    ok(markerRuns().length === 0, "#1176: the install check and the spawn path never run a CLI");
    // The OS lookup of `claude` on this PATH runs the stand-in, which prints the
    // path it ran as.
    const osLookup = spawnSync("claude", [], { env: { PATH: process.env.PATH }, encoding: "utf8" }).stdout.trim();
    ok(osLookup === SYM_CLAUDE && status.claude === true && spawned.claude_any === SYM_CLAUDE,
      `#1176: a PATH dir through a symlink and \`..\` resolves to the file the OS lookup runs (${spawned.claude_any})`);
    ok(!String(spawned.gemini_any).startsWith(REL_ENTRY),
      `#1176: a relative PATH entry is skipped: its gemini is never what spawn runs (${spawned.gemini_any})`);

    // An untrusted caller (a foreign Host, or a foreign Origin) gets bare-name
    // discovery only. It comes first, so no earlier run has been cached.
    for (const [label, headers] of [["a foreign Host", { host: "evil.example" }], ["a foreign Origin", { origin: "http://evil.example" }]]) {
      const r = await get(server, "/api/agent-model-catalog", headers);
      ok(r.status === 200 && JSON.stringify(r.body.models.codex) === '["gpt-7-nova"]' && JSON.stringify(r.body.models.grok) === '["grok-5"]',
        `#1176: an untrusted caller (${label}) gets the bare-name CLIs' models only`);
    }
    ok(markerRuns().sort().join("|") === "home-grok models|path-codex debug models",
      "#1176: an untrusted caller never runs a config-derived executable");

    const first = await get(server, "/api/agent-model-catalog");
    ok(first.status === 200 && JSON.stringify(first.body.models.grok) === '["grok-5"]',
      "#1176: discovery lists the models of the grok the install check reported (~/.grok/bin)");
    ok(JSON.stringify(first.body.models.codex) === '["gpt-7-nova","gpt-pinned-1"]',
      "#1176: an agent's absolute-path codex gets its own executable's models (with the PATH codex's)");
    ok(markerRuns().sort().join("|") === "home-grok models|path-codex debug models|pinned-codex debug models",
      "#1176: discovery ran each resolved executable once, with its fixed arguments");
    ok(!markerRuns().some((run) => run.startsWith("reviewed-codex")) && !first.body.models.codex.includes("gpt-reviewed-1"),
      "#1176: a reviewed-execution role's command is never run by discovery");
    const proxied = await get(server, "/api/agent-model-catalog", { host: "dash.example" });
    ok(JSON.stringify(proxied.body.models.codex) === '["gpt-7-nova","gpt-pinned-1"]',
      "#1176: a trusted reverse-proxy caller (trusted_dashboard_hosts) gets the config-derived models too");
    const untrustedLater = await get(server, "/api/agent-model-catalog", { host: "evil.example" });
    ok(JSON.stringify(untrustedLater.body.models.codex) === '["gpt-7-nova"]',
      "#1176: an untrusted caller never gets a config-derived executable's cached models either");

    await get(server, "/api/agent-model-catalog");
    ok(markerRuns().length === 3, "#1176: a second open is served from the cache");
    const nextCodex = standIn(path.join(TMP_HOME, "tools-next"), "next-codex", codexList("gpt-next-1"));
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    cfg.projects[0].agents.codex_path_abs = { command: PATH_CODEX, cwd: CWD };
    cfg.projects[0].agents.codex_pinned_2 = { command: PINNED_CODEX, cwd: CWD };
    cfg.projects[0].agents.codex_next = { command: nextCodex, cwd: CWD };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
    const again = await get(server, "/api/agent-model-catalog");
    ok(markerRuns().length === 4 && markerRuns()[3] === "next-codex debug models"
      && JSON.stringify(again.body.models.codex) === '["gpt-7-nova","gpt-pinned-1","gpt-next-1"]',
    "#1176: the cache is per resolved executable: a newly configured one runs once; `codex` by name or by path, and a second agent on the pinned one, reuse theirs");
  } finally {
    server.close();
  }
  process.chdir(ORIGINAL_CWD);
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.chdir(ORIGINAL_CWD);
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.error(err);
  process.exit(1);
});

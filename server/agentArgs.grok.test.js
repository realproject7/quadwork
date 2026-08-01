"use strict";

// #1023: grok is the fourth agent backend. buildAgentArgs must produce exactly
// `--always-approve`, an optional `--model <slug>`, and `--trust` — and, because
// grok has NO --mcp-config-style flag, write the file-chat MCP server into
// <cwd>/.grok/config.toml and git-exclude it so the per-spawn shim token can
// never be committed.
//
// Three things here are load-bearing and were each specified from a measurement,
// so they are asserted against fixtures that can actually fail:
//   1. The exclude must go to `git rev-parse --git-common-dir` RESOLVED against
//      the agent cwd. QuadWork agent cwds are linked worktrees, where <cwd>/.git
//      is a FILE (ENOTDIR) and a per-worktree exclude is not honored — but an
//      operator-configured cwd may be a plain clone, where the command returns a
//      RELATIVE ".git". Hence both a real linked-worktree fixture AND a
//      plain-clone fixture: either alone passes green against code that breaks
//      in production.
//   2. The write must be append-if-absent — the common-dir exclude is shared by
//      every agent worktree and buildAgentArgs runs on every spawn AND respawn.
//   3. The plain-clone fixture chdirs into its own temp dir (restored in a
//      finally). Against the naive relative-path implementation this test exists
//      to catch, the write follows the PROCESS cwd — which under `npm test` is
//      the QuadWork checkout itself. The fixture must not be able to reach it.
//
// No grok binary is required (#905 precedent): we assert built args and written
// file content. QUADWORK_SKIP_LISTEN + a temp HOME let us require the server
// module for its exported pure helper without binding a port. HOME is set BEFORE
// any require so config.js resolves CONFIG_PATH into the temp dir.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const TMP_HOME = path.join(os.tmpdir(), `quadwork-grok-test-${process.pid}`);
process.env.HOME = TMP_HOME;
process.env.QUADWORK_SKIP_LISTEN = "1";

const ORIGINAL_CWD = process.cwd();

function git(cwd, args) {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

// --- Fixtures (built before the server module is required, so config.json can
//     name their real paths) ---
//
// realpathSync is load-bearing, not tidiness: on macOS `os.tmpdir()` returns
// /var/folders/…, a SYMLINK to /private/var/folders/…. git canonicalizes the
// paths it reports, so an expected value built from the unresolved spelling
// never matches what `git rev-parse` returns, and this suite went red for every
// Mac operator while staying green on the Linux VPS and in CI. Canonicalizing
// the fixture ROOT fixes the whole class — every path below derives from it.
const FIX = path.join(TMP_HOME, "fixtures");
fs.mkdirSync(FIX, { recursive: true });
const FIX_REAL = fs.realpathSync(FIX);

// 1. A REAL linked worktree, exactly how QuadWork creates agent cwds
//    (server/routes.js: `git worktree add`). <cwd>/.git is a file here.
const REPO = path.join(FIX_REAL, "repo");
fs.mkdirSync(REPO, { recursive: true });
git(REPO, ["init", "-q"]);
fs.writeFileSync(path.join(REPO, "README.md"), "fixture\n");
git(REPO, ["add", "README.md"]);
git(REPO, ["commit", "-q", "-m", "init"]);
const WORKTREE = path.join(FIX_REAL, "wt");
git(REPO, ["worktree", "add", "-q", "-b", "agent", WORKTREE]);

// 2. A PLAIN CLONE — a non-worktree repo, which `git rev-parse
//    --git-common-dir` answers with a RELATIVE ".git".
const CLONE = path.join(FIX_REAL, "clone");
fs.mkdirSync(CLONE, { recursive: true });
git(CLONE, ["init", "-q"]);
fs.writeFileSync(path.join(CLONE, "README.md"), "fixture\n");
git(CLONE, ["add", "README.md"]);
git(CLONE, ["commit", "-q", "-m", "init"]);

// 3. A plain directory that is not a git repo at all — the exclude step must
//    degrade quietly rather than throwing and failing the spawn.
const NOGIT = path.join(FIX_REAL, "nogit");
fs.mkdirSync(NOGIT, { recursive: true });

// 4. Scratch dir to chdir into for the plain-clone case, so a naive relative
//    write lands HERE and not in the developer's/CI's own repo.
const SCRATCH = path.join(FIX_REAL, "scratch");
fs.mkdirSync(SCRATCH, { recursive: true });

const cfgDir = path.join(TMP_HOME, ".quadwork");
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(
  path.join(cfgDir, "config.json"),
  JSON.stringify({
    port: 8400,
    projects: [
      {
        id: "p1",
        working_dir: FIX_REAL,
        agents: {
          grok_model: { command: "grok", model: "grok-4.5", cwd: WORKTREE },
          grok_default: { command: "grok", cwd: NOGIT },
          grok_clone: { command: "grok", cwd: CLONE },
          grok_nocwd: { command: "grok" },
          claude_agent: { command: "claude", model: "opus", cwd: WORKTREE },
          codex_agent: { command: "codex", model: "gpt-5", cwd: WORKTREE },
          gemini_agent: { command: "gemini", model: "gemini-2.5-pro", cwd: WORKTREE },
        },
      },
    ],
  }),
);

const { buildAgentArgs } = require("./index");
const fileChat = require("./file-chat");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function modelArg(args) {
  const i = args.indexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
}

function commonDir(cwd) {
  const out = git(cwd, ["rev-parse", "--git-common-dir"]).trim();
  return path.resolve(cwd, out);
}

function excludeLines(cwd) {
  const p = path.join(commonDir(cwd), "info", "exclude");
  let body = "";
  try { body = fs.readFileSync(p, "utf-8"); } catch {}
  return body.split("\n").map((l) => l.trim());
}

async function runTests() {
  // --- 1. The exact arg contract (AC: "returns exactly") ---
  {
    const { args } = await buildAgentArgs("p1", "grok_model");
    assert(args.includes("--always-approve"), "#1023 AC: grok gets its --always-approve permission flag");
    assert(modelArg(args) === "grok-4.5", "#1023 AC: grok forwards the configured model as --model <slug>");
    assert(args.includes("--trust"), "#1023 AC: grok gets --trust (repo-local MCP servers are inert in an untrusted folder)");
    assert(
      JSON.stringify(args) === JSON.stringify(["--always-approve", "--model", "grok-4.5", "--trust"]),
      "#1023 AC: buildAgentArgs returns EXACTLY --always-approve, --model <slug>, --trust — no MCP flag",
    );
  }

  {
    const { args } = await buildAgentArgs("p1", "grok_default");
    assert(!args.includes("--model"), "#1023 AC: grok without a model → no --model (CLI default)");
    assert(args.includes("--always-approve") && args.includes("--trust"), "#1023: a grok agent with no model still gets --always-approve and --trust");
  }

  // --- 2. The written config.toml — content, not just existence ---
  {
    const tomlPath = path.join(WORKTREE, ".grok", "config.toml");
    assert(fs.existsSync(tomlPath), "#1023 AC: <cwd>/.grok/config.toml exists after arg-build");
    const toml = fs.readFileSync(tomlPath, "utf-8");
    assert(toml.includes("[mcp_servers.chat]"), "#1023 AC: config.toml declares the [mcp_servers.chat] table");
    assert(/^command = "node"$/m.test(toml), "#1023 AC: the chat server is a stdio launch — command = \"node\"");
    const argsLine = toml.split("\n").find((l) => l.startsWith("args = "));
    assert(!!argsLine, "#1023: config.toml carries an args array");
    const tomlArgs = JSON.parse(argsLine.slice("args = ".length));
    assert(tomlArgs[0] === path.join(__dirname, "mcp-chat-shim.js"), "#1023 AC: args[0] is the file-chat MCP shim path");
    assert(tomlArgs[tomlArgs.indexOf("--project") + 1] === "p1", "#1023 AC: args carry --project <id>");
    assert(tomlArgs[tomlArgs.indexOf("--agent") + 1] === "grok_model", "#1023 AC: args carry --agent <id>");
    assert(tomlArgs[tomlArgs.indexOf("--port") + 1] === "8400", "#1023 AC: args carry --port <PORT>");
    const token = tomlArgs[tomlArgs.indexOf("--token") + 1];
    assert(
      typeof token === "string" && fileChat.validateShimToken("p1", "grok_model", token),
      "#1023 AC: the --token in config.toml is the token actually registered with file-chat",
    );
    // Security invariant: the token lives only in this 0600 file.
    assert((fs.statSync(tomlPath).mode & 0o777) === 0o600, "#1023 security: the token-bearing config.toml is written 0600");
  }

  // --- 3. The exclude: real linked worktree. QuadWork's actual agent-cwd shape,
  //        where <cwd>/.git is a FILE and a per-worktree exclude is not honored. ---
  {
    assert(fs.statSync(path.join(WORKTREE, ".git")).isFile(), "fixture is a REAL linked worktree (<cwd>/.git is a file, not a dir)");
    // Both sides realpath'd as well as the root above: git's canonicalization is
    // the thing under comparison here, so this assertion must not be able to
    // fail on a path SPELLING difference on any platform.
    const common = commonDir(WORKTREE);
    assert(
      fs.realpathSync(common) === fs.realpathSync(path.join(REPO, ".git")),
      "#1023: the worktree's common dir is the MAIN repo's .git, not .git/worktrees/<name>",
    );
    assert(excludeLines(WORKTREE).includes(".grok/"), "#1023 AC: .grok/ is written to the COMMON-dir exclude");
    const status = git(WORKTREE, ["status", "--porcelain"]);
    assert(!status.includes(".grok"), "#1023 AC: git status in the worktree does NOT list .grok/ — the token file can never be committed");
  }

  // --- 4. The exclude: idempotent. buildAgentArgs runs on every spawn AND
  //        respawn against a file shared by all four worktrees. ---
  {
    await buildAgentArgs("p1", "grok_model"); // a second spawn/respawn
    await buildAgentArgs("p1", "grok_model"); // and a third
    const count = excludeLines(WORKTREE).filter((l) => l === ".grok/").length;
    assert(count === 1, `#1023 AC: repeated arg-builds leave EXACTLY one .grok/ line in the shared exclude (got ${count})`);
  }

  // --- 5. The exclude: plain clone. `git rev-parse --git-common-dir` answers
  //        RELATIVE ".git" here, so an unresolved write follows the PROCESS cwd
  //        into the wrong repo while the agent's own .grok/ stays committable.
  //        chdir'd into a scratch dir so that failure cannot touch the real repo. ---
  {
    assert(git(CLONE, ["rev-parse", "--git-common-dir"]).trim() === ".git", "fixture premise: a plain clone answers --git-common-dir with a RELATIVE .git");
    process.chdir(SCRATCH);
    try {
      await buildAgentArgs("p1", "grok_clone");
      assert(excludeLines(CLONE).includes(".grok/"), "#1023 AC: with a plain-clone cwd the exclude lands under the AGENT's own repo (path.resolve, not path.join)");
      assert(!fs.existsSync(path.join(SCRATCH, ".git")), "#1023: the exclude write never follows the server process's cwd");
      const status = git(CLONE, ["status", "--porcelain"]);
      assert(!status.includes(".grok"), "#1023 AC: git status in the plain clone does NOT list .grok/");
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  }

  // --- 6. Degrade quietly where there is nothing to exclude ---
  {
    assert(fs.existsSync(path.join(NOGIT, ".grok", "config.toml")), "#1023: a non-git cwd still gets its config.toml (arg-build does not throw)");
  }

  {
    // resolveAgentCwd returns null for an agent with no cwd. Production never
    // hits this (spawn hard-fails first), but arg-build must not throw.
    const { args } = await buildAgentArgs("p1", "grok_nocwd");
    assert(args.includes("--always-approve"), "#1023: a grok agent with no configured cwd still builds args instead of throwing");
  }

  // --- 7. No regression for the other three backends ---
  {
    const { args } = await buildAgentArgs("p1", "claude_agent");
    assert(args.includes("--dangerously-skip-permissions") && args.includes("--mcp-config"), "no regression: claude keeps its permission flag and --mcp-config");
    assert(!args.includes("--trust"), "no regression: claude does NOT get grok's --trust");
  }
  {
    const { args } = await buildAgentArgs("p1", "codex_agent");
    assert(args.some((a) => a === 'model="gpt-5"') && !args.includes("--model"), "no regression: codex still uses -c model=\"…\"");
    assert(!args.includes("--trust"), "no regression: codex does NOT get grok's --trust");
  }
  {
    const { args } = await buildAgentArgs("p1", "gemini_agent");
    assert(modelArg(args) === "gemini-2.5-pro" && args.includes("--yolo"), "no regression: gemini keeps --model <slug> and --yolo");
    assert(!args.includes("--trust"), "no regression: gemini does NOT get grok's --trust");
  }

  cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

function cleanup() {
  try { process.chdir(ORIGINAL_CWD); } catch {}
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
}

runTests().catch((err) => {
  cleanup();
  console.error(err);
  process.exit(1);
});

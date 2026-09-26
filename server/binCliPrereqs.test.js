"use strict";

// #1186: the init wizard's prerequisite step (checkPrereqs in bin/quadwork.js)
// finds each agent CLI with the shared resolver and runs the executable it
// found for the auth checks, the --version fallback and the logins, as spawn
// does. Driven through its own readline parameter with scripted answers
// ("y" to each CLI login offer, "n" to anything else). Temp HOME, and a PATH
// holding only `which`, `node` and stand-in `gh`/`brew`: claude and gemini only
// in ~/.local/bin, codex only in ~/.npm-global/bin, grok only in ~/.grok/bin,
// so neither a `which` lookup nor a bare name finds them. Each stand-in logs
// every run to a marker file. No provider CLI is ever run.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

if (process.platform === "win32") {
  console.log("  SKIP: POSIX shebang stand-in CLIs (not run on Windows)");
  console.log("\n0 passed, 0 failed\n");
  process.exit(0);
}

const TMP_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-bin-prereqs-")));
const MARKER = path.join(TMP_HOME, "cli-runs.log");
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

// Logs `<label> <args>`, then answers with the reply its args select
// (default: no output, exit 0).
function standIn(dir, name, label, replies = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file,
    `#!${process.execPath}\n` +
    `const args = process.argv.slice(2).join(" ");\n` +
    `require("fs").appendFileSync(${JSON.stringify(MARKER)}, ${JSON.stringify(label + " ")} + args + "\\n");\n` +
    `const reply = (${JSON.stringify(replies)})[args] || {};\n` +
    `if (reply.out) process.stdout.write(reply.out);\n` +
    `process.exitCode = reply.code || 0;\n`,
    { mode: 0o755 });
  return file;
}
// Not logged in: the status check fails, so the wizard also runs --version
// and then offers the login.
standIn(path.join(TMP_HOME, ".local", "bin"), "claude", "home-claude",
  { "auth status": { code: 1 }, "--version": { out: "2.0.0 (Claude Code)\n" } });
standIn(path.join(TMP_HOME, ".npm-global", "bin"), "codex", "npm-codex",
  { "login status": { code: 1 }, "--version": { out: "codex-cli 0.0.0\n" } });
standIn(path.join(TMP_HOME, ".local", "bin"), "gemini", "home-gemini");
standIn(path.join(TMP_HOME, ".grok", "bin"), "grok", "home-grok");
const FAKE_BIN = path.join(TMP_HOME, "bin");
standIn(FAKE_BIN, "gh", "gh", { "auth status": { out: "Logged in to github.com as fixture\n" } });
standIn(FAKE_BIN, "brew", "brew");
fs.symlinkSync(process.execPath, path.join(FAKE_BIN, "node"));
const REAL_WHICH = ["/usr/bin/which", "/bin/which"].find((file) => fs.existsSync(file));
if (REAL_WHICH) fs.symlinkSync(REAL_WHICH, path.join(FAKE_BIN, "which"));
process.env.PATH = FAKE_BIN;

const wizard = require("../bin/quadwork");

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
const plain = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "").trim();
const markerRuns = () => (fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf-8").split("\n").filter(Boolean) : []);
const whichFinds = (command) => spawnSync("which", [command], { env: { PATH: process.env.PATH } }).status === 0;
const onPath = (command) => process.env.PATH.split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, command)));

async function main() {
  ok(["claude", "codex", "gemini", "grok"].every((cli) => !whichFinds(cli) && !onPath(cli)),
    "precondition: neither a `which` lookup nor a bare name on this PATH finds any of the four CLIs");

  const prompts = [];
  const rl = {
    question(prompt, answer) {
      const question = plain(prompt).replace(/\s*\[[^\]]*\]\s*>$/, "");
      prompts.push(question);
      answer(/^Log in to (Claude Code|Codex CLI) now\?$/.test(question) ? "y" : "n");
    },
    pause() {},
    resume() {},
  };
  const printed = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts) => printed.push(plain(parts.join(" ")));
  console.error = console.log;
  let ready;
  try {
    ready = await wizard.checkPrereqs(rl);
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  ok(ready === true, "the prerequisite step passes with only extra-folder CLIs");
  for (const line of ["✓ Claude Code", "✓ Codex CLI", "✓ Gemini CLI", "✓ Grok CLI"]) {
    ok(printed.includes(line), `#1186: the wizard reports "${line}" for a CLI found only in an extra install folder`);
  }
  ok(JSON.stringify(prompts) === JSON.stringify(["Log in to Claude Code now?", "Log in to Codex CLI now?"]),
    `#1186: the wizard offers no install for a CLI it found; it asks only the two logins (${prompts.join(" | ")})`);
  ok(JSON.stringify(markerRuns()) === JSON.stringify([
    "gh auth status",
    "home-claude auth status",
    "home-claude --version",
    "home-claude auth login",
    "npm-codex login status",
    "npm-codex --version",
    "npm-codex login",
  ]), `#1186: the auth checks, the --version fallback and the logins run the claude and codex the wizard found, and nothing else ran (${markerRuns().join(" | ")})`);
  if (failed > 0) console.error(`  wizard output:\n    ${printed.join("\n    ")}`);

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
  console.error(err);
  process.exit(1);
});

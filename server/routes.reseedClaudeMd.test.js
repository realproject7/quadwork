// #966: reseed must refresh a worktree's QuadWork-seeded CLAUDE.md alongside
// AGENTS.md, but must NEVER clobber a project's own hand-authored CLAUDE.md.
// Covers the pure `_isSeededClaudeMd` predicate plus the endpoint-level
// behavior against temp worktrees:
//   • seeded CLAUDE.md is refreshed and an operator-added H2 is preserved
//   • foreign (hand-authored) CLAUDE.md is left byte-identical (skipped)
//   • worktree with no CLAUDE.md is handled without error (skipped)
//   • AGENTS.md reseed behavior is unchanged (still refreshed)
//
// Plain node:assert script — auto-discovered by the #836 runner. Run directly
// with `node server/routes.reseedClaudeMd.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "qw-966-home-"));
const originalHomedir = os.homedir;
os.homedir = () => TEST_HOME;
process.on("exit", () => {
  os.homedir = originalHomedir;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

// ── Stub fs.readFileSync for CONFIG_PATH BEFORE requiring routes ──────────
// (Same hermetic pattern as routes.reseedTokenPreservation.test.js.)
const realReadFileSync = fs.readFileSync;
let stubCfgJson = JSON.stringify({ projects: [] });
fs.readFileSync = function stubReadFileSync(p, ...rest) {
  if (p === CONFIG_PATH) return stubCfgJson;
  return realReadFileSync(p, ...rest);
};

const express = require("express");
const routes = require("./routes");
const { _isSeededClaudeMd } = routes;

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use(routes.router || routes);
  await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try { await fn(`http://127.0.0.1:${port}`); resolve(); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body || {});
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => chunks += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks || "{}") }); }
        catch (e) { reject(new Error(`Non-JSON response (status ${res.statusCode}): ${chunks}`)); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// A minimal but genuinely QuadWork-seeded CLAUDE.md: carries the signature
// H2 set. (We use the real template rendered for `{{project_name}}`.)
const CLAUDE_TEMPLATE = realReadFileSync(path.join(TEMPLATES_DIR, "CLAUDE.md"), "utf-8");

// A project's OWN hand-authored CLAUDE.md — none of the signature headings.
const FOREIGN_CLAUDE = `# Cool Project — Development Rules

## What is Cool Project

A bespoke tool. Nothing to do with the multi-agent template.

## Tech Stack

- Rust + wgpu

## Git

- Commit format: whatever you like
`;

// ── Pure predicate tests ─────────────────────────────────────────────────
{
  const rendered = CLAUDE_TEMPLATE.replace(/\{\{project_name\}\}/g, "demo");
  assert.equal(_isSeededClaudeMd(rendered), true, "rendered template is recognized as seeded");
  assert.equal(_isSeededClaudeMd(FOREIGN_CLAUDE), false, "hand-authored CLAUDE.md is not seeded");
  assert.equal(_isSeededClaudeMd(""), false, "empty content is not seeded");
  assert.equal(_isSeededClaudeMd(null), false, "null content is not seeded");
  // A seeded file with an operator-added H2 is still recognized.
  const withOperator = rendered + "\n## Project Notes\n- run make first\n";
  assert.equal(_isSeededClaudeMd(withOperator), true, "operator H2 doesn't hide the signature");
  // Missing even one signature heading → not seeded (fail-closed).
  const missingOne = rendered.replace(/^## Communication Rules$/m, "## Chatting");
  assert.equal(_isSeededClaudeMd(missingOne), false, "missing a signature heading → not seeded");
}

function makeTempProject(label, layout) {
  // layout: { agentKey: { cwdName, agentsMd, claudeMd } } — omit a field to
  // skip writing that file (simulates a worktree missing it).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qw-966-${label}-`));
  const workingDir = path.join(root, "proj");
  fs.mkdirSync(workingDir, { recursive: true });
  const agents = {};
  for (const [agentKey, spec] of Object.entries(layout)) {
    const cwd = path.join(root, spec.cwdName);
    fs.mkdirSync(cwd, { recursive: true });
    if (spec.agentsMd != null) fs.writeFileSync(path.join(cwd, "AGENTS.md"), spec.agentsMd);
    if (spec.claudeMd != null) fs.writeFileSync(path.join(cwd, "CLAUDE.md"), spec.claudeMd);
    agents[agentKey] = { cwd };
  }
  return { workingDir, agents };
}

(async () => {
  const dirName = "proj"; // path.basename(workingDir) → what the server substitutes

  // ── Endpoint test: seeded refreshed + operator H2 preserved; foreign
  //    skipped byte-identical; missing handled without error. ──────────────
  const projId = `p966-${crypto.randomBytes(4).toString("hex")}`;

  // A stale seeded CLAUDE.md (rendered from template) with an operator H2 and
  // a deliberately-mangled canonical section that the refresh must overwrite.
  const rendered = CLAUDE_TEMPLATE.replace(/\{\{project_name\}\}/g, dirName);
  const seededStale = rendered
      .replace("QuadWork agent", "STALE-MARKER agent") // canonical body edit
    + "\n## Project Notes\n- Local: run `make dev` before pushing.\n";

  const { workingDir, agents } = makeTempProject("mix", {
    // head: seeded CLAUDE.md → must be refreshed, operator H2 preserved
    head: { cwdName: "proj-head", agentsMd: "# Head\n\nStale.\n", claudeMd: seededStale },
    // re1: foreign CLAUDE.md → must be left byte-identical (skipped)
    re1:  { cwdName: "proj-re1",  agentsMd: "# Reviewer 1\n\nStale.\n", claudeMd: FOREIGN_CLAUDE },
    // dev: no CLAUDE.md at all → handled without error (skipped)
    dev:  { cwdName: "proj-dev",  agentsMd: "# Dev\n\nStale.\n" },
  });

  stubCfgJson = JSON.stringify({
    projects: [{ id: projId, name: "P966", repo: "ex/p966", working_dir: workingDir, agents }],
  });

  let resp;
  await withServer(async (base) => {
    resp = await post(`${base}/api/projects/${projId}/reseed-agents`, { force: true });
  });
  assert.equal(resp.status, 200, `expected 200, got ${resp.status} ${JSON.stringify(resp.body)}`);
  assert.equal(resp.body.ok, true);

  // AGENTS.md reseed behavior unchanged: all three still refreshed.
  for (const k of ["head", "re1", "dev"]) {
    assert.ok(resp.body.reseeded.includes(`${k}/AGENTS.md`), `${k}/AGENTS.md still reseeded`);
  }

  // head: seeded CLAUDE.md refreshed, stale canonical body gone, operator H2 kept.
  const headClaude = realReadFileSync(path.join(agents.head.cwd, "CLAUDE.md"), "utf-8");
  assert.ok(resp.body.reseeded.includes("head/CLAUDE.md"), "head/CLAUDE.md reported reseeded");
  assert.ok(!headClaude.includes("STALE-MARKER"), "stale canonical body overwritten by fresh template");
  assert.ok(headClaude.includes("## Multi-Agent System"), "canonical section present from fresh template");
  assert.ok(headClaude.includes("## Project Notes"), "operator H2 heading preserved");
  assert.ok(headClaude.includes("run `make dev` before pushing"), "operator H2 body preserved");
  assert.deepEqual(resp.body.preserved["head/CLAUDE.md"], ["Project Notes"], "preserved reported under head/CLAUDE.md");

  // re1: foreign CLAUDE.md left byte-identical and reported skipped.
  const re1Claude = realReadFileSync(path.join(agents.re1.cwd, "CLAUDE.md"), "utf-8");
  assert.equal(re1Claude, FOREIGN_CLAUDE, "foreign CLAUDE.md left byte-identical");
  assert.ok(resp.body.skipped.includes("re1/CLAUDE.md (not QuadWork-seeded)"), "foreign skip reported");

  // dev: no CLAUDE.md → handled without error, reported skipped, none created.
  assert.ok(!fs.existsSync(path.join(agents.dev.cwd, "CLAUDE.md")), "no CLAUDE.md created where none existed");
  assert.ok(resp.body.skipped.includes("dev/CLAUDE.md (none)"), "missing CLAUDE.md skip reported");

  console.log("routes.reseedClaudeMd.test.js: all assertions passed");
})().catch((err) => { console.error(err); process.exit(1); });

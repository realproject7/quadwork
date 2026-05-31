// #886/#893: project-aware reviewer rate-limit tests. #893 resolves the reviewer
// token path from the selected project's reviewer worktree AGENTS.md (custom
// paths), with worktree winning over cfg, and omits a stale login for a custom
// token. Plain node:assert-style script.
//
// Stubs child_process.execFile (custom-promisify, captures GH_TOKEN) and
// fs.readFileSync (config + AGENTS.md + token files) BEFORE require.

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const DEFAULT_PATH = path.join(os.homedir(), ".quadwork", "reviewer-token");

const nowSec = Math.floor(Date.now() / 1000);
const RATE_JSON = JSON.stringify({
  core: { limit: 5000, remaining: 4000, reset: nowSec + 3600 },
  graphql: { limit: 5000, remaining: 37, reset: nowSec + 3600 },
  search: { limit: 30, remaining: 30, reset: nowSec + 60 },
});

let capturedEnvToken = null;
function handleGh(file, args, options) {
  if (file === "gh" && Array.isArray(args) && args.includes("rate_limit")) {
    if (options && options.env && options.env.GH_TOKEN) capturedEnvToken = options.env.GH_TOKEN;
    return { stdout: RATE_JSON, stderr: "" };
  }
  return null;
}
const realExecFile = cp.execFile;
function stub(file, args, opts, cb) {
  const done = typeof opts === "function" ? opts : cb;
  const options = typeof opts === "function" ? {} : opts || {};
  const r = handleGh(file, args, options);
  if (r) return done(null, r.stdout, r.stderr);
  return realExecFile.apply(this, arguments);
}
stub[util.promisify.custom] = (file, args, options) => {
  const r = handleGh(file, args, options);
  return r ? Promise.resolve(r) : Promise.reject(new Error(`unexpected execFile: ${file}`));
};
cp.execFile = stub;

// fs fixtures — mutable per scenario.
let configJson = "{}";
const files = new Map(); // absolute path → content; absent AGENTS.md/token → ENOENT
const realRead = fs.readFileSync;
fs.readFileSync = function stubRead(p, ...rest) {
  if (p === CONFIG_PATH) return configJson;
  if (typeof p === "string" && files.has(p)) return files.get(p);
  if (typeof p === "string" && (p.endsWith("AGENTS.md") || p.endsWith("reviewer-token"))) {
    const err = new Error("ENOENT (test stub)");
    err.code = "ENOENT";
    throw err;
  }
  return realRead(p, ...rest);
};

const { _resolveReviewerTokenPath, getReviewerRateLimit, reviewerRateLimitPayload } = require("./routes");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

// A project with re1/re2 worktrees at /wt/<p>-re1 etc.
const PROJECT = { id: "p", working_dir: "/wt/p", agents: { re1: { cwd: "/wt/p-re1" }, re2: { cwd: "/wt/p-re2" } } };
const RE1_AGENTS = "/wt/p-re1/AGENTS.md";
const RE2_AGENTS = "/wt/p-re2/AGENTS.md";
const ghTokenLine = (p) => `export GH_TOKEN=$(cat ${p})\n`;

function reset() {
  files.clear();
  capturedEnvToken = null;
}

(async () => {
  console.log("\n--- #893 project-aware reviewer rate-limit tests ---\n");

  // Let the module-load main poll settle (it makes no reviewer call now).
  await new Promise((r) => setTimeout(r, 100));

  // ── Resolution (pure _resolveReviewerTokenPath — no gh, no cache) ────────

  // custom worktree path (re1) wins
  reset();
  configJson = JSON.stringify({ reviewer_github_user: "interns", projects: [PROJECT] });
  files.set(RE1_AGENTS, ghTokenLine("/custom/reviewer-token"));
  let r = _resolveReviewerTokenPath("p");
  ok(r.path === "/custom/reviewer-token" && r.source === "worktree", "resolves custom worktree token path (re1) with source=worktree");

  // worktree wins over cfg.reviewer_token_path
  reset();
  configJson = JSON.stringify({ reviewer_token_path: "/cfg/reviewer-token", projects: [PROJECT] });
  files.set(RE1_AGENTS, ghTokenLine("/wtwins/reviewer-token"));
  r = _resolveReviewerTokenPath("p");
  ok(r.path === "/wtwins/reviewer-token" && r.source === "worktree", "worktree path WINS over cfg.reviewer_token_path (reseed preservation order)");

  // re2 fallback when re1 AGENTS.md has no GH_TOKEN line
  reset();
  configJson = JSON.stringify({ projects: [PROJECT] });
  files.set(RE1_AGENTS, "no token here\n");
  files.set(RE2_AGENTS, ghTokenLine("/re2/reviewer-token"));
  r = _resolveReviewerTokenPath("p");
  ok(r.path === "/re2/reviewer-token" && r.source === "worktree", "falls back to re2 worktree when re1 has no GH_TOKEN line");

  // no project → cfg.reviewer_token_path
  reset();
  configJson = JSON.stringify({ reviewer_token_path: "/cfg/reviewer-token", projects: [PROJECT] });
  r = _resolveReviewerTokenPath(null);
  ok(r.path === "/cfg/reviewer-token" && r.source === "config", "no project → cfg.reviewer_token_path (source=config)");

  // no project + no cfg → default
  reset();
  configJson = JSON.stringify({ projects: [PROJECT] });
  r = _resolveReviewerTokenPath(null);
  ok(r.path === DEFAULT_PATH && r.source === "default", "no project + no cfg → default ~/.quadwork/reviewer-token");

  // unknown project → cfg/default fallback (validated, not arbitrary project)
  reset();
  configJson = JSON.stringify({ reviewer_token_path: "/cfg/reviewer-token", projects: [PROJECT] });
  files.set(RE1_AGENTS, ghTokenLine("/should-not-be-used/reviewer-token"));
  r = _resolveReviewerTokenPath("ghost");
  ok(r.path === "/cfg/reviewer-token" && r.source === "config", "unknown project → cfg/default fallback (does not sample project 'p')");

  // ── Poll + payload + login (getReviewerRateLimit + reviewerRateLimitPayload) ─

  // custom worktree token → polled with that token; login OMITTED (stale-login guard)
  reset();
  configJson = JSON.stringify({ reviewer_github_user: "interns", projects: [PROJECT] });
  files.set(RE1_AGENTS, ghTokenLine("/customA/reviewer-token"));
  files.set("/customA/reviewer-token", "ghp_customA\n");
  let payload = reviewerRateLimitPayload(await getReviewerRateLimit("p"));
  ok(capturedEnvToken === "ghp_customA", "polls the CUSTOM worktree token via GH_TOKEN");
  ok(payload && payload.graphql && payload.graphql.remaining === 37, "custom-path reviewer payload surfaced (graphql bucket)");
  ok(payload && !("login" in payload), "custom worktree token → login OMITTED (no stale cfg.reviewer_github_user)");

  // default path → login = cfg.reviewer_github_user
  reset();
  configJson = JSON.stringify({ reviewer_github_user: "mainacct", projects: [] });
  files.set(DEFAULT_PATH, "ghp_default\n");
  payload = reviewerRateLimitPayload(await getReviewerRateLimit(null));
  ok(payload && payload.login === "mainacct", "default/config source → login = cfg.reviewer_github_user");
  ok(payload && payload.core && payload.core.remaining === 4000, "default-path reviewer payload surfaced (core bucket)");

  // no token (custom path, token file absent) → payload null
  reset();
  capturedEnvToken = null;
  configJson = JSON.stringify({ projects: [PROJECT] });
  files.set(RE1_AGENTS, ghTokenLine("/notoken/reviewer-token")); // token file NOT added → ENOENT
  payload = reviewerRateLimitPayload(await getReviewerRateLimit("p"));
  ok(payload === null, "no reviewer token at resolved path → payload null (omitted)");
  ok(capturedEnvToken === null, "no token → NO reviewer gh poll fired");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

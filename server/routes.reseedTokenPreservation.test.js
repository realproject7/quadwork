// #854 endpoint-level test: the re-seed endpoint must preserve each
// reviewer's existing token path. Sets up temp worktrees whose re1/re2
// AGENTS.md contain a custom `GH_TOKEN=$(cat /custom/...)` line, POSTs to
// /api/projects/:project/reseed-agents (force:true so the batch gate is
// bypassed), and asserts the rewritten files still reference `/custom/...`
// while the discovery sections were refreshed from the current seed.
//
// Plain node:assert script — auto-discovered by the #836 runner. Run
// directly with `node server/routes.reseedTokenPreservation.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "qw-854-home-"));
const originalHomedir = os.homedir;
os.homedir = () => TEST_HOME;
process.on("exit", () => {
  os.homedir = originalHomedir;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const CONFIG_DIR = path.dirname(CONFIG_PATH);
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

// ── Stub fs.readFileSync for CONFIG_PATH BEFORE requiring routes ──────────
// routes.js reads CONFIG_PATH on every per-project call. We want our
// fixture project loaded, not the real ~/.quadwork/config.json, so the
// test is hermetic on developer machines and CI alike. Everything else
// (temp AGENTS.md, seed templates) goes through the real fs.
const realReadFileSync = fs.readFileSync;
let stubCfgJson = JSON.stringify({ projects: [] });
fs.readFileSync = function stubReadFileSync(p, ...rest) {
  if (p === CONFIG_PATH) return stubCfgJson;
  return realReadFileSync(p, ...rest);
};

const express = require("express");
const routes = require("./routes");

// Tiny in-process http server with the real router mounted.
async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use(routes.router || routes); // routes.js exports default = router
  await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}`);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body || {});
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: "POST",
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

function makeTempProject(label, agentsLayout) {
  // agentsLayout: { agentKey: { cwdName, existingAgentsMd } } — `existingAgentsMd`
  // omitted means no pre-existing file (simulates a brand-new worktree).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qw-854-${label}-`));
  const workingDir = path.join(root, "proj");
  fs.mkdirSync(workingDir, { recursive: true });
  const agents = {};
  for (const [agentKey, { cwdName, existingAgentsMd }] of Object.entries(agentsLayout)) {
    const cwd = path.join(root, cwdName);
    fs.mkdirSync(cwd, { recursive: true });
    if (existingAgentsMd != null) {
      fs.writeFileSync(path.join(cwd, "AGENTS.md"), existingAgentsMd);
    }
    agents[agentKey] = { cwd };
  }
  return { root, workingDir, agents };
}

(async () => {
  // Sanity: real seed templates exist on disk. The test fails loudly here
  // rather than silently asserting against a missing-file surprise.
  for (const slug of ["head", "re1", "re2", "dev"]) {
    const p = path.join(TEMPLATES_DIR, "seeds", `${slug}.AGENTS.md`);
    assert.ok(fs.existsSync(p), `seed template missing: ${p}`);
  }
  const re1Seed = realReadFileSync(path.join(TEMPLATES_DIR, "seeds", "re1.AGENTS.md"), "utf-8");
  const re2Seed = realReadFileSync(path.join(TEMPLATES_DIR, "seeds", "re2.AGENTS.md"), "utf-8");
  const playbookSeed = realReadFileSync(path.join(TEMPLATES_DIR, "seeds", "HEAD-PO-PLAYBOOK.md"), "utf-8");
  const playbookVersion = playbookSeed.match(/^\*\*Playbook version:\*\*\s+(\d+\.\d+\.\d+)$/m);
  assert.ok(playbookVersion, "canonical playbook seed carries a semantic version");
  // The seeds must contain the {{reviewer_token_path}} placeholder for the
  // preservation contract to be meaningful. Asserted up front so a future
  // template refactor that drops the placeholder fails this test loudly.
  assert.ok(re1Seed.includes("{{reviewer_token_path}}"), "re1 seed lost the token path placeholder");
  assert.ok(re2Seed.includes("{{reviewer_token_path}}"), "re2 seed lost the token path placeholder");

  // ── Test 1: custom token path is preserved when no body override is given.
  //    Seed existing re1/re2 with a `/custom/...` path; head/dev with no
  //    GH_TOKEN line. After re-seed, the re1/re2 files still reference
  //    `/custom/...` AND now reference GITHUB.md (proving the discovery
  //    section was refreshed from the current template).
  {
    const projId = `pTest1-${crypto.randomBytes(4).toString("hex")}`;
    const CUSTOM_RE1 = "/Users/op/.local/re1-custom-token";
    const CUSTOM_RE2 = "/Users/op/.local/re2-custom-token";
    const { workingDir, agents } = makeTempProject("custom", {
      head: { cwdName: "proj-head", existingAgentsMd: "# Head\n\nStale head body.\n" },
      dev:  { cwdName: "proj-dev",  existingAgentsMd: "# Dev\n\nStale dev body.\n" },
      re1:  { cwdName: "proj-re1",  existingAgentsMd: `# Reviewer 1\n\n## GitHub Authentication\nexport GH_TOKEN=$(cat ${CUSTOM_RE1})\n` },
      re2:  { cwdName: "proj-re2",  existingAgentsMd: `# Reviewer 2\n\n## GitHub Authentication\nexport GH_TOKEN=$(cat ${CUSTOM_RE2})\n` },
    });

    stubCfgJson = JSON.stringify({
      projects: [{ id: projId, name: "Test1", repo: "ex/test1", working_dir: workingDir, agents }],
    });
    const playbookPath = path.join(CONFIG_DIR, projId, "HEAD-PO-PLAYBOOK.md");
    fs.mkdirSync(path.dirname(playbookPath), { recursive: true });
    fs.writeFileSync(playbookPath, [
      "# Stale playbook",
      "",
      "## 1. Operating model",
      "stale canonical body",
      "",
      "## Operator Notes",
      "preserve this note",
      "",
    ].join("\n"));

    await withServer(async (base) => {
      const { status, body } = await post(`${base}/api/projects/${projId}/reseed-agents`, { force: true });
      assert.equal(status, 200, `expected 200, got ${status} ${JSON.stringify(body)}`);
      assert.equal(body.ok, true);
      assert.equal(body.reseeded.length, 5, "all 4 agents and the Head playbook re-seeded");
      assert.deepEqual(body.preserved["HEAD-PO-PLAYBOOK.md"], ["Operator Notes"]);
    });

    const re1After = realReadFileSync(path.join(agents.re1.cwd, "AGENTS.md"), "utf-8");
    const re2After = realReadFileSync(path.join(agents.re2.cwd, "AGENTS.md"), "utf-8");

    // The exact #854 acceptance criterion: custom path preserved verbatim.
    assert.ok(re1After.includes(`$(cat ${CUSTOM_RE1})`),
      `re1 lost custom token path. Got:\n${re1After}`);
    assert.ok(re2After.includes(`$(cat ${CUSTOM_RE2})`),
      `re2 lost custom token path. Got:\n${re2After}`);

    // The default token path must NOT appear (preservation, not append).
    const defaultPath = path.join(os.homedir(), ".quadwork", "reviewer-token");
    assert.ok(!re1After.includes(`$(cat ${defaultPath})`),
      "re1 also has default path — substitution leaked the fallback");
    assert.ok(!re2After.includes(`$(cat ${defaultPath})`),
      "re2 also has default path — substitution leaked the fallback");

    // Discovery section refreshed: current re1/re2 seeds point at GITHUB.md.
    assert.ok(re1After.includes("GITHUB.md"), "re1 missing GITHUB.md after re-seed");
    assert.ok(re2After.includes("GITHUB.md"), "re2 missing GITHUB.md after re-seed");

    // Head/dev have no GH_TOKEN line in their seeds — verify the resolver
    // didn't accidentally inject one when falling through to the default.
    const headAfter = realReadFileSync(path.join(agents.head.cwd, "AGENTS.md"), "utf-8");
    const devAfter  = realReadFileSync(path.join(agents.dev.cwd, "AGENTS.md"), "utf-8");
    assert.ok(!headAfter.includes("GH_TOKEN=$(cat"), "head seed should have no GH_TOKEN line");
    assert.ok(!devAfter.includes("GH_TOKEN=$(cat"),  "dev seed should have no GH_TOKEN line");
    const playbookAfter = realReadFileSync(playbookPath, "utf-8");
    assert.ok(playbookAfter.includes(playbookVersion[0]),
      `manual reseed refreshes the canonical playbook version (${playbookVersion[1]})`);
    assert.ok(!playbookAfter.includes("stale canonical body"));
    assert.ok(playbookAfter.includes("preserve this note"),
      "manual reseed preserves operator-added playbook sections");
  }

  // ── Test 2: default-path projects are unaffected. When the existing re1/re2
  //    AGENTS.md uses the canonical default token path, re-seed produces the
  //    same default path back — confirming the resolver doesn't perturb
  //    projects that never had a custom path.
  {
    const projId = `pTest2-${crypto.randomBytes(4).toString("hex")}`;
    const defaultPath = path.join(os.homedir(), ".quadwork", "reviewer-token");
    const { workingDir, agents } = makeTempProject("default", {
      head: { cwdName: "proj-head", existingAgentsMd: null },
      dev:  { cwdName: "proj-dev",  existingAgentsMd: null },
      re1:  { cwdName: "proj-re1",  existingAgentsMd: `# Reviewer 1\nexport GH_TOKEN=$(cat ${defaultPath})\n` },
      re2:  { cwdName: "proj-re2",  existingAgentsMd: `# Reviewer 2\nexport GH_TOKEN=$(cat ${defaultPath})\n` },
    });

    stubCfgJson = JSON.stringify({
      projects: [{ id: projId, name: "Test2", repo: "ex/test2", working_dir: workingDir, agents }],
    });

    await withServer(async (base) => {
      const { status, body } = await post(`${base}/api/projects/${projId}/reseed-agents`, { force: true });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    const re1After = realReadFileSync(path.join(agents.re1.cwd, "AGENTS.md"), "utf-8");
    assert.ok(re1After.includes(`$(cat ${defaultPath})`), "default-path re1 round-trips through re-seed");
  }

  // ── Test 3: cfg.reviewer_token_path is used when no AGENTS.md exists yet
  //    and no body override is given. (Legitimate "operator just created the
  //    worktree but no AGENTS.md yet" path.)
  {
    const projId = `pTest3-${crypto.randomBytes(4).toString("hex")}`;
    const CFG_DEFAULT = "/etc/quadwork/global-token";
    const { workingDir, agents } = makeTempProject("cfg", {
      re1: { cwdName: "proj-re1", existingAgentsMd: null }, // brand-new worktree
      re2: { cwdName: "proj-re2", existingAgentsMd: null },
    });

    stubCfgJson = JSON.stringify({
      reviewer_token_path: CFG_DEFAULT,
      projects: [{ id: projId, name: "Test3", repo: "ex/test3", working_dir: workingDir, agents }],
    });

    await withServer(async (base) => {
      const { status, body } = await post(`${base}/api/projects/${projId}/reseed-agents`, { force: true });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    const re1After = realReadFileSync(path.join(agents.re1.cwd, "AGENTS.md"), "utf-8");
    const re2After = realReadFileSync(path.join(agents.re2.cwd, "AGENTS.md"), "utf-8");
    assert.ok(re1After.includes(`$(cat ${CFG_DEFAULT})`), "cfg.reviewer_token_path used for new re1");
    assert.ok(re2After.includes(`$(cat ${CFG_DEFAULT})`), "cfg.reviewer_token_path used for new re2");
  }

  // ── Test 4: explicit body.reviewerTokenPath wins over the existing AGENTS.md
  //    extraction (operator-side opt-in via the API; this is the override path).
  {
    const projId = `pTest4-${crypto.randomBytes(4).toString("hex")}`;
    const EXISTING = "/old/extracted/path";
    const OVERRIDE = "/new/override/path";
    const { workingDir, agents } = makeTempProject("override", {
      re1: { cwdName: "proj-re1", existingAgentsMd: `# Reviewer 1\nexport GH_TOKEN=$(cat ${EXISTING})\n` },
      re2: { cwdName: "proj-re2", existingAgentsMd: `# Reviewer 2\nexport GH_TOKEN=$(cat ${EXISTING})\n` },
    });

    stubCfgJson = JSON.stringify({
      projects: [{ id: projId, name: "Test4", repo: "ex/test4", working_dir: workingDir, agents }],
    });

    await withServer(async (base) => {
      const { status, body } = await post(`${base}/api/projects/${projId}/reseed-agents`, {
        force: true,
        reviewerTokenPath: OVERRIDE,
      });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    });

    const re1After = realReadFileSync(path.join(agents.re1.cwd, "AGENTS.md"), "utf-8");
    assert.ok(re1After.includes(`$(cat ${OVERRIDE})`), "body override beats existing extraction");
    assert.ok(!re1After.includes(`$(cat ${EXISTING})`), "old extracted path replaced by override");
  }

  console.log("routes.reseedTokenPreservation.test.js: all assertions passed (4 endpoint scenarios)");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// #1030: the file writer must commit one complete multi-repository GITHUB.md
// from all last-good snapshots. Repository refresh completion order or one
// failed sibling must never erase another group or the operator Notes block.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-github-md-multi-"));
const originalHomedir = os.homedir;
os.homedir = () => tmp;

const configDir = path.join(tmp, ".quadwork");
const projectDir = path.join(configDir, "multi");
const githubPath = path.join(projectDir, "GITHUB.md");
fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
  installation_id: "00000000-0000-4000-8000-000000000001",
  projects: [{
    id: "multi",
    name: "Multi",
    repositories: [
      { key: "app", repo: "Acme/App", working_dir: "/tmp/app", primary: true },
      { key: "api", repo: "Acme/API", working_dir: "/tmp/api", primary: false },
    ],
  }],
}));
fs.writeFileSync(githubPath, [
  "# Legacy GitHub State",
  "",
  "## Notes",
  "",
  "Operator note with its own heading:",
  "## Decision",
  "keep both repositories",
  "",
].join("\n"));

const routes = require("./routes");

const appSnapshot = {
  issues: [{ number: 42, title: "app issue", state: "OPEN", url: "https://github.com/Acme/App/issues/42", assignees: [] }],
  prs: [], closedIssues: [], mergedPrs: [],
};
const apiSnapshot = {
  issues: [{ number: 42, title: "api issue", state: "OPEN", url: "https://github.com/Acme/API/issues/42", assignees: [] }],
  prs: [{
    number: 7, title: "api pr", state: "OPEN", url: "https://github.com/Acme/API/pull/7", assignees: [],
    reviews: [{ state: "APPROVED", submittedAt: "2026-08-31T00:00:00.000Z", body: "RE2: approved" }],
  }],
  closedIssues: [], mergedPrs: [],
};

try {
  routes._graphqlCache.set("acme/app", { ts: Date.now(), ...appSnapshot });
  routes._graphqlCache.set("acme/api", { ts: Date.now(), ...apiSnapshot });

  // App then API completion: both writes are whole-document atomic commits.
  routes.writeGithubFileFromSnapshot("multi", "Multi", "acme/app", appSnapshot, "ok");
  routes.writeGithubFileFromSnapshot("multi", "Multi", "acme/api", apiSnapshot, "ok");
  let parsed = routes.parseGithub(fs.readFileSync(githubPath, "utf-8"));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.repositories.map((repository) => repository.repo_key), ["app", "api"]);
  assert.deepEqual(parsed.openIssues.map((row) => `${row.repo_key}#${row.number}`), ["app#42", "api#42"]);
  assert.equal(parsed.reviewDetail["api#7"].re2.state, "APPROVED");
  assert.match(parsed.notes, /## Decision\nkeep both repositories/);
  assert.equal(fs.existsSync(path.join(projectDir, `.GITHUB.md.tmp-${process.pid}`)), false, "atomic temp is renamed away");

  // A failed app refresh keeps both last-good groups and marks only app stale.
  routes.writeGithubFileFromSnapshot("multi", "Multi", "acme/app", routes._graphqlCache.get("acme/app"), "error");
  parsed = routes.parseGithub(fs.readFileSync(githubPath, "utf-8"));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.repositories.find((repository) => repository.repo_key === "app").stale, true);
  assert.equal(parsed.repositories.find((repository) => repository.repo_key === "api").stale, false);
  assert.deepEqual(parsed.openIssues.map((row) => `${row.repo_key}#${row.number}`), ["app#42", "api#42"]);
  assert.match(parsed.notes, /keep both repositories/);

  // Simulate a server restart: memory is cold but the previous strict file is
  // present. The first app refresh must carry forward the API group, metadata,
  // same-number row, and persisted review attribution.
  routes._graphqlCache.clear();
  routes._githubMeta.clear();
  const restartedApp = {
    ...appSnapshot,
    issues: [{ ...appSnapshot.issues[0], title: "app issue after restart" }],
  };
  routes._graphqlCache.set("acme/app", { ts: Date.now(), ...restartedApp });
  routes.writeGithubFileFromSnapshot("multi", "Multi", "acme/app", restartedApp, "ok");
  parsed = routes.parseGithub(fs.readFileSync(githubPath, "utf-8"));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.openIssues.find((row) => row.repo_key === "app").title, "app issue after restart");
  assert.equal(parsed.openIssues.find((row) => row.repo_key === "api").title, "api issue");
  assert.equal(parsed.reviewDetail["api#7"].re2.state, "APPROVED");
  assert.notEqual(parsed.repositories.find((repository) => repository.repo_key === "api").generatedAt, null);
  assert.match(parsed.notes, /keep both repositories/);

  routes.writeGithubFileFromSnapshot("multi", "Multi", "acme/api", null, "error");
  parsed = routes.parseGithub(fs.readFileSync(githubPath, "utf-8"));
  assert.equal(parsed.openIssues.find((row) => row.repo_key === "api").title, "api issue");
  assert.equal(parsed.reviewDetail["api#7"].re2.state, "APPROVED");
  assert.equal(parsed.repositories.find((repository) => repository.repo_key === "api").stale, true);
  assert.match(parsed.notes, /keep both repositories/);

  console.log("routes.githubMarkdownMultiRepository.test.js: all assertions passed");
} finally {
  os.homedir = originalHomedir;
  fs.rmSync(tmp, { recursive: true, force: true });
}

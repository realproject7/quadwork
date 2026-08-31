// #1030: multi-repository GitHub state keeps shared raw caches canonical and
// decorates rows only at a project binding boundary. Plain node:assert test.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-multi-github-"));
const originalHomedir = os.homedir;
os.homedir = () => tmp;
const configDir = path.join(tmp, ".quadwork");
const configPath = path.join(configDir, "config.json");
fs.mkdirSync(configDir, { recursive: true });

const project = {
  id: "multi",
  name: "Multi",
  archived: false,
  idle: false,
  repositories: [
    { key: "app", repo: "Acme/App", working_dir: "/tmp/app", primary: true },
    { key: "api", repo: "Acme/API", working_dir: "/tmp/api", primary: false },
  ],
};

function writeProject(overrides = {}) {
  fs.writeFileSync(configPath, JSON.stringify({
    installation_id: "00000000-0000-4000-8000-000000000001",
    projects: [{ ...project, ...overrides }],
  }));
}
writeProject();

const express = require("express");
const routes = require("./routes");
const { captureProjectAdmission } = require("./project-lifecycle");

function mockRes() {
  const res = { headers: {}, statusCode: 200, body: undefined };
  res.set = (key, value) => { res.headers[key.toLowerCase()] = value; return res; };
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: pathname }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        json: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    }).on("error", reject);
  });
}

(async () => {
  try {
    const bindings = routes.projectRepositoryBindings(project);
    assert.deepEqual(bindings.map((binding) => binding.cache_repo), ["acme/app", "acme/api"]);
    assert.deepEqual(bindings.map((binding) => binding.key), ["app", "api"]);

    const now = Date.now();
    const appRow = { number: 42, title: "app issue", state: "OPEN", url: "app-url" };
    const apiRow = { number: 42, title: "api issue", state: "OPEN", url: "api-url" };
    routes._graphqlCache.set("acme/app", { ts: now, issues: [appRow], prs: [], closedIssues: [], mergedPrs: [] });
    routes._graphqlCache.set("acme/api", { ts: now, issues: [apiRow], prs: [], closedIssues: [], mergedPrs: [] });
    routes._githubRepoStatus.set("acme/app", { status: "ok", checkedAt: now, lastGoodAt: now });
    routes._githubRepoStatus.set("acme/api", { status: "ok", checkedAt: now, lastGoodAt: now });

    const aggregate = routes.aggregateProjectGithubState(project);
    assert.deepEqual(aggregate.issues.map((row) => [row.repo_key, row.repo, row.number]), [
      ["app", "Acme/App", 42],
      ["api", "Acme/API", 42],
    ], "same issue number remains distinct by project repository binding");
    assert.equal("repo_key" in appRow, false, "shared raw cache is not contaminated with project-local repo_key");
    assert.equal("repo" in apiRow, false, "shared raw cache is not contaminated with display repo");

    routes._ghEndpointCache.set("issues:acme/app", { ts: now, data: [appRow], stale: false });
    routes._ghEndpointCache.set("issues:acme/api", { ts: now, data: [apiRow], stale: false });
    const listRes = mockRes();
    await routes.serveGithubList({ query: { project: "multi" } }, listRes, "issues");
    assert.equal(listRes.statusCode, 200);
    assert.ok(Array.isArray(listRes.body), "compatibility endpoint remains a bare array");
    assert.deepEqual(listRes.body.map((row) => `${row.repo_key}#${row.number}`), ["app#42", "api#42"]);

    const app = express();
    app.use(routes);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const all = await request(server, "/api/github/all?project=multi");
      assert.equal(all.status, 200);
      assert.deepEqual(all.json.multi.issues.map((row) => `${row.repo_key}#${row.number}`), ["app#42", "api#42"]);
      assert.deepEqual(all.json.multi.repositories.map((repo) => repo.key), ["app", "api"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // Failed refresh keeps the prior whole snapshot and reports only this repo
    // stale; the sibling remains independently fresh.
    const priorAppSnapshot = routes._graphqlCache.get("acme/app");
    const admission = captureProjectAdmission("multi");
    await routes.refreshRepoRest("ACME/APP", [admission], async () => ({
      status: "error",
      data: { issues: [], prs: [], closedIssues: [], mergedPrs: [] },
    }));
    assert.equal(routes._graphqlCache.get("acme/app"), priorAppSnapshot, "partial error preserves the whole last-good snapshot");
    const afterFailure = routes.aggregateProjectGithubState(project);
    assert.equal(afterFailure.repositories.find((repo) => repo.key === "app").stale, true);
    assert.equal(afterFailure.repositories.find((repo) => repo.key === "api").stale, false);
    assert.equal(afterFailure.issues.find((row) => row.repo_key === "app").title, "app issue");

    // Fixed freshness is not relaxed to Infinity under critical rate limit.
    routes._rateLimit.remaining = 0;
    routes._graphqlCache.set("acme/api", { ...routes._graphqlCache.get("acme/api"), ts: now - 10 * 60_000 });
    assert.equal(routes.repositoryState(bindings[1], now).stale, true);
    routes._rateLimit.remaining = 5000;

    // Idle/archive paths serve last-known data but create neither demand nor a
    // refresh owner, including when one repository has no cache.
    routes._ghEndpointCache.delete("prs:acme/app");
    routes._ghEndpointCache.delete("prs:acme/api");
    for (const state of [{ idle: true, archived: false }, { idle: false, archived: true }]) {
      writeProject(state);
      routes._githubDemandedProjects.delete("multi");
      const beforeRefreshes = routes._restRefreshing.size;
      const res = mockRes();
      await routes.serveGithubList({ query: { project: "multi" } }, res, "prs");
      assert.deepEqual(res.body, []);
      assert.equal(routes._restRefreshing.size, beforeRefreshes, "inactive project starts zero GitHub refreshes");
      assert.equal(routes._githubDemandedProjects.has("multi"), false, "inactive project creates zero demand");
    }

    console.log("routes.multiRepositoryGithub.test.js: all assertions passed");
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

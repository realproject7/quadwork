// #1030: /api/projects aggregates every normalized repository while archived
// and idle projects initiate zero GitHub calls. Plain node:assert integration.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-projects-multi-"));
const originalHomedir = os.homedir;
const originalExecFile = childProcess.execFile;
os.homedir = () => tmp;
fs.mkdirSync(path.join(tmp, ".quadwork"), { recursive: true });

function repositories(prefix) {
  return [
    { key: "app", repo: `${prefix}/App`, working_dir: `/tmp/${prefix}-app`, primary: true },
    { key: "api", repo: `${prefix}/API`, working_dir: `/tmp/${prefix}-api`, primary: false },
  ];
}

fs.writeFileSync(path.join(tmp, ".quadwork", "config.json"), JSON.stringify({
  installation_id: "00000000-0000-4000-8000-000000000001",
  projects: [
    { id: "active", name: "Active", repositories: repositories("Acme"), agents: {} },
    { id: "active-two", name: "Active Two", repositories: repositories("Beta"), agents: {} },
    { id: "idle", name: "Idle", idle: true, repositories: repositories("IdleCo"), agents: {} },
    { id: "archived", name: "Archived", archived: true, repositories: repositories("OldCo"), agents: {} },
  ],
}));

const ghCalls = [];
let activeProjectCalls = 0;
let maxActiveProjectCalls = 0;
function fakeExecFile() {}
fakeExecFile[util.promisify.custom] = async (_command, args) => {
  ghCalls.push(args.slice());
  const endpoint = args[1] || "";
  if (endpoint === "graphql") {
    const emptyRepo = {
      openIssues: { nodes: [] }, closedIssues: { nodes: [] },
      openPRs: { nodes: [] }, mergedPRs: { nodes: [] },
    };
    return { stdout: JSON.stringify({ data: {
      repo_0: emptyRepo, repo_1: emptyRepo, repo_2: emptyRepo, repo_3: emptyRepo,
    } }), stderr: "" };
  }
  activeProjectCalls += 1;
  maxActiveProjectCalls = Math.max(maxActiveProjectCalls, activeProjectCalls);
  try {
    // Make overlap observable: the route must still hold the process-wide pass
    // to its existing GH_MAX_CONCURRENT=2 bound across every project/repo.
    await new Promise((resolve) => setTimeout(resolve, 5));
    let data = [];
    if (endpoint.includes("repos/acme/app/pulls?state=open")) data = [{ number: 1 }, { number: 2 }];
    else if (endpoint.includes("repos/acme/api/pulls?state=open")) data = [{ number: 3 }];
    else if (endpoint.includes("repos/acme/app/pulls?state=all")) data = [{ updated_at: "2026-08-01T00:00:00Z" }];
    else if (endpoint.includes("repos/acme/api/pulls?state=all")) data = [{ updated_at: "2026-08-02T00:00:00Z" }];
    else if (endpoint.includes("repos/beta/app/pulls?state=open")) data = [{ number: 4 }];
    else if (endpoint.includes("repos/beta/api/pulls?state=open")) data = [];
    else if (endpoint.includes("repos/beta/app/pulls?state=all")) data = [{ updated_at: "2026-08-03T00:00:00Z" }];
    else if (endpoint.includes("repos/beta/api/pulls?state=all")) data = [{ updated_at: "2026-08-04T00:00:00Z" }];
    else throw new Error(`unexpected GitHub call: ${endpoint}`);
    return { stdout: `HTTP/2 200\netag: fixture-${ghCalls.length}\n\n${JSON.stringify(data)}`, stderr: "" };
  } finally {
    activeProjectCalls -= 1;
  }
};
childProcess.execFile = fakeExecFile;

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: pathname }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
    }).on("error", reject);
  });
}

(async () => {
  let server;
  try {
    const express = require("express");
    const routes = require("./routes");
    const app = express();
    app.set("activeSessions", new Map());
    app.use(routes);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));

    const response = await request(server, "/api/projects");
    assert.equal(response.status, 200);
    const active = response.json.projects.find((item) => item.id === "active");
    assert.equal(active.repo, "Acme/App", "primary response alias remains compatible");
    assert.deepEqual(active.repositories.map((repo) => repo.key), ["app", "api"]);
    assert.equal(active.openPrs, 3, "open PR count is summed across repositories");
    assert.equal(active.lastActivity, "2026-08-02T00:00:00Z", "latest activity is the max across repositories");
    const activeTwo = response.json.projects.find((item) => item.id === "active-two");
    assert.equal(activeTwo.openPrs, 1);
    assert.equal(activeTwo.lastActivity, "2026-08-04T00:00:00Z");

    const idle = response.json.projects.find((item) => item.id === "idle");
    const archived = response.json.projects.find((item) => item.id === "archived");
    assert.equal(idle.repositories.length, 2);
    assert.equal(idle._idle, true);
    assert.equal(archived.repositories.length, 2);
    assert.equal(archived._archived, true);
    const projectCalls = ghCalls.filter((args) => (args[1] || "").startsWith("repos/"));
    assert.equal(projectCalls.length, 8, "only two metrics for each active repository are fetched");
    assert.ok(maxActiveProjectCalls <= 2, `GitHub metric concurrency stays globally bounded (observed ${maxActiveProjectCalls})`);
    assert.ok(projectCalls.every((args) => /^repos\/(?:acme|beta)\//.test(args[1] || "")), "idle/archive repositories make zero GitHub calls");

    const fallback = await routes.fetchAllProjectsGraphQL();
    assert.deepEqual([...fallback.keys()], ["acme/app", "acme/api", "beta/app", "beta/api"], "GraphQL fallback includes every canonical repository");
    const gqlCall = ghCalls.find((args) => args[1] === "graphql");
    const queryArg = gqlCall.find((arg) => arg.startsWith("query="));
    assert.match(queryArg, /repo_0: repository/);
    assert.match(queryArg, /repo_1: repository/);
    assert.match(queryArg, /repo_3: repository/);
    console.log("routes.projectsMultiRepository.test.js: all assertions passed");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    childProcess.execFile = originalExecFile;
    os.homedir = originalHomedir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

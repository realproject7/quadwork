// #1034 live boundary proof: run the real server against an isolated HOME and
// random loopback port. No operator config, process, repository, or network
// service is touched.

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-lifecycle-live-"));
const CONFIG_DIR = path.join(TEST_HOME, ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const REPO_DIR = path.join(TEST_HOME, "repo");
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(REPO_DIR, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: urlPath,
      headers: payload ? {
        "content-type": "application/json",
        "content-length": payload.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer(port, child, output) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check (${child.exitCode}): ${output()}`);
    }
    try {
      const response = await request(port, "GET", "/api/health");
      if (response.status === 200 && response.json?.status === "ok") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server health timeout: ${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

(async () => {
  const port = await freePort();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    installation_id: "installation_live_123456789",
    port,
    session_token: "live-test-session-token",
    file_chat_switchover_done: true,
    projects: [{
      id: "live",
      name: "Live lifecycle proof",
      archived: true,
      idle: true,
      chat_mode: "file",
      repositories: [{
        key: "primary",
        repo: "Acme/LiveProof",
        working_dir: REPO_DIR,
        primary: true,
      }],
      agents: {},
    }],
  }, null, 2));

  let logs = "";
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    env: { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-20_000); });
  child.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-20_000); });

  try {
    await waitForServer(port, child, () => logs);

    const restored = await request(port, "PUT", "/api/projects/live/archive", { archived: false });
    assert.equal(restored.status, 200, restored.text || logs);
    assert.equal(restored.json?.ok, true);
    assert.equal(restored.json?.archived, false);
    assert.deepEqual(restored.json?.cleanup_errors, []);

    const agents = await request(port, "GET", "/api/agents");
    assert.equal(agents.status, 200);
    assert.equal(Object.keys(agents.json || {}).length, 0, "unarchive never auto-starts an agent session");
    assert.equal(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).projects[0].archived, false);

    const archived = await request(port, "PUT", "/api/projects/live/archive", { archived: true });
    assert.equal(archived.status, 200, archived.text || logs);
    assert.equal(archived.json?.ok, true);
    assert.equal(archived.json?.archived, true);
    assert.deepEqual(archived.json?.cleanup_errors, []);
    assert.equal(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).projects[0].archived, true,
      "real process commits the durable archive barrier");
    assert.equal(fs.existsSync(path.join(CONFIG_DIR, "config.lock")), false,
      "successful lifecycle leaves no config transaction lock");

    console.log("project lifecycle live isolated process: PASS");
  } finally {
    await stopChild(child);
    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

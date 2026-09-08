"use strict";

// Exercise the real control event handlers without a browser/provider process.
// The integration owner separately checks real PTY lifecycle in the browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");

function fixture(initial = "stopped") {
  const cells = [];
  let cursor = 0;
  const hooks = {
    useState(initialValue) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initialValue;
      return [cells[index], (value) => { cells[index] = value; }];
    },
    useRef(initialValue) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initialValue };
      return cells[index];
    },
    useEffect() {},
  };
  const requests = [], states = [];
  let headersCalls = 0, response = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: "spawned" }) });
  const mod = { exports: {} };
  const file = path.join(__dirname, "../src/components/AgentLifecycleControls.tsx");
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function("require", "module", "exports", "fetch", js)((name) => {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return require(name);
    if (name === "@/lib/sessionToken") return { sessionTokenHeaders: async () => { headersCalls++; return { "X-Session-Token": "fixture-token" }; } };
    throw new Error(`Unexpected dependency ${name}`);
  }, mod, mod.exports, async (url, options) => { requests.push({ url, options }); return response(); });
  const props = { projectId: "project /?#", agentId: "head /?#", status: initial, onStatusChange(state) { states.push(state); props.status = state; } };
  function render() {
    cursor = 0;
    return React.Children.toArray(mod.exports.default(props).props.children);
  }
  return { requests, states, props, render, headersCalls: () => headersCalls,
    respond: (fn) => { response = fn; },
    button: (action) => render().find((node) => node.type === "button" && node.props.title === action),
    message: () => render().find((node) => node.type === "span"),
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("manual lifecycle routes use encoded segments and auth; duplicate clicks issue one request", async () => {
  const f = fixture();
  let release;
  f.respond(() => new Promise((resolve) => { release = resolve; }));
  const start = f.button("Start");
  start.props.onClick();
  start.props.onClick();
  f.button("Restart").props.onClick();
  await flush();
  assert.equal(f.headersCalls(), 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/agents/project%20%2F%3F%23/head%20%2F%3F%23/start");
  assert.deepEqual(f.requests[0].options, { method: "POST", headers: { "X-Session-Token": "fixture-token" } });
  assert.equal(f.button("Start").props.disabled, true);
  assert.equal(f.button("Restart").props.disabled, true);
  assert.match(f.message().props.children, /Start pending/);
  release({ ok: true, status: 200, json: async () => ({ ok: true, state: "spawned" }) });
  await flush();
  assert.deepEqual(f.states, ["spawned"]);
  assert.match(f.message().props.children, /unconfirmed/);
  assert.equal(f.button("Stop").props.disabled, false);
  assert.equal(f.button("Start"), undefined);

  f.respond(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: "stopped" }) }));
  f.button("Stop").props.onClick(); await flush();
  assert.match(f.requests[1].url, /\/stop$/);
  assert.deepEqual(f.states, ["spawned", "stopped"]);
  f.respond(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: "verified" }) }));
  f.button("Restart").props.onClick(); await flush();
  assert.match(f.requests[2].url, /\/restart$/);
  assert.equal(f.message().props.children, "Verified");
  assert.ok(f.button("Stop"));
});

test("refused cleanup cannot claim stopped; bounded failure stays visible and no request retries", async () => {
  const f = fixture("verified");
  f.respond(async () => ({ ok: false, status: 409, json: async () => ({ ok: false, state: "stopped", error: "Agent cleanup incomplete\n" + "x".repeat(400) }) }));
  f.button("Stop").props.onClick(); await flush();
  assert.deepEqual(f.states, []);
  assert.equal(f.props.status, "verified");
  assert.equal(f.message().props.role, "alert");
  assert.match(f.message().props.children, /^Stop failed: Agent cleanup incomplete /);
  assert.ok(f.message().props.children.length < 200);
  assert.equal(f.message().props.children.includes("\n"), false);
  assert.equal(f.button("Stop").props.disabled, false);
  await flush();
  assert.equal(f.requests.length, 1);
});

test("authentication, malformed responses and network failures never manufacture a lifecycle state", async () => {
  const f = fixture();
  for (const response of [
    async () => ({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) }),
    async () => ({ ok: true, status: 200, json: async () => ({ ok: false, state: "running", code: "project_admission_changed" }) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new Error("Invalid JSON"); } }),
    async () => { throw new Error("Network failed"); },
  ]) {
    f.respond(response);
    f.button("Start").props.onClick(); await flush();
    assert.equal(f.message().props.role, "alert");
    assert.equal(f.button("Start").props.disabled, false);
    assert.deepEqual(f.states, []);
  }
  assert.equal(f.requests.length, 4);
  for (const state of [undefined, "unknown", "__proto__"]) {
    f.respond(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state }) }));
    f.button("Start").props.onClick(); await flush();
    assert.equal(f.message().props.children, "Status unconfirmed");
  }
  assert.deepEqual(f.states, ["unknown", "unknown", "unknown"]);
});

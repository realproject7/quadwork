"use strict";

// Run the real TSX component bodies/effects with controllable browser IO.
// Actual DOM/PTY proof is performed separately on the integrated browser build.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function component(name, { dependencies = {}, globals = {} } = {}) {
  const cells = [], effects = [];
  let cursor = 0, updates = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
      return [cells[index], (value) => { updates++; cells[index] = typeof value === "function" ? value(cells[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return cells[index] ||= { current: initial }; },
    useMemo(fn, deps) {
      const index = cursor++;
      if (!sameDeps(cells[index]?.deps, deps)) cells[index] = { deps, value: fn() };
      return cells[index].value;
    },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!sameDeps(cells[index]?.deps, deps)) effects.push(() => {
        cells[index]?.cleanup?.();
        cells[index] = { deps, cleanup: fn() };
      });
    },
  };
  const filename = path.join(__dirname, `../src/components/${name}.tsx`);
  const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), js)((id) => {
    if (id === "react") return hooks;
    if (id === "react/jsx-runtime") return require(id);
    if (id in dependencies) return dependencies[id];
    if (id.endsWith(".css")) return {};
    if (id === "@/lib/panelVisibility") return require("../src/lib/panelVisibility");
    if (id === "@/lib/panelResize") return require("../src/lib/panelResize");
    if (id === "@/components/LocaleProvider") return { useLocale: () => ({ locale: "en" }) };
    if (id.startsWith("./")) return { __esModule: true, default: id.slice(2) };
    throw new Error(`Unexpected import ${id}`);
  }, mod, mod.exports, ...Object.values(globals));
  function walk(node, visit) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
    visit(node);
    walk(node.props?.children, visit);
  }
  return {
    render(props) {
      cursor = 0;
      const tree = mod.exports.default(props);
      walk(tree, (node) => { if (node.props?.ref && typeof node.props.ref === "object") node.props.ref.current = {}; });
      return tree;
    },
    commit() { for (const effect of effects.splice(0)) effect(); },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
    updates: () => updates,
    find(tree, type) { let found; walk(tree, (node) => { if (node.type === type && !found) found = node; }); return found; },
  };
}

test("dashboard discards prior-project and unmounted reads; generation flows through collapsed/expanded terminals", async () => {
  const requests = [], intervals = new Set();
  const dashboard = component("ProjectDashboard", {
    dependencies: { "@/lib/idle": { onIdleChange: () => () => {} } },
    globals: {
      fetch: (url) => {
        if (url !== "/api/agents") return Promise.resolve({ ok: true, json: async () => ({ projects: [] }) });
        const request = deferred(); requests.push(request); return request.promise;
      },
      setInterval: (fn) => { intervals.add(fn); return fn; }, clearInterval: (fn) => intervals.delete(fn),
      localStorage: { getItem: () => null },
      window: { addEventListener() {}, removeEventListener() {} },
    },
  });
  const poll = () => { for (const fn of intervals) fn(); return requests.at(-1); };
  const props = { projectId: "old" };
  dashboard.render(props); dashboard.commit();
  requests[0].resolve({ ok: true, json: async () => ({ "old/head": { state: "verified", generation_id: "old-1" } }) }); await flush();
  assert.equal(dashboard.find(dashboard.render(props), "AgentTerminalsGrid").props.agentGenerations.head, "old-1");
  const oldA = poll(), oldB = poll();
  assert.equal(requests.length, 3, "a hung read cannot prevent future observations");
  props.projectId = "new";
  assert.deepEqual(dashboard.find(dashboard.render(props), "AgentTerminalsGrid").props.agentGenerations, {}, "old generation is hidden before new effects run");
  dashboard.commit();
  requests[3].resolve({ ok: true, json: async () => ({ "new/head": { state: "verified", generation_id: "new-1" } }) }); await flush();
  for (const request of [oldB, oldA]) request.resolve({ ok: true, json: async () => ({ "old/head": { state: "verified", generation_id: "old-late" } }) });
  await flush();
  let railProps = dashboard.find(dashboard.render(props), "AgentTerminalsGrid").props;
  assert.equal(railProps.agentGenerations.head, "new-1");
  assert.equal(railProps.agentStates.head, "verified");

  const rail = component("AgentTerminalsGrid");
  assert.equal(rail.find(rail.render({ ...railProps, expanded: false }), "TerminalGrid"), undefined);
  const slow = poll(), fresh = poll();
  fresh.resolve({ ok: true, json: async () => ({ "new/head": { state: "verified", generation_id: "new-2" } }) }); await flush();
  slow.resolve({ ok: true, json: async () => ({ "new/head": { state: "verified", generation_id: "stale-generation" } }) }); await flush();
  railProps = dashboard.find(dashboard.render(props), "AgentTerminalsGrid").props;
  const gridProps = rail.find(rail.render({ ...railProps, expanded: true }), "TerminalGrid").props;
  const grid = component("TerminalGrid", { dependencies: { "@/lib/sessionToken": {} } });
  const panel = grid.find(grid.render(gridProps), "TerminalPanel");
  assert.equal(panel.props.generationId, "new-2", "expansion passes the latest generation all the way to the viewer");
  assert.equal(panel.props.projectId, "new");

  poll().resolve({ ok: false }); await flush();
  assert.equal(dashboard.find(dashboard.render(props), "AgentTerminalsGrid").props.agentGenerations.head, "new-2", "failed reads cannot erase an observed generation");
  const lastRequest = poll(); dashboard.unmount();
  const updates = dashboard.updates();
  lastRequest.resolve({ ok: true, json: async () => ({ "new/head": { state: "verified", generation_id: "after-unmount" } }) }); await flush();
  assert.equal(dashboard.updates(), updates);
  assert.equal(intervals.size, 0);
});

function viewer() {
  const terminals = [], sockets = [], timers = [], requests = [];
  let now = 0, token = async () => "token=fixture";
  class Terminal {
    constructor() { this.output = ""; this.cols = 80; this.rows = 24; terminals.push(this); }
    loadAddon() {} open() {} onData() {}
    write(value) { assert.equal(this.disposed, undefined, "a stale callback wrote to a disposed terminal"); this.output += value; }
    reset() { this.output = ""; }
    dispose() { this.disposed = true; }
  }
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.closed = true; this.readyState = 3; }
    open() { this.readyState = 1; this.onopen(); }
  }
  const panel = component("TerminalPanel", {
    dependencies: {
      "@xterm/xterm": { Terminal }, "@xterm/addon-fit": { FitAddon: class { fit() {} } },
      "@/lib/sessionToken": { sessionTokenParam: () => token() },
    },
    globals: {
      WebSocket: Socket, ResizeObserver: class { observe() {} disconnect() {} },
      requestAnimationFrame: (fn) => fn(),
      setTimeout: (fn, delay) => timers.push({ fn, due: now + delay }),
      Date: class extends Date { static now() { return now; } },
      fetch: async (url, options) => { requests.push({ url, options }); assert.equal(url, "/api/sessions"); return { ok: true, json: async () => [] }; },
    },
  });
  return { panel, terminals, sockets, requests,
    setToken(fn) { token = fn; },
    async advance(ms) { now += ms; const due = timers.splice(0).filter((timer) => { if (timer.due <= now) return true; timers.push(timer); return false; }); due.forEach((timer) => timer.fn()); await flush(); },
    async render(props) { panel.render(props); panel.commit(); await flush(); },
  };
}

test("a late generation reconnects after the stopped probe window; stable polls preserve output", async () => {
  const f = viewer();
  const props = { projectId: "project", agentId: "head", generationId: null, wsUrl: "ws://fixture" };
  await f.render(props);
  f.sockets[0].open();
  const closing = f.sockets[0].onclose({ reason: "stopped", code: 1008 });
  for (let i = 0; i < 10; i++) await f.advance(200);
  await closing;
  assert.match(f.terminals[0].output, /session closed: stopped/);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.requests.length, 10);
  props.generationId = "generation-1";
  await f.render(props);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.terminals[0].disposed, true);
  assert.equal(f.sockets[0].closed, true);
  f.sockets[1].open(); f.sockets[1].onmessage({ data: "visible prompt\r\n" });
  for (let i = 0; i < 3; i++) await f.render({ ...props, onActivity() {} });
  assert.equal(f.sockets.length, 2, "identical generation polls and callback changes do not reconnect");
  assert.equal(f.terminals[1].output, "visible prompt\r\n");
  props.generationId = "generation-2";
  await f.render(props);
  assert.equal(f.sockets.length, 3, "restart is visible even when scalar state does not change");
  f.sockets[1].onmessage({ data: "stale output" });
  assert.equal(f.terminals[2].output, "");
  assert.equal(f.requests.every(({ url, options }) => url === "/api/sessions" && options === undefined), true, "the viewer only performed existing read-only probes");
  f.panel.unmount();
});

test("generation/project changes and unmount cancel a pending token before it opens a stale socket", async () => {
  const f = viewer(), oldToken = deferred();
  f.setToken(() => oldToken.promise);
  await f.render({ projectId: "old", agentId: "head", generationId: "old-1", wsUrl: "ws://fixture" });
  assert.equal(f.sockets.length, 0);
  f.setToken(async () => "token=current");
  await f.render({ projectId: "new", agentId: "head", generationId: "new-1", wsUrl: "ws://fixture" });
  assert.equal(f.sockets.length, 1);
  assert.match(f.sockets[0].url, /project=new&agent=head&token=current$/);
  oldToken.resolve("token=stale"); await flush();
  assert.equal(f.sockets.length, 1);
  const unmountedToken = deferred(); f.setToken(() => unmountedToken.promise);
  await f.render({ projectId: "new", agentId: "head", generationId: "new-2", wsUrl: "ws://fixture" });
  f.panel.unmount(); unmountedToken.resolve("token=late"); await flush();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].closed, true);
});

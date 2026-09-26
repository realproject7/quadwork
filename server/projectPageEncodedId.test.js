"use strict";

// #1209: the dashboard works for a configured project whose id needs URL
// encoding: a legacy id with a space ("My Project", which CLI setup takes from a
// folder name) or with a "%" ("100%"). A plain id ("alpha") must behave as
// before. The real pages run here: Home, the sidebar, the project page
// (ProjectPageClient and all it renders, from ChatPanel to the terminals and
// the operator widgets), the queue page and Settings. Every module is
// transpiled with the repo's own `typescript` (the ts.transpileModule precedent
// in server/settingsPage.test.js, server/terminalViewerGeneration.test.js and
// server/mobileSidebarA11y.test.js), and the components import the real @/lib
// modules. Stand-ins replace React's renderer and hooks (react/jsx-runtime is
// real), the Next.js runtime, xterm, react-markdown, the server and the
// browser; STAND_INS and openPage set them up. The hook runtime is this file's
// model of React and is not cross-checked against react-dom. Timers never fire.
//
// The checks read what the browser and the server see: the hrefs a page
// renders, each request's URL as the page wrote it (fetch and the terminal
// WebSocket) and its JSON body, and the page's text. Two seams model them:
// - A page opened at an href gets `new URL(href)`'s pathname and hash, which
//   stay percent-encoded. usePathname() returns that pathname: Next.js takes it
//   from `new URL(canonicalUrl)` (node_modules/next/dist/client/components/
//   app-router.js).
// - The fake server reads the project a request names the way the routes do
//   (projectRefs) and answers only for a configured id. An unknown id gets 404,
//   and an invalid escape in a path gets 400, before any route runs.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const jsxRuntime = require("react/jsx-runtime");

const SRC = path.join(__dirname, "../src");
const ORIGIN = "http://quadwork.test";

// ---- The fixture --------------------------------------------------------------

// None of the projects has a V2 repository yet, so Home also links each one to
// its row in Settings.
const IDS = ["My Project", "100%", "alpha"];
const CONFIG = { projects: IDS.map((id) => ({ id, name: id, agents: {} })) };
const MESSAGE = { id: 1, sender: "head", text: "hello from head", ts: "2026-09-27T00:00:00.000Z", channel: "general" };
// A saved chat preset that names its project; ChatPresets fills {{project}} in.
const PRESET = { id: "preset-1", title: "Read GITHUB.md", message: "@head read ~/.quadwork/{{project}}/GITHUB.md" };

// ---- The fake server ----------------------------------------------------------

// Where a request names a project, as the server reads it: the `project` query
// parameter, decoded once like Express's query parser; the id segment of
// /api/{agents,projects,project,triggers,uploads}/<id>, decoded once with
// decodeURIComponent (an invalid escape is Express's 400, so its id is null);
// or a `project` / `project_id` field of the JSON body. `raw` is the id as the
// page wrote it in the URL.
function projectRefs(url, body) {
  const refs = [];
  const [pathPart, query = ""] = url.split("?");
  for (const pair of query.split("&")) {
    if (!pair.startsWith("project=")) continue;
    refs.push({ where: "the project query parameter", raw: pair.slice("project=".length), id: new URLSearchParams(pair).get("project") });
  }
  const segment = /\/api\/(?:agents|projects|project|triggers|uploads)\/([^/]+)/.exec(pathPart);
  if (segment) {
    let id = null;
    try { id = decodeURIComponent(segment[1]); } catch { /* Express answers 400 */ }
    refs.push({ where: "the path", raw: segment[1], id });
  }
  for (const key of ["project", "project_id"]) {
    if (body && typeof body[key] === "string") refs.push({ where: `the body's ${key}`, raw: null, id: body[key] });
  }
  return refs;
}

const ROUTES = [
  ["GET", /^\/api\/config$/, () => CONFIG],
  ["GET", /^\/api\/projects$/, () => ({
    projects: IDS.map((id) => ({ id, name: id, agentCount: 4, openPrs: 0, state: "active", lastActivity: null })),
    recentEvents: [],
  })],
  ["GET", /^\/api\/chat$/, () => [MESSAGE]],
  ["POST", /^\/api\/chat$/, () => ({ ok: true })],
  ["GET", /^\/api\/agents$/, () => ({})],
  ["POST", /^\/api\/agents\/[^/]+\/head\/write$/, () => ({ ok: true })],
  ["GET", /^\/api\/session-token$/, () => ({ token: "fixture-token" })],
  ["GET", /^\/api\/queue$/, () => ({ exists: true, content: "" })],
  ["GET", /^\/api\/github\/(issues|prs|closed-issues|merged-prs)$/, () => []],
  ["GET", /^\/api\/batch-active$/, () => ({ active: false })],
];

// [status, body] for a request.
function serve(method, url, body) {
  for (const ref of projectRefs(url, body)) {
    if (ref.id === null) return [400, { error: "invalid project id" }];
    if (!IDS.includes(ref.id)) return [404, { error: "project is not configured" }];
  }
  const route = url.split("?")[0];
  const match = ROUTES.find(([m, pattern]) => m === method && pattern.test(route));
  return match ? [200, match[2]()] : [404, { error: "not found" }];
}

// ---- The page -----------------------------------------------------------------

const JS = new Map();
function transpile(file) {
  if (!JS.has(file)) {
    JS.set(file, ts.transpileModule(fs.readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText);
  }
  return JS.get(file);
}

// Opens the default export of `file` (under src/) as the page at `href`, after
// every effect has run and every request has been answered. `storage` seeds
// localStorage.
async function openPage(href, file, { storage = {} } = {}) {
  const location = new URL(href, ORIGIN);
  const requests = [], alerts = [], scrolledTo = [], navigations = [];

  // ---- The browser
  const stored = new Map(Object.entries(storage));
  const localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: (key) => { stored.delete(key); },
  };
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  const fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    let body = null;
    if (typeof init.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    requests.push({ method, url: String(url), body });
    return reply(...serve(method, String(url), body));
  };
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; requests.push({ method: "WS", url: String(url), body: null }); }
    send() {}
    close() { this.readyState = 3; }
  }
  // An element as the components use one: through refs, getElementById and
  // createElement. Nothing here has layout.
  const element = () => {
    const el = {
      host: null, style: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      focus() {}, blur() {}, click() {},
      scrollIntoView() { scrolledTo.push(el.host && el.host.props.id); },
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      contains: () => false, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
    };
    return el;
  };
  const document = {
    cookie: "", activeElement: null, body: element(), documentElement: element(),
    getElementById: (id) => { for (const node of walk(tree)) if (typeof node.type === "string" && node.props.id === id) return node.el; return null; },
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => element(),
    addEventListener() {}, removeEventListener() {},
  };
  const navigator = { language: "en-US", clipboard: { writeText: async () => {} } };
  const matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  const alert = (message) => { alerts.push(String(message)); };
  const timer = () => 0;
  const timers = {
    setTimeout: timer, clearTimeout() {}, setInterval: timer, clearInterval() {},
    requestAnimationFrame: timer, cancelAnimationFrame() {},
  };
  const window = Object.assign(new EventTarget(), timers, {
    location, localStorage, navigator, matchMedia, alert, innerWidth: 1280, innerHeight: 800, confirm: () => false,
  });
  const globals = {
    window, document, localStorage, navigator, fetch, WebSocket, alert, ...timers, Node: class {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    AbortSignal: { timeout: () => undefined },
  };

  // ---- React: hooks per component instance and a stand-in element per host
  // element, both kept by position in the tree as React keeps them.
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const instances = new Map(), elements = new Map(), effects = [];
  let current = null, dirty = false, tree = [];
  const react = {
    ...React,
    useState(initial) {
      const instance = current, i = instance.cursor++;
      if (!(i in instance.cells)) {
        instance.cells[i] = typeof initial === "function" ? initial() : initial;
        instance.setters[i] = (value) => {
          const next = typeof value === "function" ? value(instance.cells[i]) : value;
          if (!Object.is(next, instance.cells[i])) { instance.cells[i] = next; dirty = true; }
        };
      }
      return [instance.cells[i], instance.setters[i]];
    },
    useRef(initial) { const cells = current.cells, i = current.cursor++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i]; },
    useMemo(fn, deps) {
      const cells = current.cells, i = current.cursor++;
      if (!(i in cells) || !sameDeps(cells[i].deps, deps)) cells[i] = { deps, value: fn() };
      return cells[i].value;
    },
    useCallback: (fn, deps) => react.useMemo(() => fn, deps),
    useEffect(fn, deps) {
      const instance = current, i = instance.cursor++;
      if (i in instance.cells && sameDeps(instance.cells[i].deps, deps)) return;
      instance.queued.push(() => {
        const cleanup = instance.cells[i] && instance.cells[i].cleanup;
        if (typeof cleanup === "function") cleanup();
        instance.cells[i] = { effect: true, deps, cleanup: fn() };
      });
    },
  };

  const STAND_INS = {
    react,
    "react/jsx-runtime": jsxRuntime,
    "next/navigation": (() => {
      const router = { push: (url) => navigations.push(url), replace: (url) => navigations.push(url), back() {}, refresh() {}, prefetch() {} };
      return { usePathname: () => location.pathname, useRouter: () => router, useSearchParams: () => location.searchParams };
    })(),
    "next/link": { __esModule: true, default: function Link({ href, children, ...rest }) { return jsxRuntime.jsx("a", { ...rest, href, children }); } },
    // Renders the loaded module once its import resolves, as next/dynamic does
    // on the client.
    "next/dynamic": { __esModule: true, default: (loader) => {
      let Loaded = null;
      loader().then((mod) => { Loaded = mod.default; dirty = true; });
      return function Dynamic(props) { return Loaded ? jsxRuntime.jsx(Loaded, props) : null; };
    } },
    "@/components/LocaleProvider": { useLocale: () => ({ hydrated: true, locale: "en", setLocale() {} }) },
    "@xterm/xterm": { Terminal: class { constructor() { this.cols = 80; this.rows = 24; } loadAddon() {} open() {} onData() {} write() {} reset() {} dispose() {} } },
    "@xterm/addon-fit": { FitAddon: class { fit() {} } },
    "react-markdown": { __esModule: true, default: function ReactMarkdown({ children }) { return jsxRuntime.jsx("div", { children }); } },
  };
  const modules = new Map();
  function load(file) {
    if (!modules.has(file)) {
      const module = { exports: {} };
      modules.set(file, module);
      const names = Object.keys(globals);
      new Function("require", "module", "exports", ...names, transpile(file))(
        (id) => resolve(id, file), module, module.exports, ...names.map((name) => globals[name]));
    }
    return modules.get(file).exports;
  }
  function resolve(id, from) {
    if (id in STAND_INS) return STAND_INS[id];
    if (id.endsWith(".css")) return {};
    const base = id.startsWith("@/") ? path.join(SRC, id.slice(2)) : id.startsWith(".") ? path.resolve(path.dirname(from), id) : null;
    const found = base && ["", ".tsx", ".ts", ".js"].map((ext) => base + ext).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!found) throw new Error(`${path.relative(SRC, from)}: unexpected import ${id}`);
    return load(found);
  }

  // The rendered tree: strings, host elements ({ type, props, el, children })
  // and components ({ component, props, children }).
  function renderChildren(children, at, out, visited) {
    (Array.isArray(children) ? children : [children]).forEach((child, i) => {
      const keyed = child && typeof child === "object" && child.key != null;
      renderNode(child, `${at}/${keyed ? `#${child.key}` : i}`, out, visited);
    });
  }
  function renderNode(node, at, out, visited) {
    if (node == null || typeof node === "boolean") return;
    if (typeof node !== "object") { out.push(String(node)); return; }
    if (Array.isArray(node)) { renderChildren(node, `${at}[]`, out, visited); return; }
    const { type, props } = node;
    if (typeof type === "string") {
      const id = `${at}<${type}>`;
      visited.add(id);
      const host = { type, props, el: elements.get(id) || element(), children: [] };
      host.el.host = host;
      elements.set(id, host.el);
      if (props.ref) props.ref.current = host.el;
      renderChildren(props.children, id, host.children, visited);
      out.push(host);
    } else if (type === jsxRuntime.Fragment) {
      renderChildren(props.children, `${at}<>`, out, visited);
    } else if (typeof type === "function") {
      const id = `${at}<${type.name || "Anonymous"}>`;
      const instance = instances.get(id) || { cells: [], setters: [], queued: [] };
      instances.set(id, instance);
      visited.add(id);
      const outer = current;
      current = instance;
      instance.cursor = 0;
      let output;
      try { output = type(props); } finally { current = outer; }
      const component = { component: type.name, props, children: [] };
      renderNode(output, `${id}/0`, component.children, visited);
      out.push(component);
      effects.push(...instance.queued.splice(0));
    } else {
      throw new Error(`fake renderer: cannot render ${String(type)}`);
    }
  }
  const Page = load(path.join(SRC, file)).default;
  function render() {
    dirty = false;
    const visited = new Set(), out = [];
    renderNode(jsxRuntime.jsx(Page, {}), "", out, visited);
    tree = out;
    for (const [id, instance] of instances) {
      if (visited.has(id)) continue;
      instances.delete(id);
      for (const cell of instance.cells) if (cell && cell.effect && typeof cell.cleanup === "function") cell.cleanup();
    }
    for (const id of elements.keys()) if (!visited.has(id)) elements.delete(id);
  }
  // Commit effects and re-render until nothing is left, including the requests.
  async function settle() {
    for (let round = 0; round < 200; round++) {
      if (effects.length) { for (const run of effects.splice(0)) run(); continue; }
      if (dirty) { render(); continue; }
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      if (!dirty && !effects.length) return;
    }
    throw new Error("fake renderer: the page never settled");
  }

  const event = (node, extra = {}) => ({ preventDefault() {}, stopPropagation() {}, target: node.el, currentTarget: node.el, ...extra });
  const page = {
    location, requests, alerts, scrolledTo, navigations,
    text: (node) => textOf(node || tree),
    all: (match) => [...walk(tree)].filter(match),
    within: (node, match) => [...walk(node.children)].filter(match),
    // The props of every rendered instance of the component named `name`.
    instances: (name) => page.all((n) => n.component === name).map((n) => n.props),
    // The one button whose text is `label`.
    button(label) {
      const found = page.all((n) => n.type === "button" && textOf(n).trim() === label);
      assert.equal(found.length, 1, `one button reads ${JSON.stringify(label)}`);
      return found[0];
    },
    hrefs: (prefix) => page.all((n) => n.type === "a" && typeof n.props.href === "string" && n.props.href.startsWith(prefix)).map((n) => n.props.href),
    async click(node) { node.props.onClick(event(node)); await settle(); },
    async type(node, value) { node.props.onChange(event(node, { target: { ...node.el, value } })); await settle(); },
  };
  render();
  await settle();
  return page;
}
function* walk(nodes) {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    yield node;
    yield* walk(node.children);
  }
}
const textOf = (node) => (typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join("") : textOf(node.children));

// Every request that names a project names `id`: in a URL as
// encodeURIComponent(id), exactly, and in a JSON body as the id itself.
// Returns those requests.
function assertEachRequestNames(page, id) {
  const naming = page.requests.filter((r) => projectRefs(r.url, r.body).length > 0);
  for (const request of naming) {
    for (const ref of projectRefs(request.url, request.body)) {
      const label = `${request.method} ${request.url}: ${ref.where}`;
      if (ref.raw === null) assert.equal(ref.id, id, `${label} is the configured id`);
      else assert.equal(ref.raw, encodeURIComponent(id), `${label} is the configured id, encoded once`);
    }
  }
  return naming;
}
const endpoint = (request) => `${request.method} ${request.url.split("?")[0].replace(/^ws:\/\/[^/]+/, "")}`;
// Home's card link for a project: the link that shows the project's name.
const homeCardLinks = (home, id) =>
  home.all((n) => n.type === "a" && home.within(n, (c) => c.type === "span" && c.props.title === id).length > 0);

// ---- The behaviour ------------------------------------------------------------

for (const id of IDS) {
  const encoded = encodeURIComponent(id);
  const name = JSON.stringify(id);

  test(`#1209 ${name}: Home and the sidebar link to the project as /project/<id encoded once>`, async () => {
    const home = await openPage("/", "components/HomeDashboard.tsx");
    assert.deepEqual(homeCardLinks(home, id).map((a) => a.props.href), [`/project/${encoded}`], "Home's card for the project");

    const sidebar = await openPage("/", "components/Sidebar.tsx");
    const icons = sidebar.all((n) => n.component === "ProjectIcon" && n.props.project.id === id);
    assert.ok(icons.length > 0, "fixture: the sidebar lists the project");
    for (const icon of icons) {
      assert.deepEqual(sidebar.within(icon, (n) => n.type === "a").map((a) => a.props.href), [`/project/${encoded}`], "the sidebar's link for the project");
    }
  });

  test(`#1209 ${name}: the project page opened from Home reads and sends chat with the configured id`, async () => {
    const home = await openPage("/", "components/HomeDashboard.tsx");
    const [card] = homeCardLinks(home, id);
    assert.ok(card, "fixture: Home shows the project");
    const page = await openPage(card.props.href, "app/project/[id]/ProjectPageClient.tsx", { storage: { "qw-chat-presets": JSON.stringify([PRESET]) } });
    assert.equal(page.location.pathname, `/project/${encoded}`, "fixture: the browser keeps the pathname encoded");
    assert.deepEqual(page.instances("ProjectDashboard").map((props) => props.projectId), [id], "the dashboard is for the configured id");

    const read = page.requests.find((r) => r.method === "GET" && r.url.startsWith("/api/chat?"));
    assert.equal(read.url, `/api/chat?path=/api/messages&channel=general&cursor=0&project=${encoded}`);
    assert.match(page.text(), /hello from head/, "the chat shows the project's messages");
    assert.doesNotMatch(page.text(), /Loading messages/);

    const input = () => page.all((n) => n.type === "textarea" && n.props.placeholder === "Message #general...")[0];
    await page.type(input(), "status?");
    await page.click(page.button("Send"));
    const sends = () => page.requests.filter((r) => r.method === "POST" && r.url.startsWith("/api/chat"));
    assert.equal(sends().length, 1, "Send posted the message");
    assert.equal(sends()[0].url, `/api/chat?project=${encoded}`);
    assert.deepEqual(sends()[0].body, { text: "@head status?", channel: "general", sender: "user" });
    assert.equal(input().props.value, "", "the sent message left the input");
    assert.doesNotMatch(page.text(), /Send failed/);

    await page.click(page.button("Preset"));
    await page.click(page.all((n) => n.type === "button" && textOf(n).startsWith(PRESET.title))[0]);
    assert.equal(sends().length, 2, "the preset posted its message");
    assert.equal(sends()[1].url, `/api/chat?project=${encoded}`);
    assert.equal(sends()[1].body.text, `@head read ~/.quadwork/${id}/GITHUB.md`, "the preset names the configured id");
    assert.doesNotMatch(page.text(), /Send failed/);
  });

  test(`#1209 ${name}: every request the project page makes names the configured id, encoded once`, async () => {
    const page = await openPage(`/project/${encoded}`, "app/project/[id]/ProjectPageClient.tsx");
    const naming = assertEachRequestNames(page, id);
    const endpoints = new Set(naming.map(endpoint));
    // Fixture: the page made the requests it makes on load, so the check above
    // covered them. They span the chat, the terminals, GitHub and the operator
    // widgets.
    for (const expected of [
      "GET /api/chat", "WS /ws/terminal", "GET /api/queue", "GET /api/github/issues", "GET /api/github/prs",
      "GET /api/github/rate-limit", "GET /api/caffeinate/status", "GET /api/batch-progress", "GET /api/loop-guard",
      "GET /api/telegram", "GET /api/discord", "GET /api/project-history/snapshots", `GET /api/project/${encoded}/agent-models`,
    ]) {
      assert.ok(endpoints.has(expected), `fixture: the page requested ${expected}; it requested ${[...endpoints].join(", ")}`);
    }
    assert.equal(page.requests.filter((r) => r.method === "WS").length, 4, "fixture: one terminal per agent");
  });

  test(`#1209 ${name}: the queue page at /project/<id encoded once>/queue sends the queue to Head for the configured id`, async () => {
    const page = await openPage(`/project/${encoded}/queue`, "app/project/[id]/queue/QueuePageClient.tsx");
    assert.deepEqual(page.instances("QueueManager").map((props) => props.projectId), [id], "the queue is for the configured id");

    await page.click(page.button("Send to Head Terminal"));
    const writes = page.requests.filter((r) => r.method === "POST" && r.url.endsWith("/head/write"));
    assert.equal(writes.length, 1, `Send posted to Head; alerts: ${page.alerts}`);
    assert.equal(writes[0].url, `/api/agents/${encoded}/head/write`);
    assert.deepEqual(page.alerts, [], "no failure was shown");
    assert.ok(page.button("Sent to Head"), "the button confirms the send");
    assertEachRequestNames(page, id);
  });

  test(`#1209 ${name}: on the project page the sidebar marks that project active, and only it`, async () => {
    const sidebar = await openPage(`/project/${encoded}`, "components/Sidebar.tsx");
    const icons = sidebar.instances("ProjectIcon");
    assert.ok(icons.length >= IDS.length, "fixture: the sidebar shows every project");
    for (const props of icons) {
      assert.equal(props.isActive, props.project.id === id, `${JSON.stringify(props.project.id)} is ${props.project.id === id ? "" : "not "}active`);
    }
  });

  test(`#1209 ${name}: Home's Configure V2 link opens Settings at the project's row`, async () => {
    const home = await openPage("/", "components/HomeDashboard.tsx");
    const href = home.hrefs("/settings#").find((link) => link === `/settings#project-${encoded}`);
    assert.ok(href, "fixture: Home links to the project's row in Settings");
    const settings = await openPage(href, "components/SettingsPage.tsx");
    assert.equal(settings.location.hash, `#project-${encoded}`, "fixture: the browser keeps the fragment encoded");
    assert.equal(settings.all((n) => n.type === "div" && n.props.id === `project-${id}`).length, 1, "fixture: Settings has the project's row");
    assert.deepEqual(settings.scrolledTo, [`project-${id}`], "Settings scrolled to the project's row");
  });
}

test("#1209: an invalid escape in the pathname is taken as typed", async () => {
  // A hand-typed /project/100% reaches the page as it is (the browser keeps a
  // lone "%"), so the page must not throw on it, and it is the id 100%.
  const page = await openPage("/project/100%", "app/project/[id]/ProjectPageClient.tsx");
  assert.equal(page.location.pathname, "/project/100%", "fixture: the browser keeps the lone %");
  assert.deepEqual(page.instances("ProjectDashboard").map((props) => props.projectId), ["100%"]);
  assertEachRequestNames(page, "100%");
});

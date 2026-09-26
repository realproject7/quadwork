"use strict";

// #1202: pins the #1198 dashboard accessibility behaviour (PR #1200) on the
// real components. The real root layout renders the real TopHeader, Sidebar,
// LocaleProvider and GlobalNotificationListener, with the real ChatPresets as
// the page. Every module is transpiled with the repo's own `typescript` (the
// ts.transpileModule precedent in server/settingsPage.test.js and
// server/terminalViewerGeneration.test.js), and the components import the real
// @/lib modules. Stand-ins replace React's renderer and hooks (only
// createContext and react/jsx-runtime are real), the Next.js runtime, and the
// browser, including a small fake document built from the rendered elements;
// STAND_INS and createPage set them all up. The repo has no DOM library. The
// hook runtime is this file's model of React: effect order, batching and ref
// timing come from it and are not cross-checked against react-dom.
//
// Faked seams for what needs layout: Tab order across layout.tsx is read from
// the fake document, and the lg close runs on the injected matchMedia. The fake
// follows only the browser rules these checks rely on:
// - Tab order is DOM order, with positive tabindex first and negative tabindex
//   skipped. A Tab that no keydown listener cancels moves focus to the next
//   stop. Past either end, focus leaves the page.
// - The inert and hidden attributes cover the element and everything inside
//   it: none of it is focusable or a Tab stop, and assistive technology does
//   not see it. hidden is display:none (the UA style sheet, made !important by
//   Tailwind's preflight). aria-hidden="true" hides a subtree from assistive
//   technology only. A click on an inert or hidden element throws: hit-testing
//   skips it, and the fake cannot tell what is underneath.
// - focus() only works on a focusable element. When the focused element is
//   removed or can no longer take focus, focus falls back to <body> (HTML's
//   focus fixup rule).
// - A click first moves focus to the target's nearest focusable ancestor, or
//   to <body>, as Chrome's mousedown does. It then runs the onClick handlers up
//   the tree and reaches window. Enter on a focused button or link clicks it
//   without moving focus.
// - matchMedia evaluates min-width and max-width, in px or rem, against the
//   simulated viewport. A media-query rem is the browser's default font size.
//   On a resize, every list whose result flips fires `change`.
//
// Browser-only, covered by PR #1200's browser proof, because the fake has no
// CSS and no layout:
// - What a width hides. Only the hidden attribute hides an element here. Below
//   lg every Tab stop these pages render before and inside the drawer is
//   displayed. The desktop rail, hidden below lg, only appears here as a place
//   focus must not leak to.
// - Where a tap lands: the overlay covering the page, and the z-[45] menu
//   button above the presets backdrop. A click goes to the element the test
//   names.
// - The drawer's position and slide. "Open" here means the drawer has its
//   slid-in class, translate-x-0. The #1205 PR's browser proof covers the
//   slide with the closed drawer inert. Here the closed drawer only has to
//   stay displayed.
// - focus and blur events. The fake only tracks document.activeElement.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const jsxRuntime = require("react/jsx-runtime");

const SRC = path.join(__dirname, "../src");

// ---- The fake document ------------------------------------------------------

class FakeNode {
  constructor() { this.parentNode = null; this.childNodes = []; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
}
class FakeText extends FakeNode {
  constructor(data) { super(); this.data = data; }
  get textContent() { return this.data; }
}
// The React prop behind each HTML attribute a selector reads.
const PROP_OF = { class: "className", for: "htmlFor", tabindex: "tabIndex" };
// React 19 renders inert and hidden as boolean attributes. Any other value is
// not rendered as written (inert="" renders no attribute at all), so it throws
// instead of guessing.
const BOOLEAN_ONLY = new Set(["inert", "hidden"]);
class FakeElement extends FakeNode {
  constructor(document, localName) { super(); this.ownerDocument = document; this.localName = localName; this.props = {}; }
  getAttribute(name) {
    const value = this.props[PROP_OF[name] || name];
    if (value == null || typeof value === "function") return null;
    if (BOOLEAN_ONLY.has(name) && typeof value !== "boolean") throw new Error(`fake document: ${name}=${JSON.stringify(value)} is not a boolean`);
    if (typeof value === "boolean") return /^(aria|data)-/.test(name) ? String(value) : value ? "" : null;
    return String(value);
  }
  get isConnected() { return this.ownerDocument.documentElement.contains(this); }
  focus() { if (this.isConnected && focusable(this)) this.ownerDocument.focused = this; }
  querySelectorAll(selectors) { return descendants(this).filter((el) => matches(el, selectors)); }
  querySelector(selectors) { return this.querySelectorAll(selectors)[0] || null; }
}
const descendants = (node) =>
  node.childNodes.filter((n) => n instanceof FakeElement).flatMap((el) => [el, ...descendants(el)]);

// A comma list of compound selectors (tag, [attr], [attr="value"], :not(...)),
// which covers every selector these components query. Anything else throws
// instead of guessing.
function matches(el, selectors) {
  return selectors.split(",").some((selector) => matchesCompound(el, selector.trim()));
}
function matchesCompound(el, selector) {
  let rest = selector;
  const tag = /^[a-z][a-z0-9]*/.exec(rest);
  if (tag) {
    if (el.localName !== tag[0]) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    let m;
    if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) {
      const value = el.getAttribute(m[1]);
      if (value === null || (m[2] !== undefined && value !== m[2])) return false;
    } else if ((m = /^:not\(([^()]*)\)/.exec(rest))) {
      if (matchesCompound(el, m[1])) return false;
    } else {
      throw new Error(`fake document: unsupported selector ${JSON.stringify(selector)}`);
    }
    rest = rest.slice(m[0].length);
  }
  return true;
}

// The element, then each ancestor up to the document.
const ancestry = (el) => (el instanceof FakeElement ? [el, ...ancestry(el.parentNode)] : []);
const inertOrHidden = (el) => ancestry(el).some((n) => n.getAttribute("inert") !== null || n.getAttribute("hidden") !== null);
// Whether assistive technology sees the element.
const exposed = (el) => !inertOrHidden(el) && !ancestry(el).some((n) => n.getAttribute("aria-hidden") === "true");

// HTML's focusable areas, for the elements these pages render.
const tabIndex = (el) => { const raw = el.getAttribute("tabindex"); return raw === null || raw.trim() === "" ? NaN : Number(raw); };
function focusable(el) {
  if (inertOrHidden(el)) return false;
  const disabled = el.getAttribute("disabled") !== null;
  if (["button", "select", "textarea"].includes(el.localName)) return !disabled;
  if (el.localName === "input") return !disabled && el.getAttribute("type") !== "hidden";
  if (el.localName === "a" && el.getAttribute("href") !== null) return true;
  return Number.isInteger(tabIndex(el));
}
// HTML sequential focus navigation: positive tabindex first, in value order,
// then tabindex 0 and natively focusable elements, in DOM order.
function tabOrder(document) {
  const stops = descendants(document.documentElement).filter((el) => focusable(el) && !(tabIndex(el) < 0));
  const rank = (el) => tabIndex(el) || 0;
  return [...stops.filter((el) => rank(el) > 0).sort((a, b) => rank(a) - rank(b)), ...stops.filter((el) => rank(el) === 0)];
}
// The accessible name, as it resolves for the controls checked here:
// aria-label, else the text content, else the title.
function accessibleName(el) {
  const label = (el.getAttribute("aria-label") || "").trim();
  if (label) return label;
  return el.textContent.replace(/\s+/g, " ").trim() || (el.getAttribute("title") || "").trim();
}
const classes = (el) => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
// Element checks compare identity and name the elements in the failure.
// assert.equal on two elements would inspect the whole fake document to build
// its diff, which takes minutes.
function show(el) {
  if (!(el instanceof FakeElement)) return String(el);
  const stop = tabOrder(el.ownerDocument).indexOf(el);
  return `<${el.localName}> ${JSON.stringify(accessibleName(el).slice(0, 40))} (${stop < 0 ? "not a Tab stop" : `Tab stop ${stop}`})`;
}
function assertSame(actual, expected, message) {
  if (actual !== expected) assert.fail(`${message}: got ${show(actual)}, expected ${show(expected)}`);
}

function mediaMatches(media, viewport) {
  const m = /^\((min|max)-width:\s*(\d+(?:\.\d+)?)(px|rem)\)$/.exec(media);
  if (!m) throw new Error(`fake matchMedia: unsupported query ${JSON.stringify(media)}`);
  const px = Number(m[2]) * (m[3] === "rem" ? viewport.defaultFontSize : 1);
  return m[1] === "min" ? viewport.width >= px : viewport.width <= px;
}
class FakeMediaQueryList extends EventTarget {
  constructor(media, viewport) { super(); this.media = media; this.matches = mediaMatches(media, viewport); }
}
class FakeKeyboardEvent extends Event {
  constructor(key, shiftKey) { super("keydown", { bubbles: true, cancelable: true }); this.key = key; this.shiftKey = shiftKey; }
}

// ---- The page ---------------------------------------------------------------

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

// Two projects, so the drawer lists links and switches between its first and
// last controls.
const CONFIG = {
  projects: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta", idle: true }],
  pinned_projects: [],
  sidebar_groups: [],
};

// The first render of the real root layout, with the real ChatPresets as the
// page: what the server renders and the first client render hydrates. No
// effect has run yet. `width` is the viewport in CSS px, and `defaultFontSize`
// is the browser's default font size in px.
function createPage({ width = 390, defaultFontSize = 16 } = {}) {
  const viewport = { width, defaultFontSize };
  const document = {
    cookie: "",
    focused: null,
    get body() { return this.documentElement.querySelector("body") || this.documentElement; },
    get activeElement() { return this.focused && this.focused.isConnected ? this.focused : this.body; },
    querySelector(selectors) { return this.documentElement.querySelector(selectors); },
    querySelectorAll(selectors) { return this.documentElement.querySelectorAll(selectors); },
  };
  document.documentElement = new FakeElement(document, "#document");

  const stored = new Map();
  const localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: (key) => { stored.delete(key); },
  };
  const mediaLists = [];
  const window = Object.assign(new EventTarget(), {
    localStorage,
    navigator: { language: "en-US" },
    matchMedia(media) { const list = new FakeMediaQueryList(media, viewport); mediaLists.push(list); return list; },
  });
  Object.defineProperty(window, "innerWidth", { get: () => viewport.width });
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (url) => {
    if (url === "/api/config") return reply(200, structuredClone(CONFIG));
    if (url === "/api/version") return reply(200, { version: "0.0.0-test" });
    if (url === "/api/health") return reply(200, { ok: true });
    if (url.startsWith("/api/batch-active?")) return reply(200, { active: false });
    return reply(404, null);
  };
  // Timers never fire: nothing checked here waits on one.
  const timer = () => ({});
  const globals = {
    window, document, Node: FakeNode, localStorage, fetch,
    setTimeout: timer, clearTimeout() {}, setInterval: timer, clearInterval() {},
    AbortSignal: { timeout: () => undefined },
  };

  // Hooks per component instance, and fake DOM nodes per host element, both
  // kept by position in the tree as React keeps them, so focus and refs
  // survive a re-render.
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const instances = new Map(), nodes = new Map(), providers = [];
  let current = null, dirty = false;
  const effects = [];
  const react = {
    createContext: React.createContext,
    useContext(context) { const entry = providers.findLast((p) => p.context === context); return entry ? entry.value : context._currentValue; },
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
    "next/link": { __esModule: true, default: function Link({ href, children, ...rest }) { return jsxRuntime.jsx("a", { ...rest, href, children }); } },
    "next/navigation": { usePathname: () => "/project/alpha" },
    "next/font/google": { Geist_Mono: () => ({ variable: "font-geist-mono" }) },
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
    const file = base && [".tsx", ".ts", ".js"].map((ext) => base + ext).find((f) => fs.existsSync(f));
    if (!file) throw new Error(`${path.relative(SRC, from)}: unexpected import ${id}`);
    return load(file);
  }

  function renderChildren(children, at, out, visited) {
    (Array.isArray(children) ? children : [children]).forEach((child, i) => {
      const keyed = child && typeof child === "object" && child.key != null;
      renderNode(child, `${at}/${keyed ? `#${child.key}` : i}`, out, visited);
    });
  }
  function renderNode(node, at, out, visited) {
    if (node == null || typeof node === "boolean") return;
    if (typeof node !== "object") { out.push(new FakeText(String(node))); return; }
    if (Array.isArray(node)) { renderChildren(node, `${at}[]`, out, visited); return; }
    const { type, props } = node;
    if (typeof type === "string") {
      const id = `${at}<${type}>`;
      const el = nodes.get(id) || new FakeElement(document, type);
      nodes.set(id, el);
      visited.add(id);
      el.props = props;
      const kids = [];
      renderChildren(props.children, id, kids, visited);
      el.childNodes = kids;
      for (const kid of kids) kid.parentNode = el;
      if (props.ref) {
        if (typeof props.ref !== "object") throw new Error("fake renderer: object refs only");
        props.ref.current = el;
      }
      out.push(el);
    } else if (type === jsxRuntime.Fragment) {
      renderChildren(props.children, `${at}<>`, out, visited);
    } else if (type && type.$$typeof === Symbol.for("react.context")) {
      providers.push({ context: type, value: props.value });
      renderChildren(props.children, `${at}<Provider>`, out, visited);
      providers.pop();
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
      renderNode(output, `${id}/0`, out, visited);
      effects.push(...instance.queued.splice(0));
    } else {
      throw new Error(`fake renderer: cannot render ${String(type)}`);
    }
  }

  const ChatPresets = load(path.join(SRC, "components/ChatPresets.tsx")).default;
  const tree = jsxRuntime.jsx(load(path.join(SRC, "app/layout.tsx")).default, {
    children: jsxRuntime.jsx(ChatPresets, { projectId: "alpha", onSend() {} }),
  });
  function render() {
    dirty = false;
    const visited = new Set(), kids = [];
    renderNode(tree, "", kids, visited);
    document.documentElement.childNodes = kids;
    for (const kid of kids) kid.parentNode = document.documentElement;
    for (const [id, el] of nodes) {
      if (visited.has(id)) continue;
      nodes.delete(id);
      el.parentNode = null;
      if (el.props.ref && el.props.ref.current === el) el.props.ref.current = null;
    }
    for (const [id, instance] of instances) {
      if (visited.has(id)) continue;
      instances.delete(id);
      for (const cell of instance.cells) if (cell && cell.effect && typeof cell.cleanup === "function") cell.cleanup();
    }
    // The focus fixup rule. It stays on <body> even if the element can take
    // focus again later.
    if (document.focused && !(document.focused.isConnected && focusable(document.focused))) document.focused = null;
  }
  // Commit effects and re-render until nothing is left, including the fetches.
  async function settle() {
    for (let round = 0; round < 100; round++) {
      if (effects.length) { for (const run of effects.splice(0)) run(); continue; }
      if (dirty) { render(); continue; }
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      if (!dirty && !effects.length) return;
    }
    throw new Error("fake renderer: the page never settled");
  }

  function dispatchClick(target) {
    let stopped = false;
    const event = {
      type: "click", target, currentTarget: null, defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true; },
      stopPropagation() { stopped = true; },
    };
    for (let n = target; n && !stopped; n = n.parentNode) {
      if (typeof n.props.onClick === "function") { event.currentTarget = n; n.props.onClick(event); }
    }
    if (!stopped) window.dispatchEvent(new Event("click"));
  }

  render();
  const page = {
    document,
    settle,
    active: () => document.activeElement,
    tabOrder: () => tabOrder(document),
    clickTargets: () => descendants(document.documentElement).filter((el) => typeof el.props.onClick === "function"),
    // The one button with this accessible name.
    button(name) {
      const found = document.querySelectorAll("button").filter((el) => accessibleName(el) === name);
      assert.equal(found.length, 1, `one button named ${JSON.stringify(name)}`);
      return found[0];
    },
    menuButton: () => page.button("Open sidebar"),
    // The mobile drawer is the aside hidden at lg. The desktop rail is the
    // aside shown at lg.
    drawer() {
      const found = document.querySelectorAll("aside").filter((el) => classes(el).includes("lg:hidden"));
      assert.equal(found.length, 1, "one mobile drawer");
      return found[0];
    },
    drawerOpen: () => classes(page.drawer()).includes("translate-x-0"),
    drawerStops: () => tabOrder(document).filter((el) => page.drawer().contains(el)),
    // Every control the drawer renders, whether or not it can take focus.
    drawerControls: () => page.drawer().querySelectorAll("a[href], button, input, select, textarea, [tabindex]"),
    // The drawer's click-outside overlay: the one click target outside the
    // drawer that opening the drawer added. `closedTargets` is recorded by
    // openPage, while the drawer is closed.
    overlay() {
      const found = page.clickTargets().filter((el) => !page.drawer().contains(el) && !page.closedTargets.has(el));
      assert.equal(found.length, 1, "one overlay while the drawer is open");
      return found[0];
    },
    // Keydown goes to window's listeners, where Sidebar's trap listens. The
    // fake does not run onKeyDown props, so it throws if the focused element
    // or an ancestor has one.
    async press(key, { shiftKey = false } = {}) {
      for (let n = document.activeElement; n; n = n.parentNode) {
        if (n.props.onKeyDown) throw new Error("fake document: onKeyDown props are not dispatched");
      }
      const event = new FakeKeyboardEvent(key, shiftKey);
      window.dispatchEvent(event);
      const from = document.activeElement;
      if (!event.defaultPrevented && key === "Tab") {
        const order = tabOrder(document), i = order.indexOf(from);
        document.focused = (i === -1 ? (shiftKey ? order.at(-1) : order[0]) : order[i + (shiftKey ? -1 : 1)]) || null;
      } else if (!event.defaultPrevented && key === "Enter" && ["a", "button"].includes(from.localName)) {
        dispatchClick(from);
      }
      await settle();
      return event;
    },
    async click(target) {
      if (inertOrHidden(target)) throw new Error(`fake document: ${show(target)} is inert or hidden, so a click cannot land on it`);
      let focusTarget = target;
      while (focusTarget instanceof FakeElement && !focusable(focusTarget)) focusTarget = focusTarget.parentNode;
      document.focused = focusTarget instanceof FakeElement ? focusTarget : null;
      dispatchClick(target);
      await settle();
    },
    async resize(nextWidth) {
      viewport.width = nextWidth;
      for (const list of mediaLists) {
        const now = mediaMatches(list.media, viewport);
        if (now === list.matches) continue;
        list.matches = now;
        const change = new Event("change");
        Object.defineProperties(change, { matches: { value: now }, media: { value: list.media } });
        list.dispatchEvent(change);
      }
      window.dispatchEvent(new Event("resize"));
      await settle();
    },
  };
  return page;
}

// The page after mount: every effect has run and every fetch has resolved.
async function openPage(options) {
  const page = createPage(options);
  await page.settle();
  page.closedTargets = new Set(page.clickTargets());
  return page;
}

// ---- The behaviour ----------------------------------------------------------

test("#1198: the mobile menu button is the first Tab stop, before and after TopHeader mounts", async () => {
  const page = createPage();
  assert.equal(accessibleName(page.tabOrder()[0]), "Open sidebar", "the hydrating render already starts with the menu button");

  await page.settle();
  const order = page.tabOrder();
  assertSame(order[0], page.menuButton(), "after mount it stays first, ahead of the header's own controls");
  assert.ok(order.indexOf(page.button("About QuadWork")) > 0, "fixture: the mounted header's controls are in the Tab order");
  await page.press("Tab");
  assertSame(page.active(), page.menuButton(), "the first Tab from the top of the page lands on it");
});

test("#1198: opening the drawer moves focus into it", async () => {
  const page = await openPage();
  await page.press("Tab");
  assertSame(page.active(), page.menuButton(), "fixture: the first Tab reaches the menu button");
  assert.equal(page.drawerOpen(), false, "fixture: the drawer starts closed");

  await page.press("Enter");
  assert.equal(page.drawerOpen(), true, "Enter on the menu button opened the drawer");
  assertSame(page.active(), page.drawerStops()[0], "focus is on the drawer's first control, not left on the menu button");
});

test("#1198: Tab and Shift+Tab stay inside the open drawer", async () => {
  const page = await openPage();
  await page.click(page.menuButton());
  const stops = page.drawerStops();
  const order = page.tabOrder();
  assert.ok(stops.length >= 3, "fixture: the drawer has a first, a middle and a last control");
  assert.ok(order.indexOf(stops[0]) > 0 && order.indexOf(stops.at(-1)) < order.length - 1,
    "fixture: the page has Tab stops before and after the drawer to leak to");
  assertSame(page.active(), stops[0], "opening put focus on the first control");

  for (let i = 1; i <= stops.length; i++) {
    await page.press("Tab");
    assertSame(page.active(), stops[i % stops.length], `Tab ${i} moves to the next drawer control, wrapping at the end`);
  }
  for (let i = 1; i <= stops.length; i++) {
    await page.press("Tab", { shiftKey: true });
    assertSame(page.active(), stops[(stops.length - i) % stops.length], `Shift+Tab ${i} moves back, wrapping at the start`);
  }

  // Focus put outside the drawer while it is open comes back in at either end.
  page.menuButton().focus();
  await page.press("Tab");
  assertSame(page.active(), stops[0], "Tab from outside enters at the first control");
  page.menuButton().focus();
  await page.press("Tab", { shiftKey: true });
  assertSame(page.active(), stops.at(-1), "Shift+Tab from outside enters at the last control");
});

for (const [closer, close] of [
  ["Escape", (page) => page.press("Escape")],
  ["the close button", (page) => page.click(page.button("Close sidebar"))],
  ["the overlay", (page) => page.click(page.overlay())],
]) {
  test(`#1198: ${closer} closes the drawer, returns focus to the menu button and releases Tab`, async () => {
    const page = await openPage();
    await page.click(page.menuButton());
    await page.press("Tab");
    assert.ok(page.drawer().contains(page.active()), "fixture: focus is inside the open drawer");

    await close(page);
    assert.equal(page.drawerOpen(), false, "the drawer closed");
    assertSame(page.active(), page.menuButton(), "focus is back on the menu button");
    const tab = await page.press("Tab");
    assert.equal(tab.defaultPrevented, false, "Tab is no longer trapped");
    assertSame(page.active(), page.tabOrder()[1], "Tab moves on from the menu button");
  });
}

test("#1198: reaching Tailwind's lg closes the drawer and releases Tab, at a 16px or 20px default font size", async () => {
  // Tailwind's lg, which the drawer's `lg:hidden` compiles to: globals.css's
  // own --breakpoint-lg if it sets one, else the theme's. The drawer must close
  // at that same width, and a media-query rem follows the browser's default
  // font size, so a px threshold would drift from it.
  const breakpointLg = (file) => /--breakpoint-lg:\s*([^;]+);/.exec(fs.readFileSync(file, "utf8"))?.[1].trim();
  const lg = breakpointLg(path.join(SRC, "app/globals.css")) || breakpointLg(require.resolve("tailwindcss/theme.css"));
  assert.match(lg, /^\d+(\.\d+)?rem$/, "Tailwind's lg is a rem width");

  for (const defaultFontSize of [16, 20]) {
    const lgPx = parseFloat(lg) * defaultFontSize;
    const page = await openPage({ width: 390, defaultFontSize });
    await page.click(page.menuButton());
    await page.resize(lgPx - 1);
    assert.equal(page.drawerOpen(), true, `${defaultFontSize}px default font: still open 1px below lg (${lgPx}px)`);

    await page.resize(lgPx);
    assert.equal(page.drawerOpen(), false, `${defaultFontSize}px default font: closed at lg`);
    const about = page.button("About QuadWork");
    about.focus();
    const tab = await page.press("Tab");
    assert.equal(tab.defaultPrevented, false, `${defaultFontSize}px default font: Tab is no longer trapped`);
    assertSame(page.active(), page.tabOrder()[page.tabOrder().indexOf(about) + 1], `${defaultFontSize}px default font: Tab moves on from About`);

    // Crossing lg again, as a second tablet rotation does, closes it again.
    await page.resize(lgPx - 1);
    await page.click(page.menuButton());
    assert.equal(page.drawerOpen(), true, `${defaultFontSize}px default font: fixture: reopened below lg`);
    await page.resize(lgPx);
    assert.equal(page.drawerOpen(), false, `${defaultFontSize}px default font: closed at lg again`);
  }
});

test("#1198: opening the sidebar closes an open presets menu", async () => {
  const page = await openPage();
  const presetsOpen = () => page.document.querySelectorAll("span").some((el) => el.textContent === "Message Presets");
  const newPresetForm = () => page.document.querySelector('[placeholder="Preset title"]');
  await page.click(page.button("Preset"));
  await page.click(page.button("+ New"));
  assert.ok(presetsOpen() && Boolean(newPresetForm()), "fixture: the presets menu is open on an unsaved new preset");

  await page.click(page.menuButton());
  assert.equal(page.drawerOpen(), true, "the drawer opened");
  assert.equal(presetsOpen(), false, "the presets menu closed");

  await page.press("Escape");
  await page.click(page.button("Preset"));
  assert.ok(presetsOpen(), "fixture: the presets menu opens again");
  assert.ok(!newPresetForm(), "it closed as its own close does, dropping the unsaved preset");
});

test("#1198: the drawer's close button is named \"Close sidebar\"", async () => {
  const page = await openPage();
  await page.click(page.menuButton());
  const named = page.drawerStops().filter((el) => accessibleName(el) === "Close sidebar");
  assert.equal(named.length, 1, "one drawer control is named Close sidebar");
  assert.equal(named[0].localName, "button");

  await page.click(named[0]);
  assert.equal(page.drawerOpen(), false, "and it is the control that closes the drawer");
});

test("#1205: below lg, the closed drawer is out of the Tab order and hidden from assistive technology", async () => {
  assert.equal(createPage().drawerStops().length, 0, "the hydrating render already keeps the closed drawer out of the Tab order");
  const page = await openPage();
  assert.equal(page.drawerOpen(), false, "fixture: the drawer starts closed");
  assert.ok(page.drawerControls().length >= 3 && page.drawerControls().includes(page.button("Close sidebar")),
    "fixture: the closed drawer still renders its close button and sidebar controls");
  const dom = descendants(page.document.documentElement);
  const afterDrawer = (el) => dom.indexOf(el) > dom.indexOf(page.drawer());
  assert.ok(page.tabOrder().some(afterDrawer) && !page.tabOrder().every(afterDrawer),
    "fixture: the page has Tab stops before and after the drawer, so a walk passes it");

  const checkClosed = async (when) => {
    assert.equal(page.drawer().getAttribute("hidden"), null, `${when}: the closed drawer stays displayed, so it can still slide`);
    // From the menu button, all the way around the page and back, both ways.
    for (const shiftKey of [false, true]) {
      const keys = shiftKey ? "Shift+Tab" : "Tab";
      const order = page.tabOrder(), visited = new Set();
      page.menuButton().focus();
      for (let i = 1; i <= order.length + 1; i++) {
        await page.press("Tab", { shiftKey });
        if (page.drawer().contains(page.active())) assert.fail(`${when}: ${keys} ${i} from the menu button focused ${show(page.active())} in the closed drawer`);
        visited.add(page.active());
      }
      assert.ok(order.every((el) => visited.has(el)), `${when}: ${keys} reached every Tab stop on the page`);
      assertSame(page.active(), page.menuButton(), `${when}: ${keys} went around the page and back to the menu button`);
    }
    for (const el of page.drawerControls()) {
      if (exposed(el)) assert.fail(`${when}: ${show(el)} in the closed drawer is exposed to assistive technology`);
    }
  };

  await checkClosed("before opening");
  await page.click(page.menuButton());
  assert.equal(page.drawerOpen(), true, "fixture: the drawer opened");
  for (const el of page.drawerControls()) {
    if (!exposed(el)) assert.fail(`open: ${show(el)} is hidden from assistive technology`);
  }
  await page.press("Escape");
  assert.equal(page.drawerOpen(), false, "fixture: Escape closed the drawer");
  await checkClosed("after closing");
});

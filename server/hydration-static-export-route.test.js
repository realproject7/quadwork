"use strict";
/**
 * #1067 — React #418 ("hydration failed because the initial UI does not match
 * what was rendered on the server") on the statically exported dynamic routes.
 *
 * next.config.ts sets `output: "export"`, and both dynamic routes declare
 * `generateStaticParams() -> [{ id: "_" }]`. The export therefore contains a
 * single prerendered document per route (out/project/_.html) whose server HTML
 * was produced with the pathname "/project/_". Express serves that same
 * document for every real project id (SPA fallback), so in the browser
 * `usePathname()` returns "/project/<real-id>" while the HTML being hydrated is
 * the "_" render. Any first-render output that depends on the pathname is
 * therefore guaranteed to mismatch.
 *
 * This harness loads the real route sources, renders them under both pathnames,
 * and asserts the first render (server pass == client's hydrating pass, before
 * effects) is pathname-independent. It also renders the post-mount pass so the
 * fix cannot degenerate into "render nothing, ever".
 *
 * Deliberately dependency-free: TSX is transpiled with the repo's own
 * `typescript` and rendered with `react-dom/server`. There is no DOM
 * implementation in this repo, so `hydrateRoot` cannot be exercised here; the
 * markup equivalence below is the Node-side proxy for it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const ROOT = path.resolve(__dirname, "..");

const ROUTES = [
  {
    label: "/project/[id]",
    file: "src/app/project/[id]/ProjectPageClient.tsx",
    prerender: "/project/_",
    runtime: "/project/qw-v2-hyd",
  },
  {
    label: "/project/[id]/queue",
    file: "src/app/project/[id]/queue/QueuePageClient.tsx",
    prerender: "/project/_/queue",
    runtime: "/project/qw-v2-hyd/queue",
  },
];

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  }).outputText;
}

/**
 * Minimal hook host. Lets the test drive the two renders React performs on the
 * client — the hydrating pass (no effects run yet) and the pass after mount
 * effects have flushed — without a DOM. Validated against real react-dom/server
 * in the "harness agrees with react-dom/server" test below.
 */
function createHookHost() {
  const host = { cells: {}, cursor: 0, effects: [], observedPathnames: [], dynamicOptions: [] };
  host.react = {
    ...React,
    useState(initial) {
      const key = `s${host.cursor++}`;
      if (!(key in host.cells)) host.cells[key] = typeof initial === "function" ? initial() : initial;
      const set = (next) => {
        host.cells[key] = typeof next === "function" ? next(host.cells[key]) : next;
      };
      return [host.cells[key], set];
    },
    useEffect(fn) {
      host.effects.push(fn);
    },
    useRef(initial) {
      const key = `r${host.cursor++}`;
      if (!(key in host.cells)) host.cells[key] = { current: initial };
      return host.cells[key];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  return host;
}

function instantiate({ source, fileName, pathname, reactModule, host }) {
  const js = transpile(source, fileName);
  const requireStub = (id) => {
    if (id === "react") return reactModule;
    if (id === "react/jsx-runtime" || id === "react/jsx-dev-runtime") return require(id);
    if (id === "next/navigation") {
      return {
        usePathname: () => {
          host.observedPathnames.push(pathname);
          return pathname;
        },
      };
    }
    if (id === "next/dynamic") {
      return {
        __esModule: true,
        default: (loader, options) => {
          host.dynamicOptions.push(options || {});
          // Stands in for the client-only panel. It renders the same marker in
          // every pass, so it is neutral for the server/client equivalence
          // check, and it echoes the projectId it was handed so the post-mount
          // assertions can tell "panel mounted with the real id" apart from
          // "rendered nothing".
          const Placeholder = (props) =>
            React.createElement("div", { "data-dynamic-panel": String(props.projectId ?? "") });
          Placeholder.displayName = "DynamicPlaceholder";
          return Placeholder;
        },
      };
    }
    throw new Error(`${fileName}: unexpected require(${JSON.stringify(id)}) — extend the harness`);
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", js)(requireStub, mod, mod.exports);
  return mod.exports.default;
}

/** Render a route source under one pathname: hydrating pass, then post-mount pass. */
function renderRoute({ source, fileName, pathname }) {
  const host = createHookHost();
  const Component = instantiate({ source, fileName, pathname, reactModule: host.react, host });
  assert.equal(typeof Component, "function", `${fileName} must default-export a component`);

  host.cursor = 0;
  const hydrating = renderToStaticMarkup(Component({}));

  for (const effect of host.effects.splice(0)) effect();
  host.cursor = 0;
  const mounted = renderToStaticMarkup(Component({}));

  return { hydrating, mounted, host };
}

/** Same first render, but driven entirely by real React under real SSR. */
function renderRouteWithReactSSR({ source, fileName, pathname }) {
  const host = createHookHost();
  const Component = instantiate({ source, fileName, pathname, reactModule: React, host });
  return renderToStaticMarkup(React.createElement(Component));
}

function readRoute(route) {
  return fs.readFileSync(path.join(ROOT, route.file), "utf8");
}

for (const route of ROUTES) {
  test(`${route.label}: the hydrating render does not depend on the pathname`, () => {
    const source = readRoute(route);
    const server = renderRoute({ source, fileName: route.file, pathname: route.prerender });
    const client = renderRoute({ source, fileName: route.file, pathname: route.runtime });

    // Guard the test's own inputs: if both renders saw the same pathname the
    // equivalence below would hold vacuously.
    assert.notDeepEqual(
      new Set(server.host.observedPathnames),
      new Set(client.host.observedPathnames),
      `both renders of ${route.file} observed the same pathname — the equivalence ` +
        `assertion below would pass vacuously`
    );
    assert.equal(
      client.hydrating,
      server.hydrating,
      `${route.file} renders different markup for the prerendered pathname ` +
        `(${route.prerender}) and the runtime pathname (${route.runtime}). The static ` +
        `export ships the former and the browser hydrates it at the latter, so this is ` +
        `React #418.\n  prerendered: ${JSON.stringify(server.hydrating)}\n  runtime:     ` +
        `${JSON.stringify(client.hydrating)}`
    );
  });

  test(`${route.label}: the post-mount render still shows the real project`, () => {
    const source = readRoute(route);
    const client = renderRoute({ source, fileName: route.file, pathname: route.runtime });

    assert.notEqual(
      client.mounted,
      client.hydrating,
      `${route.file} never renders anything for ${route.runtime}: the hydration fix must ` +
        `defer the pathname-derived render to after mount, not remove it.`
    );
    assert.match(
      client.mounted,
      /data-dynamic-panel="qw-v2-hyd"/,
      `${route.file} did not mount its client-only panel with the real project id after ` +
        `mount; got ${JSON.stringify(client.mounted)}`
    );

    // The placeholder pathname must stay blank even after mount — that guard is
    // what stops the export's own /project/_ document loading a bogus project.
    const placeholder = renderRoute({ source, fileName: route.file, pathname: route.prerender });
    assert.equal(
      placeholder.mounted,
      placeholder.hydrating,
      `${route.file} must keep rendering nothing for the placeholder id at ${route.prerender}`
    );
  });

  test(`${route.label}: the pathname is still the id source and the panel stays client-only`, () => {
    const source = readRoute(route);
    const client = renderRoute({ source, fileName: route.file, pathname: route.runtime });

    assert.ok(
      client.host.observedPathnames.length > 0,
      `${route.file} no longer reads usePathname(); the project id would stop tracking ` +
        `client-side navigation between projects.`
    );
    assert.deepEqual(
      client.host.dynamicOptions.map((o) => o.ssr),
      [false],
      `${route.file} must keep exactly one next/dynamic import with ssr:false (#102)`
    );
  });

  test(`${route.label}: harness agrees with react-dom/server`, () => {
    const source = readRoute(route);
    for (const pathname of [route.prerender, route.runtime]) {
      const viaHarness = renderRoute({ source, fileName: route.file, pathname }).hydrating;
      const viaReact = renderRouteWithReactSSR({ source, fileName: route.file, pathname });
      assert.equal(
        viaHarness,
        viaReact,
        `harness hook host diverged from react-dom/server for ${route.file} at ${pathname}`
      );
    }
  });
}

test("negative control: the equivalence check catches a pathname-dependent first render", () => {
  const divergent = `
    "use client";
    import { usePathname } from "next/navigation";
    export default function Control() {
      const id = usePathname().split("/")[2] || "";
      if (!id || id === "_") return null;
      return <div className="control">{id}</div>;
    }
  `;
  const server = renderRoute({ source: divergent, fileName: "control.tsx", pathname: "/project/_" });
  const client = renderRoute({ source: divergent, fileName: "control.tsx", pathname: "/project/real" });

  assert.equal(server.hydrating, "");
  assert.equal(client.hydrating, '<div class="control">real</div>');
  assert.notEqual(
    server.hydrating,
    client.hydrating,
    "the harness failed to observe a known divergence — the route assertions above would pass vacuously"
  );
});

test("negative control: a mount-gated first render is reported as equivalent", () => {
  const gated = `
    "use client";
    import { useEffect, useState } from "react";
    import { usePathname } from "next/navigation";
    export default function Control() {
      const pathname = usePathname();
      const [mounted, setMounted] = useState(false);
      useEffect(() => { setMounted(true); }, []);
      const id = pathname.split("/")[2] || "";
      if (!mounted || !id || id === "_") return null;
      return <div className="control">{id}</div>;
    }
  `;
  const server = renderRoute({ source: gated, fileName: "control.tsx", pathname: "/project/_" });
  const client = renderRoute({ source: gated, fileName: "control.tsx", pathname: "/project/real" });

  assert.equal(server.hydrating, client.hydrating);
  assert.equal(client.mounted, '<div class="control">real</div>');
  assert.equal(server.mounted, "");
});

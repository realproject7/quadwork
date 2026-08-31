// #939: pack-smoke guard — prevention for the 2.3.4 crash-loop (#937 regression).
//
// #937 added `require("../src/lib/injectMode.js")` to runtime Node code
// (bin/quadwork.js, server/index.js, server/routes.js) but `src/` was not in
// package.json `files`, so the published tarball omitted the module and every
// fresh `npm install` crash-looped on boot. It passed review + CI because the
// git checkout HAS `src/lib/`, so the runtime require resolves fine there — the
// failure only appears once the package is packed. Static review of the diff
// can't catch this class; only the *tarball contents* can.
//
// This guard asks npm for the authoritative tarball file list (the real `files`
// whitelist + ignore resolution, not a re-implementation) and asserts that every
// relative `require()` in shipped bin/+server/ code resolves to a file that is
// ALSO in the tarball. A module that exists in the checkout but is missing from
// the pack — the exact #937 signature — fails here instead of in prod.
//
// Uses `npm pack --dry-run --json --ignore-scripts`: --dry-run packs nothing,
// --ignore-scripts skips the slow `prepack` (next build) so this stays fast and
// deterministic in the test runner. Plain node:assert script — run with
// `node server/pack-smoke.test.js`.

const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// 1) Authoritative tarball file list from npm itself.
function tarballFiles() {
  const npmCli = process.platform === "win32" ? "npm.cmd" : "npm";
  const out = execFileSync(
    npmCli,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
  );
  // npm prints the JSON array; tolerate any leading non-JSON warning lines.
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start));
  // Normalize to forward-slash repo-relative paths.
  return new Set((parsed[0]?.files || []).map((f) => f.path.split(path.sep).join("/")));
}

// 2) Resolve a relative require specifier (from `fromFile`) to a repo-relative
//    path, trying Node's file-resolution order. Returns null if it doesn't
//    resolve to an existing file in the checkout.
function resolveRelativeRequire(fromFile, spec) {
  const base = path.resolve(path.dirname(path.join(ROOT, fromFile)), spec);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) {
        return path.relative(ROOT, c).split(path.sep).join("/");
      }
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

// Match require("..."), require('...') with a relative specifier (starts with .).
const REQUIRE_RE = /require\(\s*["'](\.[^"']*)["']\s*\)/g;

(async () => {
  const shipped = tarballFiles();

  // Sanity: the list is non-empty and contains a known runtime entrypoint.
  assert.ok(shipped.size > 0, "npm pack returned a non-empty file list");
  assert.ok(shipped.has("bin/quadwork.js"), "tarball includes bin/quadwork.js");

  // 3) Scan every shipped .js file under bin/ and server/ for relative requires.
  const shippedNodeSrc = [...shipped].filter(
    (f) => /\.js$/.test(f) && (f.startsWith("bin/") || f.startsWith("server/")),
  );
  assert.ok(shippedNodeSrc.length > 0, "found shipped Node source files to scan");

  const violations = [];
  for (const file of shippedNodeSrc) {
    const code = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const m of code.matchAll(REQUIRE_RE)) {
      const spec = m[1];
      const target = resolveRelativeRequire(file, spec);
      // target === null → resolves to nothing in the checkout (e.g. a built
      // artifact dir); not the #937 class, skip. A target that DOES exist in
      // the checkout but is absent from the tarball is the bug we guard.
      if (target && !shipped.has(target)) {
        violations.push({ file, spec, target });
      }
    }
  }

  if (violations.length) {
    const lines = violations
      .map((v) => `  ${v.file}: require("${v.spec}") → ${v.target} (NOT in tarball)`)
      .join("\n");
    assert.fail(
      `Runtime require(s) resolve to files missing from the npm tarball — ` +
        `published install would crash (#937 class). Add the path(s) to package.json "files":\n${lines}`,
    );
  }

  // 4) Regression anchor: the exact #937 module is required AND shipped.
  assert.ok(
    shipped.has("src/lib/injectMode.js"),
    'src/lib/injectMode.js is require()d by runtime code and must stay in the tarball (#937)',
  );
  assert.ok(
    shipped.has("src/lib/batchIdentity.js"),
    "Operator MCP batch actions require the shared assignment-identity helper in installed packages (#1031)",
  );

  // 5) fs-loaded / dynamically-required assets the literal-require scan can't
  //    see (#976). These are read at runtime by path (seed reseeding reads the
  //    template files; the operator MCP loads its tool modules dynamically), so
  //    a `files` regression that drops them wouldn't trip the require scan above
  //    — it would only surface as a broken install. Assert they ship.
  const assetTargets = [];

  // Seed templates: every AGENTS.md seed + the top-level CLAUDE.md template.
  const seedDir = path.join(ROOT, "templates", "seeds");
  const seedFiles = fs
    .readdirSync(seedDir)
    .filter((f) => f.endsWith(".AGENTS.md"))
    .map((f) => `templates/seeds/${f}`);
  assert.ok(seedFiles.length > 0, "found template AGENTS.md seeds to check");
  assetTargets.push(
    ...seedFiles,
    "templates/seeds/HEAD-PO-PLAYBOOK.md",
    "templates/CLAUDE.md",
  );
  const playbook = fs.readFileSync(path.join(seedDir, "HEAD-PO-PLAYBOOK.md"), "utf8");
  assert.match(playbook, /\*\*Playbook version:\*\*\s+\d+\.\d+\.\d+/,
    "Head PO playbook carries a visible semantic version");

  // Operator MCP tool modules (dynamically loaded, not literal-required).
  const toolsDir = path.join(ROOT, "server", "mcp-operator", "tools");
  const toolFiles = fs
    .readdirSync(toolsDir)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .map((f) => `server/mcp-operator/tools/${f}`);
  assert.ok(toolFiles.length > 0, "found operator MCP tool modules to check");
  assetTargets.push(...toolFiles);

  // Resource policy apply invokes this fixed source-owned helper by path to
  // obtain Linux renameat2(RENAME_EXCHANGE); it is not visible to require().
  assetTargets.push("server/resource-rename-exchange-helper.py");

  const missingAssets = assetTargets.filter((t) => !shipped.has(t));
  assert.deepEqual(
    missingAssets,
    [],
    `Runtime assets missing from the npm tarball — published install would be ` +
      `broken (#976). Add the path(s) to package.json "files":\n` +
      missingAssets.map((m) => `  ${m} (NOT in tarball)`).join("\n"),
  );

  console.log(
    `PASS: pack-smoke — ${shippedNodeSrc.length} shipped Node files scanned, ` +
      `all relative requires resolve inside the tarball; ` +
      `${assetTargets.length} runtime assets present`,
  );
  console.log("server/pack-smoke.test.js: all assertions passed");
  process.exit(0);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

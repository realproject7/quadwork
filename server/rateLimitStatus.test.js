"use strict";

// #1187: when `gh api rate_limit` fails, the GitHub header badge must show an
// unknown state, not the server's default 5000/5000 budget. This drives the
// real /api/github/rate-limit handler with a failing, then succeeding, then
// failing gh fixture and feeds every response to the same predicates that
// GitHubRateLimitBadge renders from, so the server fields and the badge's
// reading of them are checked against each other. The real badge component
// also renders those responses in en and ko, without a DOM library (the
// ts.transpileModule precedent in server/terminalLifecycleControls.test.js).

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ts = require("typescript");

let ghFails = true;
const nowSec = Math.floor(Date.now() / 1000);
const RATE_JSON = JSON.stringify({
  core: { limit: 5000, remaining: 4321, reset: nowSec + 3600 },
  graphql: { limit: 5000, remaining: 3999, reset: nowSec + 3600 },
  search: { limit: 30, remaining: 29, reset: nowSec + 60 },
});
require("./__tests__/resource-executor-fixture").installResourceExecutorFixture({
  runControlChild: (command, args) => {
    if (command === "gh" && Array.isArray(args) && args.includes("rate_limit")) {
      return ghFails
        ? Promise.reject(new Error("gh: not logged in (test fixture)"))
        : Promise.resolve({ stdout: RATE_JSON, stderr: "" });
    }
    return Promise.reject(new Error(`unexpected control child in test: ${command}`));
  },
});

// Never read the operator's ~/.quadwork: a fixed config, and a reviewer token
// that exists only while a scenario sets it.
const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const TOKEN_PATH = path.join(os.homedir(), ".quadwork", "reviewer-token");
let reviewerToken = null;
const realRead = fs.readFileSync;
fs.readFileSync = function stubRead(p, ...rest) {
  if (p === CONFIG_PATH) return JSON.stringify({ projects: [] });
  if (p === TOKEN_PATH && reviewerToken !== null) return reviewerToken;
  if (typeof p === "string" && (p === TOKEN_PATH || p.endsWith("reviewer-token"))) {
    const err = new Error("ENOENT (test stub)");
    err.code = "ENOENT";
    throw err;
  }
  return realRead.call(this, p, ...rest);
};

const routes = require("./routes");
const { mainRateLimitKnown, reviewerRateLimitKnown } = require("../src/lib/rateLimitStatus");

const layer = routes.stack.find((l) => l.route && l.route.path === "/api/github/rate-limit");
assert.ok(layer, "the rate-limit route is registered");
async function getRateLimit() {
  let body;
  await layer.route.stack[0].handle({ query: {} }, { json: (b) => { body = b; } });
  return body;
}

// Mounts GitHubRateLimitBadge in `locale` with a fetch double serving `body`,
// runs its load effect, and returns the rendered text and title attributes.
const BADGE_FILE = path.join(__dirname, "../src/components/GitHubRateLimitBadge.tsx");
const BADGE_JS = ts.transpileModule(fs.readFileSync(BADGE_FILE, "utf8"), {
  fileName: BADGE_FILE,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== "object") return;
  yield node;
  yield* walk(node.props && node.props.children);
}
const textOf = (node) => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return node && node.props ? textOf(node.props.children) : "";
};
async function renderBadge(body, locale) {
  const cells = [];
  let cursor = 0;
  const effects = [];
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [cells[index], (value) => { cells[index] = value; }];
    },
    useEffect(effect) { effects.push(effect); },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", "fetch", "setInterval", "clearInterval", BADGE_JS)((name) => {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return require(name);
    if (name === "@/components/LocaleProvider") return { useLocale: () => ({ locale }) };
    if (name === "@/lib/rateLimitStatus") return require("../src/lib/rateLimitStatus");
    throw new Error(`Unexpected dependency ${name}`);
  }, mod, mod.exports, async () => ({ ok: true, json: async () => body }), () => 0, () => {});
  const render = () => { cursor = 0; effects.length = 0; return mod.exports.default({ projectId: "p" }); };
  render();
  const cleanups = effects.map((effect) => effect());
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  const tree = render();
  for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
  return { text: textOf(tree), titles: [...walk(tree)].map((n) => n.props.title).filter(Boolean) };
}

let passed = 0;
const pass = (message) => { passed++; console.log(`  PASS: ${message}`); };

(async () => {
  // The module-load refresh runs with the failing fixture.
  await new Promise((resolve) => setTimeout(resolve, 50));

  let body = await getRateLimit();
  assert.ok(body.error, "the failed lookup is reported");
  assert.equal(body.core.remaining, 5000, "the server still carries its default budget");
  assert.equal(body.core.limit, 5000);
  assert.equal(mainRateLimitKnown(body), false);
  assert.equal("reviewer" in body, false, "no reviewer token, no reviewer block");
  pass("a failed first lookup reads as unknown, not the 5000/5000 default");

  let en = await renderBadge(body, "en");
  let ko = await renderBadge(body, "ko");
  assert.equal(en.text, "●rate limit unknown");
  assert.deepEqual(en.titles, ["GitHub rate limit unknown: the gh rate-limit lookup failed or has not run yet."]);
  assert.equal(ko.text, "●API 제한 알 수 없음");
  assert.deepEqual(ko.titles, ["GitHub API 제한을 알 수 없습니다. gh 조회가 실패했거나 아직 실행되지 않았습니다."]);
  for (const rendered of [en, ko]) assert.doesNotMatch(rendered.text, /5000|30\/30/);
  pass("the badge renders the failed lookup as unknown in en and ko, never 5000/5000");

  ghFails = false;
  await routes.refreshRateLimit();
  body = await getRateLimit();
  assert.equal(body.error, null);
  assert.equal(mainRateLimitKnown(body), true);
  assert.equal(body.core.remaining, 4321);
  assert.equal(body.graphql.remaining, 3999);
  pass("a successful lookup reads as known with the real budget");

  for (const locale of ["en", "ko"]) {
    const rendered = await renderBadge(body, locale);
    assert.equal(rendered.text, "●core4321/5000●gql3999/5000●search29/30");
  }
  pass("the badge renders the real budget after a successful lookup");

  ghFails = true;
  await routes.refreshRateLimit();
  body = await getRateLimit();
  assert.equal(body.core.remaining, 4321, "the server keeps the last values after a failure");
  assert.equal(mainRateLimitKnown(body), false);
  pass("a later failed lookup reads as unknown instead of the last values");

  assert.equal(mainRateLimitKnown({ error: null, updatedAt: 0, core: { limit: 5000, remaining: 5000 } }), false);
  assert.equal(mainRateLimitKnown(null), false);
  pass("a lookup that has not run yet reads as unknown");

  // Reviewer account: its own token and its own lookup.
  reviewerToken = "placeholder-not-a-token\n";
  ghFails = false;
  body = await getRateLimit();
  assert.equal(reviewerRateLimitKnown(body.reviewer), true);
  assert.equal(body.reviewer.graphql.remaining, 3999);
  pass("a successful reviewer lookup reads as known");

  // Each reviewer re-poll below happens after the 60s per-token cache window.
  const realNow = Date.now;
  const getRateLimitAfter = async (offsetMs) => {
    Date.now = () => realNow() + offsetMs;
    try { return await getRateLimit(); } finally { Date.now = realNow; }
  };

  ghFails = true;
  body = await getRateLimitAfter(61_000);
  assert.equal(body.reviewer.error, true);
  assert.equal("graphql" in body.reviewer, false, "the retained buckets are not sent as current");
  assert.equal(reviewerRateLimitKnown(body.reviewer), false);
  pass("a failed reviewer lookup reads as unknown instead of the last values");

  en = await renderBadge(body, "en");
  ko = await renderBadge(body, "ko");
  assert.equal(en.text, "●rate limit unknown|reviewer:●unknown");
  assert.equal(en.titles[1], "Reviewer rate limit unknown: its gh rate-limit lookup failed.");
  assert.equal(ko.text, "●API 제한 알 수 없음|reviewer:●알 수 없음");
  assert.equal(ko.titles[1], "리뷰어 계정의 API 제한을 알 수 없습니다. gh 조회가 실패했습니다.");
  pass("the badge renders the failed reviewer lookup as unknown in en and ko");

  reviewerToken = null;
  body = await getRateLimitAfter(122_000);
  assert.equal("reviewer" in body, false);
  pass("removing the reviewer token drops the reviewer block");

  console.log(`\n${passed} passed, 0 failed\n`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });

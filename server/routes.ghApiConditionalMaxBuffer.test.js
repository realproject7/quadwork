// #837 regression: ghApiConditional must parse a >1MB closed-PR list page
// rather than crashing on Node's default 1MB execFile maxBuffer. A measured
// realproject7/quadwork `pulls?state=closed&per_page=100` -i page was
// ~1.74MB, which made the call reject with ERR_CHILD_PROCESS_STDIO_MAXBUFFER
// and silently empty "Recently Merged PRs" + disable the #828/#834 fast-path.
//
// Strategy: stub child_process.execFile BEFORE requiring routes.js so the
// `execFile` reference captured by `util.promisify` is our stub. The stub
// simulates a >1MB `gh api -i` response and enforces the caller's maxBuffer
// the same way Node's real execFile does. Then assert ghApiConditional
// returns status:"ok" with parsed body. Plain node:assert script — run with
// `node server/routes.ghApiConditionalMaxBuffer.test.js`.

const assert = require("node:assert/strict");
const util = require("node:util");
const cp = require("child_process");

const realExecFile = cp.execFile;

// Build a deterministic >1MB JSON body that looks like a closed-PR page so
// the test stays meaningful against any future shape tightening.
function buildBigClosedPrPage() {
  const pr = (n) => ({
    number: n,
    title: `PR ${n} ${"x".repeat(900)}`,
    html_url: `https://github.com/o/r/pull/${n}`,
    merged_at: n % 2 ? "2026-01-01T00:00:00Z" : null,
    user: { login: "alice" },
  });
  // 1500 PRs at ~1KB each ≈ 1.5MB body, comfortably over the 1MB default.
  const body = JSON.stringify(Array.from({ length: 1500 }, (_, i) => pr(i + 1)));
  const headers = [
    "HTTP/2.0 200 OK",
    'Etag: "test-etag"',
    "Content-Type: application/json; charset=utf-8",
  ].join("\r\n");
  return `${headers}\r\n\r\n${body}`;
}

const BIG_PAYLOAD = buildBigClosedPrPage();
assert.ok(BIG_PAYLOAD.length > 1024 * 1024, "test fixture must exceed 1MB to exercise the bug");

// Tracks what options ghApiConditional actually passed for the closed-PR call.
let capturedOptions = null;

cp.execFile = function stubExecFile(command, args, options, callback) {
  // Normalize the 3-arg form (no options) — real execFile does this too.
  if (typeof options === "function") { callback = options; options = {}; }
  options = options || {};

  // Only intercept `gh api ...`. Other callers (e.g. rate_limit polling) get
  // a benign empty stdout so require-time side effects don't crash.
  if (command === "gh" && Array.isArray(args) && args[0] === "api") {
    const apiPath = args[1] || "";
    const isClosedPrPage = /pulls\?state=closed/.test(apiPath);
    const payload = isClosedPrPage ? BIG_PAYLOAD : "";

    if (isClosedPrPage) capturedOptions = options;

    const maxBuffer = typeof options.maxBuffer === "number" ? options.maxBuffer : 1024 * 1024;
    if (Buffer.byteLength(payload, "utf8") > maxBuffer) {
      const err = new Error("stdout maxBuffer exceeded");
      err.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      process.nextTick(() => callback(err, "", ""));
      return { kill: () => {} };
    }
    process.nextTick(() => callback(null, payload, ""));
    return { kill: () => {} };
  }

  return realExecFile.call(cp, command, args, options, callback);
};

// child_process.execFile carries a custom util.promisify implementation that
// resolves to `{ stdout, stderr }`. Replacing the function strips that symbol,
// so without re-attaching one the default promisify would resolve to a bare
// stdout string and routes.js's `const { stdout } = await ...` would silently
// destructure `undefined`. Define an equivalent custom impl on the stub.
cp.execFile[util.promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
  cp.execFile(command, args, options, (err, stdout, stderr) => {
    if (err) reject(err); else resolve({ stdout, stderr });
  });
});

const { ghApiConditional, GH_LIST_MAX_BUFFER } = require("./routes");

(async () => {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  // 1) The shared constant must be generous enough that any current closed-PR
  //    page comfortably fits. The acceptance criterion is >= ~32MB.
  ok(GH_LIST_MAX_BUFFER >= 32 * 1024 * 1024, `GH_LIST_MAX_BUFFER (${GH_LIST_MAX_BUFFER}) is at least 32MB`);

  // 2) A >1MB closed-PR page is parsed, not collapsed into status:"error".
  //    This is the exact failure mode from #837.
  const result = await ghApiConditional("o/r#pulls-closed-test", "repos/o/r/pulls?state=closed&per_page=100");
  ok(result.status === "ok", `status is "ok" on >1MB page (got ${JSON.stringify(result.status)})`);
  ok(Array.isArray(result.data) && result.data.length === 1500, `parsed JSON body (got ${Array.isArray(result.data) ? result.data.length : typeof result.data} items)`);
  ok(result.changed === true, "first call reports changed=true");

  // 3) The caller passed an explicit maxBuffer >= the fixture size — proving
  //    the fix is wired through to the actual call (not just present on the
  //    exported constant).
  ok(capturedOptions && typeof capturedOptions.maxBuffer === "number", "ghApiConditional passed an explicit maxBuffer option");
  ok(capturedOptions && capturedOptions.maxBuffer >= BIG_PAYLOAD.length, `passed maxBuffer (${capturedOptions && capturedOptions.maxBuffer}) covers the >1MB page (${BIG_PAYLOAD.length} bytes)`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});

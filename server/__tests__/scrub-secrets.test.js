/**
 * #545: QA verification for #538 PTY scrollback secret scrubbing.
 *
 * Tests the production scrubSecrets / scrubScrollback from server/scrub-secrets.js:
 *  - Redact secrets correctly (SECRET_NAME, API key prefixes, Bearer)
 *  - Pass through normal terminal output unchanged
 *  - Preserve ANSI escape codes on non-secret lines
 *  - Handle edge cases (empty input, very long lines, rapid multi-line output)
 *
 * Integration-level checklist items (resize, reconnect/replay flow,
 * multi-agent isolation, two-tab behavior) are verified by code-path
 * analysis in the PR description — they depend on WS + PTY runtime
 * that cannot be unit-tested without a full server harness.
 */

const { scrubSecrets, scrubScrollback, _REDACTED } = require("../scrub-secrets");

// ---- Tests ----

const assert = require("assert");
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
  }
}

console.log("\n#545 QA — scrubSecrets / scrubScrollback (production module)\n");

// --- 1. Secret redaction (true positives) ---

test("redacts ANTHROPIC_API_KEY=value", () => {
  const input = "ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxx";
  const out = scrubSecrets(input);
  assert(!out.includes("sk-ant-api03"), `got: ${out}`);
  assert(out.includes(_REDACTED));
});

test("redacts DB_PASSWORD: hunter2", () => {
  const out = scrubSecrets("DB_PASSWORD: hunter2");
  assert(!out.includes("hunter2"), `got: ${out}`);
});

test("redacts GITHUB_TOKEN=ghp_...", () => {
  const token = "ghp_" + "A".repeat(36);
  const out = scrubSecrets(`export GITHUB_TOKEN=${token}`);
  assert(!out.includes(token), `got: ${out}`);
});

test("redacts Bearer token header", () => {
  const out = scrubSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
  assert(!out.includes("eyJhbG"), `got: ${out}`);
  assert(out.includes(_REDACTED));
});

test("redacts standalone Bearer (no Authorization: prefix)", () => {
  const out = scrubSecrets("curl -H 'Bearer eyJhbGciOiJIUzI1NiJ9.xxxxxxxxxxxx'");
  assert(!out.includes("eyJhbG"), `got: ${out}`);
  assert(out.includes(`Bearer ${_REDACTED}`));
});

test("redacts sk- OpenAI key inline", () => {
  const key = "sk-" + "a".repeat(48);
  const out = scrubSecrets(`Using key ${key} for request`);
  assert(!out.includes(key), `got: ${out}`);
});

test("redacts Slack xoxb token", () => {
  const token = "xoxb-" + "1234567890-" + "A".repeat(20);
  const out = scrubSecrets(`SLACK_TOKEN=${token}`);
  assert(!out.includes(token), `got: ${out}`);
});

// --- 2. Normal output passes through unchanged ---

test("preserves plain text", () => {
  const input = "Hello, world! This is normal output.";
  assert.strictEqual(scrubSecrets(input), input);
});

test("preserves npm install output", () => {
  const input = "added 1423 packages in 45s\n182 packages are looking for funding";
  assert.strictEqual(scrubSecrets(input), input);
});

test("preserves git clone output", () => {
  const input = "Cloning into 'repo'...\nremote: Enumerating objects: 1234, done.\nReceiving objects: 100% (1234/1234)";
  assert.strictEqual(scrubSecrets(input), input);
});

test("preserves test runner output", () => {
  const input = "Tests: 42 passed, 42 total\nTime: 3.456 s";
  assert.strictEqual(scrubSecrets(input), input);
});

test("preserves JSON output without secrets", () => {
  const input = '{"status":"ok","count":42,"items":["a","b","c"]}';
  assert.strictEqual(scrubSecrets(input), input);
});

// --- 3. ANSI escape code handling ---

test("preserves ANSI colors on non-secret lines", () => {
  const input = "\x1b[32m✓\x1b[0m test passed";
  assert.strictEqual(scrubSecrets(input), input);
});

test("redacts secret even inside ANSI-styled line", () => {
  const input = "\x1b[33mAPI_KEY=\x1b[31msecretvalue123\x1b[0m";
  const out = scrubSecrets(input);
  assert(!out.includes("secretvalue123"), `got: ${out}`);
  assert(out.includes(_REDACTED));
});

test("ANSI bold output without secrets passes through", () => {
  const input = "\x1b[1mBuilding project...\x1b[0m\nCompiled successfully.";
  assert.strictEqual(scrubSecrets(input), input);
});

// --- 4. Edge cases ---

test("handles empty string", () => {
  assert.strictEqual(scrubSecrets(""), "");
});

test("handles null/undefined", () => {
  assert.strictEqual(scrubSecrets(null), null);
  assert.strictEqual(scrubSecrets(undefined), undefined);
});

test("handles very long line (>1000 chars) without secrets", () => {
  const longLine = "x".repeat(2000);
  assert.strictEqual(scrubSecrets(longLine), longLine);
});

test("handles very long line with embedded secret", () => {
  const prefix = "a".repeat(500);
  const suffix = "b".repeat(500);
  const key = "sk-" + "c".repeat(48);
  const input = `${prefix} ${key} ${suffix}`;
  const out = scrubSecrets(input);
  assert(!out.includes(key), `key should be redacted`);
});

test("handles rapid multi-line output (100 lines)", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: output data here`);
  const input = lines.join("\n");
  assert.strictEqual(scrubSecrets(input), input);
});

test("handles multi-line with mixed secrets and normal output", () => {
  const input = [
    "Starting deploy...",
    "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE",
    "Uploading artifacts...",
    "Bearer eyJhbGciOiJIUzI1NiJ9.xxxxxxxxxxxx",
    "Deploy complete!",
  ].join("\n");
  const out = scrubSecrets(input);
  assert(out.includes("Starting deploy..."));
  assert(out.includes("Uploading artifacts..."));
  assert(out.includes("Deploy complete!"));
  assert(!out.includes("AKIAIOSFODNN7EXAMPLE"));
  assert(!out.includes("eyJhbGci"));
});

// --- 5. scrubScrollback (Buffer handling) ---

test("scrubScrollback returns Buffer", () => {
  const buf = Buffer.from("SOME_SECRET_KEY=abc123\nnormal line");
  const out = scrubScrollback(buf);
  assert(Buffer.isBuffer(out), "should return a Buffer");
  assert(!out.toString().includes("abc123"));
});

test("scrubScrollback handles empty buffer", () => {
  const buf = Buffer.alloc(0);
  const out = scrubScrollback(buf);
  assert(Buffer.isBuffer(out));
  assert.strictEqual(out.length, 0);
});

test("scrubScrollback handles null", () => {
  assert.strictEqual(scrubScrollback(null), null);
});

test("scrubScrollback preserves non-secret content", () => {
  const content = "Hello world\nBuild succeeded\n42 tests passed";
  const buf = Buffer.from(content);
  const out = scrubScrollback(buf);
  assert.strictEqual(out.toString(), content);
});

// --- 6. Integration path verification ---
// These tests verify that server/index.js imports from the same module
// we're testing, ensuring no copy-paste drift.

test("server/index.js imports scrubSecrets from scrub-secrets.js", () => {
  const serverSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "index.js"), "utf-8"
  );
  assert(
    serverSource.includes('require("./scrub-secrets")') ||
    serverSource.includes("require('./scrub-secrets')"),
    "server/index.js must import from ./scrub-secrets"
  );
});

test("server/index.js uses scrubSecrets in PTY data handler", () => {
  const serverSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "index.js"), "utf-8"
  );
  assert(serverSource.includes("scrubSecrets(data)"), "live PTY path must call scrubSecrets");
});

test("server/index.js uses scrubScrollback in replay handler", () => {
  const serverSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "index.js"), "utf-8"
  );
  assert(serverSource.includes("scrubScrollback(session.scrollback)"), "replay path must call scrubScrollback");
});

// --- Summary ---

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);

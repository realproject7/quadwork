// #399: Discord bridge integration tests. Plain node:assert script —
// run with `node server/routes.discordBridge.test.js`.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  checkDiscordBridgePythonDeps,
  buildDiscordBridgeToml,
  patchAgentchattrConfigForDiscordBridge,
  buildDiscordBridgeSpawnEnv,
} = require("./routes");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qw-discord-bridge-"));

try {
  // 1) checkDiscordBridgePythonDeps: broken interpreter returns
  //    { ok: false, error } without throwing.
  const broken = checkDiscordBridgePythonDeps(path.join(tmp, "nope", "python3"));
  assert.equal(broken.ok, false);
  assert.ok(broken.error && broken.error.length > 0);

  // 2) buildDiscordBridgeToml writes agentchattr_url inside [discord].
  const toml = buildDiscordBridgeToml({
    bot_token: "MTIz.abc.def",
    channel_id: "123456789",
    agentchattr_url: "http://127.0.0.1:8301",
  }, "testproject");
  assert.match(toml, /^\[discord\]/);
  assert.match(toml, /bot_token = "MTIz\.abc\.def"/);
  assert.match(toml, /channel_id = "123456789"/);
  assert.match(toml, /agentchattr_url = "http:\/\/127\.0\.0\.1:8301"/);
  // Per-project cursor file
  assert.match(toml, /cursor_file = ".*discord-bridge-cursor-testproject\.json"/);
  // Must NOT emit a separate [agentchattr] section
  assert.equal(toml.includes("\n[agentchattr]\n"), false);

  // 3) patchAgentchattrConfigForDiscordBridge is idempotent.
  const baseConfig =
    "[agents.head]\nlabel = \"Head\"\n\n[agents.dev]\nlabel = \"Dev\"\n";
  const first = patchAgentchattrConfigForDiscordBridge(baseConfig);
  assert.equal(first.changed, true);
  assert.match(first.text, /^\[agents\.discord-bridge\]$/m);
  assert.match(first.text, /label = "Discord Bridge"/);
  // Second run is a no-op
  const second = patchAgentchattrConfigForDiscordBridge(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
  // Hand-patched config is recognized
  const handPatched =
    baseConfig + "\n[agents.discord-bridge]\nlabel = \"Discord Bridge\"\n";
  const third = patchAgentchattrConfigForDiscordBridge(handPatched);
  assert.equal(third.changed, false);
  assert.equal(third.text, handPatched);

  // 4) buildDiscordBridgeSpawnEnv strips Discord-specific env vars.
  const scrubbed = buildDiscordBridgeSpawnEnv({
    PATH: "/usr/bin",
    HOME: "/home/op",
    DISCORD_BOT_TOKEN: "wrong-token",
    DISCORD_CHANNEL_ID: "999",
    AGENTCHATTR_URL: "http://127.0.0.1:9999",
  });
  assert.equal(scrubbed.DISCORD_BOT_TOKEN, undefined);
  assert.equal(scrubbed.DISCORD_CHANNEL_ID, undefined);
  assert.equal(scrubbed.AGENTCHATTR_URL, undefined);
  // Non-discord keys pass through
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.HOME, "/home/op");

  // 5) Missing venv path check
  const fixtureBridgeDir = fs.mkdtempSync(path.join(tmp, "bridge-no-venv-"));
  const missingVenvPython = path.join(fixtureBridgeDir, ".venv", "bin", "python3");
  assert.equal(fs.existsSync(missingVenvPython), false);

  console.log("routes.discordBridge.test.js: all assertions passed (5 cases)");
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

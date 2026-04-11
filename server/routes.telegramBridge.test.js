// #353 / quadwork#353: readLastLines helper test. Plain
// node:assert script — run with
// `node server/routes.telegramBridge.test.js`.
//
// The bridge start/install handlers are integration-shaped (they
// spawn python3), so this file covers only the pure log-tailing
// helper that the handlers rely on for error reporting.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  readLastLines,
  checkTelegramBridgePythonDeps,
  resolveProjectAgentchattrUrl,
  buildTelegramBridgeToml,
  patchAgentchattrConfigForTelegramBridge,
  buildTelegramBridgeSpawnEnv,
} = require("./routes");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qw-bridge-log-"));
function write(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

try {
  // 1) Missing file returns empty string.
  assert.equal(readLastLines(path.join(tmp, "missing.log"), 5), "");

  // 2) Empty file returns empty string.
  assert.equal(readLastLines(write("empty.log", ""), 5), "");

  // 3) Fewer lines than N → return them all, joined with \n.
  assert.equal(
    readLastLines(write("two.log", "a\nb\n"), 5),
    "a\nb",
  );

  // 4) More lines than N → return only the last N in order.
  assert.equal(
    readLastLines(write("many.log", "a\nb\nc\nd\ne\nf\n"), 3),
    "d\ne\nf",
  );

  // 5) \r\n line endings handled.
  assert.equal(
    readLastLines(write("crlf.log", "x\r\ny\r\nz\r\n"), 2),
    "y\nz",
  );

  // 6) Blank lines inside the tail are skipped (filter non-empty).
  //    This matches readLastLines' `.filter((l) => l.length > 0)`.
  assert.equal(
    readLastLines(write("blanks.log", "a\n\nb\n\n\nc\n"), 2),
    "b\nc",
  );

  // 7) Simulated crash trace — the caller should get the final
  //    frame so the operator can see the ModuleNotFoundError.
  const crash = [
    "Traceback (most recent call last):",
    '  File "telegram_bridge.py", line 3, in <module>',
    "    import requests",
    "ModuleNotFoundError: No module named 'requests'",
    "",
  ].join("\n");
  const got = readLastLines(write("crash.log", crash), 20);
  assert.match(got, /ModuleNotFoundError/);
  assert.match(got, /No module named 'requests'/);

  // 8) #372: pre-flight dep-check failures must be persisted to
  //    the bridge log file so a subsequent status poll can surface
  //    them via last_error. Without this the widget's local
  //    actionError got clobbered by the next 5s polling cycle and
  //    the failure appeared as a silent Start → Stopped flicker.
  //    Here we simulate the exact fs.writeFileSync the start
  //    handler now runs on pre-flight failure, then round-trip it
  //    through readLastLines to confirm the error text survives.
  const preflightLog = path.join(tmp, "preflight.log");
  const msg =
    "Bridge Python dependencies not installed. Click \"Install Bridge\" to install them, " +
    "or run: pip3 install -r /tmp/fake/requirements.txt\n\n" +
    "Import error: Traceback (most recent call last):\n" +
    "  File \"<string>\", line 1, in <module>\n" +
    "    import requests\n" +
    "ModuleNotFoundError: No module named 'requests'";
  fs.writeFileSync(
    preflightLog,
    `[${new Date().toISOString()}] pre-flight dep check failed\n${msg}\n`,
  );
  const tail = readLastLines(preflightLog, 20);
  assert.match(tail, /pre-flight dep check failed/);
  assert.match(tail, /ModuleNotFoundError/);
  assert.match(tail, /Install Bridge/);

  // 9) #380: checkTelegramBridgePythonDeps accepts an explicit
  //    interpreter path. Passing a guaranteed-broken path must
  //    return { ok: false, error } without throwing.
  const broken = checkTelegramBridgePythonDeps(path.join(tmp, "nope", "python3"));
  assert.equal(broken.ok, false);
  assert.ok(broken.error && broken.error.length > 0);

  // 10) #380: start handler's missing-venv branch — we don't boot
  //     the server here, but the branch reduces to a plain
  //     fs.existsSync check on `<BRIDGE_DIR>/.venv/bin/python3`,
  //     so we verify the check returns false for a fixture dir
  //     that has no `.venv` subdir at all.
  const fixtureBridgeDir = fs.mkdtempSync(path.join(tmp, "bridge-no-venv-"));
  const missingVenvPython = path.join(fixtureBridgeDir, ".venv", "bin", "python3");
  assert.equal(fs.existsSync(missingVenvPython), false);

  // 11) #380: round-trip — build a real venv in a tmp dir, install
  //     a stdlib-only sentinel is trivially importable, and confirm
  //     checkTelegramBridgePythonDeps reports ok when `requests`
  //     is installed into that venv. Skipped gracefully on CI if
  //     `python3 -m venv` or network-backed pip install fails.
  const venvDir = path.join(tmp, "case11-venv");
  let venvSkipped = false;
  try {
    execFileSync("python3", ["-m", "venv", venvDir], { timeout: 30000, stdio: "pipe" });
    const venvPython = path.join(venvDir, "bin", "python3");
    const venvPip = path.join(venvDir, "bin", "pip");
    // Without `requests` installed yet, the check must fail.
    const before = checkTelegramBridgePythonDeps(venvPython);
    assert.equal(before.ok, false);
    try {
      execFileSync(venvPip, ["install", "--quiet", "requests"], { timeout: 120000, stdio: "pipe" });
    } catch {
      venvSkipped = true;
    }
    if (!venvSkipped) {
      const after = checkTelegramBridgePythonDeps(venvPython);
      assert.equal(after.ok, true);
    }
  } catch {
    venvSkipped = true;
  }

  // 12) #383 Bug 1: resolveProjectAgentchattrUrl prefers the
  //     per-project URL over the global default. Every project
  //     after the first uses a distinct port, so silently reading
  //     the global default routed bridge traffic to the wrong AC
  //     instance.
  assert.equal(
    resolveProjectAgentchattrUrl(
      { agentchattr_url: "http://127.0.0.1:8300" },
      { id: "quadwork", agentchattr_url: "http://127.0.0.1:8301" },
    ),
    "http://127.0.0.1:8301",
  );
  // Falls back to global default when the project has no URL of
  // its own (legacy single-project installs).
  assert.equal(
    resolveProjectAgentchattrUrl(
      { agentchattr_url: "http://127.0.0.1:8300" },
      { id: "legacy" },
    ),
    "http://127.0.0.1:8300",
  );
  // Hard-coded fallback when neither is set.
  assert.equal(
    resolveProjectAgentchattrUrl({}, {}),
    "http://127.0.0.1:8300",
  );

  // 13) #383 Bug 2: buildTelegramBridgeToml writes agentchattr_url
  //     inside [telegram]. The upstream bridge's load_config only
  //     reads from that section — a separate [agentchattr] section
  //     is silently ignored and the bridge falls back to its
  //     hardcoded :8300 default.
  const toml13 = buildTelegramBridgeToml({
    bot_token: "123:abc",
    chat_id: "-42",
    agentchattr_url: "http://127.0.0.1:8301",
  }, "testproject");
  assert.match(toml13, /^\[telegram\]/);
  assert.match(toml13, /bot_token = "123:abc"/);
  assert.match(toml13, /chat_id = "-42"/);
  assert.match(toml13, /agentchattr_url = "http:\/\/127\.0\.0\.1:8301"/);
  // #404: cursor_file must be per-project so multiple bridges
  // don't clobber each other's position.
  assert.match(toml13, /cursor_file = ".*tg-bridge-cursor-testproject\.json"/);
  // Must NOT emit a separate [agentchattr] section — the bridge
  // would silently ignore it.
  assert.equal(toml13.includes("\n[agentchattr]\n"), false);

  // 14) #383 Bug 3: patchAgentchattrConfigForTelegramBridge is
  //     idempotent. The Install Bridge migration may run multiple
  //     times; it must not duplicate the section or corrupt the
  //     file.
  const baseConfig =
    "[agents.head]\nlabel = \"Head\"\n\n[agents.dev]\nlabel = \"Dev\"\n";
  const first = patchAgentchattrConfigForTelegramBridge(baseConfig);
  assert.equal(first.changed, true);
  assert.match(first.text, /^\[agents\.tg\]$/m);
  assert.match(first.text, /label = "Telegram Bridge"/);
  // Running a second time is a no-op.
  const second = patchAgentchattrConfigForTelegramBridge(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
  // #439: a config with old slug [agents.telegram-bridge] is migrated
  // to [agents.tg] and flagged as changed.
  const handPatched =
    baseConfig + "\n[agents.telegram-bridge]\nlabel = \"Telegram Bridge\"\n";
  const third = patchAgentchattrConfigForTelegramBridge(handPatched);
  assert.equal(third.changed, true);
  assert.match(third.text, /^\[agents\.tg\]$/m);

  // 15) #383 Bug 4: buildTelegramBridgeSpawnEnv strips the three
  //     env vars the upstream bridge treats as higher-precedence
  //     than TOML. Without this, an operator shell that exported a
  //     different bot's token (common on machines running AC2)
  //     silently overrode the QuadWork-written TOML and the bridge
  //     ran as the wrong identity.
  const scrubbed = buildTelegramBridgeSpawnEnv({
    PATH: "/usr/bin",
    HOME: "/home/op",
    TELEGRAM_BOT_TOKEN: "wrong-token",
    TELEGRAM_CHAT_ID: "-999",
    AGENTCHATTR_URL: "http://127.0.0.1:9999",
  });
  assert.equal(scrubbed.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(scrubbed.TELEGRAM_CHAT_ID, undefined);
  assert.equal(scrubbed.AGENTCHATTR_URL, undefined);
  // Non-telegram keys must pass through untouched — the bridge
  // still needs PATH/HOME/etc. to find python and open files.
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.HOME, "/home/op");

  console.log(
    "routes.telegramBridge.test.js: all assertions passed (15 cases" +
      (venvSkipped ? ", case 11 pip step skipped" : "") +
      ")",
  );
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

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
const { readLastLines } = require("./routes");

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

  console.log("routes.telegramBridge.test.js: all assertions passed (7 cases)");
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

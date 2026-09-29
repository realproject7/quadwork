const assert = require("node:assert/strict");
const { refreshTerminalScreen } = require("./terminal-screen-refresh");

const calls = [];
const term = { resize: (cols, rows) => calls.push({ cols, rows }) };

assert.equal(refreshTerminalScreen(term, { cols: 80, rows: 24 }), true);
assert.deepEqual(calls, [
  { cols: 79, rows: 24 },
  { cols: 80, rows: 24 },
], "refresh raises a real resize transition and restores the viewer's exact dimensions");

calls.length = 0;
assert.equal(refreshTerminalScreen(term, { cols: 1, rows: 24 }), true);
assert.deepEqual(calls, [
  { cols: 1, rows: 23 },
  { cols: 1, rows: 24 },
], "one-column terminals use a row transition");

calls.length = 0;
assert.equal(refreshTerminalScreen(term, { cols: 1, rows: 1 }), false);
assert.deepEqual(calls, [], "minimum-size terminals are left untouched");
assert.equal(refreshTerminalScreen(term, { cols: 0, rows: 24 }), false);
assert.deepEqual(calls, [], "invalid dimensions are ignored");

console.log("server/terminal-screen-refresh.test.js: all assertions passed");

// #825 (#797 follow-up): wiring guard for self-heal breaker reset on manual
// stop. server/index.js binds a port at require time, so it can't be unit-
// required; this asserts the integration by source inspection (same approach as
// rate-limit-handling.test.js). The behaviour that clearState actually resets a
// tripped breaker is covered in self-heal.test.js (Test 7).
//
// Plain node:assert script — run with `node server/index.selfHealStop.test.js`.

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf-8");

function span(marker, len = 1400) {
  const s = src.indexOf(marker);
  return s === -1 ? "" : src.slice(s, s + len);
}

function run() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { passed++; console.log(`  PASS: ${m}`); } else { failed++; console.error(`  FAIL: ${m}`); } };

  const stopFn = span("async function stopAgentSession(");
  const restartFn = span("async function restartAgentSession(");

  // stopAgentSession gates the clear behind a clearSelfHeal flag and calls
  // selfHeal.clearState(key) — NOT an unconditional clear (which would reset the
  // #797 breaker on every auto-restart, since restartAgentSession stops first).
  ok(/stopAgentSession\(key,\s*\{[\s\S]*?clearSelfHeal\s*=\s*false/.test(stopFn), "stopAgentSession takes { clearSelfHeal = false } (off by default)");
  ok(/if\s*\(clearSelfHeal\)\s*selfHeal\.clearState\(key\)/.test(stopFn), "stopAgentSession clears self-heal state ONLY when clearSelfHeal is set");

  // restartAgentSession forwards the flag to its internal stop.
  ok(/restartAgentSession\(key,\s*\{\s*reason,\s*clearSelfHeal\s*=\s*false\s*\}/.test(restartFn), "restartAgentSession takes clearSelfHeal (default false)");
  ok(/stopAgentSession\(key,\s*\{\s*clearSelfHeal\s*\}\)/.test(restartFn), "restartAgentSession forwards clearSelfHeal to stopAgentSession");

  // The self-heal AUTO-restart must NOT clear (breaker window must persist).
  ok(/restartAgentSession\(key,\s*\{\s*reason:\s*"thinking-block-400"\s*\}\)/.test(src), "auto-restart (thinking-block-400) does NOT pass clearSelfHeal → breaker preserved");

  // Manual intervention paths DO reset the window.
  ok(/restartAgentSession\(key,\s*\{\s*reason:\s*"manual",\s*clearSelfHeal:\s*true\s*\}\)/.test(src), "manual restart route passes clearSelfHeal: true");
  ok(/stopAgentSession\(key,\s*\{\s*clearSelfHeal:\s*true\s*\}\)/.test(src), "manual stop / full-reset passes clearSelfHeal: true");
  ok(/stopAgentSession\(`\$\{projectId\}\/\$\{agentId\}`,\s*\{\s*clearSelfHeal:\s*true\s*\}\)/.test(src), "project reset loop passes clearSelfHeal: true");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();

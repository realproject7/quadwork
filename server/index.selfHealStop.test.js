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

function span(marker, len = 2200) {
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

  // #1053 keeps the old breaker flag but makes source/authorization explicit:
  // a caller cannot accidentally turn an automatic recovery into an operator
  // restart merely by reusing the helper.
  ok(/restartAgentSession\(key,\s*\{\s*reason,\s*clearSelfHeal\s*=\s*false,\s*lifecycleSource\s*=\s*"operator_restart",\s*operatorAuthorized\s*=\s*false/.test(restartFn), "restartAgentSession distinguishes default operator source from unauthorized automatic recovery");
  ok(/stopAgentSession\(key,\s*\{\s*clearSelfHeal\s*\}\)/.test(restartFn), "restartAgentSession forwards clearSelfHeal to stopAgentSession");

  // The self-heal AUTO-restart must retain an automatic source and must NOT
  // clear the breaker. Its actual process request is later governed by #1053.
  ok(/restartAgentSession\(key,\s*\{\s*reason:\s*"thinking-block-400",\s*lifecycleSource:\s*"self_heal"\s*\}\)/.test(src), "auto-restart uses self_heal source and does NOT pass clearSelfHeal → breaker preserved");

  // Manual intervention paths alone carry the operator source/authority and
  // may reset the legacy detector window.
  ok(/reason:\s*"manual",[\s\S]*?clearSelfHeal:\s*true,[\s\S]*?lifecycleSource:\s*"operator_restart",[\s\S]*?operatorAuthorized:\s*true/.test(src), "manual restart carries operator authority and clearSelfHeal: true");
  ok(/stopAgentSession\(key,\s*\{\s*clearSelfHeal:\s*true\s*\}\)/.test(src), "manual stop / full-reset passes clearSelfHeal: true");
  ok(/stopAgentSession\(`\$\{projectId\}\/\$\{agentId\}`,\s*\{\s*clearSelfHeal:\s*true\s*\}\)/.test(src), "project reset loop passes clearSelfHeal: true");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();

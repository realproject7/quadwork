// #1054: the CI-economy contract is instruction-level behavior, so pin the
// shipped templates and package surface directly. Plain node:assert script;
// server/run-tests.js discovers it automatically.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const template = fs.readFileSync(path.join(root, "templates", "CLAUDE.md"), "utf8");
const guide = fs.readFileSync(path.join(root, "docs", "ci-economy.md"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.match(
  template,
  /wait for \*\*both verdicts\*\* before editing or pushing/i,
  "Dev must collect both independent verdicts before starting the next remote revision",
);
assert.match(
  template,
  /Mutation testing, negative controls[\s\S]*\*\*local\/VPS-only\*\*/,
  "deliberately broken mutations must stay off the remote PR branch",
);
assert.match(
  template,
  /pushes exactly one replacement candidate `C2`/,
  "one review round must produce one consolidated candidate push",
);
assert.match(
  template,
  /Full Candidate CI[\s\S]*`ci:full` label is added/,
  "the expensive lane must be tied to an explicit candidate event",
);
assert.match(
  template,
  /\[skip ci\][\s\S]*final candidate MUST be a later, real non-skipped commit/,
  "an unsplit repository must be able to suppress an exceptional intermediate push without suppressing the final candidate",
);
assert.match(
  template,
  /both final approvals must name the same current candidate SHA/,
  "candidate batching must preserve exact-tip two-review evidence",
);

assert.match(
  guide,
  /Do not include `synchronize` in the Full Candidate CI trigger/,
  "the migration guide must prevent full CI from returning on every push",
);
assert.match(
  guide,
  /remove and re-add `ci:full` after the consolidated push/,
  "the guide must explain how a revised candidate requests full verification",
);
assert.ok(
  pkg.files.includes("docs/ci-economy.md"),
  "the operator guide must ship in the published npm package",
);

console.log("ciEconomyTemplate.test.js: all assertions passed");

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
function helpers(component, names) {
  const filename = path.join(__dirname, "..", "src", "components", component + ".tsx");
  const source = fs.readFileSync(filename, "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(functions.length, names.length);
  const compiled = ts.transpileModule(functions.map((node) => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = {}; vm.createContext(context); vm.runInContext(compiled, context); return context;
}
const setup = helpers("SetupWizard", ["blankPolicy", "v2PolicyFromDraft", "listFromInput"]);
assert.equal(setup.blankPolicy().mode, "ci-less");
assert.equal(setup.v2PolicyFromDraft(setup.blankPolicy()).evidence_keys.join(","), "unit,typecheck,build");
const settings = helpers("SettingsPage", ["blankPolicy", "blankRepository", "policyDraftFromRepository", "policyFromDraft", "listFromInput"]);
assert.equal(settings.blankRepository().policy.mode, "ci-less");
assert.equal(settings.policyDraftFromRepository({}).mode, "", "missing existing policy is not silently rewritten");
const external = { version: 1, mode: "github-checks", registration_grace_seconds: 120, same_sha_retry_budget: 2, checks: [
  { name: "test", required: true, kind: "product" }, { name: "classify", required: true, kind: "control-plane" }, { name: "coverage", required: false, kind: "product" },
] };
const draft = settings.policyDraftFromRepository({ ci_policy: external });
assert.equal(draft.mode, "github-checks");
assert.equal(JSON.stringify(settings.policyFromDraft(draft)), JSON.stringify(external), "unchanged external check kinds and metadata are preserved");
assert.equal(settings.policyFromDraft({ ...draft, mode: "ci-less", evidenceKeys: "unit, typecheck" }).mode, "ci-less");
assert.equal(settings.policyFromDraft({ ...draft, mode: "" }), undefined, "clearing policy never restores hidden original authority");
console.log("localVerificationPolicyUi.test.js: new local default and explicit existing-policy preservation passed");

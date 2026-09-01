"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  GENERATED_START,
  GENERATED_END,
  mergeProjectEnvironmentsDocument,
  writeProjectEnvironmentsMap,
} = require("./project-environments-map");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-project-environments-map-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const installation_id = "installation_1234567890abcdef";
const project = {
  id: "alpha",
  repositories: [{ key: "primary", repo: "Acme/Alpha", working_dir: "/private/alpha", primary: true }],
  environment_bindings: [{
    installation_id: "peerinstall_1234567890abcdef",
    project_id: "beta",
    label: "VPS Beta",
    environment_class: "vps",
    hostname: "must-not-serialize",
  }],
  coordination_repo_key: "primary",
  watch_batch_requests: true,
  secret: "never-projected",
};
const config = { installation_id, projects: [project], api_key: "never-projected" };

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  PASS: ${message}`);
}

// The M1 validator rejects unexpected binding fields. Use a valid record for
// writer proof and retain the hostile fields only in surrounding config data.
delete project.environment_bindings[0].hostname;
const first = writeProjectEnvironmentsMap(config, project, { configDir: root });
const filePath = first.file_path;
const firstText = fs.readFileSync(filePath, "utf8");
const mode = fs.statSync(filePath).mode & 0o777;

ok(mode === 0o600, "new map file is owner read/write only");
ok(firstText.includes(GENERATED_START) && firstText.includes(GENERATED_END), "map has a bounded generated section");
ok(firstText.includes("Acme/Alpha") === false && firstText.includes("acme/alpha"), "canonical repository comes from the registered record only");
ok(!firstText.includes("/private/alpha") && !firstText.includes("never-projected"), "map never serializes path, secret, or arbitrary config fields");

const operatorSection = "## Operator Notes\n\nKeep this hand-written section byte-for-byte.\n";
fs.writeFileSync(filePath, `${firstText.trimEnd()}\n\n${operatorSection}`, { mode: 0o644 });
project.environment_bindings[0].label = "Renamed VPS Beta";
const second = writeProjectEnvironmentsMap(config, project, { configDir: root });
const secondText = fs.readFileSync(filePath, "utf8");

ok(secondText.includes(operatorSection.trimEnd()), "reseed preserves an operator-owned H2 section verbatim");
ok(secondText.includes("Renamed VPS Beta") && !secondText.includes('"secret"'), "reseed refreshes only the allow-listed generated map");
ok((fs.statSync(filePath).mode & 0o777) === 0o600, "reseed re-hardens an existing map file to mode 0600");
ok(second.preserved_operator_sections === true, "writer reports preserved operator-owned sections without serializing them as map data");

const merged = mergeProjectEnvironmentsDocument("## Operator Custom\nkeep\n", '{\n  "current": {}\n}\n');
ok(merged.includes("## Operator Custom\nkeep"), "standalone merger keeps arbitrary operator H2 sections");

const crlfMerged = mergeProjectEnvironmentsDocument(
  `# Project Environments\r\n\r\n## Managed Environment Map\r\n${GENERATED_START}\r\nold\r\n${GENERATED_END}\r\n\r\n## Operator CRLF\r\nkeep\r\n`,
  '{\n  "current": {}\n}\n',
);
ok((crlfMerged.match(new RegExp(GENERATED_START, "g")) || []).length === 1 && crlfMerged.includes("## Operator CRLF\r\nkeep"),
  "CRLF reseed replaces the managed section once while preserving operator content");

console.log(`\n${passed} passed`);
console.log("server/project-environments-map.test.js: all assertions passed");

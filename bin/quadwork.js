#!/usr/bin/env node

"use strict";

const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const LEGACY_MAIN = path.join(__dirname, "quadwork-legacy.js");

function installProtocolOverlay() {
  const { installLocalReviewProtocol } = require("../server/local-review-protocol");
  const sourceCheckout = fs.existsSync(path.join(PACKAGE_ROOT, ".git"));
  return installLocalReviewProtocol({
    configPath: path.join(os.homedir(), ".quadwork", "config.json"),
    templatesDir: path.join(PACKAGE_ROOT, "templates"),
    // Do not dirty a source checkout. Published/npx packages have no .git and
    // receive the same managed block in their seed files before setup/reseed.
    patchTemplates: !sourceCheckout || process.env.QUADWORK_PATCH_SOURCE_TEMPLATES === "1",
    onError(entry) {
      process.stderr.write(`QuadWork local-review protocol warning: ${entry.file}: ${entry.error}\n`);
    },
  });
}

function runReview(argv) {
  const { runReviewCli } = require("../server/local-review");
  return runReviewCli(argv, { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
}

function runLegacyMain() {
  // The original CLI keeps its require.main guard so it can be imported by its
  // tests. Point Node's main entry at it and execute in this process rather than
  // leaving an extra long-lived wrapper process around `quadwork start`.
  process.argv[1] = LEGACY_MAIN;
  Module.runMain();
}

function main() {
  try {
    installProtocolOverlay();
  } catch (error) {
    process.stderr.write(`QuadWork local-review protocol warning: ${error.message || error}\n`);
  }
  if (process.argv[2] === "review") {
    process.exitCode = runReview(process.argv.slice(3));
    return;
  }
  runLegacyMain();
}

if (require.main === module) {
  main();
} else {
  // Preserve the historical import surface used by server/binStop.test.js and
  // any external tooling that imports the CLI helpers directly.
  module.exports = {
    ...require("./quadwork-legacy"),
    installProtocolOverlay,
    main,
    runLegacyMain,
    runReview,
  };
}

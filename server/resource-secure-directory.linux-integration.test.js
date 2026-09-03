"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLinuxSecureDirectoryHandle } = require("./resource-secure-directory");

if (process.platform !== "linux") {
  console.log("resource-secure-directory.linux-integration.test.js: skipped (Linux-only descriptor integration)");
} else {
  const publicRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qw-secure-directory-linux-")));
  const anchoredRoot = `${publicRoot}.anchored`;
  let handle = null;

  try {
    fs.chmodSync(publicRoot, 0o700);
    const sourceName = ".resource-state.json.previous";
    const destinationName = "resource-state.json";
    const sourceBytes = "descriptor-source\n";
    const destinationBytes = "descriptor-destination\n";
    const attackerSourceBytes = "attacker-source\n";
    const attackerDestinationBytes = "attacker-destination\n";

    fs.writeFileSync(path.join(publicRoot, sourceName), sourceBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(publicRoot, destinationName), destinationBytes, { mode: 0o600 });
    const directoryIdentity = fs.lstatSync(publicRoot);
    const sourceIdentity = fs.lstatSync(path.join(publicRoot, sourceName));
    const destinationIdentity = fs.lstatSync(path.join(publicRoot, destinationName));

    // Do not inject the unit-test helper seam here. A successful commit crosses
    // the production execFileSync boundary, where the opened directory is
    // inherited by the real Python helper as child fd 3.
    handle = createLinuxSecureDirectoryHandle({
      directory: publicRoot,
      directoryIdentity,
    });
    handle.assertAvailable();

    // Replace the accepted pathname after the descriptor has been opened.
    // A pathname-based exchange would mutate these attacker-controlled peers;
    // the descriptor-relative helper must remain pinned to anchoredRoot.
    fs.renameSync(publicRoot, anchoredRoot);
    fs.mkdirSync(publicRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(publicRoot, sourceName), attackerSourceBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(publicRoot, destinationName), attackerDestinationBytes, { mode: 0o600 });

    const pinned = handle.stat();
    assert.equal(String(pinned.dev), String(directoryIdentity.dev));
    assert.equal(String(pinned.ino), String(directoryIdentity.ino));
    assert.notEqual(String(fs.lstatSync(publicRoot).ino), String(directoryIdentity.ino));

    handle.commit({
      mode: "exchange",
      source: sourceName,
      destination: destinationName,
      sourceIdentity,
      destinationIdentity,
      expectedUid: process.getuid(),
    });

    assert.equal(fs.readFileSync(path.join(anchoredRoot, destinationName), "utf8"), sourceBytes);
    assert.equal(fs.readFileSync(path.join(anchoredRoot, sourceName), "utf8"), destinationBytes);
    assert.equal(String(fs.lstatSync(path.join(anchoredRoot, destinationName)).ino), String(sourceIdentity.ino));
    assert.equal(String(fs.lstatSync(path.join(anchoredRoot, sourceName)).ino), String(destinationIdentity.ino));
    assert.equal(fs.readFileSync(path.join(publicRoot, sourceName), "utf8"), attackerSourceBytes);
    assert.equal(fs.readFileSync(path.join(publicRoot, destinationName), "utf8"), attackerDestinationBytes);
  } finally {
    if (handle) handle.close();
    fs.rmSync(publicRoot, { recursive: true, force: true });
    fs.rmSync(anchoredRoot, { recursive: true, force: true });
  }

  console.log("resource-secure-directory.linux-integration.test.js: all assertions passed");
}

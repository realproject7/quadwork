"use strict";

// #1064: QuadWork's Node prerequisite is patch-level.  The durable stores hold
// their writer lock in the kernel through a native addon whose prebuilds
// target the Node-20 N-API surface from 20.3.0 onward, so 20.0, 20.1 and 20.2
// must be refused — and a major-only check cannot refuse them.
//
// `package.json` `engines` is not the gate and cannot be: npm's
// `engine-strict` is false in this project, so `engines` only warns.
//
// Two separate things are pinned below, because they are separate things.
// The comparator is pure arithmetic over a version string and is tested as
// such.  Where it is *called* is what decides how much it protects: a check
// reachable only from `init` would leave every other command to fail later,
// deep inside a store write, with an errno.  The last block therefore drives
// the real CLI as the main module under a runtime it must refuse, so the
// claim "every command is gated" is asserted rather than asserted about.

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const {
  MINIMUM_NODE_VERSION,
  parseNodeVersion,
  satisfiesMinimumNodeVersion,
} = require("../bin/quadwork");

assert.deepEqual(MINIMUM_NODE_VERSION, [20, 3, 0], "the floor is 20.3.0");

// Parsing: only a plain vMAJOR.MINOR.PATCH is a version.  Anything else is
// null, so an unreadable answer can never be read as new enough.
{
  assert.deepEqual(parseNodeVersion("v20.3.0"), [20, 3, 0]);
  assert.deepEqual(parseNodeVersion("20.3.0"), [20, 3, 0]);
  assert.deepEqual(parseNodeVersion("  v24.18.0\n"), [24, 18, 0]);
  assert.deepEqual(parseNodeVersion("v22.0.0-nightly"), [22, 0, 0], "a prerelease suffix does not hide the version");
  for (const bad of ["", "v20", "v20.3", "node v20.3.0", "twenty", null, undefined, 20, {}, "vX.Y.Z"]) {
    assert.equal(parseNodeVersion(bad), null, JSON.stringify(bad));
    assert.equal(satisfiesMinimumNodeVersion(bad), false, `${JSON.stringify(bad)} is not proof of a new enough runtime`);
  }
}

// The refusals the old major-only check let through.  These are the whole
// reason the comparison is patch-level.
for (const version of ["v20.0.0", "v20.1.0", "v20.2.0", "v20.2.99"]) {
  assert.equal(satisfiesMinimumNodeVersion(version), false, `${version} must be refused`);
}
// And everything at or above the floor, including the minor that a string
// compare would sort below it.
for (const version of ["v20.3.0", "v20.3.1", "v20.4.0", "v20.10.0", "v21.0.0", "v22.11.0", "v24.18.0", "v100.0.0"]) {
  assert.equal(satisfiesMinimumNodeVersion(version), true, `${version} must be accepted`);
}
// Below 20 stays refused, as it always was.
for (const version of ["v18.20.8", "v19.9.0", "v16.0.0", "v0.10.48"]) {
  assert.equal(satisfiesMinimumNodeVersion(version), false, `${version} must be refused`);
}
// "20.10.0" < "20.3.0" as strings; the comparison must be numeric per part.
assert.ok("20.10.0" < "20.3.0", "the lexical trap this comparison must not fall into is real");

// The comparator is generic over its floor, so the floor above is data rather
// than something baked into the branch structure.
{
  assert.equal(satisfiesMinimumNodeVersion("v20.3.0", [20, 3, 1]), false);
  assert.equal(satisfiesMinimumNodeVersion("v20.3.1", [20, 3, 1]), true);
  assert.equal(satisfiesMinimumNodeVersion("v20.3.0", [20, 2, 9]), true);
}

// The installer's own message names the floor, so an operator is told which
// version to install rather than being left to infer it.
{
  const source = fs.readFileSync(path.join(__dirname, "..", "bin", "quadwork.js"), "utf8");
  assert.match(source, /version \$\{MINIMUM_NODE_VERSION\.join\("\."\)\} or newer is required/,
    "the refusal message is derived from the floor, not from a hardcoded string that can drift");
  assert.doesNotMatch(source, /version 20 or newer is required/, "the major-only message is gone");
}

// `engines` states the same floor for the humans and tools that read it, even
// though it does not enforce anything here.
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=20.3.0", "package.json states the same floor as the installer's gate");
}

// The gate is not a comparator sitting in a file: it runs before command
// dispatch, so every command refuses a too-old runtime.  Proving that needs
// the CLI to be the main module under a runtime it will refuse, which a
// `--require` preload arranges by redefining `process.version` before the main
// module loads.
{
  const binPath = path.join(__dirname, "..", "bin", "quadwork.js");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quadwork-node-floor-"));
  try {
    const preload = (version) => {
      const file = path.join(scratch, `${version.replace(/\W/g, "_")}.js`);
      fs.writeFileSync(file, `Object.defineProperty(process, "version", { value: ${JSON.stringify(version)}, configurable: true });\n`);
      return file;
    };
    const cli = (version, ...args) => spawnSync(process.execPath, ["-r", preload(version), binPath, ...args], { encoding: "utf8" });

    // `not-a-command` is deliberate: with no gate it reaches dispatch, prints
    // usage and exits 0 — which is exactly the negative control below, so a
    // refusal here can only have come from the version check.
    const refused = cli("v20.2.0", "not-a-command");
    assert.equal(refused.status, 1, `a too-old runtime must exit 1: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /QuadWork requires Node\.js 20\.3\.0 or newer/);
    assert.doesNotMatch(refused.stdout, /Usage: quadwork/, "the gate ran before dispatch, so no command output appeared");

    // Every command, not just `init`.  Each of these would otherwise run to
    // completion on 20.0-20.2 and meet the native addon far downstream.
    for (const command of ["init", "start", "stop", "doctor", "resources", "cleanup", "add-project", "ac-restore"]) {
      const blocked = cli("v20.0.0", command);
      assert.equal(blocked.status, 1, `${command} must be refused: ${blocked.stdout}${blocked.stderr}`);
      assert.match(blocked.stderr, /QuadWork requires Node\.js 20\.3\.0 or newer/, command);
      assert.equal(blocked.stdout, "", `${command} produced output before the gate: ${blocked.stdout}`);
    }
    // The no-subcommand default is dispatch too, and it is gated with the rest.
    const bare = cli("v20.2.99");
    assert.equal(bare.status, 1, `${bare.stdout}${bare.stderr}`);
    assert.match(bare.stderr, /QuadWork requires Node\.js 20\.3\.0 or newer/);

    // Negative control: the same preload and the same spawn with an acceptable
    // version reach dispatch, so the refusals above are the version's doing and
    // not the harness's.
    // (`not-a-command` also exits 1 — that is the usage branch's own exit — so
    // the streams, not the status, are what separate the two outcomes.)
    const allowed = cli("v20.3.0", "not-a-command");
    assert.match(allowed.stdout, /Usage: quadwork/, "an acceptable runtime reaches command dispatch");
    assert.doesNotMatch(allowed.stderr, /QuadWork requires Node\.js/, "the gate did not fire on an acceptable runtime");
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

console.log("binNodeVersion tests passed");

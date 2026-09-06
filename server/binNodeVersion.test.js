"use strict";

// #1074: the installer's Node prerequisite is now patch-level.  The durable
// stores hold their writer lock in the kernel through a native addon whose
// prebuilds target the Node-20 N-API surface from 20.3.0 onward, so 20.0,
// 20.1 and 20.2 must be refused — and a major-only check cannot refuse them.
//
// `package.json` `engines` is not the gate and cannot be: npm's
// `engine-strict` is false in this project, so `engines` only warns.  That
// makes this check the only thing standing between a too-old runtime and a
// failure that would otherwise surface deep inside a store write.

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
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

console.log("binNodeVersion tests passed");

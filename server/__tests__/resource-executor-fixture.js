"use strict";

// Explicit unit-test dependency replacement. Never imported by product code:
// these tests exercise route/Git semantics, not Linux containment authority.
const cp = require("node:child_process");
const util = require("node:util");
function installResourceExecutorFixture({ runControlChild } = {}) {
  const file = require.resolve("../resource-runtime-owner");
  const original = require(file);
  const owner = {
    runControlChild: runControlChild || ((command, args, options = {}) => {
      const { input, ...opts } = options;
      // Preserve existing explicit async command fixtures. Native execFile's
      // stdin path is exercised directly for the real Git runner tests.
      if (cp.execFile !== nativeExec && cp.execFile[util.promisify.custom]) return cp.execFile[util.promisify.custom](command, args, opts);
      return new Promise((resolve, reject) => {
        const child = cp.execFile(command, args, opts, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
        child?.stdin?.on("error", () => {});
        child?.stdin?.end(input);
      });
    }),
    runControlChildSync: (...args) => cp.execFileSync(...args),
  };
  require.cache[file].exports = { ...original, getSharedResourceRuntimeOwner: () => owner };
  return () => { require.cache[file].exports = original; };
}
const nativeExec = cp.execFile;
module.exports = { installResourceExecutorFixture };

"use strict";

// Explicit unit-test dependency replacement. Never imported by product code:
// these tests exercise route/Git semantics, not Linux containment authority.
const cp = require("node:child_process");
const util = require("node:util");
const Module = require("node:module");
function installResourceExecutorFixture({ runControlChild } = {}) {
  const file = require.resolve("../resource-runtime-owner");
  const originalLoad = Module._load;
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
  // Load production dependencies only when the test normally imports them,
  // after its private HOME/fs setup. Never read the operator's config early.
  Module._load = function (request, parent, main) {
    const result = originalLoad.call(this, request, parent, main);
    if (request.includes("resource-runtime-owner") && Module._resolveFilename(request, parent) === file) return { ...result, getSharedResourceRuntimeOwner: () => owner };
    return result;
  };
  return () => { Module._load = originalLoad; };
}
const nativeExec = cp.execFile;
module.exports = { installResourceExecutorFixture };

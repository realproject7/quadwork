"use strict";

// Explicit unit-test dependency replacement. Never imported by product code:
// these tests exercise route/Git semantics, not Linux containment authority.
const cp = require("node:child_process");
const util = require("node:util");
const Module = require("node:module");
function installResourceExecutorFixture({ runControlChild, preserveRuntimeOwner = false } = {}) {
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
  const facades = new WeakMap();
  const originals = new WeakMap();
  function withControlFixture(realOwner) {
    if (!facades.has(realOwner)) {
      const facade = new Proxy(realOwner, {
        get(target, key) {
          if (Object.hasOwn(owner, key)) return owner[key];
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      facades.set(realOwner, facade);
      originals.set(facade, realOwner);
    }
    return facades.get(realOwner);
  }
  // Load production dependencies only when the test normally imports them,
  // after its private HOME/fs setup. Never read the operator's config early.
  Module._load = function (request, parent, main) {
    const result = originalLoad.call(this, request, parent, main);
    if (request.includes("resource-runtime-owner") && Module._resolveFilename(request, parent) === file) return {
      ...result,
      getSharedResourceRuntimeOwner: () => preserveRuntimeOwner ? withControlFixture(result.getSharedResourceRuntimeOwner()) : owner,
      // Composed index.js tests keep the genuine immutable owner's snapshot,
      // worker admission and HTTP attestation. Only control execution is a
      // fixture; this dependency replacement never exists in product imports.
      ...(preserveRuntimeOwner ? {
        captureResourceRuntimeOwner: (candidate) => result.captureResourceRuntimeOwner(originals.get(candidate) || candidate),
      } : {}),
    };
    return result;
  };
  return () => { Module._load = originalLoad; };
}
const nativeExec = cp.execFile;
module.exports = { installResourceExecutorFixture };

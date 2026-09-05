"use strict";

// #1066: the one fixed Git runner the Delivery Candidate chain injects.  It
// runs `git` — never another program, never through a shell — with an argv
// restricted to the read-only object operations the Git-object adapter needs
// plus `mktree`, in the caller's cwd, with stdin fed from an optional string
// and then closed, a bounded output buffer, and a per-call timeout the caller
// sets under the fixed ceiling (the adapter passes what remains of its one
// composition deadline).  A process failure or timeout resolves `{ ok: false }`
// so the adapter fails closed; only an invalid request throws.

const { execFile } = require("node:child_process");
const path = require("node:path");

const VERSION = 1;
const MAX_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const FIELDS = new Set(["version", "cwd", "args", "input", "timeout_ms"]);
const ALLOWED_ARGV = [["rev-parse"], ["remote", "get-url"], ["status"], ["show", "-s"], ["ls-tree"], ["mktree"], ["merge-base", "--is-ancestor"]];

function invalid(message) { return new TypeError(`delivery Git runner: ${message}`); }

function runDeliveryGit(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key) => !FIELDS.has(key))) {
    throw invalid("request has an unknown field");
  }
  if (request.version !== VERSION) throw invalid("request version is invalid");
  if (typeof request.cwd !== "string" || !path.isAbsolute(request.cwd)) throw invalid("cwd must be an absolute path");
  if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      !ALLOWED_ARGV.some((prefix) => prefix.every((word, index) => request.args[index] === word))) {
    throw invalid("argv is not an allowed Git object operation");
  }
  if (request.input !== undefined && typeof request.input !== "string") throw invalid("input must be a string");
  if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms <= 0 || request.timeout_ms > MAX_TIMEOUT_MS) {
    throw invalid("timeout must be a positive integer within the fixed ceiling");
  }
  return new Promise((resolve) => {
    const child = execFile("git", [...request.args], {
      cwd: request.cwd, encoding: "utf8", timeout: request.timeout_ms, maxBuffer: MAX_OUTPUT_BYTES,
    }, (error, stdout) => resolve(error ? { ok: false, output: "" } : { ok: true, output: stdout }));
    child.stdin.on("error", () => {});
    child.stdin.end(request.input);
  });
}

module.exports = { VERSION, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES, runDeliveryGit };

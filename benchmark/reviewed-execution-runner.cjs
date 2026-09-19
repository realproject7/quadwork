#!/usr/bin/env node
'use strict';

// #1115 preparation only. It intentionally has no provider launcher, auth
// command, workload sender, or child_process dependency. A later reviewed
// worker may consume this immutable preparation receipt through V2 PTY only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const productPath = require('./v2-product-path-core.cjs');
const contract = require('./reviewed-execution-contract.cjs');
const profiles = require('../server/reviewed-execution-profiles');

function profileForAdapter(adapter) {
  if (adapter === 'codex') return profiles.PROFILES.v2_codex_readonly_v1;
  if (adapter === 'claude') return profiles.PROFILES.v2_claude_restricted_v1;
  throw new Error('reviewed_execution_adapter_not_supported');
}

function reviewedAgentConfig(profile, binding, repository) {
  return Object.freeze({
    cwd: repository,
    command: profile.executable,
    command_identity: profile.backend,
    model: profile.model,
    auto_approve: false,
    mcp_inject: 'none',
    reviewed_execution_id: profile.id,
    reviewed_execution_candidate_digest: binding.candidate_digest,
    reviewed_execution_root: binding.disposable_root,
    reviewed_execution_ledger_directory: binding.ledger_directory,
    reviewed_execution_authorization_key: binding.authorization_key,
    reviewed_execution_sandbox_profile: binding.sandbox_profile,
    reviewed_execution_sandbox_digest: binding.sandbox_digest,
  });
}

async function prepareReviewedExecution({ adapter, parent_dir, ledger_parent, authorization_id }) {
  const profile = profileForAdapter(adapter);
  const root = productPath.createDisposableProductPathRoot({ parent_dir });
  const candidate = profiles.candidateDigest();
  const consumed = contract.consumeAuthorization({ ledger_parent, candidate_digest: candidate, profile_id: profile.id, authorization_id });
  const sandboxDirectory = path.join(root, 'home', '.reviewed-execution');
  fs.mkdirSync(sandboxDirectory, { mode: 0o700 }); fs.chmodSync(sandboxDirectory, 0o700);
  const sandbox = contract.createSandbox({ profile_id: profile.id, candidate_digest: candidate, disposable_root: root, ledger_directory: consumed.ledger_directory, sandbox_directory: sandboxDirectory });
  const binding = Object.freeze({ candidate_digest: candidate, disposable_root: root, ledger_directory: consumed.ledger_directory, authorization_key: consumed.authorization_key, sandbox_profile: sandbox.path, sandbox_digest: sandbox.digest });
  const preflight = await contract.preflight({ profile_id: profile.id, ...binding, home: path.join(root, 'home') });
  const config = reviewedAgentConfig(profile, binding, path.join(root, 'repository'));
  return Object.freeze({ root, binding, authorization_receipt: consumed.receipt, preflight, config, report: contract.redactedReport({ profile_id: profile.id, candidate_digest: candidate, ...preflight }) });
}

function ownedDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error('reviewed_execution_executor_directory_unsafe');
  return fs.realpathSync(directory);
}

async function prepareOwnedProfile(adapter) {
  const executorRoot = ownedDirectory(path.join(os.tmpdir(), 'quadwork-v2-reviewed-executor'));
  const ledgerRoot = ownedDirectory(path.join(os.homedir(), 'Library', 'Application Support', 'QuadWork', 'reviewed-execution-ledger-parent'));
  return prepareReviewedExecution({ adapter, parent_dir: executorRoot, ledger_parent: ledgerRoot, authorization_id: 'reviewed-v2-product-path-v1' });
}

// Production callers have no root, model, argv, environment, or authorization
// input. Synthetic roots are exposed only to the unit-test hook below.
module.exports = Object.freeze({ prepareReviewedClaude: () => prepareOwnedProfile('claude'), prepareReviewedCodex: () => prepareOwnedProfile('codex'), testHooks: Object.freeze({ prepareReviewedExecution, profileForAdapter, reviewedAgentConfig }) });

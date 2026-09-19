#!/usr/bin/env node
'use strict';

// #1109 reviewed execution registry. Any executable, CLI update, source
// anchor, model profile, or future provider needs a separately reviewed source
// change here. Nothing supplied by a caller can mint or alter this contract.
const core = require('./live-provider-compatibility-core.cjs');

const IDENTITY = Object.freeze({
  base_digest: '1183c1e1dc399f08971c2a20bc79c5d2850062d32f3459e399eb607fe3686ea2',
  harness_digest: 'd9797e07e74f45a2fb283c31044865137fd32ef9767a8874e184f515866309cf',
  source_digest: '86fda121b2a3186e713e487781d8403de4b7222f896330c19f7f65ffed2211cb',
  workload_digest: 'aa43308b1a1b54bb7c776100012e2e67c8061dadc0a770e3d56d020db3f9d730',
});
const REVIEWED_EXECUTIONS = Object.freeze({
  codex: Object.freeze({ adapter: 'codex', executable_path: '/opt/homebrew/bin/codex', resolved_path: '/opt/homebrew/Caskroom/codex/0.153.1/bin/codex', executable_digest: '62709f1e3beddf61abdc16fc6e702e7fc90ad2aed26e33e6d319ab4a5a090c7a', version_digest: 'd11fe443fb44b5a2250aad94b2ec3971cf2ab34e65ecc9895017ff03160add90', identity: IDENTITY }),
  claude: Object.freeze({ adapter: 'claude', executable_path: '/Users/cho/.local/bin/claude', resolved_path: '/Users/cho/.local/share/claude/versions/2.1.277', executable_digest: '73d6a2a55c46907e49bd8bb7608e134333bd71173351ee16ddce7d7db9914b9c', version_digest: '57acde8af4b70a838ef099b3d1215ce7261164a836b69a79738cc73675a0ded1', identity: IDENTITY }),
});

async function runReviewedLiveCompatibility(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new core.LiveCompatibilityError('live_run_shape');
  const reviewed = REVIEWED_EXECUTIONS[value.adapter];
  if (!reviewed) throw new core.LiveCompatibilityError('live_adapter_not_supported');
  return core.runReviewedCompatibility(reviewed, value);
}

module.exports = Object.freeze({ ADAPTERS: core.ADAPTERS, CAPS: core.CAPS, EVIDENCE_MARKER: core.EVIDENCE_MARKER, LiveCompatibilityError: core.LiveCompatibilityError, ROOT_MARKER: core.ROOT_MARKER, createDisposableLiveCompatibilityEvidenceRoot: core.createDisposableLiveCompatibilityEvidenceRoot, createDisposableLiveCompatibilityRoot: core.createDisposableLiveCompatibilityRoot, runReviewedLiveCompatibility, sanitizedEnvironment: core.sanitizedEnvironment });

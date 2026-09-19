'use strict';

// This file is test-only. Production callers import live-provider-compatibility
// and cannot pass a reviewed contract or a runtime seam.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./live-provider-compatibility-core.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fakeReviewedContract(adapter, executable, version = 'fake\n') {
  const resolved = fs.realpathSync(executable);
  return Object.freeze({ adapter, executable_path: executable, resolved_path: resolved, executable_digest: sha(fs.readFileSync(resolved)), version_digest: sha(version), identity: Object.freeze({ base_digest: sha('base'), harness_digest: sha(fs.readFileSync(path.join(__dirname, 'live-provider-compatibility-core.cjs'))), source_digest: sha(fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'))), workload_digest: sha('Return exactly QUADWORK_LIVE_OK. Do not use tools. Do not read, write, or change files.') }) });
}
function runFakeCompatibility(adapter, executable, value, runtime) { return core.runReviewedCompatibility(fakeReviewedContract(adapter, executable), { adapter, executable, ...value }, runtime); }
module.exports = Object.freeze({ ...core, fakeReviewedContract, runFakeCompatibility });

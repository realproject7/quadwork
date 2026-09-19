#!/usr/bin/env node
'use strict';

const core = require('./live-provider-compatibility-core.cjs');

async function runReviewedLiveCompatibility(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new core.LiveCompatibilityError('live_run_shape');
  return core.runInstalledCompatibility(value);
}

module.exports = Object.freeze({ ADAPTERS: core.ADAPTERS, CAPS: core.CAPS, EVIDENCE_MARKER: core.EVIDENCE_MARKER, LiveCompatibilityError: core.LiveCompatibilityError, ROOT_MARKER: core.ROOT_MARKER, createDisposableLiveCompatibilityEvidenceRoot: core.createDisposableLiveCompatibilityEvidenceRoot, createDisposableLiveCompatibilityRoot: core.createDisposableLiveCompatibilityRoot, runReviewedLiveCompatibility, sanitizedEnvironment: core.sanitizedEnvironment });

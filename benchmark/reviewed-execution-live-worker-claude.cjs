#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const profiles = require('../server/reviewed-execution-profiles');
const child = require('./reviewed-execution-live-child-protocol.cjs');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const role = 'benchmark_claude'; const profile = profiles.PROFILES.v2_claude_restricted_v1;
process.env.QUADWORK_REVIEWED_EXECUTION_CHILD_ROLE = role;
const nonce = process.env.QUADWORK_REVIEWED_PARENT_NONCE; const candidate = process.env.QUADWORK_REVIEWED_CANDIDATE_DIGEST;
if (typeof process.send !== 'function' || !/^[a-f0-9]{64}$/.test(nonce) || candidate !== profiles.candidateDigest() || sha256(fs.readFileSync(__filename)) !== process.env.QUADWORK_REVIEWED_WORKER_DIGEST) process.exit(1);
process.send({ type: 'reviewed_execution_ready', nonce, candidate_digest: candidate, worker_digest: process.env.QUADWORK_REVIEWED_WORKER_DIGEST });
process.once('message', message => { if (message?.type !== 'reviewed_execution_admit' || message.nonce !== nonce || !/^[a-f0-9]{64}$/.test(message.admission)) return process.exit(1); void child.prepareFixedChild(profile).then(report => { if (report) process.send({ type: 'reviewed_execution_result', report }, () => process.exit(0)); else require('../server/index.js'); }).catch(() => process.send({ type: 'reviewed_execution_result', report: child.failedChildReport(role) }, () => process.exit(1))); });

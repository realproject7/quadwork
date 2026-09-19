#!/usr/bin/env node
'use strict';
const profiles = require('../server/reviewed-execution-profiles');
const child = require('./reviewed-execution-live-child-protocol.cjs');
process.env.QUADWORK_REVIEWED_EXECUTION_CHILD_ROLE = 'benchmark_claude';
void child.prepareFixedChild(profiles.PROFILES.v2_claude_restricted_v1).then(report => {
  if (report) process.send?.({ type: 'reviewed_execution_result', report }, () => process.exit(0));
  else require('../server/index.js');
}).catch(() => process.send?.({ type: 'reviewed_execution_result', report: child.failedChildReport('benchmark_claude') }, () => process.exit(1)));

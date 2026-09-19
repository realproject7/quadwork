#!/usr/bin/env node
'use strict';
if (process.env.QUADWORK_REVIEWED_EXECUTION_CHILD !== '1') process.exit(1);
process.env.QUADWORK_REVIEWED_EXECUTION_CHILD_ROLE = 'benchmark_claude';
require('./reviewed-execution-live-child-protocol.cjs');

# Offline benchmark preparation

This is the first preparation utility for #1037, not a benchmark runner.

```sh
node benchmark/preflight.cjs \
  --manifest docs/v2-benchmark-manifest.draft.json \
  --repo .
node --test benchmark/preflight.test.cjs
```

The report verifies local product commit/tag/tree identities, calculates a
canonical manifest digest, and lists missing preparation data. Exit zero means
the supplied draft was inspected successfully. It does **not** mean the benchmark
is ready. Invalid input, unavailable Git, and mismatched local identities return
nonzero. Every report has `execution_authorized: false`.

The tool cannot launch models, mutate a repository, contact GitHub, validate an
operator's approval, freeze targets, or run any benchmark. It never grants those
capabilities based on a caller-supplied approval or Mode 3 flag. It checks only
the preparation schema; nested run contracts and approval evidence need the
later reviewed implementation.

Use Node 20.3+ on macOS with Command Line Tools Git at
`/Library/Developer/CommandLineTools/usr/bin/git`, or Linux with `/usr/bin/git`.
No Windows support is claimed for this non-shipping helper. Git runs with a
restricted child environment, fixed argv, bounded execution and output, no
replacement objects, and no allowed network transport. No global config is
changed. The top-level `benchmark/` directory is outside the package's shipped
file allowlist.

The measurement design and proposed work bundle are in
[`docs/v2-benchmark-plan.md`](../docs/v2-benchmark-plan.md) and
[`docs/v2-benchmark-workload.md`](../docs/v2-benchmark-workload.md).

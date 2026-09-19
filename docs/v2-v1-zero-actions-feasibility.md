# V1 zero-GitHub-Actions feasibility boundary (#1037)

This record narrows one question only: whether the shipped `quadwork@2.7.1`
source makes a GitHub check or Action result part of its dashboard readiness
predicate. It does not audit Head's actual merge decision and is not a Mode 1
delivery result.

Run the read-only audit from a repository that contains the shipped reference
tag and commit:

```sh
node benchmark/v1-zero-actions.cjs --repo .
node --test benchmark/v1-zero-actions.test.cjs
```

The audit fixes the reference at tag `v2.7.1` and commit
`59198955480c2224e1980e1645690d34a8ec0db3`. It reads three exact Git objects
with a constrained Git environment and compares their SHA-256 values before
examining the policy. It does not read configuration, call a provider, contact
GitHub, start QuadWork, create a repository, mutate a ref, or publish a
package.

## Static result

The V1 dashboard predicate in `server/routes.js` reaches `ready` after two
role-attributed approvals. It does not consult `statusCheckRollup`, check runs,
or a required-check field. V1 does fetch check metadata for the dashboard, so
check reads must not be described as an Action gate.

The default trigger text mentions two current-revision approvals, but it is not
an audited Head merge gate and does not prove candidate freshness. The audit
makes no claim about what an actual Head process will merge.

The audit lists the V1 `server/ci-less-evidence.js` path separately. A
successful empty listing records `absent`; a non-empty listing records
`present`; any Git failure records `unknown` and remains a blocker. The current
tagged source is confirmed `absent`, so it cannot provide the V2
local-verification receipt format.

## What remains unproved

The audit result is
`dashboard_readiness_without_check_result_delivery_unproved`. It does not set
`mode_1_zero_actions_feasibility` to `proved` in the measurement manifest.
The following require an explicitly bounded, disposable-repository live
exercise after a reviewed calibration protocol fixes the model identities, task
bundle, cache policy, and run budget. This occurs before numeric targets are
derived and before the final measurement manifest is frozen:

1. Repository Actions are disabled before the run and remain disabled.
2. The target's branch protection and actual Head merge policy permit the V1 path.
3. An actual V1 ticket, PR, two independent reviews, Head merge, and post-merge
   readback complete without a hosted check result.

If that exercise cannot complete, Mode 1 remains blocked. Do not patch V1,
manufacture a green status, substitute a V2 receipt, or exclude the missing
wait from a matched timing result.

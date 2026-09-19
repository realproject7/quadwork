# V1 zero-GitHub-Actions feasibility boundary (#1037)

This record narrows one question only: whether the shipped `quadwork@2.7.1`
source makes a GitHub check or Action result part of its code-level
merge-readiness predicate. It is not a Mode 1 delivery result.

Run the read-only audit from a repository that contains the signed reference
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

The V1 ready predicate in `server/routes.js` reaches `ready` after two current
role-attributed approvals. It does not consult `statusCheckRollup`, check runs,
or a required-check field. The V1 default Head instruction likewise says to
merge after both current-revision approvals. V1 does fetch check metadata for
the dashboard, so check reads must not be described as an Action gate.

V1 predates `server/ci-less-evidence.js`. It therefore cannot provide the V2
local-verification receipt format.

## What remains unproved

The audit result is `source_policy_compatible_delivery_unproved`. It does not
set `mode_1_zero_actions_feasibility` to `proved` in the measurement manifest.
The following require an explicitly bounded, disposable-repository live
exercise after the benchmark manifest, model identities, and run budget are
frozen:

1. Repository Actions are disabled before the run and remain disabled.
2. The target's branch protection and merge policy permit the exact V1 path.
3. An actual V1 ticket, PR, two independent reviews, merge, and post-merge
   readback complete without a hosted check result.

If that exercise cannot complete, Mode 1 remains blocked. Do not patch V1,
manufacture a green status, substitute a V2 receipt, or exclude the missing
wait from a matched timing result.

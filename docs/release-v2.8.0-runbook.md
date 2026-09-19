# v2.8.0 release runbook

This is the actions-free release path for the open release gate in #1026. It
replaces its obsolete requirement for a green GitHub Actions check. It does not
authorize a release, tag, deployment, credential change, or `npm publish`.

## Current status

`main` is version `2.7.1`. The planned public version is `2.8.0`, as recorded
in #1026. The V2 implementation merged at `9e1d08fc57ea46b2aa5356bfa573e8c028d1cdc8`.
The benchmark and release-recommendation gate in #1037 is still open. Do not
prepare or merge a version bump until #1037 records its required outcome.

The release notes must be generated from the final release commit. Do not reuse
#1026's earlier Grok-only note as the complete description of this release, and
do not make an unmeasured V2 performance claim.

## Release-source pull request

After #1037 permits a release recommendation, create one release-source pull
request from the current `main` tip. Its only changes are:

- `package.json`: root `version` is `2.8.0`.
- `package-lock.json`: root `version` and `packages[""].version` are `2.8.0`.

The pull request must identify its exact base and head commits. Rebase or
recreate it if `main` changes before merge. It must receive two independent
reviews of its final head commit.

## Local verification

GitHub Actions stays disabled. The release-source candidate needs local proof
for its exact commit, not a hosted status badge or a result from an earlier
candidate. Run these commands in a clean checkout after dependencies are
installed:

```bash
npm test
npm run build
npm pack --dry-run
```

Record the command, exit status, Node and npm versions, package version, base
commit, candidate commit, and timestamp. `npm pack --dry-run` must show the
intended executable, server, templates, output, selected source helpers, and
published documentation only. It must not include benchmark fixtures or local
evidence files.

The final release commit needs the same local proof after its merge to `main`.
If that commit differs from the reviewed release-source candidate, repeat the
affected review and verification before continuing.

## Finalization before publish

Once the merged `main` commit has the required local evidence and two final
reviews, the PO may create the `v2.8.0` tag and GitHub release on that exact
commit with generated notes. Confirm that the tag resolves to the verified
commit and that npm still reports `2.7.1` as the published version before the
operator gate.

Do not run `npm run release:patch`, `npm run release:minor`, or
`npm run release:major`. Each chains Git push, GitHub release creation, and
`npm publish`, so it cannot preserve the publish gate.

## Operator gate

Only the operator performs the final registry publish. At that point the
operator runs `npm publish` from the exact tagged `main` checkout. The package
already defines `prepublishOnly` as `npm test`; a failure stops publication and
must be recorded against the tagged candidate.

After a successful publish, verify the registry version and integrity, then
perform any separately authorized local or VPS upgrade and restart work. Those
host changes are outside this runbook and must not be performed from a benchmark
or release-preparation checkout.

# v2.8.0 release runbook

This is the actions-free release path for the open release gate in #1026. It
replaces its obsolete requirement for a green GitHub Actions check. It does not
authorize a release, tag, deployment, credential change, or `npm publish`.

## Current status, 2026-09-20 (#1155)

`main` is version `2.7.1`. The planned public version is `2.8.0`, as recorded
in #1026. The V2 implementation merged at `9e1d08fc57ea46b2aa5356bfa573e8c028d1cdc8`.
The source-audit and verification work in #1037 must be reported separately.
Implementation and source-audit completion require their ledger, resolved
findings, deterministic checks, and two independent exact-candidate reviews.
Real-provider turns, product E2E/device checks, and live benchmarks are on hold
until the operator returns and explicitly resumes testing. Keep #1037 open for
its retained verification and release gates, even after source work is complete.

Local build, isolated installation, and test preparation are authorized after
the implementation and audit fixes are complete. Installation readiness is not
product/provider success. The later local-install proof must precede any version
change, tag, release, or npm publish. Failed or unperformed proof blocks
provider-support and publish recommendation, not a scoped implementation claim.
The matched benchmark and manifest-freeze order in
[the benchmark plan](v2-benchmark-plan.md) still apply before performance or
release claims. Do not prepare or merge a version bump until those gates pass
and the operator authorizes the release stage.

The reviewed runner is now a security harness and historical evidence, not the
required provider-support or release proof. Preserve all past authorizations,
consumed attempts, failures, diagnostics, and receipts unchanged. Consumed
one-shot authorizations cannot be retried or reset. Only unresolved obligations
to schedule further runner attempts are superseded. The PO must record the
operator-return hold in the handoff and continuity watcher so no automation
starts a live test.

The release notes must be generated from the final release commit. Do not reuse
#1026's earlier Grok-only note as the complete description of this release, and
do not make an unmeasured V2 performance claim.

## Local-install readiness before testing

This stage stops before product startup or provider execution. Keep every
existing installation, service, configuration, project, and user-owned file
untouched. Do not run `quadwork init`, replace a global install, add a global
symlink, restart a service, use a production/VPS target, or alter credentials.

1. Select the final clean reviewed source after audit fixes. Record its commit,
   tree, two independent review receipts, and local validation results. Use
   `npm test`, `npx tsc --noEmit`, `npm run build`, `npm pack --dry-run`, and
   package smoke on that exact candidate. Deterministic tests may use their
   disposable fixture CLI/HTTP/PTY processes; they are not real-provider or
   product E2E proof. Record honest failures and skips.
2. Create a new owner-only local preparation root with separate archive,
   installation-prefix, runtime-home, cache, disposable-project, and receipt
   directories. Refuse an existing or symlinked target. Select a short enough
   absolute root for the platform's Unix-domain socket path limit. Put actual
   paths, the selected Node/npm executables, and ownership facts in the local
   readiness receipt rather than assuming a machine-specific path here.
3. After the successful build, run
   `npm pack --ignore-scripts --pack-destination "$qw_artifact_dir"` from the
   exact source checkout. This retains the already-validated build. Record the
   archive's SHA-256, npm integrity, package version, and source commit. Inspect
   the member list for the intended shipping contents and reject paths that
   escape the extraction root. Do not rebuild or edit the extracted product.
4. Extract that exact archive, removing only its leading `package/` component,
   into the fresh `$qw_prefix/node_modules/quadwork` directory. The tarball does
   not ship `package-lock.json`. Copy the exact reviewed source lockfile into
   that package directory and record its digest, then use `npm ci --omit=dev`
   there to install the locked runtime dependencies. Do not use an ordinary
   range-resolving install, a registry copy of QuadWork, or a global link.
   Native dependency setup may run only in this owned installation. Record
   Node/npm versions, platform, install command/result, and installed dependency
   identities. A required host change or login is an operator gate.
5. Verify the installed product files against the tarball member digests and
   record the result. Account separately for the copied source lockfile and
   installed dependencies; their presence does not change the archive identity.
   Prepare only a fresh minimal runtime config under
   `$qw_runtime_home/.quadwork/config.json`, with `projects: []`,
   `restart_respawn: { enabled: false }`, and a distinct unused `port`, such as
   `18420`. Select it without stopping any current listener. The server reads
   `config.port`; a `PORT` environment variable does not select this port.
6. Prepare executor-owned disposable local project directories and a scenario
   checklist, using no operator repository, existing worktree, normal config,
   or credential material. Use synthetic fixtures for upgrade preparation.
   Record their ownership and baseline digests. Do not activate a project,
   launch an agent, start the server, or perform a live scenario yet.
7. Stage the launch instructions below, raw-free result forms, cleanup scope,
   and the remaining gates in the local receipt. Mark installation as ready
   only when its actual checks pass. Mark every unperformed live scenario
   `pending_operator_return`, never pass. Carry that hold into the handoff and
   continuity watcher before ending preparation.

Use task-specific path variables taken from that local receipt. For dependency
installation, run from the owned package directory with a clean child
environment. For example, with `qw_package_dir` set to the exact
`$qw_prefix/node_modules/quadwork` directory, first create two distinct empty
owner-only files at `$qw_cache/user.npmrc` and `$qw_cache/global.npmrc` in the
fresh preparation root. npm rejects using the same file for both config layers.

```sh
env -i PATH="$qw_tool_path" HOME="$qw_runtime_home" USERPROFILE="$qw_runtime_home" \
  npm_config_userconfig="$qw_cache/user.npmrc" \
  npm_config_globalconfig="$qw_cache/global.npmrc" \
  npm_config_cache="$qw_cache" \
  "$qw_npm" ci --prefix "$qw_package_dir" --omit=dev --no-audit --no-fund
```

`qw_tool_path` contains only the selected Node/npm and required system tools.
Set `HOME` and `USERPROFILE` only for the child, never in the operator's shell
profile. Do not inherit provider config variables, copy authentication files,
inspect Keychain data, or create login state. Missing provider login or device
confirmation must be resolved by the operator under the unchanged
[provider-state authority boundary](reviewed-execution-provider-state-boundary.md).
Resuming tests alone does not expand credential authority.

## Operator-resumed local verification

The following is a staged procedure, not permission to start it now. Once the
operator explicitly resumes, recheck the source/archive/installed-file identity,
ownership, selected unused config port, Actions disabled, and zero active cache
and artifacts. Freeze the local scenario's provider/model identities, one-action
turn cap, wall-time bound, allowed disposable writes, stop condition, and cleanup
scope before launch. Stop on missing authority or unmet prerequisites.

Run the exact installed CLI in the foreground with its isolated child home:

```sh
env -i PATH="$qw_runtime_path" HOME="$qw_runtime_home" USERPROFILE="$qw_runtime_home" \
  "$qw_node" "$qw_prefix/node_modules/quadwork/bin/quadwork.js" start
```

`qw_runtime_path` must be explicitly recorded; adding a provider-state path or
environment variable requires its own authority. Do not use `npx quadwork`, an
unqualified global CLI, `quadwork init`, or an existing service. Open only the
selected loopback dashboard. Stop this owned foreground instance with its
Ctrl+C shutdown path and confirm its owned processes exited; do not signal
unrelated processes or call a global `quadwork stop`.

The resumed checklist must distinguish these proofs:

- One bounded project-path action with Codex and one with Claude through the
  installed product's ordinary launch and lifecycle path. Use only the owned
  disposable project and the recorded model. CLI presence/version, startup,
  direct standalone provider invocation, and deterministic fixtures cannot
  satisfy this requirement. Missing login, unsupported model, timeout, or
  failed lifecycle/cleanup is a blocked or failed result, not provider support.
- The retained #1037 legacy, multi-repository, browser, lifecycle, and device
  scenarios, each with its own result and pending gates. Provider success does
  not prove these scenarios. Any scenario needing remote mutation, device
  approval, or other authority must honor its separate gate.
- The matched benchmark, only under its reviewed run budget and manifest-freeze
  order. Local provider success is neither a performance result nor permission
  to skip matched baselines or observe Mode 3 before the target freeze.

Record append-only raw-free receipts: scenario and attempt identity, UTC time,
source commit, archive digest, installed-file verification, provider/model
identity, declared bounds, success/failure/block class, and bounded lifecycle
and cleanup facts. Preserve failures. Evidence receipts, screenshots, logs,
issues, and reports must contain no raw prompts, terminal/provider output,
authentication data, or Keychain data. Do not capture an extra transcript.
The ordinary product may temporarily keep scrollback or chat data while it
runs; the reviewed runner's non-retention behavior does not prove otherwise.
Before a later ordinary-product action, establish that its temporary data can
stay within the declared executor-owned scope and be removed during cleanup.
No raw content may remain after the scenario. Do not inspect, import, or alter
provider authentication or Keychain data to establish that condition. If
confinement or cleanup cannot be established within existing authority, record
a retention gate and stop before the action. Remove only owned transient data;
retain sanitized receipts and historical evidence. This policy adds no product
retention bypass or provider-state authority.

No automatic retry or reviewed-runner fallback is authorized. A failed action
blocks the corresponding support and publish recommendation. Successful local
proof still does not authorize a version change, tag, release, npm publish,
deployment, or replacement of an existing installation.

## Release-source pull request

This later stage requires operator authorization, successful local-install
provider proof, and the retained #1037 release-recommendation gates. Only then
create one release-source pull request from the current `main` tip. Its only
changes are:

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
npx tsc --noEmit
npm run build
npm pack --dry-run
```

Record the command, exit status, Node and npm versions, package version, base
commit, candidate commit, and timestamp. `npm pack --dry-run` must show the
intended executable, server, templates, output, selected source helpers, and
published documentation only. It must not include benchmark fixtures or local
evidence files.

## GitHub Actions storage guard

Actions is disabled for this repository, so release preparation must create no
Actions minutes, caches, or artifacts. Before the release-source PR and before
the tag, record these read-only account-usage checks:

```bash
gh api repos/realproject7/quadwork/actions/permissions
gh api repos/realproject7/quadwork/actions/cache/usage
gh api --paginate --slurp repos/realproject7/quadwork/actions/artifacts \
  | jq '[.[].artifacts[]|select(.expired==false)|.size_in_bytes]|add // 0'
```

The permission result must remain `enabled: false`; cache and artifact values
are recorded as facts, never offset by adding a workflow cache. Do not add
`actions/cache`, `setup-node` caching, `node_modules` caches, or artifact
uploads as a release workaround. A request to enable Actions is a separate
operator-approved change with an explicit minutes and storage budget.

The final release commit needs the same local proof after its merge to `main`.
If that commit differs from the reviewed release-source candidate, repeat the
affected review and verification before continuing.

## Finalization before publish

Only in the separately authorized release stage, after the merged `main`
commit has the required local evidence and two final reviews, may the PO create
the `v2.8.0` tag and GitHub release on that exact commit with generated notes.
Confirm that the tag resolves to the verified commit and that npm still
reports `2.7.1` as the published version before the operator gate. These are
future release instructions, not authority supplied by #1155 or this runbook.

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

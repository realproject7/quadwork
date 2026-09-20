# Reviewed execution provider-state authority boundary

## Current status, 2026-09-20 (#1155)

The comparison below preserves the historical source facts and authority limits
recorded for #1147. It is not installed-product provider support or release
proof. The reviewed runner remains a security harness; its unresolved future
one-shot obligations no longer block implementation or source-audit completion.
Preserve prior authorizations, consumed attempts, diagnostics, and evidence
unchanged. Consumed authorizations cannot be retried, reset, or reused.

Real-provider turns, product E2E/device checks, and live benchmarks remain on
hold until the operator returns and explicitly resumes testing. Local build,
isolated installation, and test preparation do not authorize reading provider
state. The later installed-product check must use the exact reviewed artifact
and retain only raw-free result facts; this historical note cannot satisfy it.

No interactive login, OAuth grant, credential/auth-file/Keychain inspection,
copying, or change is authorized. Missing login, device confirmation, or extra
provider-state access remains an operator gate. The explicit authority rule at
the end of this note remains in force for every later execution path.

## Historical source comparison (#1147)

This note is a source-fact comparison for #1147. It is not authentication,
entitlement, provider availability, or credential evidence. The implementation
and its test read checked-in source only; they do not enumerate, open, copy,
mount, or authorize a user provider configuration or credential directory.

| Path | HOME source fact | Provider-state conclusion |
| --- | --- | --- |
| #1109 compatibility smoke | `sanitizedEnvironment()` retains the inherited `HOME` environment value. | The checked-in smoke source does not itself inspect provider state. Provider behavior under that inherited state is not a credential claim. |
| Reviewed Claude | The fixed child assigns `HOME` and `USERPROFILE` to its executor-owned disposable directory. Claude's reviewed profile has an empty fixed environment and its generated sandbox has no Claude provider-state read path. | No Claude provider-state read authority is added or observed by #1147. |
| Reviewed Codex | The fixed child also assigns disposable `HOME`/`USERPROFILE`. Independently, the already source-controlled Codex profile supplies its fixed `CODEX_HOME`, and the existing generated sandbox lists that same static path. | This pre-existing, static Codex authority is recorded for review; #1147 neither reads its contents nor expands, narrows, copies, mounts, or changes it. It is not proof of login or entitlement. |

The redacted `cleanup_attestation` field may contain only `none`, `stop`,
`shutdown`, `survivor`, `root`, `environment`, or `unverified`. `root` includes
the existing root-facts/Git postcondition. The field never contains raw terminal
output, exit details, paths, argv, prompts, credentials, or root facts.

Any future change that reads, inherits, copies, mounts, or otherwise expands
access to a user provider configuration or credential directory requires an
explicit operator credential-authority approval before implementation. A normal
reviewed-execution authorization, a provider one-shot authorization, or this
source-fact diagnostic does not grant that authority.

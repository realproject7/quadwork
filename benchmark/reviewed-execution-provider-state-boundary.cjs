'use strict';

// This diagnostic reads only checked-in source files. It intentionally does
// not inspect HOME, CODEX_HOME, provider configuration, a keychain, or any
// credential directory. It is a source-fact comparison, not an availability,
// login, entitlement, or credential assertion.
const fs = require('node:fs');
const path = require('node:path');

const OPERATOR_CREDENTIAL_AUTHORITY = 'explicit_operator_credential_authority_required';

function sourceFacts() {
  const repository = path.resolve(__dirname, '..');
  const read = relative => fs.readFileSync(path.join(repository, relative), 'utf8');
  const compatibility = read('benchmark/live-provider-compatibility-core.cjs');
  const child = read('benchmark/reviewed-execution-live-child-protocol.cjs');
  const profiles = read('server/reviewed-execution-profiles.js');
  const normal_home_is_inherited = compatibility.includes("const SAFE_ENVIRONMENT = new Set(['HOME'")
    && compatibility.includes('function sanitizedEnvironment(source = process.env)');
  const reviewed_home_is_disposable = child.includes('process.env.HOME = locations.home; process.env.USERPROFILE = locations.home;');
  const claude_has_no_profile_environment = profiles.includes("env: Object.freeze({}),\n  }),");
  const codex_home_is_static_existing_authority = profiles.includes('env: Object.freeze({ CODEX_HOME })')
    && profiles.includes("...(profile.backend === 'codex' ? [CODEX_HOME] : [])");
  if (!normal_home_is_inherited || !reviewed_home_is_disposable || !claude_has_no_profile_environment || !codex_home_is_static_existing_authority) throw new Error('reviewed_execution_provider_state_source_drift');
  return Object.freeze({
    schema_version: 1,
    comparison: 'source_only',
    normal_home: Object.freeze({ home: 'inherited_safe_environment', provider_state_observed: false }),
    reviewed_claude: Object.freeze({ home: 'executor_owned_disposable', provider_state_observed: false, provider_state_read_authorized: false }),
    reviewed_codex: Object.freeze({ home: 'executor_owned_disposable', provider_state_observed: false, static_codex_home_authority_preexisting: true }),
    future_expansion_authority: OPERATOR_CREDENTIAL_AUTHORITY,
  });
}

module.exports = Object.freeze({ OPERATOR_CREDENTIAL_AUTHORITY, sourceFacts });

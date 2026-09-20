'use strict';

// This diagnostic reads only checked-in source files. It intentionally does
// not inspect HOME, provider configuration, a keychain, or auth-file content.
// It is a source-fact comparison, not an availability, login, entitlement,
// or credential assertion.
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
  const claude_config_locator_is_fixed = profiles.includes("const CLAUDE_CONFIG_DIR = '/Users/cho';")
    && profiles.includes('env: Object.freeze({ CLAUDE_CONFIG_DIR })')
    && profiles.includes("profile.env?.CLAUDE_CONFIG_DIR !== path.dirname(filename)");
  const staticMappings = profiles.includes("const CODEX_AUTH_FILE = '/Users/cho/.codex/auth.json';")
    && profiles.includes("const CLAUDE_AUTH_FILE = '/Users/cho/.claude.json';")
    && profiles.includes('provider_state_file: CODEX_AUTH_FILE')
    && profiles.includes('provider_state_file: CLAUDE_AUTH_FILE')
    && profiles.includes('(allow file-read* (literal')
    && !profiles.includes("...(profile.backend === 'codex' ? [CODEX_HOME] : [])");
  const noKeychainRoute = !/exec(?:File|Sync)?\([^)]*security/.test(profiles)
    && !/exec(?:File|Sync)?\([^)]*security/.test(child)
    && !/find-(?:generic|internet)-password/.test(profiles)
    && !/find-(?:generic|internet)-password/.test(child);
  if (!normal_home_is_inherited || !reviewed_home_is_disposable || !claude_config_locator_is_fixed || !staticMappings || !noKeychainRoute) throw new Error('reviewed_execution_provider_state_source_drift');
  return Object.freeze({
    schema_version: 1,
    comparison: 'source_only',
    normal_home: Object.freeze({ home: 'inherited_safe_environment', provider_state_observed: false }),
    reviewed_claude: Object.freeze({ home: 'executor_owned_disposable', provider_state_observed: false, provider_state_read_authorized: true, provider_state_binding: 'exact_file_metadata_validated', provider_state_locator: 'fixed_claude_config_dir' }),
    reviewed_codex: Object.freeze({ home: 'executor_owned_disposable', provider_state_observed: false, provider_state_read_authorized: true, provider_state_binding: 'exact_file_metadata_validated' }),
    future_expansion_authority: OPERATOR_CREDENTIAL_AUTHORITY,
  });
}

module.exports = Object.freeze({ OPERATOR_CREDENTIAL_AUTHORITY, sourceFacts });

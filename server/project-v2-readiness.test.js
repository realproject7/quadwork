"use strict";

const assert = require("node:assert/strict");
const { projectV2Readiness } = require("./project-v2-readiness");

const policy = { version: 1, mode: "ci-less", evidence_keys: ["operator"] };

function project(repositories, extra = {}) {
  return { id: "alpha", repositories, ...extra };
}

function repository(overrides = {}) {
  return {
    key: "web",
    repo: "Acme/Web",
    working_dir: "/tmp/acme-web",
    primary: true,
    ci_policy: policy,
    ...overrides,
  };
}

function codes(value) {
  return value.reasons.map((entry) => entry.code);
}

const valid = projectV2Readiness(project([repository()]));
assert.equal(valid.ready, true);
assert.deepEqual(valid.reasons, []);
console.log("  PASS: valid policy-backed repository is ready");

const legacy = projectV2Readiness({ id: "alpha", repo: "Acme/Web", working_dir: "/tmp/acme-web" });
assert.equal(legacy.ready, false);
assert.deepEqual(codes(legacy), ["legacy_scalar", "repositories_required", "invalid_primary_repository_count"]);
console.log("  PASS: scalar projects expose explicit legacy readiness");

const primary = projectV2Readiness(project([
  repository({ primary: false }),
  repository({ key: "api", repo: "Acme/Api", working_dir: "/tmp/acme-api", primary: false }),
]));
assert.equal(primary.ready, false);
assert.deepEqual(codes(primary), ["invalid_primary_repository_count"]);
assert.equal(primary.reasons[0].primary_count, 0);
console.log("  PASS: primary cardinality remains typed");

const missing = projectV2Readiness(project([repository({ ci_policy: undefined })]));
assert.equal(missing.ready, false);
assert.equal(missing.reasons[0].code, "invalid_ci_policy", "present undefined is invalid rather than inferred");

const absent = repository();
delete absent.ci_policy;
const absentResult = projectV2Readiness(project([absent]));
assert.equal(absentResult.ready, false);
assert.deepEqual(absentResult.reasons, [{ code: "missing_policy", repo_key: "web" }]);
console.log("  PASS: absent policy is missing_policy and is never inferred");

const invalid = projectV2Readiness(project([repository({ ci_policy: { mode: "github-checks", checks: [] } })]));
assert.equal(invalid.ready, false);
assert.equal(invalid.reasons[0].code, "invalid_ci_policy");
assert.equal(invalid.reasons[0].repo_key, "web");
assert.ok(typeof invalid.reasons[0].policy_code === "string");
console.log("  PASS: invalid policy retains a safe repository-qualified reason");

const duplicate = projectV2Readiness(project([
  repository(),
  repository({ key: "web", repo: "acme/web", working_dir: "/tmp/acme-web-2", primary: false }),
]));
assert.equal(duplicate.ready, false);
assert.deepEqual(codes(duplicate), ["duplicate_repository_key", "duplicate_repository"]);
console.log("  PASS: duplicate identities fail before activation");

console.log("\n6 passed, 0 failed\n");

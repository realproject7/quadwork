"use strict";

// #1031: pure repository-qualified work-item identity.
//
// This module deliberately knows nothing about config files, activation,
// GitHub, review receipts, or later WorkTaskRef/DeliveryCandidateRef schemas.
// Callers supply the already-normalized registered repository list and retain
// ownership of all I/O and authority transitions.

const REPOSITORY_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const NUMBER_RE = /^[1-9]\d{0,6}$/;
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
// #1033 defines this as a server-issued opaque id, not a UUID or a counter.
// Validate only a bounded, transport-safe representation here; generation and
// freshness remain the assignment owner's responsibility.
const ASSIGNMENT_ATTEMPT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WORK_ITEM_KINDS = new Set(["issue", "pr"]);

const REF_FIELDS = Object.freeze(["kind", "number", "repo", "repoKey"]);
const PROVENANCE_FIELDS = Object.freeze(["assignment_attempt", "batch_number", "installation_id"]);

class WorkItemRefError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkItemRefError";
    this.code = code;
  }
}

function diagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

function fail(code, message) {
  throw new WorkItemRefError(code, message);
}

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === fields.length && fields.every((field, index) => actual[index] === field);
}

function canonicalRepository(repo) {
  return typeof repo === "string" && REPOSITORY_RE.test(repo) ? repo.toLowerCase() : null;
}

function validateKind(kind) {
  if (!WORK_ITEM_KINDS.has(kind)) fail("invalid_work_item_kind", "work item kind must be issue or pr");
  return kind;
}

function assertWorkItemRef(ref) {
  if (!exactFields(ref, REF_FIELDS)) {
    fail("invalid_work_item_ref", "work item reference must contain only repoKey, repo, number, and kind");
  }
  if (typeof ref.repoKey !== "string" || !REPOSITORY_KEY_RE.test(ref.repoKey)) {
    fail("invalid_repository_key", "work item repository key is invalid");
  }
  if (typeof ref.repo !== "string" || !REPOSITORY_RE.test(ref.repo)) {
    fail("invalid_repository", "work item repository is invalid");
  }
  if (!Number.isSafeInteger(ref.number) || ref.number < 1 || ref.number > 9_999_999) {
    fail("invalid_work_item_number", "work item number must be an integer from 1 through 9999999");
  }
  validateKind(ref.kind);
  return ref;
}

function buildRepositoryRegistry(repositories) {
  if (!Array.isArray(repositories) || repositories.length === 0) {
    fail("invalid_repository_registry", "registered repositories must be a non-empty array");
  }
  const byCanonicalRepo = new Map();
  const keys = new Set();
  const entries = repositories.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("invalid_repository_registry", "registered repository entry is invalid");
    }
    if (typeof entry.key !== "string" || !REPOSITORY_KEY_RE.test(entry.key)) {
      fail("invalid_repository_key", "registered repository key is invalid");
    }
    if (keys.has(entry.key)) fail("duplicate_repository_key", "registered repository key is duplicated");
    const canonical = canonicalRepository(entry.repo);
    if (!canonical) fail("invalid_repository", "registered repository name is invalid");
    if (byCanonicalRepo.has(canonical)) {
      fail("duplicate_registered_repository", "canonical registered repository is duplicated");
    }
    const normalized = Object.freeze({ key: entry.key, repo: entry.repo, primary: entry.primary === true });
    keys.add(entry.key);
    byCanonicalRepo.set(canonical, normalized);
    return normalized;
  });
  return { entries, byCanonicalRepo };
}

function parsedError(error, details = {}) {
  if (error instanceof WorkItemRefError) {
    return { ok: false, diagnostic: diagnostic(error.code, error.message, details) };
  }
  return { ok: false, diagnostic: diagnostic("invalid_work_item_ref", "work item reference is invalid", details) };
}

function parseWorkItemToken(token, options = {}) {
  try {
    const registry = buildRepositoryRegistry(options.repositories);
    const kind = validateKind(options.kind || "issue");
    if (typeof token !== "string" || token.length === 0 || token.trim() !== token) {
      fail("invalid_work_item_ref", "work item token is malformed");
    }

    let registered;
    let numberText;
    let legacyUnowned = false;
    const qualified = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(.+)$/.exec(token);
    const bare = /^#(.+)$/.exec(token);
    if (qualified) {
      if (!NUMBER_RE.test(qualified[2])) fail("invalid_work_item_number", "work item number is malformed");
      registered = registry.byCanonicalRepo.get(qualified[1].toLowerCase());
      if (!registered) fail("unknown_repository", "work item repository is not registered for this project");
      numberText = qualified[2];
    } else if (bare) {
      if (!NUMBER_RE.test(bare[1])) fail("invalid_work_item_number", "work item number is malformed");
      if (options.allowLegacyBare !== true) {
        fail("bare_ref_forbidden", "bare work item references are not allowed in this mode");
      }
      if (registry.entries.length !== 1) {
        fail("bare_ref_ambiguous", "bare work item reference is ambiguous for a multi-repository project");
      }
      registered = registry.entries[0];
      numberText = bare[1];
      legacyUnowned = true;
    } else {
      fail("invalid_work_item_ref", "work item token must be owner/repo#number or an allowed legacy #number");
    }

    const ref = Object.freeze({
      repoKey: registered.key,
      repo: registered.repo,
      number: Number(numberText),
      kind,
    });
    return { ok: true, ref, legacyUnowned, token: serializeWorkItemRef(ref) };
  } catch (error) {
    return parsedError(error, { token: typeof token === "string" ? token : null });
  }
}

function lineCandidate(content, repositories) {
  if (/^\[?#/.test(content) || /^\[?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#/.test(content)) return true;
  if (/^\[?[A-Za-z0-9._-]+\/[A-Za-z0-9._\/-]*#/.test(content)) return true;
  // Diagnose the common immediate `owner/repo #42` split. Path/URL prose where
  // the issue mention is not the second token remains ignored below.
  const separated = /^\[?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\s+#/.exec(content);
  if (!separated || !Array.isArray(repositories)) return false;
  const canonical = canonicalRepository(separated[1]);
  if (!canonical) return false;
  return true;
}

function parseWorkItemLine(line, options = {}) {
  if (typeof line !== "string") {
    return { ok: false, diagnostic: diagnostic("invalid_work_item_line", "work item line must be a string") };
  }
  const marker = /^\s*(?:(?:[-*]|\d+\.)\s+)?(?:\[[ xX]\]\s+)?/.exec(line);
  const content = line.slice(marker ? marker[0].length : 0);
  if (!content || !lineCandidate(content, options.repositories)) return { ok: true, ignored: true };

  let token;
  let remainder;
  if (content.startsWith("[")) {
    const close = content.indexOf("]");
    if (close < 0) {
      return { ok: false, diagnostic: diagnostic("invalid_work_item_line", "bracketed work item token is not closed", { line }) };
    }
    token = content.slice(1, close);
    remainder = content.slice(close + 1);
  } else {
    const match = /^(\S+?)(?=$|\s|[—:])/.exec(content);
    if (!match) {
      return { ok: false, diagnostic: diagnostic("invalid_work_item_line", "work item token is not delimited", { line }) };
    }
    token = match[1];
    remainder = content.slice(match[0].length);
  }

  const parsed = parseWorkItemToken(token, options);
  if (!parsed.ok) return { ...parsed, diagnostic: { ...parsed.diagnostic, line } };
  return {
    ...parsed,
    ignored: false,
    remainder: remainder.trim().replace(/^[—:]+\s*/, ""),
  };
}

function parseWorkItemLines(lines, options = {}) {
  if (!Array.isArray(lines)) {
    return { ok: false, items: [], diagnostics: [diagnostic("invalid_work_item_lines", "work item lines must be an array")] };
  }
  const items = [];
  const diagnostics = [];
  const seen = new Set();
  lines.forEach((line, index) => {
    const parsed = parseWorkItemLine(line, options);
    if (!parsed.ok) {
      diagnostics.push({ ...parsed.diagnostic, line_number: index + 1 });
      return;
    }
    if (parsed.ignored) return;
    const key = workItemKey(parsed.ref);
    if (seen.has(key)) {
      diagnostics.push(diagnostic(
        "duplicate_work_item_ref",
        "work item reference is duplicated",
        { line, line_number: index + 1, token: parsed.token },
      ));
      return;
    }
    seen.add(key);
    items.push({ ref: parsed.ref, legacyUnowned: parsed.legacyUnowned, remainder: parsed.remainder });
  });
  return { ok: diagnostics.length === 0, items, diagnostics };
}

function serializeWorkItemRef(ref) {
  assertWorkItemRef(ref);
  return `${ref.repo}#${ref.number}`;
}

function serializeWorkItemRefApi(ref) {
  assertWorkItemRef(ref);
  return { repo_key: ref.repoKey, repo: ref.repo, number: ref.number, kind: ref.kind };
}

function workItemKey(ref) {
  assertWorkItemRef(ref);
  return JSON.stringify(["work-item-ref", 1, ref.repoKey, ref.repo.toLowerCase(), ref.number, ref.kind]);
}

function validateAssignmentProvenance(provenance) {
  try {
    if (!exactFields(provenance, PROVENANCE_FIELDS)) {
      fail(
        "invalid_ownership_provenance",
        "ownership provenance must contain only installation_id, batch_number, and assignment_attempt",
      );
    }
    if (typeof provenance.installation_id !== "string" || !INSTALLATION_ID_RE.test(provenance.installation_id)) {
      fail("invalid_installation_id", "ownership installation_id is missing or invalid");
    }
    if (!Number.isSafeInteger(provenance.batch_number) || provenance.batch_number < 1) {
      fail("invalid_batch_number", "ownership batch_number must be a positive safe integer");
    }
    if (typeof provenance.assignment_attempt !== "string" ||
        !ASSIGNMENT_ATTEMPT_RE.test(provenance.assignment_attempt)) {
      fail("invalid_assignment_attempt", "ownership assignment_attempt is missing or invalid");
    }
    return {
      ok: true,
      value: Object.freeze({
        installation_id: provenance.installation_id,
        batch_number: provenance.batch_number,
        assignment_attempt: provenance.assignment_attempt,
      }),
    };
  } catch (error) {
    return parsedError(error);
  }
}

function validateOwnershipProvenance(provenance, ref) {
  try {
    assertWorkItemRef(ref);
    const assignment = validateAssignmentProvenance(provenance);
    if (!assignment.ok) fail(assignment.diagnostic.code, assignment.diagnostic.message);
    return {
      ok: true,
      value: Object.freeze({
        ...assignment.value,
        ref: Object.freeze({ ...ref }),
      }),
    };
  } catch (error) {
    return parsedError(error);
  }
}

function ownershipKey(provenance, ref) {
  const validated = validateOwnershipProvenance(provenance, ref);
  if (!validated.ok) fail(validated.diagnostic.code, validated.diagnostic.message);
  const value = validated.value;
  return JSON.stringify([
    "work-item-owner",
    1,
    value.installation_id,
    value.batch_number,
    value.assignment_attempt,
    workItemKey(value.ref),
  ]);
}

module.exports = {
  WorkItemRefError,
  parseWorkItemToken,
  parseWorkItemLine,
  parseWorkItemLines,
  assertWorkItemRef,
  serializeWorkItemRef,
  serializeWorkItemRefApi,
  workItemKey,
  validateAssignmentProvenance,
  validateOwnershipProvenance,
  ownershipKey,
};

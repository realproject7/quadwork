"use strict";

const crypto = require("crypto");

const WORKER_UNIT_PREFIX = "quadwork-worker-";
const CONTROL_UNIT_PREFIX = "quadwork-control-";
const UNIT_DIGEST_HEX_LENGTH = 40;
const MAX_UNIT_BASE_LENGTH = 63;
const QUALIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERATED_UNIT_BASE_RE = /^(?:quadwork-worker|quadwork-control)-[a-f0-9]{40}$/;

class ResourceUnitError extends Error {
  constructor(field, detail) {
    super(`${field} ${detail}`);
    this.name = "ResourceUnitError";
    this.code = "QW_INVALID_RESOURCE_UNIT_IDENTITY";
    this.field = field;
  }
}

function qualifier(value, field) {
  if (typeof value !== "string" || !QUALIFIER_RE.test(value)) {
    throw new ResourceUnitError(field, "must be a path-free identifier of at most 128 characters");
  }
  return value;
}

function digestIdentity(parts) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex")
    .slice(0, UNIT_DIGEST_HEX_LENGTH);
}

function generatedBase(prefix, identityParts) {
  const base = `${prefix}${digestIdentity(identityParts)}`;
  if (base.length > MAX_UNIT_BASE_LENGTH || !GENERATED_UNIT_BASE_RE.test(base)) {
    throw new ResourceUnitError("identity", "did not produce a supported systemd unit base");
  }
  return base;
}

function createWorkerUnitBase(identity = {}) {
  const projectId = qualifier(identity.projectId, "projectId");
  const generationId = qualifier(identity.generationId, "generationId");
  return generatedBase(WORKER_UNIT_PREFIX, ["worker", projectId, generationId]);
}

function createControlUnitBase(identity = {}) {
  const projectId = qualifier(identity.projectId, "projectId");
  const generationId = qualifier(identity.generationId, "generationId");
  const operationId = qualifier(identity.operationId, "operationId");
  return generatedBase(CONTROL_UNIT_PREFIX, ["control", projectId, generationId, operationId]);
}

function validateGeneratedUnitBase(value) {
  if (typeof value !== "string"
    || value.length > MAX_UNIT_BASE_LENGTH
    || !GENERATED_UNIT_BASE_RE.test(value)) {
    throw new ResourceUnitError("unitBase", "must be a generated QuadWork worker or control unit base");
  }
  return value;
}

function scopeUnitFromBase(unitBase) {
  return `${validateGeneratedUnitBase(unitBase)}.scope`;
}

function baseFromScopeUnit(scopeUnit) {
  if (typeof scopeUnit !== "string" || !scopeUnit.endsWith(".scope")) {
    throw new ResourceUnitError("scopeUnit", "must be a generated QuadWork .scope unit");
  }
  return validateGeneratedUnitBase(scopeUnit.slice(0, -".scope".length));
}

module.exports = {
  WORKER_UNIT_PREFIX,
  CONTROL_UNIT_PREFIX,
  MAX_UNIT_BASE_LENGTH,
  ResourceUnitError,
  createWorkerUnitBase,
  createControlUnitBase,
  validateGeneratedUnitBase,
  scopeUnitFromBase,
  baseFromScopeUnit,
};

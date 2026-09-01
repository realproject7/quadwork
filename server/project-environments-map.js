"use strict";

// Disk-backed, Head-readable projection of the environment bindings. The JSON
// inside the generated section comes exclusively from the M1 allow-list
// renderer; this writer neither discovers environments nor retains arbitrary
// project/config fields.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { renderProjectEnvironmentsMap } = require("./project-environment-bindings");

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".quadwork");
const FILE_NAME = "PROJECT-ENVIRONMENTS.md";
const GENERATED_HEADING = "## Managed Environment Map";
const GENERATED_START = "<!-- quadwork:project-environments:generated:start -->";
const GENERATED_END = "<!-- quadwork:project-environments:generated:end -->";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalRepositoryFromProject(project, key) {
  if (!Array.isArray(project?.repositories)) return null;
  const record = project.repositories.find((entry) => entry && entry.key === key);
  if (!record || typeof record.repo !== "string") return null;
  return record.repo.trim().toLowerCase();
}

function projectEnvironmentInput(config, project) {
  return {
    installation_id: config?.installation_id,
    project,
    resolveCanonicalRepository: canonicalRepositoryFromProject,
  };
}

function generatedSection(content) {
  return [
    GENERATED_HEADING,
    GENERATED_START,
    "```json",
    content.trimEnd(),
    "```",
    GENERATED_END,
    "",
  ].join("\n");
}

function operatorSections(existing) {
  if (typeof existing !== "string" || !existing) return "";
  // Preserve H2 sections verbatim except this file's managed section. A
  // future generated field cannot leak through this merger because only the
  // explicit renderer above authors the managed body.
  const chunks = existing.split(/(?=^##\s+)/m);
  return chunks
    .filter((chunk) => /^##\s+/.test(chunk))
    .filter((chunk) => !/^## Managed Environment Map(?:\r?\n|$)/.test(chunk))
    .map((chunk) => chunk.trimEnd())
    .filter(Boolean)
    .join("\n\n");
}

function mergeProjectEnvironmentsDocument(existing, renderedMap) {
  if (typeof renderedMap !== "string") throw new TypeError("rendered environment map must be a string");
  const preserved = operatorSections(existing);
  return [
    "# Project Environments",
    "",
    generatedSection(renderedMap).trimEnd(),
    ...(preserved ? ["", preserved] : []),
    "",
  ].join("\n");
}

function ensurePrivateDirectory(dir, fsImpl = fs) {
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(dir, 0o700); } catch {}
}

function writePrivateAtomic(filePath, content, fsImpl = fs) {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fsImpl.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    try { fsImpl.chmodSync(tmpPath, 0o600); } catch {}
    fsImpl.renameSync(tmpPath, filePath);
    try { fsImpl.chmodSync(filePath, 0o600); } catch {}
  } catch (error) {
    try { fsImpl.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function writeProjectEnvironmentsMap(config, project, options = {}) {
  if (!isPlainObject(config) || !isPlainObject(project) || typeof project.id !== "string" || !project.id) {
    throw new TypeError("project environment map requires configured project identity");
  }
  const rendered = renderProjectEnvironmentsMap(projectEnvironmentInput(config, project));
  if (!rendered.ok) {
    const error = new Error(rendered.error.message);
    error.code = rendered.error.code;
    error.field = rendered.error.field;
    throw error;
  }
  const configDir = options.configDir || DEFAULT_CONFIG_DIR;
  const fsImpl = options.fsImpl || fs;
  const projectDir = path.join(configDir, project.id);
  const filePath = path.join(projectDir, FILE_NAME);
  let existing = "";
  try { existing = fsImpl.readFileSync(filePath, "utf8"); } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  ensurePrivateDirectory(projectDir, fsImpl);
  const content = mergeProjectEnvironmentsDocument(existing, rendered.content);
  writePrivateAtomic(filePath, content, fsImpl);
  return Object.freeze({
    file_path: filePath,
    payload: rendered.payload,
    content,
    preserved_operator_sections: operatorSections(existing) ? true : false,
  });
}

module.exports = {
  FILE_NAME,
  GENERATED_HEADING,
  GENERATED_START,
  GENERATED_END,
  canonicalRepositoryFromProject,
  projectEnvironmentInput,
  mergeProjectEnvironmentsDocument,
  writePrivateAtomic,
  writeProjectEnvironmentsMap,
};

const fs = require("fs");
const path = require("path");
const os = require("os");
const { ensureSecureDir, writeSecureFile } = require("./config");
const { parseMentions } = require("./file-chat");

const KNOWN_FIELDS = new Set([
  "id", "timestamp", "ts", "sender", "channel", "type", "text", "message", "mentions",
]);

function convertAcRecord(record, nextId) {
  let ts;
  if (record.timestamp) {
    const raw = Number(record.timestamp);
    ts = !isNaN(raw) && raw > 0
      ? new Date(raw * 1000).toISOString()
      : String(record.timestamp);
  } else if (record.ts) {
    const raw = Number(record.ts);
    ts = !isNaN(raw) && raw > 0
      ? new Date(raw * 1000).toISOString()
      : String(record.ts);
  } else {
    ts = new Date().toISOString();
  }

  const text = record.text || record.message || "";
  const known = {
    id: nextId,
    seq: nextId,
    ts,
    sender: record.sender || "unknown",
    channel: record.channel || "general",
    type: record.type === "system" ? "system" : "message",
    text,
    mentions: parseMentions(text),
  };

  const legacy = {};
  for (const [key, val] of Object.entries(record)) {
    if (!KNOWN_FIELDS.has(key)) {
      legacy[key] = val;
    }
  }
  if (record.type && record.type !== known.type) {
    legacy.type = record.type;
  }
  if (Object.keys(legacy).length > 0) known._legacy = legacy;
  return known;
}

function migrateProject(projectId) {
  const chatDir = path.join(os.homedir(), ".quadwork", projectId, "chat");
  const migratedPath = path.join(chatDir, ".migrated");
  const targetPath = path.join(chatDir, "general.jsonl");

  if (fs.existsSync(migratedPath)) return null;

  if (fs.existsSync(targetPath)) {
    console.log(`[migration] ${projectId}: general.jsonl already exists without .migrated — skipping (Phase 1 test project)`);
    return null;
  }

  const acLogPath = path.join(
    os.homedir(), ".quadwork", projectId, "agentchattr", "data", "agentchattr_log.jsonl"
  );
  if (!fs.existsSync(acLogPath)) return null;

  const content = fs.readFileSync(acLogPath, "utf-8");
  const lines = content.split("\n");
  const converted = [];
  let nextId = 0;
  let skipped = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      converted.push(convertAcRecord(record, nextId));
      nextId++;
    } catch {
      skipped++;
    }
  }

  if (converted.length === 0 && skipped === 0) return null;

  if (converted.length === 0 && skipped > 0) {
    console.log(`[migration] ${projectId}: AC log has ${skipped} lines but none are valid JSON — skipping`);
    return null;
  }

  ensureSecureDir(chatDir);

  const tmpPath = targetPath + ".tmp";
  const output = converted.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeSecureFile(tmpPath, output);

  const verifyContent = fs.readFileSync(tmpPath, "utf-8");
  const verifyLines = verifyContent.trim().split("\n");
  let verified = 0;
  for (const vl of verifyLines) {
    try {
      JSON.parse(vl);
      verified++;
    } catch {
      fs.unlinkSync(tmpPath);
      throw new Error(`Migration validation failed for ${projectId}: corrupt line in tmp file`);
    }
  }
  if (verified !== converted.length) {
    fs.unlinkSync(tmpPath);
    throw new Error(`Migration validation failed for ${projectId}: expected ${converted.length} records, got ${verified}`);
  }

  fs.renameSync(tmpPath, targetPath);
  try { fs.chmodSync(targetPath, 0o600); } catch {}

  const systemMsg = {
    id: nextId,
    seq: nextId,
    ts: new Date().toISOString(),
    sender: "system",
    channel: "general",
    type: "system",
    text: `Chat history migrated from AC (${converted.length} messages)`,
    mentions: [],
  };
  fs.appendFileSync(targetPath, JSON.stringify(systemMsg) + "\n", { mode: 0o600 });

  const manifest = {
    migrated_at: new Date().toISOString(),
    source: acLogPath,
    messages: converted.length,
    skipped,
  };
  writeSecureFile(migratedPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`[migration] ${projectId}: migrated ${converted.length} messages, ${skipped} skipped (invalid JSON)`);
  return { messages: converted.length, skipped };
}

function runAcMigration(config) {
  const failed = [];
  const projects = config.projects || [];
  for (const project of projects) {
    if (!project || !project.id) continue;
    try {
      migrateProject(project.id);
    } catch (err) {
      console.error(`[migration] ${project.id}: failed — ${err.message}`);
      failed.push(project.id);
    }
  }
  return failed;
}

module.exports = { runAcMigration, migrateProject, convertAcRecord };

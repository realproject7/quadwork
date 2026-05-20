const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { ensureSecureDir } = require("./config");

function convertToAcFormat(record) {
  const acRecord = {
    ...(record._legacy || {}),
    id: record.id,
    sender: record.sender,
    text: record.text,
    channel: record.channel,
    timestamp: record.ts,
    type: record.type,
    _quadwork_restored_id: record.id,
  };
  return acRecord;
}

function normalizeTs(ts) {
  if (typeof ts === "number") return new Date(ts * 1000).toISOString();
  return String(ts || "");
}

function contentHash(record) {
  const key = `${normalizeTs(record.ts)}|${record.sender}|${record.channel}|${record.text}`;
  return crypto.createHash("sha1").update(key).digest("hex");
}

function restoreProject(projectId) {
  const chatFile = path.join(os.homedir(), ".quadwork", projectId, "chat", "general.jsonl");
  if (!fs.existsSync(chatFile)) return null;

  const acDataDir = path.join(os.homedir(), ".quadwork", projectId, "agentchattr", "data");
  const acLogPath = path.join(acDataDir, "agentchattr_log.jsonl");

  const existingHashes = new Set();
  const existingRestoredIds = new Set();
  if (fs.existsSync(acLogPath)) {
    const existing = fs.readFileSync(acLogPath, "utf-8");
    for (const line of existing.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        existingHashes.add(contentHash({
          ts: rec.timestamp,
          sender: rec.sender,
          channel: rec.channel,
          text: rec.text,
        }));
        if (rec._quadwork_restored_id !== undefined) {
          existingRestoredIds.add(rec._quadwork_restored_id);
        }
      } catch {}
    }
  }

  const content = fs.readFileSync(chatFile, "utf-8");
  const lines = content.split("\n");
  const toAppend = [];
  let skipped = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }

    if (record.type === "system" && record.sender === "system" &&
        record.text && record.text.startsWith("Chat history migrated from AC")) {
      skipped++;
      continue;
    }

    if (existingRestoredIds.has(record.id)) {
      skipped++;
      continue;
    }

    const acRecord = convertToAcFormat(record);
    const hash = contentHash({
      ts: acRecord.timestamp,
      sender: acRecord.sender,
      channel: acRecord.channel,
      text: acRecord.text,
    });
    if (existingHashes.has(hash)) {
      skipped++;
      continue;
    }

    toAppend.push(acRecord);
    existingHashes.add(hash);
  }

  if (toAppend.length === 0) {
    console.log(`[ac-restore] ${projectId}: no new messages to restore (${skipped} skipped)`);
    return { restored: 0, skipped };
  }

  ensureSecureDir(acDataDir);
  const output = toAppend.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(acLogPath, output, { mode: 0o600 });
  try { fs.chmodSync(acLogPath, 0o600); } catch {}

  console.log(`[ac-restore] ${projectId}: restored ${toAppend.length} messages, ${skipped} skipped`);
  return { restored: toAppend.length, skipped };
}

function runAcRestore(config, projectFilter) {
  const projects = config.projects || [];
  for (const project of projects) {
    if (!project || !project.id) continue;
    if (projectFilter && project.id !== projectFilter) continue;
    try {
      restoreProject(project.id);
    } catch (err) {
      console.error(`[ac-restore] ${project.id}: failed — ${err.message}`);
    }
  }
}

module.exports = { runAcRestore, restoreProject, convertToAcFormat, contentHash };

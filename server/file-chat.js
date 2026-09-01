const fs = require("fs");
const path = require("path");
const os = require("os");
const { ensureSecureDir, writeSecureFile } = require("./config");
const { envelopeFor } = require("./trusted-event-transport");
const { envelopeFor: reviewCycleEnvelopeFor } = require("./review-cycle-event");
const { batchRequestNotice } = require("./batch-request-notice");
const { headLifecycleNotice } = require("./head-lifecycle-notice");

const MENTION_RE = /@(\w[\w-]*)/g;

// Per-project state keyed by projectId
const projectState = new Map();

function getState(projectId) {
  if (!projectState.has(projectId)) {
    projectState.set(projectId, { nextId: null, cache: [] });
  }
  return projectState.get(projectId);
}

function chatDir(projectId) {
  return path.join(os.homedir(), ".quadwork", projectId, "chat");
}

function chatFile(projectId) {
  return path.join(chatDir(projectId), "general.jsonl");
}

function writerLockPath(projectId) {
  return path.join(chatDir(projectId), ".writer.pid");
}

function parseMentions(text) {
  if (typeof text !== "string") return [];
  const mentions = [];
  let m;
  while ((m = MENTION_RE.exec(text)) !== null) {
    mentions.push(m[1].toLowerCase());
  }
  return [...new Set(mentions)];
}

// --- Writer lock ---

function acquireWriterLock(projectId) {
  const lockPath = writerLockPath(projectId);
  const dir = chatDir(projectId);
  ensureSecureDir(dir);

  if (fs.existsSync(lockPath)) {
    let existingPid;
    try {
      existingPid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
    } catch {
      // Corrupt lock file — overwrite
    }
    if (existingPid) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`QuadWork already running on this directory (pid ${existingPid})`);
      } catch (err) {
        if (err.code === "ESRCH") {
          console.warn(`[file-chat] Stale writer lock for project ${projectId} (pid ${existingPid}), replacing`);
        } else if (!err.code) {
          throw err;
        }
      }
    }
  }

  writeSecureFile(lockPath, String(process.pid));
}

function releaseWriterLock(projectId) {
  try {
    fs.unlinkSync(writerLockPath(projectId));
  } catch {}
}

// --- ID recovery ---

function recoverNextId(projectId) {
  const filePath = chatFile(projectId);
  let maxId = 0;

  if (!fs.existsSync(filePath)) return 1;

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.id === "number" && record.id > maxId) {
        maxId = record.id;
      }
    } catch {
      console.warn(`[file-chat] Skipped corrupt JSONL line in project ${projectId}`);
    }
  }

  return maxId + 1;
}

// --- Core functions ---

const CACHE_SIZE = 200;
const MAX_RESUME_SOURCE_RECORDS = 2048;
const MAX_RESUME_SOURCE_BYTES = 128 * 1024 * 1024;

function initProject(projectId) {
  const dir = chatDir(projectId);
  ensureSecureDir(dir);

  acquireWriterLock(projectId);

  const state = getState(projectId);
  state.nextId = recoverNextId(projectId);

  // Populate cache from existing file
  const filePath = chatFile(projectId);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // already warned during recoverNextId
      }
    }
    state.cache = records.slice(-CACHE_SIZE);
  }

  console.log(`[file-chat] Initialized project ${projectId}, next ID: ${state.nextId}, cached: ${state.cache.length} messages`);
}

function shutdownProject(projectId) {
  releaseWriterLock(projectId);
  projectState.delete(projectId);
  const prefix = `${projectId}:`;
  for (const [key, token] of _shimTokens) {
    if (!key.startsWith(prefix)) continue;
    _shimTokens.delete(key);
    _shimPrincipals.delete(token);
  }
}

function appendRecord(projectId, { sender, channel = "general", text, type = "message", attachments } = {}, trustedEvent = null, resumeStructural = null) {
  const state = getState(projectId);
  if (state.nextId === null) {
    throw new Error(`Project ${projectId} not initialized — call initProject first`);
  }

  const id = state.nextId++;
  const seq = id; // seq mirrors id for single-channel
  const record = {
    id,
    seq,
    ts: new Date().toISOString(),
    sender: sender || "system",
    channel,
    type,
    text: text || "",
    mentions: parseMentions(text),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(trustedEvent ? { trusted_event: trustedEvent } : {}),
    // Structural resume tags are an internal, server-authored field.  The
    // public append API deliberately has no parameter for it; closed append
    // seams below reconstruct it from their own typed event contracts.
    ...(resumeStructural ? { resume_structural: resumeStructural } : {}),
  };

  const dir = chatDir(projectId);
  ensureSecureDir(dir);
  const filePath = chatFile(projectId);

  const line = JSON.stringify(record) + "\n";

  let retries = 3;
  while (retries > 0) {
    try {
      fs.appendFileSync(filePath, line, { mode: 0o600 });
      try { fs.chmodSync(filePath, 0o600); } catch {}
      break;
    } catch (err) {
      retries--;
      if (retries === 0) {
        console.error(`[file-chat] Append failure for project ${projectId}: ${err.message}`);
        throw err;
      }
      // #975: retry immediately — no sleep. The previous
      // Atomics.wait(...,100) was a SYNCHRONOUS 100ms block on the main
      // thread (up to 300ms per append) on every chat + system message; in
      // this single-process server that froze every agent's WS/HTTP/timers.
      // appendFileSync transient failures are rare and not time-dependent, so
      // the busy-wait bought nothing. Attempt count is unchanged.
    }
  }

  state.cache.push(record);
  if (state.cache.length > CACHE_SIZE) {
    state.cache = state.cache.slice(-CACHE_SIZE);
  }

  return record;
}

function appendMessage(projectId, { sender, channel = "general", text, type = "message", attachments } = {}, _skipLoopGuard = false) {
  void _skipLoopGuard;
  return appendRecord(projectId, { sender, channel, text, type, attachments });
}

function sameTrustedEvent(projectId, record, envelope) {
  const event = record?.trusted_event;
  if (!event || typeof event !== "object" || event.correlation_id !== envelope.correlation_id) return null;
  let persisted;
  try { persisted = envelopeFor(projectId, event.kind, event.anchors); }
  catch { throw new Error("trusted monitor correlation collision"); }
  const matches = event.version === envelope.version && persisted.correlation_id === envelope.correlation_id
    && record.sender === "system" && record.type === "system" && record.text === envelope.text;
  if (!matches) throw new Error("trusted monitor correlation collision");
  return record;
}

function findTrustedMonitorEvent(projectId, state, envelope) {
  for (const record of state.cache) {
    const match = sameTrustedEvent(projectId, record, envelope);
    if (match) return match;
  }
  const filePath = chatFile(projectId);
  if (!fs.existsSync(filePath)) return null;
  let content;
  try { content = fs.readFileSync(filePath, "utf8"); }
  catch (error) { throw new Error(`trusted monitor event read failed: ${error.message}`); }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const match = sameTrustedEvent(projectId, record, envelope);
      if (match) return match;
    } catch (error) {
      if (error?.message === "trusted monitor correlation collision") throw error;
      // Existing file-chat recovery already treats a corrupt historical JSONL
      // line as non-authoritative. It cannot become a new trusted receipt.
    }
  }
  return null;
}

function sameTrustedReviewCycleEvent(record, envelope, resumeStructural) {
  const event = record?.trusted_event;
  if (!event || typeof event !== "object" || event.scope !== "review_cycle" || event.correlation_id !== envelope.correlation_id) return null;
  const matches = event.version === envelope.version && event.kind === envelope.kind &&
    JSON.stringify(event.anchors) === JSON.stringify(envelope.anchors) &&
    record.sender === "system" && record.type === "system" && record.text === envelope.text &&
    JSON.stringify(record.resume_structural) === JSON.stringify(resumeStructural);
  if (!matches) throw new Error("trusted review-cycle correlation collision");
  return record;
}

function findTrustedReviewCycleEvent(projectId, state, envelope, resumeStructural) {
  for (const record of state.cache) {
    const match = sameTrustedReviewCycleEvent(record, envelope, resumeStructural);
    if (match) return match;
  }
  const filePath = chatFile(projectId);
  if (!fs.existsSync(filePath)) return null;
  let content;
  try { content = fs.readFileSync(filePath, "utf8"); }
  catch (error) { throw new Error(`trusted review-cycle event read failed: ${error.message}`); }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const match = sameTrustedReviewCycleEvent(record, envelope, resumeStructural);
      if (match) return match;
    } catch (error) {
      if (error?.message === "trusted review-cycle correlation collision") throw error;
    }
  }
  return null;
}

function sameTrustedBatchRequest(record, notice) {
  const event = record?.trusted_event;
  if (!event || typeof event !== "object" || event.scope !== "batch_request" || event.correlation_key !== notice.correlation_key) return null;
  const matches = event.version === notice.trusted_event.version && JSON.stringify(event.anchors) === JSON.stringify(notice.trusted_event.anchors) &&
    record.sender === notice.sender && record.channel === notice.channel && record.type === notice.type && record.text === notice.text &&
    JSON.stringify(record.resume_structural) === JSON.stringify(notice.resume_structural);
  if (!matches) throw new Error("trusted batch-request correlation collision");
  return record;
}

function findTrustedBatchRequest(projectId, state, notice) {
  for (const record of state.cache) {
    const match = sameTrustedBatchRequest(record, notice);
    if (match) return match;
  }
  const filePath = chatFile(projectId);
  if (!fs.existsSync(filePath)) return null;
  let content;
  try { content = fs.readFileSync(filePath, "utf8"); }
  catch (error) { throw new Error(`trusted batch-request event read failed: ${error.message}`); }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const match = sameTrustedBatchRequest(record, notice);
      if (match) return match;
    } catch (error) {
      if (error?.message === "trusted batch-request correlation collision") throw error;
    }
  }
  return null;
}

function sameTrustedHeadLifecycle(record, notice) {
  const event = record?.trusted_event;
  if (!event || typeof event !== "object" || event.scope !== "head_lifecycle" || event.correlation_key !== notice.correlation_key) return null;
  const matches = event.version === notice.trusted_event.version && JSON.stringify(event.anchors) === JSON.stringify(notice.trusted_event.anchors) &&
    record.sender === notice.sender && record.channel === notice.channel && record.type === notice.type && record.text === notice.text &&
    JSON.stringify(record.resume_structural) === JSON.stringify(notice.resume_structural);
  if (!matches) throw new Error("trusted Head lifecycle correlation collision");
  return record;
}

function findTrustedHeadLifecycle(projectId, state, notice) {
  for (const record of state.cache) {
    const match = sameTrustedHeadLifecycle(record, notice);
    if (match) return match;
  }
  const filePath = chatFile(projectId);
  if (!fs.existsSync(filePath)) return null;
  let content;
  try { content = fs.readFileSync(filePath, "utf8"); }
  catch (error) { throw new Error(`trusted Head lifecycle event read failed: ${error.message}`); }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const match = sameTrustedHeadLifecycle(record, notice);
      if (match) return match;
    } catch (error) {
      if (error?.message === "trusted Head lifecycle correlation collision") throw error;
    }
  }
  return null;
}

// Server-only closed append seam for the Monitor transport. It deliberately
// reconstructs the canonical envelope rather than accepting caller prose,
// recipient lists, or arbitrary JSONL metadata. Ordinary system messages keep
// using appendMessage and are never eligible for the trusted PTY path.
function appendTrustedMonitorEventOnce(projectId, candidate) {
  if (!candidate || typeof candidate !== "object") throw new Error("trusted monitor envelope required");
  const envelope = envelopeFor(projectId, candidate.kind, candidate.anchors);
  if (candidate.project_id !== envelope.project_id || candidate.correlation_id !== envelope.correlation_id
    || candidate.version !== envelope.version || candidate.sender !== envelope.sender
    || candidate.type !== envelope.type || candidate.text !== envelope.text
    || !Array.isArray(candidate.recipients) || candidate.recipients.length !== 1 || candidate.recipients[0] !== "head") {
    throw new Error("trusted monitor envelope invalid");
  }
  const state = getState(projectId);
  if (state.nextId === null) throw new Error(`Project ${projectId} not initialized — call initProject first`);
  const existing = findTrustedMonitorEvent(projectId, state, envelope);
  if (existing) return { ok: true, id: existing.id, duplicate: true };
  const metadata = Object.freeze({
    version: envelope.version,
    correlation_id: envelope.correlation_id,
    kind: envelope.kind,
    anchors: envelope.anchors,
  });
  const record = appendRecord(projectId, {
    sender: "system",
    channel: "general",
    type: "system",
    text: envelope.text,
  }, metadata);
  return { ok: true, id: record.id, duplicate: false };
}

// #1048's private #1036 append seam.  The dispatcher supplies only a durable
// cycle snapshot, M1 event plan, and the server's current project-generation
// context; this function reconstructs the fixed text, recipients, anchors and
// recovery tag. Public chat routes never expose either argument shape, so
// prose/pulses cannot mint a cycle delivery.
function appendTrustedReviewCycleEventOnce(projectId, candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "cycle,plan,project_id,resume") {
    throw new Error("trusted review-cycle envelope required");
  }
  const envelope = reviewCycleEnvelopeFor(projectId, candidate.cycle, candidate.plan);
  if (candidate.project_id !== envelope.project_id) throw new Error("trusted review-cycle envelope invalid");
  const resume = candidate.resume;
  if (!resume || typeof resume !== "object" || Array.isArray(resume) ||
      Object.keys(resume).sort().join(",") !== "batch_id,head_generation" ||
      !Number.isSafeInteger(resume.head_generation) || resume.head_generation < 0 ||
      (resume.batch_id !== null && (typeof resume.batch_id !== "string" || !/^[a-z][a-z0-9_-]{2,95}$/.test(resume.batch_id)))) {
    throw new Error("trusted review-cycle resume context invalid");
  }
  const resumeStructural = Object.freeze({
    version: 1,
    project_id: projectId,
    trusted: true,
    tag: "review_cycle",
    batch_id: resume.batch_id,
    head_generation: resume.head_generation,
    target: "head",
    server_authored: true,
  });
  const state = getState(projectId);
  if (state.nextId === null) throw new Error(`Project ${projectId} not initialized — call initProject first`);
  const existing = findTrustedReviewCycleEvent(projectId, state, envelope, resumeStructural);
  if (existing) return { ok: true, id: existing.id, duplicate: true };
  const metadata = Object.freeze({
    scope: "review_cycle",
    version: envelope.version,
    correlation_id: envelope.correlation_id,
    kind: envelope.kind,
    anchors: envelope.anchors,
  });
  const record = appendRecord(projectId, {
    sender: "system",
    channel: "general",
    type: "system",
    text: envelope.text,
  }, metadata, resumeStructural);
  return { ok: true, id: record.id, duplicate: false };
}

// #1046's closed Batch Request delivery seam. The reconciliation runtime has
// already durably admitted exactly one Head plan before it reaches here; this
// function does not accept title/body prose, a recipient list, or a generic
// chat payload. It records the fixed notice exactly once and carries the
// matching structural tag needed by #1047's resume source.
function appendTrustedBatchRequestOnce(projectId, candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("trusted batch-request envelope required");
  }
  const notice = batchRequestNotice(candidate);
  if (notice.project_id !== projectId) throw new Error("trusted batch-request project mismatch");
  const state = getState(projectId);
  if (state.nextId === null) throw new Error(`Project ${projectId} not initialized — call initProject first`);
  const existing = findTrustedBatchRequest(projectId, state, notice);
  if (existing) return { ok: true, id: existing.id, duplicate: true };
  const record = appendRecord(projectId, {
    sender: notice.sender,
    channel: notice.channel,
    type: notice.type,
    text: notice.text,
  }, notice.trusted_event, notice.resume_structural);
  return { ok: true, id: record.id, duplicate: false };
}

// #1047's only server-owned recovery write.  A lifecycle operation has already
// produced the opaque operation/session generation before this seam runs.  It
// cannot append an arbitrary system message or tag another agent's session.
function appendTrustedHeadLifecycleOnce(projectId, candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("trusted Head lifecycle receipt required");
  }
  const notice = headLifecycleNotice(candidate);
  if (notice.project_id !== projectId) throw new Error("trusted Head lifecycle project mismatch");
  const state = getState(projectId);
  if (state.nextId === null) throw new Error(`Project ${projectId} not initialized — call initProject first`);
  const existing = findTrustedHeadLifecycle(projectId, state, notice);
  if (existing) return { ok: true, id: existing.id, duplicate: true };
  const record = appendRecord(projectId, {
    sender: notice.sender,
    channel: notice.channel,
    type: notice.type,
    text: notice.text,
  }, notice.trusted_event, notice.resume_structural);
  return { ok: true, id: record.id, duplicate: false };
}

// #1047's one ordinary-message recovery tag. The HTTP chat route has already
// authenticated this as an operator/user message; this narrow seam cannot tag
// an agent, choose a different tag, or mint an executable instruction from
// unmentioned prose. User text remains opaque evidence in the raw record.
function appendTrustedOperatorHeadMention(projectId, candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "attachments,batch_id,head_generation,text") {
    throw new Error("trusted operator Head mention required");
  }
  if (typeof candidate.text !== "string" || Buffer.byteLength(candidate.text, "utf8") > 64 * 1024 ||
      !parseMentions(candidate.text).includes("head") || !Number.isSafeInteger(candidate.head_generation) || candidate.head_generation < 0 ||
      (candidate.batch_id !== null && (typeof candidate.batch_id !== "string" || !/^[a-z][a-z0-9_-]{2,95}$/.test(candidate.batch_id))) ||
      (candidate.attachments !== null && (!Array.isArray(candidate.attachments) || candidate.attachments.some((item) =>
        !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "name" ||
        typeof item.name !== "string" || !item.name || /[/\\]/.test(item.name))))) {
    throw new Error("trusted operator Head mention invalid");
  }
  const state = getState(projectId);
  if (state.nextId === null) throw new Error(`Project ${projectId} not initialized — call initProject first`);
  return appendRecord(projectId, {
    sender: "user",
    channel: "general",
    type: "message",
    text: candidate.text,
    ...(candidate.attachments && candidate.attachments.length ? { attachments: candidate.attachments } : {}),
  }, null, Object.freeze({
    version: 1,
    project_id: projectId,
    trusted: true,
    tag: "operator_head_mention",
    batch_id: candidate.batch_id,
    head_generation: candidate.head_generation,
    target: "head",
    server_authored: false,
  }));
}

// A resume source is deliberately not `readMessages()`: that public helper
// tail-slices and skips malformed historical JSONL for panel availability.
// Recovery requires a stable, complete bounded suffix.  A malformed line or a
// file too large to inspect fails closed instead of silently dropping history.
function readPrimaryChatResumeRecords(projectId) {
  const filePath = chatFile(projectId);
  if (!fs.existsSync(filePath)) return { freshness: "live", records: [] };
  let stats;
  try { stats = fs.statSync(filePath); }
  catch (error) { throw new Error(`Primary Chat source stat failed: ${error.message}`); }
  if (!stats.isFile() || stats.size > MAX_RESUME_SOURCE_BYTES) {
    throw new Error("Primary Chat source is unavailable");
  }
  let content;
  try { content = fs.readFileSync(filePath, "utf8"); }
  catch (error) { throw new Error(`Primary Chat source read failed: ${error.message}`); }
  const records = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { throw new Error("Primary Chat source has a malformed record"); }
  }
  return { freshness: "live", records: records.slice(-MAX_RESUME_SOURCE_RECORDS) };
}

// A current V2 batch needs a server-issued qualified Head assignment before a
// resume feed can claim an active-batch start boundary.  Missing or historical
// records are intentionally represented by null; the runtime then withholds
// the feed rather than manufacturing a boundary from queue prose or wall time.
function findPrimaryChatResumeBatchStart(projectId, batchId, headGeneration) {
  if (typeof batchId !== "string" || !Number.isSafeInteger(headGeneration) || headGeneration < 0) return null;
  const source = readPrimaryChatResumeRecords(projectId);
  for (const record of source.records) {
    const structural = record?.resume_structural;
    if (structural?.version === 1 && structural.project_id === projectId && structural.trusted === true &&
        structural.tag === "head_assignment" && structural.batch_id === batchId &&
        structural.head_generation === headGeneration && structural.target === "head" &&
        structural.server_authored === false && Number.isSafeInteger(record?.id) && record.id > 0) {
      return record.id - 1;
    }
  }
  return null;
}

function readMessages(projectId, { since_id = 0, limit = 50 } = {}) {
  const state = getState(projectId);

  // Try cache first
  if (state.cache.length > 0) {
    const cacheMinId = state.cache[0].id;
    if (since_id >= cacheMinId || since_id === 0) {
      let results = since_id > 0
        ? state.cache.filter((m) => m.id > since_id)
        : state.cache;
      return results.slice(-limit);
    }
  }

  // Fall back to disk
  const filePath = chatFile(projectId);
  if (!fs.existsSync(filePath)) {
    console.warn(`[file-chat] Missing chat file for project ${projectId}, creating empty`);
    const dir = chatDir(projectId);
    ensureSecureDir(dir);
    writeSecureFile(filePath, "");
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const results = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (since_id > 0 && record.id <= since_id) continue;
      results.push(record);
    } catch {
      console.warn(`[file-chat] Skipped corrupt JSONL line in project ${projectId}`);
    }
  }

  return results.slice(-limit);
}

function getNextId(projectId) {
  const state = getState(projectId);
  if (state.nextId === null) {
    state.nextId = recoverNextId(projectId);
  }
  return state.nextId;
}

// #717: per-project loop guard state
const _loopGuardState = new Map();

function checkLoopGuard(projectId, msg, maxHops = 30) {
  let state = _loopGuardState.get(projectId) || { hops: 0, paused: false };

  if (msg.sender === "user") {
    const isResume = typeof msg.text === "string" && msg.text.trim() === "/continue";
    state.hops = 0;
    state.paused = false;
    _loopGuardState.set(projectId, state);
    if (isResume) {
      appendMessageInternal(projectId, {
        sender: "system",
        type: "system",
        text: "Loop guard resumed.",
        channel: msg.channel || "general",
      });
    }
    return;
  }

  if (msg.type === "system") return;
  if (state.paused) return;

  state.hops++;
  if (state.hops >= maxHops) {
    state.paused = true;
    appendMessageInternal(projectId, {
      sender: "system",
      type: "system",
      text: `Loop guard: paused after ${maxHops} agent-to-agent messages with no human reply. Type /continue to resume.`,
      channel: msg.channel || "general",
    });
  }
  _loopGuardState.set(projectId, state);
}

function isLoopGuardPaused(projectId) {
  const state = _loopGuardState.get(projectId);
  return state ? state.paused : false;
}

function resetLoopGuard(projectId) {
  _loopGuardState.delete(projectId);
}

function appendMessageInternal(projectId, opts) {
  return appendMessage(projectId, opts, true);
}

// #715: per-agent shim tokens for authenticated sends.
// Map<"projectId:agentId", token> plus the inverse principal lookup used by
// read-only role tools. The inverse is load-bearing: those endpoints derive
// project/actor from the secret itself and never trust caller identity fields.
const _shimTokens = new Map();
const _shimPrincipals = new Map();

function registerShimToken(projectId, agentId, token) {
  const key = `${projectId}:${agentId}`;
  const previous = _shimTokens.get(key);
  if (previous) _shimPrincipals.delete(previous);
  const collision = _shimPrincipals.get(token);
  if (collision) _shimTokens.delete(`${collision.projectId}:${collision.agentId}`);
  _shimTokens.set(key, token);
  _shimPrincipals.set(token, Object.freeze({ projectId, agentId }));
}

function validateShimToken(projectId, agentId, token) {
  return _shimTokens.get(`${projectId}:${agentId}`) === token;
}

function resolveShimPrincipal(token) {
  if (typeof token !== "string" || !token) return null;
  const principal = _shimPrincipals.get(token);
  if (!principal || !validateShimToken(principal.projectId, principal.agentId, token)) return null;
  return principal;
}

module.exports = {
  initProject,
  shutdownProject,
  appendMessage,
  // Private server composition seam. No route/MCP surface exposes it.
  appendTrustedMonitorEventOnce,
  appendTrustedReviewCycleEventOnce,
  appendTrustedBatchRequestOnce,
  appendTrustedHeadLifecycleOnce,
  appendTrustedOperatorHeadMention,
  // Private recovery-source seams. They are not mounted as general history
  // APIs and retain the source's strict corruption semantics.
  readPrimaryChatResumeRecords,
  findPrimaryChatResumeBatchStart,
  readMessages,
  getNextId,
  parseMentions,
  MENTION_RE,
  checkLoopGuard,
  isLoopGuardPaused,
  resetLoopGuard,
  registerShimToken,
  validateShimToken,
  resolveShimPrincipal,
  // exposed for testing
  _getState: getState,
  _chatDir: chatDir,
  _chatFile: chatFile,
};

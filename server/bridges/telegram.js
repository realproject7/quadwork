const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");

const instances = new Map();
const startOperations = new Map();
const stopRequests = new Map();
const MANUAL_AUTHORITY_FINGERPRINT = "manual";

function normalizeAuthorityKey(authorityKey) {
  const admissionGeneration = authorityKey?.admission_generation;
  const assignmentFingerprint = authorityKey?.assignment_fingerprint;
  return Object.freeze({
    admission_generation: Number.isSafeInteger(admissionGeneration) && admissionGeneration >= 0
      ? admissionGeneration
      : null,
    assignment_fingerprint: typeof assignmentFingerprint === "string" && assignmentFingerprint
      ? assignmentFingerprint
      : MANUAL_AUTHORITY_FINGERPRINT,
  });
}

function sameAuthority(left, right) {
  return !!left && !!right &&
    left.admission_generation === right.admission_generation &&
    left.assignment_fingerprint === right.assignment_fingerprint;
}

function registerStopRequest(projectId, authorityKey) {
  const request = { authorityKey };
  const requests = stopRequests.get(projectId) || new Set();
  requests.add(request);
  stopRequests.set(projectId, requests);
  return request;
}

function unregisterStopRequest(projectId, request) {
  const requests = stopRequests.get(projectId);
  if (!requests) return;
  requests.delete(request);
  if (requests.size === 0) stopRequests.delete(projectId);
}

function startCancelled(projectId, authorityKey) {
  const requests = stopRequests.get(projectId);
  if (!requests) return false;
  return [...requests].some((request) =>
    request.authorityKey === null || sameAuthority(request.authorityKey, authorityKey));
}

function isCurrent(projectId, inst) {
  return !inst.stopping && instances.get(projectId) === inst;
}

function retirementFailure(result) {
  const error = new Error("Telegram bridge cleanup is incomplete; retry the operation");
  error.code = "bridge_cleanup_incomplete";
  error.retryable = true;
  error.cleanupResult = result;
  return error;
}

async function performRetirement(projectId, inst) {
  inst.stopping = true;
  if (typeof inst.cancelRetirement === "function") {
    inst.cancelRetirement();
    inst.cancelRetirement = null;
  }
  let timers = 0;
  const cleanupErrors = [];
  for (const controller of inst.controllers || []) {
    try {
      controller.abort();
      inst.controllers.delete(controller);
    }
    catch (err) {
      cleanupErrors.push({
        resource: "telegram_bridge",
        code: "fetch_abort_failed",
        message: err?.message || "Telegram bridge fetch abort failed",
        retryable: true,
      });
    }
  }
  for (const field of ["timer", "updateTimer"]) {
    if (!inst[field]) continue;
    try {
      clearTimeout(inst[field]);
      inst[field] = null;
      timers += 1;
    } catch (err) {
      cleanupErrors.push({
        resource: "telegram_bridge",
        code: "timer_stop_failed",
        message: err?.message || "Telegram bridge timer stop failed",
        retryable: true,
      });
    }
  }
  if (!(await settleInFlight(inst, inst.stopTimeoutMs || 5000))) {
    cleanupErrors.push({
      resource: "telegram_bridge",
      code: "inflight_stop_timeout",
      message: "Telegram bridge in-flight work did not settle",
      retryable: true,
    });
  }
  const ok = cleanupErrors.length === 0;
  if (ok && instances.get(projectId) === inst) {
    instances.delete(projectId);
    console.log(`[bridge] telegram ${projectId}: stopped`);
  }
  return {
    ok,
    resources: {
      telegram_bridges: ok ? 1 : 0,
      bridge_timers: timers,
    },
    cleanup_errors: cleanupErrors,
  };
}

function retireInstance(projectId, inst) {
  if (!inst) return Promise.resolve({
    ok: true,
    resources: { telegram_bridges: 0, bridge_timers: 0 },
    cleanup_errors: [],
  });
  if (inst.retirement) return inst.retirement;
  const retirement = performRetirement(projectId, inst).catch((err) => ({
    ok: false,
    resources: { telegram_bridges: 0, bridge_timers: 0 },
    cleanup_errors: [{
      resource: "telegram_bridge",
      code: "retirement_failed",
      message: err?.message || "Telegram bridge retirement failed",
      retryable: true,
    }],
  }));
  inst.retirement = retirement;
  retirement.then(() => {
    if (inst.retirement === retirement) inst.retirement = null;
  });
  return retirement;
}

function retireStaleInstance(projectId, inst) {
  if (!inst || inst.retirement) return;
  void retireInstance(projectId, inst);
}

function isAuthorizedCurrent(projectId, inst) {
  if (!isCurrent(projectId, inst)) return false;
  if (typeof inst.isAuthorityCurrent !== "function") return true;
  let authorized = false;
  try { authorized = inst.isAuthorityCurrent() === true; } catch {}
  if (!authorized) retireStaleInstance(projectId, inst);
  return authorized;
}

function staleAuthorityError() {
  const error = new Error("bridge assignment or admission changed");
  error.code = "bridge_authority_changed";
  return error;
}

async function track(inst, promise) {
  if (!inst.inFlight) inst.inFlight = new Set();
  const owned = Promise.resolve(promise);
  inst.inFlight.add(owned);
  owned.then(
    () => inst.inFlight.delete(owned),
    () => inst.inFlight.delete(owned),
  );
  if (!inst.retirementSignal) return owned;
  return Promise.race([
    owned,
    inst.retirementSignal.then(() => { throw staleAuthorityError(); }),
  ]);
}

async function bridgeFetch(inst, url, options = {}, timeoutMs = 5000) {
  if (!isAuthorizedCurrent(inst.projectId, inst)) throw staleAuthorityError();
  if (!inst.controllers) inst.controllers = new Set();
  const controller = new AbortController();
  inst.controllers.add(controller);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    return await track(inst, fetch(url, { ...options, signal }));
  } finally {
    inst.controllers.delete(controller);
  }
}

async function settleInFlight(inst, timeoutMs = 5000) {
  const pending = [...(inst.inFlight || [])];
  if (pending.length === 0) return true;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = Promise.allSettled(pending).then(() => true);
  const completed = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return completed;
}

// #782: cursor-lag threshold beyond which a valid cursor is treated as
// stale (bridge stopped mid-backlog) and reseeded to latest on start.
// Small lags within this window keep continuity for graceful restarts.
//
// #786: intentional trade-off — if the bridge was down while 11+ messages
// arrived, those messages are skipped (not replayed to Telegram). This
// prevents the "old message flood" bug. If continuity is needed for long
// downtimes, increase this threshold or remove the stale-cursor check.
const STALE_CURSOR_THRESHOLD = 10;

function cursorPath(projectId) {
  return path.join(CONFIG_DIR, `tg-bridge-cursor-${projectId}.json`);
}

function offsetPath(projectId) {
  return path.join(CONFIG_DIR, `tg-bridge-offset-${projectId}.json`);
}

function readCursor(projectId) {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath(projectId), "utf-8"));
    return data.last_seen_id || 0;
  } catch {
    return 0;
  }
}

function writeCursor(projectId, sinceId) {
  try {
    fs.writeFileSync(cursorPath(projectId), JSON.stringify({ last_seen_id: sinceId }), { mode: 0o600 });
  } catch {}
}

function readOffset(projectId) {
  try {
    const data = JSON.parse(fs.readFileSync(offsetPath(projectId), "utf-8"));
    return data.offset || 0;
  } catch {
    return 0;
  }
}

function writeOffset(projectId, offset) {
  try {
    fs.writeFileSync(offsetPath(projectId), JSON.stringify({ offset }), { mode: 0o600 });
  } catch {}
}

async function sendTelegram(inst, botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await bridgeFetch(inst, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }, 10000);
  if (!res.ok) throw new Error(`Telegram sendMessage ${res.status}`);
}

async function pollLoop(projectId, botToken, chatId, qwPort) {
  const inst = instances.get(projectId);
  if (!inst) return;
  if (!inst.projectId) inst.projectId = projectId;
  if (!isAuthorizedCurrent(projectId, inst)) return;

  try {
    let sinceId = inst.cursor;
    const r = await bridgeFetch(inst,
      `http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}&since_id=${sinceId}&limit=50`,
      {}, 5000,
    );
    if (!isAuthorizedCurrent(projectId, inst)) return;
    if (!r.ok) throw new Error(`Chat API ${r.status}`);
    const messages = await track(inst, r.json());
    if (!isAuthorizedCurrent(projectId, inst)) return;

    for (const msg of messages) {
      if (!isAuthorizedCurrent(projectId, inst)) return;
      if (msg.sender === "tg" || msg.sender === "telegram-bridge" || (msg.sender && msg.sender.startsWith("tg:"))) continue;
      if (inst.forwardedIds.has(msg.id)) continue;

      const text = `**${msg.sender}**: ${msg.text}`;
      const truncated = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
      if (!isAuthorizedCurrent(projectId, inst)) return;
      await sendTelegram(inst, botToken, chatId, truncated);
      if (!isAuthorizedCurrent(projectId, inst)) return;

      inst.forwardedIds.add(msg.id);
      if (inst.forwardedIds.size > 2000) {
        const arr = [...inst.forwardedIds];
        inst.forwardedIds = new Set(arr.slice(-1000));
      }

      if (msg.id > inst.cursor) {
        if (!isAuthorizedCurrent(projectId, inst)) return;
        inst.cursor = msg.id;
        writeCursor(projectId, inst.cursor);
      }
    }
  } catch (err) {
    if (isAuthorizedCurrent(projectId, inst)) inst.lastError = err.message;
  }

  if (isAuthorizedCurrent(projectId, inst)) {
    inst.timer = setTimeout(() => pollLoop(projectId, botToken, chatId, qwPort), 2000);
  }
}

async function startTelegramUpdates(projectId, botToken, chatId, qwPort) {
  const inst = instances.get(projectId);
  if (!inst) return;
  if (!inst.projectId) inst.projectId = projectId;
  if (!isAuthorizedCurrent(projectId, inst)) return;

  let offset = readOffset(projectId);
  let retryDelay = 500;

  async function tick() {
    if (!isAuthorizedCurrent(projectId, inst)) return;
    try {
      const allowedUpdates = encodeURIComponent(JSON.stringify(["message"]));
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=10&allowed_updates=${allowedUpdates}`;
      const res = await bridgeFetch(inst, url, {}, 30000);
      if (!isAuthorizedCurrent(projectId, inst)) return;
      if (!res.ok) throw new Error(`Telegram getUpdates ${res.status}`);
      const data = await track(inst, res.json());
      if (!isAuthorizedCurrent(projectId, inst)) return;
      retryDelay = 500;
      if (data.ok && data.result) {
        for (const update of data.result) {
          if (!isAuthorizedCurrent(projectId, inst)) return;
          offset = update.update_id + 1;
          if (!isAuthorizedCurrent(projectId, inst)) return;
          writeOffset(projectId, offset);
          const text = update.message?.text;
          const from = update.message?.from?.username || update.message?.from?.first_name || "unknown";
          const msgChatId = String(update.message?.chat?.id);
          if (!text || msgChatId !== String(chatId)) continue;

          try {
            if (!isAuthorizedCurrent(projectId, inst)) return;
            const r = await bridgeFetch(inst, `http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Bridge-Sender": `tg:${from}`,
              },
              body: JSON.stringify({
                project: projectId,
                text,
                channel: "general",
                ...(inst.automationIdentity || {}),
              }),
            }, 5000);
            if (!isAuthorizedCurrent(projectId, inst)) return;
            if (!r.ok) {
              console.error(`[bridge] telegram ${projectId} inbound POST failed: ${r.status}`);
            }
          } catch (err) {
            console.error(`[bridge] telegram ${projectId} inbound error: ${err.message}`);
          }
        }
      }
    } catch (err) {
      if (isAuthorizedCurrent(projectId, inst)) {
        inst.lastError = err.message;
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
    }

    if (isAuthorizedCurrent(projectId, inst)) {
      inst.updateTimer = setTimeout(tick, retryDelay);
    }
  }

  tick();
}

async function startInstance(projectId, botToken, chatId, qwPort, options, authorityKey) {
  const isAuthorityCurrent = typeof options.isAuthorityCurrent === "function"
    ? options.isAuthorityCurrent
    : null;
  const automationIdentity = options.automationIdentity && typeof options.automationIdentity === "object"
    ? Object.freeze({ ...options.automationIdentity })
    : null;
  if (isAuthorityCurrent) {
    let authorized = false;
    try { authorized = isAuthorityCurrent() === true; } catch {}
    if (!authorized) return;
  }

  const oldCursor = path.join(CONFIG_DIR, `telegram-bridge-cursor-${projectId}.json`);
  const newCursor = cursorPath(projectId);
  if (!fs.existsSync(newCursor) && fs.existsSync(oldCursor)) {
    try { fs.renameSync(oldCursor, newCursor); } catch {}
  }

  let cancelRetirement;
  const retirementSignal = new Promise((resolve) => { cancelRetirement = resolve; });
  const inst = {
    projectId,
    cursor: readCursor(projectId),
    forwardedIds: new Set(),
    timer: null,
    updateTimer: null,
    stopping: false,
    lastError: null,
    startedAt: Date.now(),
    controllers: new Set(),
    inFlight: new Set(),
    isAuthorityCurrent,
    automationIdentity,
    retirement: null,
    retirementSignal,
    cancelRetirement,
    ready: false,
  };
  Object.defineProperty(inst, "authorityKey", { value: authorityKey, enumerable: true });
  instances.set(projectId, inst);

  // #782: seed cursor to latest on first enable (no cursor file, or
  // cursor=0) AND on stale-cursor restarts where the cursor lags the
  // latest chat message by more than STALE_CURSOR_THRESHOLD. The stale
  // case covers bridges stopped mid-backlog so the next start does not
  // replay old conversations to Telegram. Small lags (graceful restart
  // mid-conversation) keep continuity.
  const cursorFileExists = fs.existsSync(cursorPath(projectId));
  try {
    const r = await bridgeFetch(inst,
      `http://127.0.0.1:${qwPort}/api/chat?project=${encodeURIComponent(projectId)}&limit=1`,
      {}, 5000,
    );
    if (!isAuthorizedCurrent(projectId, inst)) return;
    if (r.ok) {
      const msgs = await track(inst, r.json());
      if (!isAuthorizedCurrent(projectId, inst)) return;
      if (msgs.length > 0) {
        const latestId = msgs[msgs.length - 1].id;
        const stale = !cursorFileExists
          || inst.cursor === 0
          || (latestId - inst.cursor) > STALE_CURSOR_THRESHOLD;
        if (stale) {
          if (!isAuthorizedCurrent(projectId, inst)) return;
          inst.cursor = latestId;
          writeCursor(projectId, inst.cursor);
        }
      }
    } else {
      // #786: surface HTTP failures so non-OK responses don't fall
      // through silently (the catch only fires on thrown errors).
      console.warn(`[bridge] telegram ${projectId}: cursor seed fetch returned ${r.status}`);
    }
  } catch (err) {
    if (isAuthorizedCurrent(projectId, inst)) console.warn(`[bridge] telegram ${projectId}: cursor seed failed (${err.message})`);
  }

  // Archive can stop the instance while cursor seeding awaits. A stale start
  // must not recreate polling/update owners after cleanup has completed.
  if (!isAuthorizedCurrent(projectId, inst)) return;

  if (!isAuthorizedCurrent(projectId, inst)) return;
  pollLoop(projectId, botToken, chatId, qwPort).catch((err) => {
    console.error(`[bridge] telegram ${projectId} poll crashed: ${err.message}`);
    inst.lastError = err.message;
    void stop(projectId).catch((stopErr) => {
      console.error(`[bridge] telegram ${projectId} stop failed: ${stopErr.message}`);
    });
  });

  if (!isAuthorizedCurrent(projectId, inst)) return;
  startTelegramUpdates(projectId, botToken, chatId, qwPort).catch((err) => {
    console.error(`[bridge] telegram ${projectId} updates crashed: ${err.message}`);
    inst.lastError = err.message;
  });

  inst.ready = true;
  console.log(`[bridge] telegram ${projectId}: started`);
  return { ok: true, running: true, already_running: false };
}

async function start(projectId, botToken, chatId, qwPort, options = {}) {
  const authorityKey = normalizeAuthorityKey(options.authorityKey);
  const live = instances.get(projectId);
  if (live) {
    const exactCurrent = !live.stopping && sameAuthority(live.authorityKey, authorityKey) &&
      isAuthorizedCurrent(projectId, live);
    if (!exactCurrent) void retireInstance(projectId, live);
  }
  const previous = startOperations.get(projectId) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    if (startCancelled(projectId, authorityKey)) return undefined;
    const existing = instances.get(projectId);
    if (existing) {
      if (existing.ready !== false && !existing.stopping && sameAuthority(existing.authorityKey, authorityKey) &&
          isAuthorizedCurrent(projectId, existing)) {
        return { ok: true, running: true, already_running: true };
      }
      const retired = await retireInstance(projectId, existing);
      if (startCancelled(projectId, authorityKey)) return undefined;
      if (!retired.ok) throw retirementFailure(retired);
    }
    if (startCancelled(projectId, authorityKey)) return undefined;
    return startInstance(projectId, botToken, chatId, qwPort, options, authorityKey);
  });
  startOperations.set(projectId, operation);
  try {
    return await operation;
  } finally {
    if (startOperations.get(projectId) === operation) startOperations.delete(projectId);
  }
}

async function stop(projectId, authorityKey = undefined) {
  const requestedAuthority = authorityKey === undefined ? null : normalizeAuthorityKey(authorityKey);
  const stopRequest = registerStopRequest(projectId, requestedAuthority);
  async function retireCurrent() {
    const inst = instances.get(projectId);
    if (!inst) {
      return {
        ok: true,
        resources: { telegram_bridges: 0, bridge_timers: 0 },
        cleanup_errors: [],
      };
    }
    if (requestedAuthority !== null && !sameAuthority(inst.authorityKey, requestedAuthority)) {
      return {
        ok: true,
        resources: { telegram_bridges: 0, bridge_timers: 0 },
        cleanup_errors: [],
      };
    }
    return retireInstance(projectId, inst);
  }
  try {
    const live = instances.get(projectId);
    if (live && (requestedAuthority === null || sameAuthority(live.authorityKey, requestedAuthority))) {
      void retireInstance(projectId, live);
    }
    const previous = startOperations.get(projectId);
    if (!previous) return await retireCurrent();
    const operation = previous.catch(() => {}).then(retireCurrent);
    startOperations.set(projectId, operation);
    try {
      return await operation;
    } finally {
      if (startOperations.get(projectId) === operation) startOperations.delete(projectId);
    }
  } finally {
    unregisterStopRequest(projectId, stopRequest);
  }
}

function isRunning(projectId, authorityKey = undefined) {
  const inst = instances.get(projectId);
  if (!inst) return false;
  // Calls without a key are ownership/status probes. Preserve the retained
  // tombstone signal after a failed teardown, while a live stale owner is
  // retired and no longer reported as running.
  if (authorityKey === undefined) {
    if (inst.stopping) return !inst.retirement;
    return inst.ready !== false && isAuthorizedCurrent(projectId, inst);
  }
  return inst.ready !== false && !inst.stopping &&
    sameAuthority(inst.authorityKey, normalizeAuthorityKey(authorityKey)) &&
    isAuthorizedCurrent(projectId, inst);
}

// #972: stop every running instance (used on server shutdown).
async function stopAll() {
  return Promise.all([...instances.keys()].map((projectId) => stop(projectId)));
}

function getLastError(projectId) {
  const inst = instances.get(projectId);
  return inst?.lastError || null;
}

module.exports = { start, stop, stopAll, isRunning, getLastError, readCursor, _instances: instances, _pollLoop: pollLoop };

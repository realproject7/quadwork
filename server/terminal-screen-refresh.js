const REFRESH_SETTLE_MS = 150;
const MIN_REFRESH_INTERVAL_MS = 1000;
const pendingBySession = new WeakMap();
const lastRefreshBySession = new WeakMap();

function validDimensions(value) {
  return value && Number.isInteger(value.cols) && Number.isInteger(value.rows) &&
    value.cols >= 1 && value.cols <= 500 && value.rows >= 1 && value.rows <= 500;
}

function adjacentDimensions({ cols, rows }) {
  if (cols > 1) return { cols: cols - 1, rows };
  if (rows > 1) return { cols, rows: rows - 1 };
  return null;
}

// Resize notifications can be coalesced by the OS if both transitions happen
// in one event-loop turn. Keep the temporary size for a short interval so the
// child can observe and handle it before restoring the current viewer size.
// Requests from other viewers share a pending repaint, or queue one paced
// repaint after it; a single connection is separately limited by its gate.
function requestTerminalScreenRefresh(session) {
  if (!session || !session.term || session._stopping || session.state !== "running" || !validDimensions(session.lastDims)) return false;
  if (pendingBySession.has(session)) return true;

  const state = { term: session.term, phase: "scheduled", timer: null };
  pendingBySession.set(session, state);
  const sinceLast = Date.now() - (lastRefreshBySession.get(session) || 0);
  const delay = Math.max(0, MIN_REFRESH_INTERVAL_MS - sinceLast);

  const clear = () => {
    if (state.timer) clearTimeout(state.timer);
    if (pendingBySession.get(session) === state) pendingBySession.delete(session);
    state.timer = null;
  };
  const restore = () => {
    const dims = validDimensions(session.lastDims) ? session.lastDims : state.originalDims;
    if (session.term === state.term && validDimensions(dims)) state.term.resize(dims.cols, dims.rows);
  };
  const finish = () => {
    try {
      if (state.phase === "resizing" && session.term === state.term) {
        try { restore(); } catch {}
      }
    } finally {
      clear();
    }
  };
  const start = () => {
    state.timer = null;
    if (pendingBySession.get(session) !== state || session.term !== state.term || session._stopping || session.state !== "running") {
      clear();
      return;
    }
    const dims = session.lastDims;
    const temporary = adjacentDimensions(dims);
    if (!temporary) { clear(); return; }
    state.originalDims = { cols: dims.cols, rows: dims.rows };
    try {
      state.term.resize(temporary.cols, temporary.rows);
      state.phase = "resizing";
      lastRefreshBySession.set(session, Date.now());
      state.timer = setTimeout(finish, REFRESH_SETTLE_MS);
    } catch {
      try { restore(); } catch {}
      clear();
    }
  };
  state.timer = setTimeout(start, delay);
  return true;
}

function cancelTerminalScreenRefresh(session) {
  const state = session && pendingBySession.get(session);
  if (!state) return false;
  try {
    if (state.phase === "resizing" && session.term === state.term) {
      const dims = validDimensions(session.lastDims) ? session.lastDims : state.originalDims;
      if (validDimensions(dims)) {
        try { state.term.resize(dims.cols, dims.rows); } catch {}
      }
    }
  } finally {
    if (state.timer) clearTimeout(state.timer);
    pendingBySession.delete(session);
  }
  return true;
}

function createTerminalRefreshGate() {
  let replayRequested = false;
  let refreshRequested = false;
  return Object.freeze({
    markReplay() { replayRequested = true; },
    requestRefresh() {
      if (!replayRequested || refreshRequested) return false;
      refreshRequested = true;
      return true;
    },
  });
}

module.exports = { requestTerminalScreenRefresh, cancelTerminalScreenRefresh, createTerminalRefreshGate };

const assert = require("node:assert/strict");
const pty = require("node-pty");
const {
  requestTerminalScreenRefresh,
  cancelTerminalScreenRefresh,
  createTerminalRefreshGate,
} = require("./terminal-screen-refresh");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

async function main() {
  if (process.platform === "win32") {
    console.log("server/terminal-screen-refresh.test.js: skipped child SIGWINCH assertion on Windows");
    return;
  }

  const code = [
    'process.on("SIGWINCH", () => { const size = []; process.stdout._handle.getWindowSize(size); process.stdout.write(`SIZE:${size[0]}x${size[1]}\\n`); });',
    'process.stdin.on("data", () => process.stdout.write("UNEXPECTED_INPUT\\n"));',
    'process.stdout.write("READY\\n");',
    'setInterval(() => {}, 1000);',
  ].join(" ");
  const term = pty.spawn(process.execPath, ["-e", code], {
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    cwd: process.cwd(),
    env: process.env,
  });
  let output = "";
  const observedSizes = [];
  term.onData((chunk) => {
    output += chunk;
    for (const match of chunk.matchAll(/SIZE:(\d+)x(\d+)/g)) observedSizes.push({ cols: Number(match[1]), rows: Number(match[2]), at: Date.now() });
  });
  const session = { term, lastDims: { cols: 80, rows: 24 }, state: "running", _stopping: false };

  try {
    await waitFor(() => output.includes("READY"), "PTY child started");
    const firstViewer = createTerminalRefreshGate();
    assert.equal(firstViewer.requestRefresh(), false, "out-of-order refresh before replay is refused");
    firstViewer.markReplay();
    assert.equal(firstViewer.requestRefresh(), true, "one refresh is admitted after replay");
    assert.equal(firstViewer.requestRefresh(), false, "repeated refresh on one viewer is refused");
    assert.equal(requestTerminalScreenRefresh(session), true);

    const secondViewer = createTerminalRefreshGate();
    secondViewer.markReplay();
    assert.equal(secondViewer.requestRefresh(), true, "a second viewer may join the in-flight repaint");
    assert.equal(requestTerminalScreenRefresh(session), true, "simultaneous viewers share one paced repaint");
    assert.equal(secondViewer.requestRefresh(), false, "a viewer cannot schedule repeated resizes");

    await waitFor(() => observedSizes.length >= 2, "child observes temporary and restored PTY dimensions");
    assert.deepEqual(observedSizes.slice(0, 2).map(({ cols, rows }) => ({ cols, rows })), [
      { cols: 79, rows: 24 },
      { cols: 80, rows: 24 },
    ], "the child handles both distinct resize events with the original size restored");
    assert.doesNotMatch(output, /UNEXPECTED_INPUT/, "screen refresh sends no input to the child");

    const thirdViewer = createTerminalRefreshGate();
    thirdViewer.markReplay();
    assert.equal(thirdViewer.requestRefresh(), true);
    assert.equal(requestTerminalScreenRefresh(session), true, "a later viewer queues a refresh behind the session rate limit");
    await waitFor(() => observedSizes.length >= 4, "queued repaint completes");
    assert.ok(observedSizes[2].at - observedSizes[0].at >= 900, "session refreshes are rate limited to about one per second");

    const cancelViewer = createTerminalRefreshGate();
    cancelViewer.markReplay();
    assert.equal(cancelViewer.requestRefresh(), true);
    requestTerminalScreenRefresh(session);
    await waitFor(() => observedSizes.length >= 5, "cancel fixture enters its temporary size");
    assert.equal(cancelTerminalScreenRefresh(session), true, "session cleanup cancels and restores an in-flight resize");
    await waitFor(() => observedSizes.length >= 6, "cleanup restores the current PTY size");
    assert.deepEqual({ cols: observedSizes[5].cols, rows: observedSizes[5].rows }, { cols: 80, rows: 24 });
    console.log("server/terminal-screen-refresh.test.js: child observed paced resize/redraw, gates, rate limit, and cleanup");
  } finally {
    cancelTerminalScreenRefresh(session);
    try { term.kill(); } catch {}
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

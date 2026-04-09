// #236 / quadwork#236: sendViaWebSocket ack/body/error regression.
// Stands up a minimal fake AgentChattr ws server that mirrors app.py's
// `type:"message"` handler behavior (accept the frame, assign an id +
// timestamp, broadcast `{type:"message", data: msg}` back to the
// sender) and verifies:
//
//   1. Successful send resolves with {ok:true, message:{id,…}} — the
//      echoed broadcast frame, not a fake {ok:true}.
//   2. Attachments survive the round trip.
//   3. History replay on connect does NOT satisfy the ack (the echo
//      must come AFTER the send, not before).
//   4. A premature close without an echo rejects with an error (the
//      old fire-and-forget path silently resolved).
//   5. Close code 4003 rejects with err.code === "EAGENTCHATTR_401"
//      so the /api/chat handler can surface a proper 401.
//
// Run with: node server/routes.chatWsSend.test.js

const assert = require("node:assert/strict");
const http = require("node:http");
const { WebSocketServer } = require("ws");
const { sendViaWebSocket } = require("./routes");

function startFakeAc({ historyBeforeAck = [], rejectWithCode = null, dropBeforeAck = false } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (rejectWithCode === 4003) {
      // Accept the upgrade, then immediately close with 4003 the way
      // AC's /ws handler does on invalid token.
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(4003, "forbidden: invalid session token");
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Simulate history replay on connect — these must NOT satisfy
      // the ack, even if they match (sender,text,channel).
      let historyMaxId = 0;
      for (const msg of historyBeforeAck) {
        ws.send(JSON.stringify({ type: "message", data: msg }));
        if (typeof msg.id === "number" && msg.id > historyMaxId) historyMaxId = msg.id;
      }
      // Mirror AC: emit one `type:"status"` frame after history so the
      // client knows the replay is done. See agentchattr/app.py
      // `broadcast_status()` call in the /ws handler (line ~1082).
      ws.send(JSON.stringify({ type: "status", data: { ready: true } }));
      let nextId = Math.max(9000, historyMaxId + 1);
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== "message") return;
        if (dropBeforeAck) {
          ws.close();
          return;
        }
        // Mirror store.add: assign id + timestamp, rebroadcast.
        const echoed = {
          id: nextId++,
          sender: frame.sender,
          text: frame.text,
          channel: frame.channel || "general",
          attachments: frame.attachments || [],
          reply_to: frame.reply_to ?? null,
          timestamp: Date.now() / 1000,
        };
        ws.send(JSON.stringify({ type: "message", data: echoed }));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

(async () => {
  // 1 + 2) Success path: echo carries server id + attachments preserved.
  {
    const ac = await startFakeAc();
    const result = await sendViaWebSocket(ac.url, "fake-token", {
      text: "hello from test",
      sender: "user",
      channel: "general",
      attachments: [{ url: "/uploads/x.png", name: "x.png" }],
    });
    assert.equal(result.ok, true);
    assert.ok(result.message, "expected echoed message object");
    assert.equal(typeof result.message.id, "number");
    assert.ok(result.message.id >= 9000);
    assert.equal(result.message.text, "hello from test");
    assert.equal(result.message.sender, "user");
    assert.equal(result.message.attachments.length, 1);
    assert.equal(result.message.attachments[0].name, "x.png");
    await ac.close();
  }

  // 3) Stale history replay must NOT satisfy the ack — even when the
  //    history contains a message that is IDENTICAL (sender, text,
  //    channel, reply_to) and has a recent timestamp (e.g. a retry of
  //    the same message sent <1s ago). Prior heuristic matcher was
  //    vulnerable to this; the fix uses the (1) status-frame history
  //    boundary and (2) strictly-greater-id correlation baseline so
  //    the historical echo is definitionally rejected. Reviewer1
  //    flagged this race on PR #382 round 1.
  {
    const stale = {
      id: 42, sender: "user", text: "same words",
      channel: "general", attachments: [], reply_to: null,
      timestamp: Date.now() / 1000, // RIGHT NOW — old heuristic would accept this
    };
    const ac = await startFakeAc({ historyBeforeAck: [stale] });
    const result = await sendViaWebSocket(ac.url, "fake-token", {
      text: "same words",
      sender: "user",
      channel: "general",
      attachments: [],
    });
    assert.ok(result.message.id > 42, `expected live echo id > 42, got ${result.message.id}`);
    await ac.close();
  }

  // 4) Premature close without ack rejects.
  {
    const ac = await startFakeAc({ dropBeforeAck: true });
    let threw = false;
    try {
      await sendViaWebSocket(ac.url, "fake-token", {
        text: "will drop", sender: "user", channel: "general", attachments: [],
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /closed before ack|websocket/);
      assert.notEqual(err.code, "EAGENTCHATTR_401");
    }
    assert.equal(threw, true, "expected sendViaWebSocket to reject on premature close");
    await ac.close();
  }

  // 5) 4003 (bad token) rejects with EAGENTCHATTR_401.
  {
    const ac = await startFakeAc({ rejectWithCode: 4003 });
    let threw = false;
    try {
      await sendViaWebSocket(ac.url, "bad-token", {
        text: "denied", sender: "user", channel: "general", attachments: [],
      });
    } catch (err) {
      threw = true;
      assert.equal(err.code, "EAGENTCHATTR_401");
    }
    assert.equal(threw, true, "expected sendViaWebSocket to reject with EAGENTCHATTR_401");
    await ac.close();
  }

  console.log("routes.chatWsSend.test.js: all assertions passed (5 cases)");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

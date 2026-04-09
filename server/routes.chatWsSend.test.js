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
      for (const msg of historyBeforeAck) {
        ws.send(JSON.stringify({ type: "message", data: msg }));
      }
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== "message") return;
        if (dropBeforeAck) {
          ws.close();
          return;
        }
        // Mirror store.add: assign id + timestamp, rebroadcast.
        const echoed = {
          id: 9001,
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
    assert.equal(result.message.id, 9001);
    assert.equal(result.message.text, "hello from test");
    assert.equal(result.message.sender, "user");
    assert.equal(result.message.attachments.length, 1);
    assert.equal(result.message.attachments[0].name, "x.png");
    await ac.close();
  }

  // 3) Stale history replay must NOT satisfy the ack. The server sends
  //    a matching (sender,text) frame on connect BEFORE we've sent
  //    anything — sendViaWebSocket should ignore it (timestamp gate
  //    + sentAt guard) and still wait for the real post-send echo.
  {
    const stale = {
      id: 1, sender: "user", text: "ghost", channel: "general",
      attachments: [], reply_to: null,
      timestamp: (Date.now() - 60_000) / 1000, // 60s in the past
    };
    const ac = await startFakeAc({ historyBeforeAck: [stale] });
    const result = await sendViaWebSocket(ac.url, "fake-token", {
      text: "ghost",
      sender: "user",
      channel: "general",
      attachments: [],
    });
    assert.equal(result.message.id, 9001, "must resolve with the live echo, not the historical one");
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

// #940: chat image attachments — two regressions, two fixes.
//   1. GET /api/uploads/:project/:filename must serve a file living under
//      the ~/.quadwork dot-dir (res.sendFile needs { dotfiles: "allow" }).
//   2. POST /api/chat + appendMessage must thread `attachments` through and
//      persist only the `name` (never the absolute server FS `path`).
//
// Plain node:assert script — run with `node server/routes.uploadAttachments.test.js`.

const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DIR = path.join(os.tmpdir(), `routes-uploads-test-${process.pid}-${Date.now()}`);

// Override HOME BEFORE requiring routes/config so CONFIG_DIR resolves to a
// `.quadwork` dot-dir under the temp dir (exercising the real dotfiles path).
const origHome = os.homedir;
os.homedir = () => TEST_DIR;

const CONFIG_DIR = path.join(TEST_DIR, ".quadwork");
const PROJECT = "uploads-test-project";
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(CONFIG_DIR, "config.json"), JSON.stringify({
  projects: [{ id: PROJECT, archived: false }],
}));

const fileChat = require("./file-chat");
const router = require("./routes");
const express = require("express");

const UPLOAD_NAME = "upload-12345.png";
// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex",
);

function cleanup() {
  os.homedir = origHome;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

function req(server, { method = "GET", urlPath, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  // --- Direct appendMessage unit checks (no HTTP) ---------------------------
  fileChat.initProject(PROJECT);

  {
    const m = fileChat.appendMessage(PROJECT, {
      sender: "user",
      text: "hi",
      attachments: [{ name: "upload-a.png" }],
    });
    assert.deepEqual(m.attachments, [{ name: "upload-a.png" }], "appendMessage stores attachments");
  }
  {
    const m = fileChat.appendMessage(PROJECT, { sender: "user", text: "no attach" });
    assert.equal("attachments" in m, false, "appendMessage omits attachments field when absent");
  }
  {
    const m = fileChat.appendMessage(PROJECT, { sender: "user", text: "empty", attachments: [] });
    assert.equal("attachments" in m, false, "appendMessage omits attachments field when empty array");
  }
  console.log("PASS: appendMessage attachments round-trip (store / omit-absent / omit-empty)");

  // --- HTTP: serve under dot-dir + POST /api/chat persistence ---------------
  const uploadsDir = path.join(CONFIG_DIR, PROJECT, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, UPLOAD_NAME), PNG_BYTES);

  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  try {
    // Bug 1: serve route returns 200 for a file living under the dot-dir.
    const served = await req(server, { urlPath: `/api/uploads/${PROJECT}/${UPLOAD_NAME}` });
    assert.equal(served.status, 200, "GET /api/uploads serves dot-dir file with 200");
    assert.equal(served.buf.length, PNG_BYTES.length, "served bytes match the on-disk file");
    console.log("PASS: serve endpoint returns 200 for a file under the .quadwork dot-dir");

    // Bug 1 guard retained: traversal in filename is rejected.
    const trav = await req(server, { urlPath: `/api/uploads/${PROJECT}/..%2Fconfig.json` });
    assert.ok(trav.status === 400 || trav.status === 404, "traversal filename is not served");

    // Bug 2: POST /api/chat persists attachments (name only, no path).
    const posted = await req(server, {
      method: "POST",
      urlPath: `/api/chat?project=${PROJECT}`,
      body: {
        text: "look at this",
        attachments: [{ path: "/home/u/.quadwork/p/uploads/upload-x.png", name: "upload-x.png" }],
      },
    });
    assert.equal(posted.status, 200, "POST /api/chat with attachments succeeds");
    const postedMsg = JSON.parse(posted.buf.toString()).message;
    assert.deepEqual(postedMsg.attachments, [{ name: "upload-x.png" }], "persisted attachment carries name only (path dropped)");

    // Refetch confirms persistence survives reload from disk.
    const fetched = await req(server, { urlPath: `/api/chat?project=${PROJECT}&since_id=${postedMsg.id - 1}` });
    const msgs = JSON.parse(fetched.buf.toString());
    const reloaded = msgs.find((m) => m.id === postedMsg.id);
    assert.ok(reloaded, "posted message is returned on refetch");
    assert.deepEqual(reloaded.attachments, [{ name: "upload-x.png" }], "attachments survive refetch with name only");
    console.log("PASS: POST /api/chat round-trips attachments (name only) through persistence");

    // Bug 2 validation: non-array attachments rejected.
    const badType = await req(server, {
      method: "POST",
      urlPath: `/api/chat?project=${PROJECT}`,
      body: { text: "x", attachments: { name: "nope.png" } },
    });
    assert.equal(badType.status, 400, "non-array attachments rejected with 400");

    // Bug 2 validation: attachment name with path separators rejected.
    const badName = await req(server, {
      method: "POST",
      urlPath: `/api/chat?project=${PROJECT}`,
      body: { text: "x", attachments: [{ name: "../../etc/passwd" }] },
    });
    assert.equal(badName.status, 400, "attachment name with path separators rejected with 400");
    console.log("PASS: POST /api/chat rejects non-array attachments and traversal names");
  } finally {
    server.close();
  }

  console.log("routes.uploadAttachments.test.js: all assertions passed");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

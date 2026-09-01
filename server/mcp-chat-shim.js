#!/usr/bin/env node
"use strict";

const http = require("http");
const readline = require("readline");

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const PROJECT = flag("project");
const AGENT = flag("agent");
const PORT = flag("port");
const TOKEN = flag("token");

if (!PROJECT || !AGENT || !PORT) {
  process.stderr.write("Usage: node mcp-chat-shim.js --project <id> --agent <id> --port <port> [--token <token>]\n");
  process.exit(1);
}

const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT_ROLES = new Set(["head", "dev", "re1", "re2"]);

const CHAT_TOOLS = [
  {
    name: "chat_send",
    description: "Send a message to the project chat",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", default: "general" },
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
  {
    name: "chat_read",
    description: "Read recent messages from project chat",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", default: "general" },
        limit: { type: "number", default: 50 },
        since_id: { type: "number" },
      },
    },
  },
];

const ISSUE_CONTRACT_REVISION_TOOL = {
  name: "issue_contract_revision",
  description: "Read the authenticated live GitHub issue body revision for one registered repository in this project. The server derives project and actor from this role's shim token; callers provide only repo_key and issue.",
  inputSchema: {
    type: "object",
    properties: {
      repo_key: { type: "string", description: "Registered project repository key" },
      issue: { type: "integer", minimum: 1 },
    },
    required: ["repo_key", "issue"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

const SUBMIT_CI_EVIDENCE_TOOL = {
  name: "submit_ci_evidence",
  description: "Submit bounded CI-less evidence for the authenticated Dev role's current assignment. Evidence labels are data only; this operation never executes commands.",
  inputSchema: {
    type: "object",
    properties: {
      assignment_attempt: { type: "string" },
      contract_revision: { type: "string" },
      repo_key: { type: "string" },
      item: {
        type: "object",
        properties: {
          repo_key: { type: "string" },
          repo: { type: "string" },
          number: { type: "integer", minimum: 1 },
          kind: { type: "string", enum: ["issue"] },
        },
        required: ["repo_key", "repo", "number", "kind"],
        additionalProperties: false,
      },
      pr_number: { type: "integer", minimum: 1 },
      exact_sha: { type: "string" },
      policy_version: { type: "integer", minimum: 1 },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            outcome: { type: "string", enum: ["pass", "fail"] },
            exit_code: { type: "integer", minimum: 0, maximum: 255 },
            evidence_ref: { type: "string" },
          },
          required: ["key", "outcome", "exit_code", "evidence_ref"],
          additionalProperties: false,
        },
      },
    },
    required: ["assignment_attempt", "contract_revision", "repo_key", "item", "pr_number", "exact_sha", "policy_version", "results"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const READ_CI_EVIDENCE_TOOL = {
  name: "read_ci_evidence",
  description: "Read one redacted, server-authenticated CI-less evidence receipt for this project.",
  inputSchema: {
    type: "object",
    properties: { record_id: { type: "string" } },
    required: ["record_id"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const SUBMIT_REVIEW_CYCLE_RECEIPT_TOOL = {
  name: "submit_review_cycle_receipt",
  description: "Bind this authenticated reviewer's one current GitHub review object to the server-owned exact-SHA review cycle. Chat claims and prose are not accepted.",
  inputSchema: {
    type: "object",
    properties: {
      target_identity_digest: { type: "string" },
      review_id: { type: ["string", "integer"] },
      nonce: { type: "string" },
    },
    required: ["target_identity_digest", "review_id", "nonce"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

const ISSUE_REVIEW_CYCLE_NONCE_TOOL = {
  name: "issue_review_cycle_nonce",
  description: "Read this authenticated reviewer's one private, one-time nonce for the current server-owned review cycle. Put it in the GitHub review body before submitting the receipt.",
  inputSchema: {
    type: "object",
    properties: { target_identity_digest: { type: "string" } },
    required: ["target_identity_digest"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

// The Head resume path intentionally has no caller-selected project, agent,
// generation, source, or endpoint.  The server derives that authority from
// the per-role shim token and its current Head binding.
const CHAT_RESUME_TOOL = {
  name: "chat_resume",
  description: "Resume the authenticated Head's bounded Primary Chat evidence page. The server derives the active Head binding from this shim token.",
  inputSchema: {
    type: "object",
    properties: {
      cursor: { type: ["string", "null"], maxLength: 2048 },
      limit: { type: "integer", minimum: 1, maximum: 64 },
    },
    required: ["cursor", "limit"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function plainRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseChatResumeArguments(value) {
  if (!plainRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "cursor" || keys[1] !== "limit") return null;
  if (value.cursor !== null && (typeof value.cursor !== "string" || value.cursor.length > 2048)) return null;
  if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 64) return null;
  return { cursor: value.cursor, limit: value.limit };
}

function toolsForActor() {
  if (!PROJECT_ROLES.has(AGENT)) return CHAT_TOOLS;
  const tools = [...CHAT_TOOLS, ISSUE_CONTRACT_REVISION_TOOL, READ_CI_EVIDENCE_TOOL];
  if (AGENT === "head" && TOKEN) tools.push(CHAT_RESUME_TOOL);
  if (AGENT === "dev") tools.push(SUBMIT_CI_EVIDENCE_TOOL);
  if (AGENT === "re1" || AGENT === "re2") tools.push(ISSUE_REVIEW_CYCLE_NONCE_TOOL, SUBMIT_REVIEW_CYCLE_RECEIPT_TOOL);
  return tools;
}

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function httpRequest(method, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function handleToolCall(id, name, params) {
  try {
    if (name === "chat_resume") {
      // Hidden calls from every non-Head shim are rejected locally.  A Head
      // process must also have the token that the fixed endpoint authenticates.
      if (AGENT !== "head" || !TOKEN) return jsonRpcError(id, -32601, "Unknown tool: chat_resume");
      const request = parseChatResumeArguments(params);
      if (!request) return jsonRpcError(id, -32602, "Invalid chat_resume arguments");
      try {
        const res = await httpRequest("POST", "/api/chat-resume", request, { "X-Chat-Token": TOKEN });
        // The server's diagnostic payload can contain authorization or source
        // details.  This fixed client boundary returns no such details.
        if (res.status >= 400) return jsonRpcError(id, -32000, "chat_resume unavailable");
        return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(res.body) }] });
      } catch {
        return jsonRpcError(id, -32000, "chat_resume unavailable");
      }
    }

    if (name === "chat_send") {
      const res = await httpRequest("POST", `/api/chat?project=${encodeURIComponent(PROJECT)}`, {
        text: params.message || "",
        channel: params.channel || "general",
      }, { "X-Chat-Sender": AGENT, ...(TOKEN ? { "X-Chat-Token": TOKEN } : {}) });
      if (res.status >= 400) {
        return jsonRpcError(id, -32000, `API error ${res.status}: ${JSON.stringify(res.body)}`);
      }
      // #932: MCP structuredContent must be a record, not a top-level array —
      // gemini's SDK auto-parses the result text and rejects a bare array with
      // `invalid_type`. chat_read's body is an array of messages, so wrap it in
      // an object; chat_send's body is already an object → the guard is a no-op.
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(Array.isArray(res.body) ? { messages: res.body } : res.body) }] });
    }

    if (name === "chat_read") {
      const qs = new URLSearchParams({ project: PROJECT });
      if (params.channel) qs.set("channel", params.channel);
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.since_id) qs.set("since_id", String(params.since_id));
      const res = await httpRequest("GET", `/api/chat?${qs.toString()}`);
      if (res.status >= 400) {
        return jsonRpcError(id, -32000, `API error ${res.status}: ${JSON.stringify(res.body)}`);
      }
      // #932: MCP structuredContent must be a record, not a top-level array —
      // gemini's SDK auto-parses the result text and rejects a bare array with
      // `invalid_type`. chat_read's body is an array of messages, so wrap it in
      // an object; chat_send's body is already an object → the guard is a no-op.
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(Array.isArray(res.body) ? { messages: res.body } : res.body) }] });
    }

    if (name === "issue_contract_revision") {
      const res = await httpRequest(
        "POST",
        "/api/issue-contract-revision",
        params,
        TOKEN ? { "X-Chat-Token": TOKEN } : {},
      );
      if (res.status >= 400) {
        return jsonRpcError(id, -32000, `API error ${res.status}: ${JSON.stringify(res.body)}`);
      }
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(res.body) }] });
    }

    if (name === "submit_ci_evidence") {
      const res = await httpRequest(
        "POST",
        "/api/ci-evidence",
        params,
        TOKEN ? { "X-Chat-Token": TOKEN } : {},
      );
      if (res.status >= 400) {
        return jsonRpcError(id, -32000, `API error ${res.status}: ${JSON.stringify(res.body)}`);
      }
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(res.body) }] });
    }

    if (name === "read_ci_evidence") {
      const res = await httpRequest(
        "POST",
        "/api/ci-evidence/read",
        params,
        TOKEN ? { "X-Chat-Token": TOKEN } : {},
      );
      if (res.status >= 400) {
        return jsonRpcError(id, -32000, `API error ${res.status}: ${JSON.stringify(res.body)}`);
      }
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(res.body) }] });
    }

    if (name === "submit_review_cycle_receipt") {
      const res = await httpRequest("POST", "/api/review-cycle-receipt", params,
        TOKEN ? { "X-Chat-Token": TOKEN } : {});
      if (res.status >= 400) return jsonRpcError(id, -32000, `API error ${res.status}: ${JSON.stringify(res.body)}`);
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(res.body) }] });
    }

    if (name === "issue_review_cycle_nonce") {
      const res = await httpRequest("POST", "/api/review-cycle-nonce", params,
        TOKEN ? { "X-Chat-Token": TOKEN } : {});
      if (res.status >= 400) return jsonRpcError(id, -32000, `API error ${res.status}: ${JSON.stringify(res.body)}`);
      return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(res.body) }] });
    }

    return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
  } catch (err) {
    return jsonRpcError(id, -32000, err.message);
  }
}

// --- MCP stdio protocol ---

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "quadwork-chat", version: "1.0.0" },
    });
  }

  if (method === "initialized") {
    return null;
  }

  if (method === "tools/list") {
    return jsonRpc(id, { tools: toolsForActor() });
  }

  if (method === "tools/call") {
    return handleToolCall(id, params?.name, params?.arguments || {});
  }

  if (method === "ping") {
    return jsonRpc(id, {});
  }

  if (id != null) {
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
  return null;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(jsonRpcError(null, -32700, "Parse error") + "\n");
    return;
  }
  const response = await handleMessage(msg);
  if (response) {
    process.stdout.write(response + "\n");
  }
});

rl.on("close", () => {
  process.exit(0);
});

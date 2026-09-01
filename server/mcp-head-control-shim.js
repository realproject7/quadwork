#!/usr/bin/env node
"use strict";

// This is intentionally a separate, fixed-surface stdio entry point.  Its
// only outbound operation is the Head-control endpoint below; the server
// authenticates the launch token and re-checks the fixed binding envelope.

const http = require("node:http");
const readline = require("node:readline");

const API_PATH = "/api/head-control";
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const IDENTIFIER_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN_RE = /^[^\s\r\n]{16,512}$/;

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message) {
  throw new Error(message);
}

function exact(value, fields) {
  if (!plain(value)) fail("value must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("value has unknown or missing fields");
  }
}

function allowed(value, fields) {
  if (!plain(value)) fail("value must be an object");
  if (Object.keys(value).some((key) => !fields.includes(key))) fail("value has an unknown field");
}

function copyJson(value, depth = 0) {
  if (depth > 32) fail("value is nested too deeply");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("value contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => copyJson(item, depth + 1));
  if (!plain(value)) fail("value is not JSON data");
  const result = Object.create(null);
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, {
      value: copyJson(value[key], depth + 1), enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function boundedJson(value, limit) {
  const copied = copyJson(value);
  if (Buffer.byteLength(JSON.stringify(copied), "utf8") > limit) fail("value exceeds the fixed size bound");
  return copied;
}

function identifier(value) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) fail("identity is invalid");
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 1) {
    fail("revision is invalid");
  }
  return value;
}

function launch(argv) {
  const values = Object.create(null);
  const names = new Set(["project", "agent", "generation", "port", "token"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || !names.has(flag.slice(2)) ||
        value === undefined || hasOwn(values, flag.slice(2))) {
      fail("invalid launch arguments");
    }
    values[flag.slice(2)] = value;
  }
  exact(values, ["project", "agent", "generation", "port", "token"]);
  if (typeof values.project !== "string" || !PROJECT_RE.test(values.project) || values.agent !== "head" ||
      typeof values.generation !== "string" || !/^(0|[1-9][0-9]*)$/.test(values.generation) ||
      typeof values.port !== "string" || !/^[1-9][0-9]{0,4}$/.test(values.port) ||
      typeof values.token !== "string" || !TOKEN_RE.test(values.token)) {
    fail("invalid launch identity");
  }
  const generation = Number(values.generation);
  const port = Number(values.port);
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(port) || port > 65535) fail("invalid launch identity");
  return Object.freeze({
    project: values.project,
    generation,
    port,
    token: values.token,
  });
}

let IDENTITY;
try {
  IDENTITY = launch(process.argv.slice(2));
} catch {
  process.stderr.write("Usage: node mcp-head-control-shim.js --project <id> --agent=head --generation <n> --port <port> --token <token>\n");
  process.exit(1);
}

const TOOL_DEFS = Object.freeze([
  Object.freeze({
    name: "get_pipeline_status",
    description: "Read the fixed Head pipeline status for this launch binding.",
    inputSchema: {
      type: "object",
      properties: {
        idempotency_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        correlation_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
      },
      required: ["idempotency_key", "correlation_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }),
  Object.freeze({
    name: "put_batch_manifest",
    description: "Store one proposed batch manifest at the supplied optimistic revision.",
    inputSchema: {
      type: "object",
      properties: {
        expected_revision: { type: "integer", minimum: 0 },
        idempotency_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        correlation_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        manifest: { type: "object" },
      },
      required: ["expected_revision", "idempotency_key", "correlation_id", "manifest"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }),
  Object.freeze({
    name: "freeze_batch_manifest",
    description: "Freeze the stored batch manifest at the supplied optimistic revision.",
    inputSchema: {
      type: "object",
      properties: {
        expected_revision: { type: "integer", minimum: 0 },
        idempotency_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        correlation_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
      },
      required: ["expected_revision", "idempotency_key", "correlation_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }),
  Object.freeze({
    name: "cut_batch",
    description: "Cut one already-safe batch using the supplied optimistic revision.",
    inputSchema: {
      type: "object",
      properties: {
        expected_revision: { type: "integer", minimum: 0 },
        idempotency_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        correlation_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        cut: {
          type: "object",
          properties: {
            tasks: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } },
          },
          required: ["tasks"],
          additionalProperties: false,
        },
      },
      required: ["expected_revision", "idempotency_key", "correlation_id", "cut"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }),
  Object.freeze({
    name: "recent_head_control_audit",
    description: "Read the bounded redacted Head-control audit for this launch binding.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }),
]);

const TOOL_NAMES = new Set(TOOL_DEFS.map((tool) => tool.name));

function commandArguments(name, value) {
  if (!TOOL_NAMES.has(name)) fail("tool is unknown");
  if (!plain(value)) fail("arguments must be an object");
  let parsed;
  if (name === "get_pipeline_status") {
    exact(value, ["idempotency_key", "correlation_id"]);
    parsed = { idempotency_key: identifier(value.idempotency_key), correlation_id: identifier(value.correlation_id) };
  } else if (name === "freeze_batch_manifest") {
    exact(value, ["expected_revision", "idempotency_key", "correlation_id"]);
    parsed = {
      expected_revision: revision(value.expected_revision),
      idempotency_key: identifier(value.idempotency_key),
      correlation_id: identifier(value.correlation_id),
    };
  } else if (name === "put_batch_manifest") {
    exact(value, ["expected_revision", "idempotency_key", "correlation_id", "manifest"]);
    if (!plain(value.manifest)) fail("manifest is invalid");
    parsed = {
      expected_revision: revision(value.expected_revision),
      idempotency_key: identifier(value.idempotency_key),
      correlation_id: identifier(value.correlation_id),
      manifest: copyJson(value.manifest),
    };
  } else if (name === "cut_batch") {
    exact(value, ["expected_revision", "idempotency_key", "correlation_id", "cut"]);
    if (!plain(value.cut)) fail("cut is invalid");
    exact(value.cut, ["tasks"]);
    if (!Array.isArray(value.cut.tasks) || value.cut.tasks.length === 0 || value.cut.tasks.length > 64 ||
        !value.cut.tasks.every(plain)) fail("cut is invalid");
    parsed = {
      expected_revision: revision(value.expected_revision),
      idempotency_key: identifier(value.idempotency_key),
      correlation_id: identifier(value.correlation_id),
      cut: copyJson(value.cut),
    };
  } else {
    exact(value, []);
    parsed = Object.create(null);
  }
  return boundedJson(parsed, MAX_ARGUMENT_BYTES);
}

function containsSecret(value) {
  if (typeof value === "string") return value.includes(IDENTITY.token);
  if (Array.isArray(value)) return value.some(containsSecret);
  return plain(value) && Object.values(value).some(containsSecret);
}

function requestControl(name, argumentsValue) {
  const envelope = {
    version: 1,
    binding: {
      project_id: IDENTITY.project,
      actor: "head",
      generation: IDENTITY.generation,
    },
    request: {
      tool: name,
      arguments: argumentsValue,
    },
  };
  const payload = JSON.stringify(envelope);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: IDENTITY.port,
      path: API_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload, "utf8"),
        "X-Head-Control-Token": IDENTITY.token,
      },
    }, (response) => {
      let body = "";
      let received = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        received += Buffer.byteLength(chunk, "utf8");
        if (received > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("response exceeds the fixed size bound"));
          return;
        }
        body += chunk;
      });
      response.on("error", reject);
      response.on("end", () => {
        if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error("Head-control API rejected the request"));
          return;
        }
        let decoded;
        try { decoded = JSON.parse(body); } catch { reject(new Error("Head-control API returned malformed JSON")); return; }
        try {
          exact(decoded, ["ok", "result"]);
          if (decoded.ok !== true || (name === "recent_head_control_audit" ? !Array.isArray(decoded.result) : !plain(decoded.result)) ||
              containsSecret(decoded)) {
            fail("Head-control API returned an invalid result");
          }
          resolve(boundedJson(decoded.result, MAX_RESPONSE_BYTES));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error("Head-control API timed out")));
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function requestId(message) {
  return plain(message) && hasOwn(message, "id") && (typeof message.id === "string" || Number.isFinite(message.id))
    ? message.id
    : null;
}

function paramsEmpty(params) {
  if (params === undefined) return;
  exact(params, []);
}

async function handleToolCall(id, params) {
  try {
    exact(params, ["name", "arguments"]);
    if (typeof params.name !== "string" || !TOOL_NAMES.has(params.name)) {
      return jsonRpcError(id, -32601, "Tool not found");
    }
  } catch {
    return jsonRpcError(id, -32602, "Invalid params");
  }
  let argumentsValue;
  try {
    argumentsValue = commandArguments(params.name, params.arguments);
  } catch {
    return jsonRpcError(id, -32602, "Invalid params");
  }
  try {
    const result = await requestControl(params.name, argumentsValue);
    return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch {
    return jsonRpcError(id, -32000, "Head-control request failed");
  }
}

async function handleMessage(message) {
  if (!plain(message)) return jsonRpcError(null, -32600, "Invalid Request");
  try {
    allowed(message, ["jsonrpc", "id", "method", "params"]);
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") fail("invalid request");
    if (hasOwn(message, "id") && !(typeof message.id === "string" || Number.isFinite(message.id))) fail("invalid request id");
  } catch {
    return jsonRpcError(requestId(message), -32600, "Invalid Request");
  }

  const id = requestId(message);
  if (message.method === "initialize") {
    try { paramsEmpty(message.params); } catch { return jsonRpcError(id, -32602, "Invalid params"); }
    return jsonRpc(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "quadwork-head-control", version: "1.0.0" },
    });
  }
  if (message.method === "initialized") {
    try { paramsEmpty(message.params); } catch { return id === null ? null : jsonRpcError(id, -32602, "Invalid params"); }
    return null;
  }
  if (message.method === "tools/list") {
    try { paramsEmpty(message.params); } catch { return jsonRpcError(id, -32602, "Invalid params"); }
    return jsonRpc(id, { tools: TOOL_DEFS });
  }
  if (message.method === "tools/call") {
    if (!hasOwn(message, "params")) return jsonRpcError(id, -32602, "Invalid params");
    return handleToolCall(id, message.params);
  }
  if (message.method === "ping") {
    try { paramsEmpty(message.params); } catch { return jsonRpcError(id, -32602, "Invalid params"); }
    return jsonRpc(id, {});
  }
  return id === null ? null : jsonRpcError(id, -32601, "Method not found");
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
let serial = Promise.resolve();

input.on("line", (line) => {
  serial = serial.then(async () => {
    let message;
    try { message = JSON.parse(line); } catch {
      process.stdout.write(jsonRpcError(null, -32700, "Parse error") + "\n");
      return;
    }
    const response = await handleMessage(message);
    if (response) process.stdout.write(response + "\n");
  }).catch(() => {
    process.stdout.write(jsonRpcError(null, -32000, "Head-control request failed") + "\n");
  });
});

input.on("close", () => {
  serial.finally(() => process.exit(0));
});

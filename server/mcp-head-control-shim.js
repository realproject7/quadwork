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
const RECOVERABLE_ROLES = new Set(["dev", "re1", "re2"]);
const RECOVERY_REASONS = new Set(["process_exited", "unresponsive", "resource_killed", "launch_failed"]);
const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ATTEMPT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
    name: "retire_batch",
    description: "Retire the frozen batch at the supplied optimistic revision so a successor manifest can be put. Refused while any task holds build or review authority.",
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
    name: "abandon_batch_manifest",
    description: "Abandon the stored, never-frozen batch manifest at the supplied optimistic revision so a successor manifest can be put. Refused once the manifest is frozen or any pipeline exists; frozen, cut, and retired records are never touched.",
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
    name: "queue_local_correction",
    description: "Return one released changes-requested task candidate to Dev as a bounded local correction at the supplied optimistic revision.",
    inputSchema: {
      type: "object",
      properties: {
        expected_revision: { type: "integer", minimum: 0 },
        idempotency_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        correlation_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        correction: {
          type: "object",
          properties: {
            work_task_ref: { type: "object" },
            review_round_ref: { type: "object" },
            candidate_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
          required: ["work_task_ref", "review_round_ref", "candidate_digest"],
          additionalProperties: false,
        },
      },
      required: ["expected_revision", "idempotency_key", "correlation_id", "correction"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }),
  Object.freeze({
    name: "read_propagation_stop",
    description: "Read the Head-private pending pre-release propagation stop for one task of the frozen batch, or null.",
    inputSchema: {
      type: "object",
      properties: {
        idempotency_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        correlation_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        work_task_ref: { type: "object" },
      },
      required: ["idempotency_key", "correlation_id", "work_task_ref"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }),
  Object.freeze({
    name: "get_project_status",
    description: "Read this project's current qualified assignment, Project Monitor state and last evaluation, each worker's raw session health/generation/observation times, the redacted capacity summary, and the merged_but_not_advanced / loaded_next_item_unassigned observations. Observation times matter: `running` alone is not proof of health.",
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
    name: "review_handoff",
    description: "Read the structured current-cycle review handoff for the active repository-qualified item: repo key, PR, exact SHA, cycle id, readiness, CI, review 0/2 1/2 2/2 or changes_requested, mergeability, reviewer receipt presence, and whether the Head merge gate is due. Read-only: it never creates, repeats, or cancels a review request.",
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
    name: "project_monitor",
    description: "Control the fixed-policy Head-only Project Monitor: `start` enables observation of the current qualified assignment (refused when archived, not V2-ready, or no active batch), `stop` suspends it, `evaluate_now` runs one deduplicated evaluation of cached/live facts and delivers a Head event only when a fixed-policy transition is genuinely due. It accepts no message, cadence, recipient, or broadcast mode.",
    inputSchema: {
      type: "object",
      properties: {
        idempotency_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        correlation_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        command: { type: "string", enum: ["start", "stop", "evaluate_now"] },
      },
      required: ["idempotency_key", "correlation_id", "command"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }),
  Object.freeze({
    name: "recover_worker",
    description: "Request one bounded relaunch of dev, re1, or re2 after structured loss evidence (exited/unresponsive/resource_killed/launch_failed) for the current assignment attempt and the exact lost generation. Refused for head, a healthy or unconfirmed session, a stale generation, a non-current assignment, an archived project, or insufficient capacity. An open circuit is refused too, except for the single permitted trial naming that circuit's exact loss correlation and expected generation; once that trial is consumed, further calls are refused with `head_trial_consumed` until an operator trial clears the circuit. Returns the lifecycle result verbatim: `spawned` is not `verified` and is never recovery. A relaunched worker clears its trial only by posting to chat through its own per-spawn shim token, which proves that generation booted its CLI and acted; a worker that never posts stays uncleared until an operator restart.",
    inputSchema: {
      type: "object",
      properties: {
        idempotency_key: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        correlation_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,95}$" },
        recovery: {
          type: "object",
          properties: {
            agent: { type: "string", enum: ["dev", "re1", "re2"] },
            expected_generation: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" },
            assignment_attempt: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" },
            reason_code: { type: "string", enum: ["process_exited", "unresponsive", "resource_killed", "launch_failed"] },
          },
          required: ["agent", "expected_generation", "assignment_attempt", "reason_code"],
          additionalProperties: false,
        },
      },
      required: ["idempotency_key", "correlation_id", "recovery"],
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
  if (name === "get_pipeline_status" || name === "get_project_status" || name === "review_handoff") {
    exact(value, ["idempotency_key", "correlation_id"]);
    parsed = { idempotency_key: identifier(value.idempotency_key), correlation_id: identifier(value.correlation_id) };
  } else if (name === "project_monitor") {
    exact(value, ["idempotency_key", "correlation_id", "command"]);
    if (!["start", "stop", "evaluate_now"].includes(value.command)) fail("command is invalid");
    parsed = { idempotency_key: identifier(value.idempotency_key), correlation_id: identifier(value.correlation_id), command: value.command };
  } else if (name === "recover_worker") {
    exact(value, ["idempotency_key", "correlation_id", "recovery"]);
    if (!plain(value.recovery)) fail("recovery is invalid");
    exact(value.recovery, ["agent", "expected_generation", "assignment_attempt", "reason_code"]);
    const recovery = value.recovery;
    if (!RECOVERABLE_ROLES.has(recovery.agent) || !RECOVERY_REASONS.has(recovery.reason_code) ||
        typeof recovery.expected_generation !== "string" || !GENERATION_RE.test(recovery.expected_generation) ||
        typeof recovery.assignment_attempt !== "string" || !ATTEMPT_RE.test(recovery.assignment_attempt)) fail("recovery is invalid");
    parsed = { idempotency_key: identifier(value.idempotency_key), correlation_id: identifier(value.correlation_id), recovery: copyJson(recovery) };
  } else if (name === "freeze_batch_manifest" || name === "retire_batch" || name === "abandon_batch_manifest") {
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
  } else if (name === "queue_local_correction") {
    exact(value, ["expected_revision", "idempotency_key", "correlation_id", "correction"]);
    if (!plain(value.correction)) fail("correction is invalid");
    exact(value.correction, ["work_task_ref", "review_round_ref", "candidate_digest"]);
    if (!plain(value.correction.work_task_ref) || !plain(value.correction.review_round_ref)) fail("correction is invalid");
    parsed = {
      expected_revision: revision(value.expected_revision),
      idempotency_key: identifier(value.idempotency_key),
      correlation_id: identifier(value.correlation_id),
      correction: copyJson(value.correction),
    };
  } else if (name === "read_propagation_stop") {
    exact(value, ["idempotency_key", "correlation_id", "work_task_ref"]);
    if (!plain(value.work_task_ref)) fail("work_task_ref is invalid");
    parsed = {
      idempotency_key: identifier(value.idempotency_key),
      correlation_id: identifier(value.correlation_id),
      work_task_ref: copyJson(value.work_task_ref),
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
  // The handshake and listing follow the shipped chat shim: clients send
  // initialize capabilities/clientInfo and an optional tools/list cursor, so
  // their params are not validated.  tools/call remains the strict surface.
  if (message.method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "quadwork-head-control", version: "1.0.0" },
    });
  }
  if (message.method === "initialized" || message.method === "notifications/initialized") {
    return null;
  }
  if (message.method === "tools/list") {
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

"use strict";

const assert = require("assert/strict");
const {
  canonicalIssueContractBody,
  issueContractRevision,
  fetchIssueContractRevision,
  createIssueContractRevisionHandler,
} = require("./issue-contract-revision");

const vectors = [
  ["null", null, "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["empty", "", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["no terminal LF", "alpha", "alpha\n", "b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060"],
  ["one terminal LF", "alpha\n", "alpha\n", "b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060"],
  ["multiple terminal LF", "alpha\n\n\n", "alpha\n", "b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060"],
  ["LF-only nonempty", "\n\n\n", "\n", "01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b"],
  ["CRLF and lone CR", "a\r\nb\rc\n", "a\nb\nc\n", "880553fca8fcea94e325ee2cfb48e5a985cc797f39a14cc6d3cedecfeb2ae4d2"],
  ["interior blank lines", "a\n\n\nb", "a\n\n\nb\n", "ebbfa3d605b9dd23739e36d89f299a2906608cde597a866dc890dd6816af3d7a"],
  ["whitespace-only", " \t ", " \t \n", "56753379523e1167952355ac1a86d59bd560394a6901450a129cbdbcde0784c0"],
  ["trailing spaces", "alpha  \n\n", "alpha  \n", "a1d36921b09507031f6a0d2ecbda13dac0d41b20318f6138ccbf3f01907deb5c"],
  ["decomposed Unicode", "e\u0301\n", "e\u0301\n", "f979a211b00b61497349a7c753652a3d173550a368711a9f9f9845e6383db7cb"],
  ["composed Unicode", "é\n", "é\n", "edd3a863872a04239eb29ad4bc12fc892b3d4ae57cc7e786a3697816f8e141c2"],
];

for (const [label, input, canonical, digest] of vectors) {
  assert.equal(canonicalIssueContractBody(input), canonical, `${label}: canonical bytes`);
  assert.equal(issueContractRevision(input), digest, `${label}: lowercase SHA-256`);
}
assert.notEqual(issueContractRevision("e\u0301"), issueContractRevision("é"), "Unicode normalization is forbidden");
assert.throws(
  () => canonicalIssueContractBody(undefined),
  (error) => error.code === "issue_contract_source_mismatch",
  "undefined body fails closed instead of becoming empty",
);

function responseCapture() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return payload; },
  };
}

function successfulRevision(repo = "acme/web", issue = 42) {
  return {
    repo,
    issue,
    contract_revision: issueContractRevision("contract"),
    observed_at: "2026-08-29T12:34:56.000Z",
    source: "github_authenticated_rest",
    source_status: "ok",
  };
}

async function gatedRace({ mutate }) {
  let generation = 3;
  let observation = { repo: "Acme/Web", issue: 42, fingerprint: "queue-a" };
  let releaseFetch;
  let markStarted;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const handler = createIssueContractRevisionHandler({
    resolveShimPrincipal: () => ({ projectId: "p", agentId: "dev" }),
    captureProjectAdmission: () => ({ project_id: "p", generation }),
    isAdmissionCurrent: (token) => token.generation === generation,
    resolveRegisteredIssue: () => observation,
    fetchRevision: async () => {
      markStarted();
      await fetchGate;
      return successfulRevision();
    },
  });
  const req = { headers: { "x-chat-token": "token" }, query: {}, body: { repo_key: "web", issue: 42 } };
  const res = responseCapture();
  const pending = handler(req, res);
  await started;
  ({ generation, observation } = mutate({ generation, observation }));
  releaseFetch();
  await pending;
  return res;
}

(async () => {
  const calls = [];
  const result = await fetchIssueContractRevision({
    repo: "Acme/Web",
    issue: 42,
    requestIssue: async (repo, issue) => {
      calls.push({ repo, issue });
      return {
        repository_url: "https://api.github.com/repos/ACME/WEB",
        number: 42,
        body: "contract\r\n\r\n",
      };
    },
    now: () => new Date("2026-08-29T12:34:56.000Z"),
  });
  assert.deepEqual(calls, [{ repo: "acme/web", issue: 42 }], "only canonical repo and issue reach authenticated REST");
  assert.deepEqual(result, {
    repo: "acme/web",
    issue: 42,
    contract_revision: "3dd7131bf1c92dd2a9c9eb03891f3fbaf0321ef9ef019be728d8cc29225d6928",
    observed_at: "2026-08-29T12:34:56.000Z",
    source: "github_authenticated_rest",
    source_status: "ok",
  });

  const mismatches = [
    ["repository mismatch", { repository_url: "https://api.github.com/repos/acme/api", number: 42, body: "x" }],
    ["issue mismatch", { repository_url: "https://api.github.com/repos/acme/web", number: 41, body: "x" }],
    ["PR masquerading as issue", { repository_url: "https://api.github.com/repos/acme/web", number: 42, body: "x", pull_request: {} }],
    ["missing body", { repository_url: "https://api.github.com/repos/acme/web", number: 42 }],
  ];
  for (const [label, payload] of mismatches) {
    await assert.rejects(
      () => fetchIssueContractRevision({ repo: "acme/web", issue: 42, requestIssue: async () => payload }),
      (error) => error.code === "issue_contract_source_mismatch",
      `${label} fails closed`,
    );
  }
  await assert.rejects(
    () => fetchIssueContractRevision({ repo: "acme/web", issue: 42, requestIssue: async () => { throw new Error("offline"); } }),
    (error) => error.code === "issue_contract_read_failed",
    "authenticated REST read failure returns no revision",
  );

  const queueRace = await gatedRace({
    mutate: ({ generation, observation }) => ({
      generation,
      observation: { ...observation, fingerprint: "queue-b" },
    }),
  });
  assert.equal(queueRace.statusCode, 409, "A→B queue rollover during REST read fails closed");
  assert.equal(queueRace.payload.code, "issue_contract_target_changed");
  assert.equal(Object.prototype.hasOwnProperty.call(queueRace.payload, "contract_revision"), false,
    "stale queue observation publishes no digest");

  const bindingRace = await gatedRace({
    mutate: ({ generation, observation }) => ({
      generation,
      observation: { ...observation, repo: "Acme/API" },
    }),
  });
  assert.equal(bindingRace.statusCode, 409, "repository binding change during REST read fails closed");
  assert.equal(bindingRace.payload.code, "issue_contract_target_changed");

  const admissionRace = await gatedRace({
    mutate: ({ generation, observation }) => ({ generation: generation + 1, observation }),
  });
  assert.equal(admissionRace.statusCode, 409, "archive/remove generation change during REST read fails closed");
  assert.equal(admissionRace.payload.code, "issue_contract_admission_changed");
  assert.equal(Object.prototype.hasOwnProperty.call(admissionRace.payload, "contract_revision"), false,
    "stale admission generation publishes no digest");

  const mismatchHandler = createIssueContractRevisionHandler({
    resolveShimPrincipal: () => ({ projectId: "p", agentId: "re1" }),
    captureProjectAdmission: () => ({ project_id: "p", generation: 9 }),
    isAdmissionCurrent: () => true,
    resolveRegisteredIssue: () => ({ repo: "Acme/Web", issue: 42, fingerprint: "queue-a" }),
    fetchRevision: async () => successfulRevision("acme/other", 42),
  });
  const mismatchRes = responseCapture();
  await mismatchHandler(
    { headers: { "x-chat-token": "token" }, query: {}, body: { repo_key: "web", issue: 42 } },
    mismatchRes,
  );
  assert.equal(mismatchRes.statusCode, 502, "helper/result mismatch fails closed at the publication boundary");
  assert.equal(mismatchRes.payload.code, "issue_contract_source_mismatch");

  console.log("issue contract revision tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

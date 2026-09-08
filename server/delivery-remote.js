"use strict";

// Production transport for one server-selected registered clone. Every child
// goes through the caller's bounded control-process owner. Tests inject a
// different transport for local bare repositories; production never accepts one.
const fs = require("node:fs");
const { fail, sha, text } = require("./delivery-execution-contract");
function githubRemote(value) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(value);
  return match ? match[1].toLowerCase() : null;
}
function createDeliveryRemote({ repository, cwd, run, now = () => new Date().toISOString() }) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository) || typeof run !== "function") fail("delivery_remote_unavailable");
  repository = repository.toLowerCase();
  const canonicalPath = fs.realpathSync(cwd);
  let deadline = Date.now() + 60000;
  function setDeadline(value) { deadline = value; }
  const execute = async (file, args, optional = false) => {
    if (Date.now() >= deadline) fail("delivery_deadline_exceeded");
    try { const result = await run(file, args, { cwd: canonicalPath, encoding: "utf8", timeout: Math.min(15000, deadline - Date.now()), maxBuffer: 1024 * 1024 }); return String(result.stdout ?? result).trim(); }
    catch (error) { if (optional && error?.code === 1) return ""; fail("delivery_remote_read_or_write_unknown"); }
  };
  const git = (args, optional = false) => execute("git", args, optional);
  const api = async (suffix, args = []) => {
    let parsed;
    try { parsed = JSON.parse(await execute("gh", ["api", `repos/${repository}${suffix}`, ...args])); } catch { fail("delivery_remote_read_or_write_unknown"); }
    return parsed;
  };
  async function validate() {
    if (fs.realpathSync(cwd) !== canonicalPath || await git(["rev-parse", "--show-toplevel"]) !== canonicalPath) fail("delivery_remote_path_changed");
    const raw = await git(["config", "--get-all", "remote.origin.url"]);
    const push = await git(["config", "--get-all", "remote.origin.pushurl"], true);
    const rewrite = await git(["config", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"], true);
    const refspec = await git(["config", "--get-all", "remote.origin.push"], true);
    const effective = await git(["remote", "get-url", "--push", "--all", "origin"]);
    if (raw.includes("\n") || push || rewrite || refspec || effective !== raw || githubRemote(raw) !== repository) fail("delivery_remote_target_ambiguous");
    return repository;
  }
  async function branch(name) {
    text(name, 240);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes("..")) fail("delivery_branch_invalid");
    const lines = (await git(["ls-remote", "--refs", "origin", `refs/heads/${name}`])).split("\n").filter(Boolean);
    if (!lines.length) return null;
    if (lines.length !== 1) fail("delivery_remote_branch_ambiguous");
    const [oid, ref] = lines[0].split(/\s+/);
    if (ref !== `refs/heads/${name}`) fail("delivery_remote_branch_ambiguous");
    return sha(oid);
  }
  async function base() {
    const data = await api("");
    if (data.full_name?.toLowerCase() !== repository) fail("delivery_remote_repository_changed");
    const name = data.default_branch;
    const oid = await branch(name);
    if (!oid) fail("delivery_remote_base_unavailable");
    return { branch: name, sha: oid };
  }
  async function push(branchName, oid) {
    await validate(); sha(oid);
    await git(["push", `--force-with-lease=refs/heads/${branchName}:`, "origin", `${oid}:refs/heads/${branchName}`]);
  }
  function pull(data) {
    if (!data || !Number.isSafeInteger(data.number) || data.number < 1 || data.base?.repo?.full_name?.toLowerCase() !== repository || data.head?.repo?.full_name?.toLowerCase() !== repository) fail("delivery_pull_identity_invalid");
    return { number: data.number, node_id: text(data.node_id), url: `https://github.com/${repository}/pull/${data.number}`, repository,
      head: sha(data.head.sha), head_branch: text(data.head.ref, 240), base: sha(data.base.sha), base_branch: text(data.base.ref, 240),
      body: typeof data.body === "string" ? data.body : "", draft: data.draft === true,
      state: data.merged_at ? "MERGED" : data.state === "open" ? "OPEN" : "CLOSED", merge_sha: data.merged_at ? sha(data.merge_commit_sha) : null,
      merged_at: data.merged_at || null, observed_at: now() };
  }
  async function findPulls(branchName) {
    const data = await api(`/pulls?state=all&head=${encodeURIComponent(`${repository.split("/")[0]}:${branchName}`)}&per_page=100`);
    if (!Array.isArray(data) || data.length >= 100) fail("delivery_pull_ambiguous");
    return data.map(pull);
  }
  async function readPull(number) { if (!Number.isSafeInteger(number) || number < 1) fail("delivery_pull_invalid"); return pull(await api(`/pulls/${number}`)); }
  async function createPull(plan) {
    await validate();
    return pull(await api("/pulls", ["--method", "POST", "-f", `head=${plan.branch}`, "-f", `base=${plan.base_branch}`, "-f", `title=${plan.title}`, "-f", `body=${plan.body}`, "-F", "draft=false"]));
  }
  async function object(oid) {
    sha(oid);
    const parts = (await git(["show", "-s", "--format=%H%n%T%n%P", oid, "--"])).split("\n");
    if (parts[0] !== oid) fail("delivery_git_object_invalid");
    return { sha: oid, tree: sha(parts[1]), parents: (parts[2] || "").split(" ").filter(Boolean).map(sha) };
  }
  async function mergedObjects(mergeSha, branchName) {
    await validate();
    const tip = await branch(branchName);
    if (!tip) fail("delivery_merge_unreachable");
    await git(["fetch", "--no-tags", "origin", sha(mergeSha), tip]);
    const commit = await object(mergeSha);
    await git(["merge-base", "--is-ancestor", mergeSha, tip]);
    return { ...commit, target_tip: tip, reachable: true };
  }
  async function issue(number) {
    const data = await api(`/issues/${number}`);
    if (data.number !== number || data.pull_request || typeof data.body !== "string" && data.body !== null || !["open", "closed"].includes(data.state)) fail("delivery_issue_identity_invalid");
    return { number, state: data.state, body: data.body || "", operator_hold: Array.isArray(data.labels) && data.labels.some((label) => ["operator-hold", "operator-gated", "requires-operator-approval"].includes(label?.name)) };
  }
  async function closeIssue(number) { await validate(); await api(`/issues/${number}`, ["--method", "PATCH", "-f", "state=closed"]); }
  return Object.freeze({ setDeadline, validate, branch, base, push, findPulls, readPull, createPull, object, mergedObjects, issue, closeIssue });
}
module.exports = { githubRemote, createDeliveryRemote };

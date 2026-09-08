"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync, execFile } = require("node:child_process");
const runChild = require("node:util").promisify(execFile);
const { createDeliveryRemote, githubRemote } = require("./delivery-remote");
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qw-remote-contract-"));
  const git = (args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git(["init", "-q", "-b", "main"]); git(["config", "user.name", "Delivery Test"]); git(["config", "user.email", "delivery@example.test"]);
    fs.writeFileSync(path.join(directory, "a"), "base\n"); git(["add", "a"]); git(["commit", "-qm", "base"]);
    const base = git(["rev-parse", "HEAD"]), bare = path.join(directory, "remote.git");
    git(["init", "--bare", "-q", bare]); git(["push", "-q", bare, "main"]);
    git(["remote", "add", "origin", "https://github.com/owner/web.git"]);
    const calls = [];
    const pull = { number: 5, node_id: "PR_exact", html_url: "https://github.com/owner/web/pull/5", state: "open", draft: false,
      head: { sha: base, ref: "quadwork/delivery-one", repo: { full_name: "owner/web" } }, base: { sha: base, ref: "main", repo: { full_name: "owner/web" } }, body: "manifest" };
    const remote = createDeliveryRemote({ repository: "Owner/Web", cwd: directory,
      run: async (file, args, options) => {
        calls.push({ file, args: [...args] });
        if (file === "gh") {
          assert.equal(args[0], "api");
          assert.equal(args[args.indexOf("--hostname") + 1], "github.com", "GH_HOST cannot redirect the canonical GitHub target");
          if (args[1] === "repos/owner/web") return { stdout: JSON.stringify({ full_name: "owner/web", default_branch: "main" }) };
          return { stdout: JSON.stringify(args[1].includes("?state=all") ? [pull] : pull) };
        }
        // Local bare Git is an injected test transport, never a product target.
        const testArgs = args.map((value) => ["ls-remote", "push", "fetch"].includes(args[0]) && value === "origin" ? bare : value);
        return runChild(file, testArgs, options);
      },
    });
    assert.equal(githubRemote(bare), null); assert.equal(githubRemote("https://user:secret@github.com/owner/web.git"), null);
    assert.equal(await remote.validate(), "owner/web"); assert.deepEqual(await remote.base(), { branch: "main", sha: base });
    await remote.push("quadwork/delivery-one", base); assert.equal(await remote.branch("quadwork/delivery-one"), base);
    const sent = calls.find((c) => c.args[0] === "push");
    assert.deepEqual(sent.args.slice(0, 3), ["push", "--force-with-lease=refs/heads/quadwork/delivery-one:", "origin"]);
    assert.equal((await remote.createPull({ branch: "quadwork/delivery-one", base_branch: "main", title: "bounded", body: "manifest" })).number, 5);
    assert.equal((await remote.findPulls("quadwork/delivery-one")).length, 1);
    fs.writeFileSync(path.join(directory, "a"), "new\n"); git(["add", "a"]); git(["commit", "-qm", "new"]); const next = git(["rev-parse", "HEAD"]);
    await assert.rejects(() => remote.push("quadwork/delivery-one", next), (e) => e.code === "delivery_remote_read_or_write_unknown");
    assert.equal(await remote.branch("quadwork/delivery-one"), base, "create-only push never replaced the raced branch");
    for (const [key, value] of [["remote.origin.pushurl", "https://github.com/owner/other.git"], ["url.ssh://elsewhere/.insteadOf", "https://github.com/"], ["remote.origin.push", "HEAD:main"]]) {
      git(["config", key, value]);
      await assert.rejects(() => remote.validate(), (e) => e.code === "delivery_remote_target_ambiguous");
      git(["config", "--unset", key]);
    }
    git(["config", "--add", "remote.origin.url", "https://github.com/owner/other.git"]);
    await assert.rejects(() => remote.validate(), (e) => e.code === "delivery_remote_target_ambiguous");
    assert.equal(calls.some((call) => call.args.some((arg) => /actions\/|check-runs|workflow/.test(arg))), false);
    console.log("PASS canonical effective remote, create-only real Git update, fixed non-draft PR and ambiguous-target refusal");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

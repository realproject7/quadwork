// #342 / quadwork#342: unit test for the identity-aware prompt
// builder. No test runner is wired up in this repo, so this file
// is a plain node:assert script — run it with `node server/queue-watcher.test.js`
// and it exits non-zero on any failure.

const assert = require("node:assert/strict");
const { buildInjectionPrompt } = require("./queue-watcher");

const DEFAULT_AGENT_SLUGS = ["dev", "head", "reviewer1", "reviewer2"];

// 1) Channel prompt — each of the 4 default slugs must:
//    - name the agent with @<slug>
//    - pass sender: "<slug>" explicitly
//    - tell the agent to look for @<slug> mentions (NOT @claude)
for (const slug of DEFAULT_AGENT_SLUGS) {
  const p = buildInjectionPrompt(slug, { channel: "general" });
  assert.match(p, new RegExp(`You are @${slug} `), `channel: names @${slug}`);
  assert.match(p, new RegExp(`sender: "${slug}"`), `channel: sender string for ${slug}`);
  assert.match(p, new RegExp(`@${slug} mentions`), `channel: @${slug} mention filter`);
  assert.match(p, /NOT @claude/, `channel: explicit NOT @claude guard for ${slug}`);
  assert.match(p, /#general/, `channel: channel name for ${slug}`);
}

// 2) Channel defaults to "general" when not provided.
{
  const p = buildInjectionPrompt("dev", {});
  assert.match(p, /#general/, "channel defaults to general");
}

// 3) Non-default channel is passed through.
{
  const p = buildInjectionPrompt("dev", { channel: "batch-33" });
  assert.match(p, /#batch-33/, "custom channel is used");
}

// 4) Job-thread prompt — each slug must:
//    - name the agent with @<slug>
//    - reference the job_id
//    - pass sender: "<slug>" explicitly
for (const slug of DEFAULT_AGENT_SLUGS) {
  const p = buildInjectionPrompt(slug, { jobId: "42" });
  assert.match(p, new RegExp(`You are @${slug} `), `job: names @${slug}`);
  assert.match(p, /job_id=42/, `job: job_id for ${slug}`);
  assert.match(p, new RegExp(`sender: "${slug}"`), `job: sender string for ${slug}`);
}

// 5) customPrompt wins over channel and jobId and is returned as-is.
{
  const p = buildInjectionPrompt("dev", {
    channel: "general",
    jobId: "99",
    customPrompt: "  do the thing  ",
  });
  assert.equal(p, "do the thing", "customPrompt overrides + trims");
}

// 6) Blank customPrompt is ignored (falls through to channel/job path).
{
  const p = buildInjectionPrompt("reviewer2", { customPrompt: "   ", channel: "general" });
  assert.match(p, /You are @reviewer2 /);
  assert.match(p, /#general/);
}

console.log(`queue-watcher.test.js: all assertions passed (${DEFAULT_AGENT_SLUGS.length * 2 + 4} cases)`);

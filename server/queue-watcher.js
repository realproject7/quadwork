/**
 * Per-agent queue watcher (#393 / quadwork#251).
 *
 * AgentChattr does NOT push chat to agents. When the operator types
 * `@head` in chat, AC writes a job line to `{data_dir}/{name}_queue.jsonl`
 * and walks away. Something on the agent side has to poll that file and
 * inject an `mcp read` prompt into the running CLI's PTY so the agent
 * picks up the chat. Without that injection the agent never responds,
 * even when registration and heartbeats work.
 *
 * Reference: /Users/cho/Projects/agentchattr/wrapper.py lines 438-541
 * (`_queue_watcher`). Polling (not fs.watch) is intentional: matches
 * wrapper.py's behavior and avoids the cross-platform fs.watch
 * footguns.
 *
 * #342 / quadwork#342: the v1 prompt intentionally omitted the
 * identity hints from wrapper.py lines 501-528, which broke
 * Claude Code agent sessions. Claude's default self-concept is
 * `@claude`, so a bare `mcp read #general - you were mentioned`
 * causes chat_read(sender: "claude") and a filter on `@claude`
 * mentions — both wrong when the agent is actually @dev /
 * @reviewerN. Codex doesn't trip the same way because its init
 * path already claims identity. The fix here is to scope the
 * wrapper.py additions to identity only: the injected prompt
 * now explicitly names the agent slug and tells the agent which
 * sender to use on chat_read and which mentions to look for.
 */

const fs = require("fs");
const path = require("path");

const POLL_INTERVAL_MS = 1000;

/**
 * Pure helper: build the injected prompt text for a given agent
 * slug + trigger shape. Exported so it can be unit-tested without
 * a PTY or a filesystem queue. Priority matches the tick() call
 * site below: customPrompt > jobId > channel.
 *
 * agentName is expected to be the registered agent slug such as
 * `dev`, `head`, `re1`, `re2`. The helper does not
 * validate — upstream already controls who may register.
 */
function buildInjectionPrompt(agentName, { channel, jobId, customPrompt } = {}) {
  if (customPrompt && typeof customPrompt === "string" && customPrompt.trim()) {
    // Operator-supplied prompts already control the identity
    // wording; leave them alone.
    return customPrompt.trim();
  }
  if (jobId) {
    return (
      `You are @${agentName} in this AgentChattr instance. ` +
      `mcp read job_id=${jobId} with sender: "${agentName}" — ` +
      `you (@${agentName}) were mentioned in a job thread, take appropriate action.`
    );
  }
  const ch = channel || "general";
  return (
    `You are @${agentName} in this AgentChattr instance. ` +
    `mcp read #${ch} with sender: "${agentName}" — ` +
    `look for @${agentName} mentions (NOT @claude). ` +
    `You were mentioned, take appropriate action.`
  );
}

/**
 * Start polling `{dataDir}/{agentName}_queue.jsonl`. When non-empty,
 * read all lines, truncate the file (atomic-ish claim — same race the
 * Python wrapper accepts), parse each JSON line, build a single
 * injected prompt, and write it into the supplied PTY terminal.
 *
 * Returns an opaque interval handle. Pass it to stopQueueWatcher to
 * cancel; safe to call with null.
 */
function startQueueWatcher(dataDir, agentName, ptyTerm) {
  if (!dataDir || !agentName || !ptyTerm) return null;
  const queueFile = path.join(dataDir, `${agentName}_queue.jsonl`);

  const tick = () => {
    try {
      if (!fs.existsSync(queueFile)) return;
      const stat = fs.statSync(queueFile);
      if (stat.size === 0) return;

      const content = fs.readFileSync(queueFile, "utf-8");
      // Atomic claim: truncate immediately so the next AC write lands
      // in an empty file and we don't double-process the same job on
      // the next tick. There's a small race if AC writes between the
      // read and the truncate; wrapper.py accepts the same race.
      fs.writeFileSync(queueFile, "");

      const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return;

      let channel = "general";
      let customPrompt = "";
      let jobId = null;
      let hasTrigger = false;
      for (const line of lines) {
        let data;
        try {
          data = JSON.parse(line);
        } catch {
          continue;
        }
        hasTrigger = true;
        if (data && typeof data === "object") {
          if (typeof data.channel === "string") channel = data.channel;
          // AgentChattr serializes job_id as an integer (agents.py
          // defines `job_id: int | None`), so accept both numbers and
          // strings here. Without this, job-thread triggers fall back
          // to the channel prompt and the agent reads the wrong
          // conversation. Cast to string for the prompt template.
          if (typeof data.job_id === "number" || typeof data.job_id === "string") {
            jobId = String(data.job_id);
          }
          if (typeof data.prompt === "string" && data.prompt.trim()) {
            customPrompt = data.prompt.trim();
          }
        }
      }
      if (!hasTrigger) return;

      const prompt = buildInjectionPrompt(agentName, { channel, jobId, customPrompt });

      // Flatten newlines: multi-line writes trigger paste detection in
      // Claude Code (shows "[Pasted text +N]") and can break injection
      // of long prompts. Mirrors wrapper.py:532.
      const flat = prompt.replace(/\n/g, " ");
      // Inject text and Enter as SEPARATE writes with a delay between.
      // Codex's TUI does not submit when text + "\r" arrive in one chunk —
      // it needs the text to render, then a separate Enter keystroke.
      // Claude Code accepts either form. Mirrors wrapper_unix.py inject():
      // tmux send-keys -l <text> ; sleep ; tmux send-keys Enter.
      // Delay scales with prompt length so longer prompts get more time
      // to render before submit.
      ptyTerm.write(flat);
      const submitDelayMs = Math.max(300, flat.length);
      setTimeout(() => {
        try { ptyTerm.write("\r"); } catch { /* swallow */ }
      }, submitDelayMs);
    } catch {
      // Swallow — next tick will retry. Logging here would spam the
      // server output once per second on a permission error.
    }
  };

  return setInterval(tick, POLL_INTERVAL_MS);
}

/**
 * Stop a watcher started by startQueueWatcher. Safe to call with null.
 */
function stopQueueWatcher(handle) {
  if (handle) clearInterval(handle);
}

module.exports = {
  startQueueWatcher,
  stopQueueWatcher,
  buildInjectionPrompt,
};

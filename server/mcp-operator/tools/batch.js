"use strict";

// #793: batch-definition tools (Tier 2 — act). Create/replace and append to a
// project's OVERNIGHT-QUEUE.md (the batch the scheduled trigger feeds agents).
// New file under tools/ — additive, auto-merged by #790's loader, no edits to
// existing modules. These WRITE the batch definition; they do NOT start it
// (that's #794).
//
// Queue writes can strand ~/.quadwork/<id>/ state for an unknown id, so every
// tool calls assertKnownProject(project) before any write.

function requireContent(content) {
  if (typeof content !== "string" || content === "") {
    throw new Error("content must be a non-empty string.");
  }
}

module.exports = {
  defs: [
    {
      name: "set_batch",
      description:
        "Replace a project's OVERNIGHT-QUEUE.md with `content` (full overwrite). This defines the batch but does NOT start it. Rejects empty content. Use append_batch to add to an existing queue instead of replacing it.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
          content: { type: "string", description: "Full markdown content for OVERNIGHT-QUEUE.md." },
        },
        required: ["project", "content"],
      },
    },
    {
      name: "append_batch",
      description:
        "Append `content` to the end of a project's OVERNIGHT-QUEUE.md (read-then-write; creates the queue from scratch if absent). Does NOT start the batch. LOST-UPDATE CAVEAT: the read→write is not atomic and is not locked — if you (or the dashboard) edit the queue between this tool's read and write, that edit is overwritten. Re-read the queue (read_queue) before appending if you may have edited it elsewhere.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
          content: { type: "string", description: "Markdown to append after the existing queue content." },
        },
        required: ["project", "content"],
      },
    },
    {
      name: "ensure_batch",
      description:
        "Ensure a project's OVERNIGHT-QUEUE.md exists, creating it from the template if absent (idempotent — never overwrites). Returns { ok, existed }. Useful before the first append_batch.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
        },
        required: ["project"],
      },
    },
  ],

  handlers: {
    set_batch: async (params, ctx) => {
      const { project, content } = params;
      requireContent(content);
      await ctx.assertKnownProject(project);
      await ctx.httpRequest("PUT", `/api/queue?project=${encodeURIComponent(project)}`, { content });
      return { ok: true };
    },

    append_batch: async (params, ctx) => {
      const { project, content } = params;
      requireContent(content);
      await ctx.assertKnownProject(project);
      // No server-side append exists (POST only creates-from-template), so do
      // it MCP-side: read current content, combine, PUT back.
      const current = await ctx.httpRequest("GET", `/api/queue?project=${encodeURIComponent(project)}`);
      const existing = current && typeof current.content === "string" ? current.content : "";
      // Exact combine rule — no stray leading blank line when the queue is empty.
      const base = existing.trimEnd();
      const combined = base ? base + "\n" + content : content;
      await ctx.httpRequest("PUT", `/api/queue?project=${encodeURIComponent(project)}`, { content: combined });
      return { ok: true };
    },

    ensure_batch: async (params, ctx) => {
      const { project } = params;
      await ctx.assertKnownProject(project);
      const res = await ctx.httpRequest("POST", `/api/queue?project=${encodeURIComponent(project)}`);
      return { ok: !!(res && res.ok), existed: !!(res && res.existed) };
    },
  },
};

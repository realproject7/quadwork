"use strict";

// #792: send_message (Tier 2 — act). Lets the operator agent post into a
// project's chat exactly as if the human operator typed it in the dashboard.
// New file under tools/ — additive, auto-merged by #790's loader, no edits to
// existing modules.

module.exports = {
  defs: [
    {
      name: "send_message",
      description:
        'Post a message into a project\'s team chat AS THE OPERATOR (recorded with sender "user"). This is how you direct the agents — e.g. "@head start the batch" wakes Head via the dispatcher. Bare agent names (head/dev/re1/re2) are auto-converted to @mentions server-side, so send raw text. NOTE: posting as the operator RESETS the chat loop guard (#717), exactly as if a human typed it — this is intended; the operator agent acts as the human operator.',
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
          text: { type: "string", description: "Message text. Bare agent names become @mentions automatically." },
        },
        required: ["project", "text"],
      },
    },
  ],

  handlers: {
    send_message: async (params, ctx) => {
      const { project, text } = params;
      // Validate first — an unknown id would otherwise create a stray
      // ~/.quadwork/<id>/chat/ file via appendMessage.
      await ctx.assertKnownProject(project);
      // Deliberately send NO X-Chat-Sender / X-Bridge-Sender header, so
      // /api/chat records the message as sender "user" (the operator).
      const res = await ctx.httpRequest("POST", `/api/chat?project=${encodeURIComponent(project)}`, { text });
      return res && res.message ? res.message : res;
    },
  },
};

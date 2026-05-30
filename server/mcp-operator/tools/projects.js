"use strict";

// #790: tools/projects.js — the FIRST conflict-free tool module. Each module
// under tools/ exports { defs, handlers } and is auto-merged by the loader in
// mcp-operator.js. Later tickets (#791–#795) add a NEW file here; they never
// edit a shared array/switch, which is what makes the parallel batch
// genuinely conflict-free.

module.exports = {
  defs: [
    {
      name: "list_projects",
      description:
        "List the QuadWork projects configured on this machine. Returns id, name and repo for each project. Use the returned ids with the other operator tools.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
  handlers: {
    // Public output is only { id, name, repo } — the internal `agents` id list
    // is a validation aid (assertKnownProject/assertKnownAgent), not
    // operator-facing, so strip it here.
    list_projects: async (_params, ctx) => {
      const projects = await ctx.getConfiguredProjects();
      return projects.map((p) => ({ id: p.id, name: p.name, repo: p.repo }));
    },
  },
};

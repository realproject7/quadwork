"use strict";

const { primaryRepository } = require("../../config");

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
        "List the QuadWork projects configured on this machine. Returns id, name, repositories, and a temporary primary repo alias for each project. Use the returned ids with the other operator tools.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
  handlers: {
    // The internal `agents` id list is a validation aid
    // (assertKnownProject/assertKnownAgent), not operator-facing. The temporary
    // scalar alias is derived from the canonical primary repository at response
    // serialization time and is never read from or written to project config.
    list_projects: async (_params, ctx) => {
      const projects = await ctx.getConfiguredProjects();
      return projects.map((p) => {
        const repositories = Array.isArray(p.repositories) ? p.repositories : [];
        const primary = primaryRepository({ repositories });
        return {
          id: p.id,
          name: p.name,
          repositories,
          repo: primary ? primary.repo : undefined,
        };
      });
    },
  },
};

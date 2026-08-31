"use strict";

// #791: Tier 1 read-only observation tools. A NEW file under tools/ — additive,
// no edits to existing tool modules (the conflict-free structure from #790).
//
// Reads are NOT side-effect-free on unknown projects: GET /api/chat →
// readMessages CREATES ~/.quadwork/<project>/chat/general.jsonl if missing, so
// a bogus id strands state. Every project-scoped tool here calls
// assertKnownProject(project) BEFORE its HTTP call. list_agents validates only
// when `project` is supplied. (httpRequest's timeout/ECONNREFUSED/non-2xx
// mapping comes for free from #790.)

module.exports = {
  defs: [
    {
      name: "read_chat",
      description:
        "Read recent messages from a project's team chat. Returns the message array (id, sender, text, ts as raw ISO, type, channel). Honors since_id / limit for paging.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
          since_id: { type: "number", description: "Only return messages with id greater than this." },
          limit: { type: "number", description: "Max messages to return (default 50)." },
        },
        required: ["project"],
      },
    },
    {
      name: "batch_status",
      description:
        "Get a project's overnight-batch status as { active, progress }, preserving repository-qualified rows and assignment provenance from /api/batch-active and /api/batch-progress without transformation. `active.active` plus matching installation_id, batch_number, opaque assignment_attempt, assignment_key, current, owned, and provenance=owned is the live authority. Each progress row retains separate repo_key, repo, number, kind, a work_item_ref object with those same four fields, the same provenance fields, and an OPEN-only live_pr reference (number, URL, state, tip). Foreign, unowned, legacy_unowned, stale, and sticky completed progress is observational only and never current authority.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
        },
        required: ["project"],
      },
    },
    {
      name: "read_queue",
      description:
        "Read a project's OVERNIGHT-QUEUE.md. Returns { exists, content } where content is the raw markdown (empty string when the file does not exist).",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
        },
        required: ["project"],
      },
    },
    {
      name: "list_agents",
      description:
        "List agents and their state. Returns EVERY configured agent (config ∪ runtime) as { project, agent, state, error } — state is running/stopped/missing, so stopped or untracked agents are included, not just live sessions. Omit `project` to list all projects, or pass one to filter.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Optional project id to filter by (validated when supplied)." },
        },
      },
    },
  ],

  handlers: {
    read_chat: async (params, ctx) => {
      const { project, since_id, limit } = params;
      await ctx.assertKnownProject(project);
      const qs = new URLSearchParams({ project });
      if (since_id != null) qs.set("since_id", String(since_id));
      if (limit != null) qs.set("limit", String(limit));
      return ctx.httpRequest("GET", `/api/chat?${qs.toString()}`);
    },

    batch_status: async (params, ctx) => {
      const { project } = params;
      await ctx.assertKnownProject(project);
      const p = encodeURIComponent(project);
      const [active, progress] = await Promise.all([
        ctx.httpRequest("GET", `/api/batch-active?project=${p}`),
        ctx.httpRequest("GET", `/api/batch-progress?project=${p}`),
      ]);
      return { active, progress };
    },

    read_queue: async (params, ctx) => {
      const { project } = params;
      await ctx.assertKnownProject(project);
      const res = await ctx.httpRequest("GET", `/api/queue?project=${encodeURIComponent(project)}`);
      return { exists: !!(res && res.exists), content: (res && res.content) || "" };
    },

    // Merge configured ∪ runtime — /api/agents alone returns only live
    // agentSessions and misses configured-but-stopped agents. Mirrors the
    // config-first pattern in the reset route (server/index.js).
    list_agents: async (params, ctx) => {
      const { project } = params;
      if (project) await ctx.assertKnownProject(project);
      const configured = await ctx.getConfiguredProjects();
      const runtime = await ctx.httpRequest("GET", "/api/agents");
      const rt = runtime && typeof runtime === "object" ? runtime : {};
      const projects = project ? configured.filter((p) => p.id === project) : configured;

      const result = [];
      for (const p of projects) {
        const ids = new Set(p.agents);
        // Include any live session id under this project not in config (defensive).
        for (const key of Object.keys(rt)) {
          const slash = key.indexOf("/");
          if (slash > 0 && key.slice(0, slash) === p.id) ids.add(key.slice(slash + 1));
        }
        for (const agent of ids) {
          const session = rt[`${p.id}/${agent}`];
          result.push({
            project: p.id,
            agent,
            state: session ? session.state : "missing",
            error: session ? session.error || null : null,
          });
        }
      }
      return result;
    },
  },
};

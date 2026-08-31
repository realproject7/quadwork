"use strict";

// #795: non-destructive agent lifecycle control (Tier 2 — act). start / stop /
// restart / interrupt an individual agent, and interrupt a whole project. New
// file under tools/ — additive, auto-merged by #790's loader, no edits to
// existing modules. Destructive ops (full_reset, reset, raw PTY write) are
// intentionally OUT of scope — the action allow-list keeps those endpoints
// unreachable from this tool.

// The ONLY actions agent_control will route. The path is built from this
// validated value — never from arbitrary input — so `full-reset` / `reset` /
// `write` can't be reached.
const ACTIONS = ["start", "stop", "restart", "interrupt"];
const ACTION_SET = new Set(ACTIONS);

module.exports = {
  defs: [
    {
      name: "agent_control",
      description:
        "Control a single agent lifecycle. start/restart return the server-generated operation and generation lifecycle observation; they do not claim a model turn resumed. A circuit-open recovery must name the currently observed generation and loss correlation. Non-destructive only — reset / full-reset / raw writes are not available here.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project id (from list_projects)." },
          agent: { type: "string", description: "Agent id (head/dev/re1/re2 — from list_agents)." },
          action: { type: "string", enum: ACTIONS, description: "start | stop | restart | interrupt." },
          expected_generation: { type: "string", description: "Required for a circuit-open start/restart trial; obtain from list_agents." },
          loss_correlation: { type: "string", description: "Required for a circuit-open start/restart trial; obtain from list_agents." },
        },
        required: ["project", "agent", "action"],
      },
    },
    {
      name: "interrupt_all",
      description:
        "Send Ctrl+C to EVERY running agent in a project (interrupts what they're doing; does not kill the sessions). Returns { ok, interrupted } — the count of agents interrupted.",
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
    agent_control: async (params, ctx) => {
      const { project, agent, action, expected_generation, loss_correlation } = params;
      // Validate in order, all BEFORE the action HTTP call. The backend does
      // NOT validate the agent (stop returns ok for any string; interrupt only
      // checks runtime sessions), so assertKnownAgent is load-bearing.
      await ctx.assertKnownProject(project);
      await ctx.assertKnownAgent(project, agent);
      if (!ACTION_SET.has(action)) {
        throw new Error(`Invalid action: ${action}. Must be one of: ${ACTIONS.join(", ")}.`);
      }
      // Path built only from the validated allow-list action + encoded params.
      const body = (action === "start" || action === "restart") && (expected_generation || loss_correlation)
        ? {
          ...(typeof expected_generation === "string" ? { expected_generation } : {}),
          ...(typeof loss_correlation === "string" ? { loss_correlation } : {}),
        }
        : undefined;
      return ctx.httpRequest(
        "POST",
        `/api/agents/${encodeURIComponent(project)}/${encodeURIComponent(agent)}/${action}`,
        body,
      );
    },

    interrupt_all: async (params, ctx) => {
      const { project } = params;
      await ctx.assertKnownProject(project);
      return ctx.httpRequest("POST", `/api/agents/${encodeURIComponent(project)}/interrupt-all`);
    },
  },
};

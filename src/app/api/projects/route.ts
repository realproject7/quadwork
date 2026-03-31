import { NextResponse } from "next/server";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

interface ProjectConfig {
  id: string;
  name: string;
  repo: string;
  agents?: Record<string, unknown>;
}

interface ChattrConfig {
  agentchattr_url?: string;
  agentchattr_token?: string;
  projects: ProjectConfig[];
}

function getConfig(): ChattrConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { projects: [] };
  }
}

let activeProjects: Set<string> | null = null;

function fetchActiveSessions(): Set<string> {
  if (activeProjects !== null) return activeProjects;
  activeProjects = new Set();
  try {
    const cfg = getConfig();
    const port = (cfg as unknown as { port?: number }).port || 3001;
    const out = execFileSync("curl", ["-sf", "--max-time", "1", `http://127.0.0.1:${port}/api/sessions`], {
      encoding: "utf-8",
      timeout: 2000,
    });
    const sessions = JSON.parse(out);
    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        if (s.projectId) activeProjects.add(s.projectId);
      }
    }
  } catch {
    // Backend not running — all projects idle
  }
  return activeProjects;
}

function isProjectActive(projectId: string): "active" | "idle" {
  return fetchActiveSessions().has(projectId) ? "active" : "idle";
}

function ghJson(args: string[]): unknown[] {
  try {
    const out = execFileSync("gh", args, { encoding: "utf-8", timeout: 15000 });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface ChatMessage {
  id: number;
  sender: string;
  text: string;
  time: string;
}

async function getChatActivity(cfg: ChattrConfig): Promise<ChatMessage[]> {
  const url = cfg.agentchattr_url || "http://127.0.0.1:8300";
  const token = cfg.agentchattr_token;
  const headers: Record<string, string> = token ? { "x-session-token": token } : {};

  try {
    const res = await fetch(`${url}/api/messages?channel=general&limit=30`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : data.messages || [];
  } catch {
    return [];
  }
}

function getProjectData(repo: string, agents: Record<string, unknown> | undefined) {
  if (!REPO_RE.test(repo)) {
    return { openPrs: 0, lastActivity: null };
  }

  const prs = ghJson(["pr", "list", "-R", repo, "--json", "number", "--limit", "100"]);

  // Get last activity from most recent PR or event
  const recentPrs = ghJson(["pr", "list", "-R", repo, "--state", "all", "--json", "updatedAt", "--limit", "1"]) as { updatedAt: string }[];
  const lastActivity = recentPrs[0]?.updatedAt || null;

  return {
    openPrs: prs.length,
    lastActivity,
  };
}

export async function GET() {
  activeProjects = null; // Reset per-request
  const cfg = getConfig();

  // Fetch chat messages for activity feed (has correct agent names)
  const chatMsgs = await getChatActivity(cfg);

  // Filter for workflow events (PR, merge, push, approve mentions)
  const eventKeywords = /\b(PR|merged|pushed|approved|opened|closed|review|commit)\b/i;
  const workflowMsgs = chatMsgs
    .filter((m) => eventKeywords.test(m.text) && m.sender !== "system")
    .slice(-10)
    .reverse();

  // Build number-to-project mapping for activity attribution (issues + PRs share namespace)
  const numberToProject: Record<number, string> = {};
  const projectResults = cfg.projects.map((p: ProjectConfig) => {
    const data = getProjectData(p.repo, p.agents);
    const hasAgents = p.agents && Object.keys(p.agents).length > 0;

    if (REPO_RE.test(p.repo)) {
      // Map PR numbers to this project
      const allPrs = ghJson(["pr", "list", "-R", p.repo, "--state", "all", "--json", "number", "--limit", "100"]) as { number: number }[];
      for (const pr of allPrs) numberToProject[pr.number] = p.name;

      // Map issue numbers to this project (branch task/N uses issue numbers)
      const allIssues = ghJson(["issue", "list", "-R", p.repo, "--state", "all", "--json", "number", "--limit", "100"]) as { number: number }[];
      for (const issue of allIssues) numberToProject[issue.number] = p.name;
    }

    return {
      id: p.id,
      name: p.name,
      repo: p.repo,
      agentCount: p.agents ? Object.keys(p.agents).length : 0,
      openPrs: data.openPrs,
      state: hasAgents ? isProjectActive(p.id) : "idle",
      lastActivity: data.lastActivity,
    };
  });

  // Build activity feed from chat with correct agent identities
  // Attribution: repo/name match → PR/issue number → branch task/N pattern → single-project fallback
  // Only include events that can be attributed to a project
  const recentEvents: { time: string; text: string; actor: string; projectName: string }[] = [];

  for (const m of workflowMsgs) {
    let projectName = cfg.projects.find((p) => m.text.includes(p.repo) || m.text.includes(p.name))?.name;

    // Try PR/issue number cross-reference
    if (!projectName) {
      const numMatch = m.text.match(/#(\d+)/);
      if (numMatch) {
        projectName = numberToProject[parseInt(numMatch[1], 10)];
      }
    }

    // Try branch name pattern: task/N-slug → extract issue number
    if (!projectName) {
      const branchMatch = m.text.match(/task\/(\d+)/);
      if (branchMatch) {
        projectName = numberToProject[parseInt(branchMatch[1], 10)];
      }
    }

    // Single project fallback
    if (!projectName && cfg.projects.length === 1) {
      projectName = cfg.projects[0].name;
    }

    // Only include attributed events
    if (projectName) {
      recentEvents.push({
        time: m.time,
        text: m.text.length > 120 ? m.text.slice(0, 120) + "…" : m.text,
        actor: m.sender,
        projectName,
      });
    }

    if (recentEvents.length >= 10) break;
  }

  return NextResponse.json({ projects: projectResults, recentEvents });
}

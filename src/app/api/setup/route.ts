import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function exec(cmd: string, args: string[], opts?: { cwd?: string }): { ok: boolean; output: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf-8", timeout: 30000, ...opts });
    return { ok: true, output: out.trim() };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

// POST /api/setup?step=verify-repo|create-worktrees|seed-files|add-config
export async function POST(req: NextRequest) {
  const step = req.nextUrl.searchParams.get("step");
  const body = await req.json().catch(() => ({}));

  switch (step) {
    case "verify-repo":
      return verifyRepo(body.repo);
    case "create-worktrees":
      return createWorktrees(body.workingDir, body.repo);
    case "seed-files":
      return seedFiles(body.workingDir, body.projectName, body.repo);
    case "add-config":
      return addConfig(body);
    default:
      return NextResponse.json({ error: "Unknown step" }, { status: 400 });
  }
}

function verifyRepo(repo: string) {
  if (!repo || !REPO_RE.test(repo)) {
    return NextResponse.json({ ok: false, error: "Invalid repo format (use owner/repo)" });
  }
  const result = exec("gh", ["repo", "view", repo, "--json", "name,owner"]);
  return NextResponse.json({ ok: result.ok, error: result.ok ? undefined : "Cannot access repo. Check gh auth and repo permissions." });
}

function createWorktrees(workingDir: string, repo: string) {
  if (!workingDir) return NextResponse.json({ ok: false, error: "Missing working directory" });

  // Clone if not a git repo
  if (!fs.existsSync(path.join(workingDir, ".git"))) {
    if (!fs.existsSync(workingDir)) {
      fs.mkdirSync(workingDir, { recursive: true });
    }
    if (!REPO_RE.test(repo)) return NextResponse.json({ ok: false, error: "Invalid repo" });
    const clone = exec("gh", ["repo", "clone", repo, workingDir]);
    if (!clone.ok) return NextResponse.json({ ok: false, error: `Clone failed: ${clone.output}` });
  }

  const agents = ["t1", "t2a", "t2b", "t3"];
  const created: string[] = [];
  const errors: string[] = [];

  for (const agent of agents) {
    const wtDir = path.join(workingDir, agent);
    if (fs.existsSync(wtDir)) {
      created.push(`${agent} (exists)`);
      continue;
    }
    const result = exec("git", ["worktree", "add", wtDir, "main"], { cwd: workingDir });
    if (result.ok) {
      created.push(agent);
    } else {
      errors.push(`${agent}: ${result.output}`);
    }
  }

  return NextResponse.json({ ok: errors.length === 0, created, errors });
}

function seedFiles(workingDir: string, projectName: string, repo: string) {
  if (!workingDir) return NextResponse.json({ ok: false, error: "Missing working directory" });

  const agents = ["t1", "t2a", "t2b", "t3"];
  const seeded: string[] = [];

  for (const agent of agents) {
    const wtDir = path.join(workingDir, agent);
    if (!fs.existsSync(wtDir)) continue;

    // AGENTS.md
    const agentsMd = path.join(wtDir, "AGENTS.md");
    if (!fs.existsSync(agentsMd)) {
      fs.writeFileSync(agentsMd, `# ${projectName} — ${agent.toUpperCase()} Agent\n\nRepo: ${repo}\nRole: ${agent === "t1" ? "Owner" : agent.startsWith("t2") ? "Reviewer" : "Builder"}\n`);
      seeded.push(`${agent}/AGENTS.md`);
    }

    // CLAUDE.md
    const claudeMd = path.join(wtDir, "CLAUDE.md");
    if (!fs.existsSync(claudeMd)) {
      fs.writeFileSync(claudeMd, `# ${projectName}\n\nBranch: task/<issue>-<slug>\nCommit: [#<issue>] Short description\nNever push to main.\n`);
      seeded.push(`${agent}/CLAUDE.md`);
    }
  }

  return NextResponse.json({ ok: true, seeded });
}

function addConfig(body: { id: string; name: string; repo: string; workingDir: string; backend: string }) {
  const { id, name, repo, workingDir, backend } = body;

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    cfg = { port: 3001, agentchattr_url: "http://127.0.0.1:8300", projects: [] };
  }

  // Check if project already exists
  if (cfg.projects.some((p: { id: string }) => p.id === id)) {
    return NextResponse.json({ ok: true, message: "Project already in config" });
  }

  const agents: Record<string, { display_name: string; command: string; cwd: string; model: string; agents_md: string }> = {};
  for (const [agentId, role] of [["t1", "opus"], ["t2a", "sonnet"], ["t2b", "sonnet"], ["t3", "sonnet"]]) {
    agents[agentId] = {
      display_name: agentId.toUpperCase(),
      command: backend || "claude",
      cwd: path.join(workingDir, agentId),
      model: role,
      agents_md: "",
    };
  }

  cfg.projects.push({ id, name, repo, working_dir: workingDir, agents });

  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

  return NextResponse.json({ ok: true });
}

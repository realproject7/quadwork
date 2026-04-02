/**
 * Migrated Next.js API routes — now served directly from Express.
 * Routes: config, chat, projects, memory, setup, rename, github/issues, github/prs, telegram
 */
const express = require("express");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const router = express.Router();

const CONFIG_DIR = path.join(os.homedir(), ".quadwork");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const ENV_PATH = path.join(CONFIG_DIR, ".env");
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

const DEFAULT_CONFIG = {
  port: 8400,
  agentchattr_url: "http://127.0.0.1:8300",
  projects: [],
};

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfigFile(cfg) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ─── Config ────────────────────────────────────────────────────────────────

router.get("/api/config", (_req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    res.json(JSON.parse(raw));
  } catch (err) {
    if (err.code === "ENOENT") return res.json(DEFAULT_CONFIG);
    res.status(500).json({ error: "Failed to read config", detail: err.message });
  }
});

router.put("/api/config", (req, res) => {
  try {
    const body = req.body;
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(body, null, 2));
    // Trigger sync is handled internally since we're in the same process now
    if (typeof req.app.get("syncTriggers") === "function") {
      req.app.get("syncTriggers")();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to write config", detail: err.message });
  }
});

// ─── Chat (AgentChattr proxy) ──────────────────────────────────────────────

function getChattrConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return {
      url: cfg.agentchattr_url || "http://127.0.0.1:8300",
      token: cfg.agentchattr_token || null,
    };
  } catch {
    return { url: "http://127.0.0.1:8300", token: null };
  }
}

function chatAuthHeaders(token) {
  if (!token) return {};
  return { "x-session-token": token };
}

router.get("/api/chat", async (req, res) => {
  const apiPath = req.query.path || "/api/messages";
  const { url: base, token } = getChattrConfig();

  const fwd = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== "path") fwd.set(k, String(v));
  }
  if (token) fwd.set("token", token);

  const url = `${base}${apiPath}?${fwd.toString()}`;
  try {
    const r = await fetch(url, { headers: chatAuthHeaders(token) });
    if (!r.ok) return res.status(r.status).json({ error: `AgentChattr returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "AgentChattr unreachable", detail: err.message });
  }
});

router.post("/api/chat", async (req, res) => {
  const { url: base, token } = getChattrConfig();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
  try {
    const r = await fetch(`${base}/api/send${tokenParam}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...chatAuthHeaders(token) },
      body: JSON.stringify(req.body),
    });
    if (!r.ok) return res.status(r.status).json({ error: `AgentChattr returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "AgentChattr unreachable", detail: err.message });
  }
});

// ─── Projects (dashboard aggregation) ──────────────────────────────────────

function ghJson(args) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf-8", timeout: 15000 });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

router.get("/api/projects", async (req, res) => {
  const cfg = readConfigFile();
  const chattrUrl = cfg.agentchattr_url || "http://127.0.0.1:8300";
  const chattrToken = cfg.agentchattr_token;

  // Fetch active sessions from our own in-memory state (only running PTYs)
  const activeSessions = req.app.get("activeSessions") || new Map();
  const activeProjectIds = new Set();
  for (const [, info] of activeSessions) {
    if (info.projectId && info.state === "running") activeProjectIds.add(info.projectId);
  }

  // Fetch chat messages
  let chatMsgs = [];
  try {
    const headers = chattrToken ? { "x-session-token": chattrToken } : {};
    const r = await fetch(`${chattrUrl}/api/messages?channel=general&limit=30`, { headers });
    if (r.ok) {
      const data = await r.json();
      chatMsgs = Array.isArray(data) ? data : data.messages || [];
    }
  } catch {}

  const eventKeywords = /\b(PR|merged|pushed|approved|opened|closed|review|commit)\b/i;
  const workflowMsgs = chatMsgs
    .filter((m) => eventKeywords.test(m.text) && m.sender !== "system")
    .slice(-10)
    .reverse();

  const numberToProject = {};
  const projectResults = (cfg.projects || []).map((p) => {
    let openPrs = 0;
    let lastActivity = null;

    if (REPO_RE.test(p.repo)) {
      const prs = ghJson(["pr", "list", "-R", p.repo, "--json", "number", "--limit", "100"]);
      openPrs = prs.length;

      const recentPrs = ghJson(["pr", "list", "-R", p.repo, "--state", "all", "--json", "updatedAt", "--limit", "1"]);
      lastActivity = recentPrs[0]?.updatedAt || null;

      const allPrs = ghJson(["pr", "list", "-R", p.repo, "--state", "all", "--json", "number", "--limit", "100"]);
      for (const pr of allPrs) numberToProject[pr.number] = p.name;
      const allIssues = ghJson(["issue", "list", "-R", p.repo, "--state", "all", "--json", "number", "--limit", "100"]);
      for (const issue of allIssues) numberToProject[issue.number] = p.name;
    }

    const hasAgents = p.agents && Object.keys(p.agents).length > 0;
    return {
      id: p.id,
      name: p.name,
      repo: p.repo,
      agentCount: p.agents ? Object.keys(p.agents).length : 0,
      openPrs,
      state: hasAgents && activeProjectIds.has(p.id) ? "active" : "idle",
      lastActivity,
    };
  });

  // Build activity feed
  const recentEvents = [];
  for (const m of workflowMsgs) {
    let projectName = (cfg.projects || []).find((p) => m.text.includes(p.repo) || m.text.includes(p.name))?.name;
    if (!projectName) {
      const numMatch = m.text.match(/#(\d+)/);
      if (numMatch) projectName = numberToProject[parseInt(numMatch[1], 10)];
    }
    if (!projectName) {
      const branchMatch = m.text.match(/task\/(\d+)/);
      if (branchMatch) projectName = numberToProject[parseInt(branchMatch[1], 10)];
    }
    if (!projectName && cfg.projects && cfg.projects.length === 1) {
      projectName = cfg.projects[0].name;
    }
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

  res.json({ projects: projectResults, recentEvents });
});

// ─── GitHub Issues / PRs ───────────────────────────────────────────────────

function getRepo(projectId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const project = cfg.projects?.find((p) => p.id === projectId);
    const repo = project?.repo;
    if (repo && REPO_RE.test(repo)) return repo;
    return null;
  } catch {
    return null;
  }
}

router.get("/api/github/issues", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });

  try {
    const out = execFileSync(
      "gh",
      ["issue", "list", "-R", repo, "--json", "number,title,state,assignees,labels,createdAt,url", "--limit", "50"],
      { encoding: "utf-8", timeout: 15000 }
    );
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(502).json({ error: "gh issue list failed", detail: err.message });
  }
});

router.get("/api/github/prs", (req, res) => {
  const repo = getRepo(req.query.project || "");
  if (!repo) return res.status(400).json({ error: "No repo configured for project" });

  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "-R", repo, "--json", "number,title,state,author,assignees,reviewDecision,reviews,statusCheckRollup,url,createdAt", "--limit", "50"],
      { encoding: "utf-8", timeout: 15000 }
    );
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(502).json({ error: "gh pr list failed", detail: err.message });
  }
});

// ─── Memory ────────────────────────────────────────────────────────────────

function getProject(projectId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return cfg.projects?.find((p) => p.id === projectId) || null;
  } catch {
    return null;
  }
}

function getMemoryPaths(project) {
  const workDir = project.working_dir || "";
  return {
    cardsDir: project.memory_cards_dir || path.join(workDir, "..", "agent-memory", "archive", "v2", "cards"),
    sharedMemoryPath: project.shared_memory_path || path.join(workDir, "..", "agent-memory", "central", "short-term", "agent-os.md"),
    butlerDir: project.butler_scripts_dir || path.join(workDir, "..", "agent-memory", "scripts"),
  };
}

function findMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findMdFiles(full));
    else if (entry.name.endsWith(".md")) results.push(full);
  }
  return results;
}

function parseFrontmatter(content) {
  const fm = {};
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return fm;
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (val.startsWith("[") && val.endsWith("]")) val = val.slice(1, -1).trim();
      fm[key] = val;
    }
  }
  return fm;
}

router.get("/api/memory", (req, res) => {
  const projectId = req.query.project || "";
  const action = req.query.action || "cards";
  const project = getProject(projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const paths = getMemoryPaths(project);

  if (action === "cards") {
    const search = req.query.search || "";
    try {
      const files = findMdFiles(paths.cardsDir);
      const cards = files.map((fullPath) => {
        const content = fs.readFileSync(fullPath, "utf-8");
        const fm = parseFrontmatter(content);
        const relPath = path.relative(paths.cardsDir, fullPath);
        const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
        const firstLine = body.split("\n")[0]?.replace(/^#\s*/, "").trim();
        return {
          file: relPath,
          title: firstLine || fm.id || path.basename(fullPath, ".md"),
          date: fm.at || "",
          agent: fm.by || "",
          tags: fm.tags || "",
          content: body,
        };
      });
      cards.sort((a, b) => b.date.localeCompare(a.date));
      if (search) {
        const q = search.toLowerCase();
        return res.json(cards.filter((c) =>
          c.title.toLowerCase().includes(q) || c.agent.toLowerCase().includes(q) || c.tags.toLowerCase().includes(q) || c.content.toLowerCase().includes(q)
        ));
      }
      return res.json(cards);
    } catch {
      return res.json([]);
    }
  }

  if (action === "status") {
    const agents = project.agents || {};
    const status = {};
    for (const [id, agent] of Object.entries(agents)) {
      const targetPath = path.join(agent.cwd || "", "shared-memory.md");
      if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        status[id] = { injected: true, lastModified: stat.mtime.toISOString() };
      } else {
        status[id] = { injected: false, lastModified: null };
      }
    }
    const sourceExists = fs.existsSync(paths.sharedMemoryPath);
    return res.json({ agents: status, sourceExists });
  }

  if (action === "shared-memory") {
    try {
      const content = fs.readFileSync(paths.sharedMemoryPath, "utf-8");
      return res.json({ content, path: paths.sharedMemoryPath });
    } catch {
      return res.json({ content: "", path: paths.sharedMemoryPath });
    }
  }

  if (action === "settings") {
    return res.json({
      memory_cards_dir: project.memory_cards_dir || "",
      shared_memory_path: project.shared_memory_path || "",
      butler_scripts_dir: project.butler_scripts_dir || "",
    });
  }

  res.status(400).json({ error: "Unknown action" });
});

router.post("/api/memory", (req, res) => {
  const projectId = req.query.project || "";
  const action = req.query.action || "";
  const project = getProject(projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const paths = getMemoryPaths(project);

  if (action === "butler") {
    const allowed = ["butler-scan.sh", "butler-consolidate.sh", "inject.sh"];
    const command = req.body.command;
    if (!allowed.includes(command)) return res.json({ ok: false, error: `Unknown command: ${command}` });
    const scriptPath = path.join(paths.butlerDir, command);
    if (!fs.existsSync(scriptPath)) return res.json({ ok: false, error: `Script not found: ${scriptPath}` });
    try {
      const output = execFileSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 30000,
        cwd: path.dirname(paths.butlerDir),
      });
      return res.json({ ok: true, output });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  }

  if (action === "save-memory") {
    try {
      const dir = path.dirname(paths.sharedMemoryPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(paths.sharedMemoryPath, req.body.content);
      return res.json({ ok: true });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  }

  if (action === "save-settings") {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      const proj = cfg.projects?.find((p) => p.id === projectId);
      if (!proj) return res.json({ ok: false, error: "Project not found" });
      const s = req.body;
      if (s.memory_cards_dir !== undefined) proj.memory_cards_dir = s.memory_cards_dir || undefined;
      if (s.shared_memory_path !== undefined) proj.shared_memory_path = s.shared_memory_path || undefined;
      if (s.butler_scripts_dir !== undefined) proj.butler_scripts_dir = s.butler_scripts_dir || undefined;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      return res.json({ ok: true });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  }

  res.status(400).json({ error: "Unknown action" });
});

// ─── Setup ─────────────────────────────────────────────────────────────────

function exec(cmd, args, opts) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf-8", timeout: 30000, ...opts });
    return { ok: true, output: out.trim() };
  } catch (err) {
    return { ok: false, output: err.message };
  }
}

router.post("/api/setup", (req, res) => {
  const step = req.query.step;
  const body = req.body || {};

  switch (step) {
    case "verify-repo": {
      const repo = body.repo;
      if (!repo || !REPO_RE.test(repo)) return res.json({ ok: false, error: "Invalid repo format (use owner/repo)" });
      const result = exec("gh", ["repo", "view", repo, "--json", "name,owner"]);
      return res.json({ ok: result.ok, error: result.ok ? undefined : "Cannot access repo. Check gh auth and repo permissions." });
    }
    case "create-worktrees": {
      const workingDir = body.workingDir;
      if (!workingDir) return res.json({ ok: false, error: "Missing working directory" });
      if (!fs.existsSync(path.join(workingDir, ".git"))) {
        if (!fs.existsSync(workingDir)) fs.mkdirSync(workingDir, { recursive: true });
        if (!REPO_RE.test(body.repo)) return res.json({ ok: false, error: "Invalid repo" });
        const clone = exec("gh", ["repo", "clone", body.repo, workingDir]);
        if (!clone.ok) return res.json({ ok: false, error: `Clone failed: ${clone.output}` });
      }
      // Sibling dirs: ../projectName-t1/, ../projectName-t2a/, etc. (matches CLI wizard)
      const projectName = path.basename(workingDir);
      const parentDir = path.dirname(workingDir);
      const agents = ["t1", "t2a", "t2b", "t3"];
      const created = [];
      const errors = [];
      for (const agent of agents) {
        const wtDir = path.join(parentDir, `${projectName}-${agent}`);
        if (fs.existsSync(wtDir)) { created.push(`${agent} (exists)`); continue; }
        const branchName = `worktree-${agent}`;
        exec("git", ["branch", branchName, "HEAD"], { cwd: workingDir });
        const result = exec("git", ["worktree", "add", wtDir, branchName], { cwd: workingDir });
        if (result.ok) {
          created.push(agent);
        } else {
          // Fallback: detached worktree
          const result2 = exec("git", ["worktree", "add", "--detach", wtDir, "HEAD"], { cwd: workingDir });
          if (result2.ok) created.push(`${agent} (detached)`);
          else errors.push(`${agent}: ${result.output}`);
        }
      }
      return res.json({ ok: errors.length === 0, created, errors });
    }
    case "seed-files": {
      const workingDir = body.workingDir;
      if (!workingDir) return res.json({ ok: false, error: "Missing working directory" });
      // Use directory basename for sibling paths and template substitution (matches CLI)
      const dirName = path.basename(workingDir);
      const parentDir = path.dirname(workingDir);
      const reviewerUser = body.reviewerUser || "";
      const reviewerTokenPath = body.reviewerTokenPath || path.join(os.homedir(), ".quadwork", "reviewer-token");
      const agents = ["t1", "t2a", "t2b", "t3"];
      const seeded = [];
      for (const agent of agents) {
        // Sibling dir layout (matches CLI wizard)
        const wtDir = path.join(parentDir, `${dirName}-${agent}`);
        if (!fs.existsSync(wtDir)) continue;

        // AGENTS.md — use template with placeholder substitution (matches CLI)
        const agentsMd = path.join(wtDir, "AGENTS.md");
        if (!fs.existsSync(agentsMd)) {
          const seedSrc = path.join(TEMPLATES_DIR, "seeds", `${agent}.AGENTS.md`);
          if (fs.existsSync(seedSrc)) {
            let content = fs.readFileSync(seedSrc, "utf-8");
            content = content.replace(/\{\{reviewer_github_user\}\}/g, reviewerUser);
            content = content.replace(/\{\{reviewer_token_path\}\}/g, reviewerTokenPath);
            fs.writeFileSync(agentsMd, content);
          } else {
            // Fallback stub if template missing
            fs.writeFileSync(agentsMd, `# ${dirName} — ${agent.toUpperCase()} Agent\n\nRepo: ${body.repo}\nRole: ${agent === "t1" ? "Owner" : agent.startsWith("t2") ? "Reviewer" : "Builder"}\n`);
          }
          seeded.push(`${agent}/AGENTS.md`);
        }

        // CLAUDE.md — use template with placeholder substitution (matches CLI)
        const claudeMd = path.join(wtDir, "CLAUDE.md");
        if (!fs.existsSync(claudeMd)) {
          const claudeSrc = path.join(TEMPLATES_DIR, "CLAUDE.md");
          if (fs.existsSync(claudeSrc)) {
            let content = fs.readFileSync(claudeSrc, "utf-8");
            // CLI uses path.basename(workingDir) for {{project_name}}
            content = content.replace(/\{\{project_name\}\}/g, dirName);
            fs.writeFileSync(claudeMd, content);
          } else {
            fs.writeFileSync(claudeMd, `# ${dirName}\n\nBranch: task/<issue>-<slug>\nCommit: [#<issue>] Short description\nNever push to main.\n`);
          }
          seeded.push(`${agent}/CLAUDE.md`);
        }
      }
      return res.json({ ok: true, seeded });
    }
    case "agentchattr-config": {
      const workingDir = body.workingDir;
      if (!workingDir) return res.json({ ok: false, error: "Missing working directory" });
      // Use directory basename for sibling paths, display name for metadata
      const dirName = path.basename(workingDir);
      const displayName = body.projectName || dirName;
      const parentDir = path.dirname(workingDir);
      const tomlPaths = [
        path.join(workingDir, "agentchattr", "config.toml"),
        path.join(parentDir, "agentchattr", "config.toml"),
        path.join(os.homedir(), ".agentchattr", "config.toml"),
      ];
      let tomlPath = tomlPaths.find((p) => fs.existsSync(p));
      const backends = body.backends;
      if (!tomlPath) {
        const dir = path.join(workingDir, "agentchattr");
        fs.mkdirSync(dir, { recursive: true });
        tomlPath = path.join(dir, "config.toml");
        const agents = ["t1", "t2a", "t2b", "t3"];
        const colors = ["#10a37f", "#22c55e", "#f59e0b", "#da7756"];
        const labels = ["Owner", "Reviewer", "Reviewer", "Builder"];
        let content = `[meta]\nname = "${displayName}"\n\n`;
        agents.forEach((agent, i) => {
          const wtDir = path.join(parentDir, `${dirName}-${agent}`);
          content += `[agents.${agent}]\ncommand = "${(backends && backends[agent]) || "claude"}"\ncwd = "${wtDir}"\ncolor = "${colors[i]}"\nlabel = "${agent.toUpperCase()} ${labels[i]}"\nmcp_inject = "flag"\n\n`;
        });
        fs.writeFileSync(tomlPath, content);
      } else {
        let content = fs.readFileSync(tomlPath, "utf-8");
        const agents = ["t1", "t2a", "t2b", "t3"];
        const colors = ["#10a37f", "#22c55e", "#f59e0b", "#da7756"];
        const labels = ["Owner", "Reviewer", "Reviewer", "Builder"];
        agents.forEach((agent, i) => {
          if (!content.includes(`[agents.${agent}]`)) {
            const wtDir = path.join(parentDir, `${dirName}-${agent}`);
            content += `\n[agents.${agent}]\ncommand = "${(backends && backends[agent]) || "claude"}"\ncwd = "${wtDir}"\ncolor = "${colors[i]}"\nlabel = "${agent.toUpperCase()} ${labels[i]}"\nmcp_inject = "flag"\n`;
          }
        });
        fs.writeFileSync(tomlPath, content);
      }
      // Restart AgentChattr so config changes take effect
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        const port = cfg.port || 8400;
        fetch(`http://127.0.0.1:${port}/api/agentchattr/restart`, { method: "POST" }).catch(() => {});
      } catch {}
      return res.json({ ok: true, path: tomlPath });
    }
    case "add-config": {
      const { id, name, repo, workingDir, backends } = body;
      // Use directory basename for sibling paths (matches CLI wizard)
      const dirName = path.basename(workingDir);
      const parentDir = path.dirname(workingDir);
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
      catch { cfg = { port: 8400, agentchattr_url: "http://127.0.0.1:8300", projects: [] }; }
      if (cfg.projects.some((p) => p.id === id)) return res.json({ ok: true, message: "Project already in config" });
      // Match CLI wizard agent structure: { cwd, command }
      const agents = {};
      for (const agentId of ["t1", "t2a", "t2b", "t3"]) {
        agents[agentId] = {
          cwd: path.join(parentDir, `${dirName}-${agentId}`),
          command: (backends && backends[agentId]) || "claude",
        };
      }
      cfg.projects.push({ id, name, repo, working_dir: workingDir, agents });
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      return res.json({ ok: true });
    }
    default:
      return res.status(400).json({ error: "Unknown step" });
  }
});

// ─── Rename ────────────────────────────────────────────────────────────────

function replaceInFile(filePath, oldStr, newStr) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes(oldStr)) return false;
    fs.writeFileSync(filePath, content.replaceAll(oldStr, newStr));
    return true;
  } catch {
    return false;
  }
}

function replaceInFileRegex(filePath, oldStr, newStr) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf-8");
    const escaped = oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");
    if (!regex.test(content)) return false;
    fs.writeFileSync(filePath, content.replace(regex, newStr));
    return true;
  } catch {
    return false;
  }
}

router.post("/api/rename", (req, res) => {
  const { type, projectId, oldName, newName, agentId } = req.body;
  const cfg = readConfigFile();
  const project = cfg.projects?.find((p) => p.id === projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const changes = [];
  const workDir = project.working_dir || "";

  if (type === "project") {
    project.name = newName;
    changes.push("config.json");
    if (project.trigger_message && project.trigger_message.includes(oldName)) {
      project.trigger_message = project.trigger_message.replaceAll(oldName, newName);
      changes.push("trigger_message");
    }
    if (workDir) {
      const claudeMd = path.join(workDir, "CLAUDE.md");
      if (replaceInFile(claudeMd, oldName, newName)) changes.push("CLAUDE.md");
    }
  }

  if (type === "agent" && agentId) {
    const agent = project.agents?.[agentId];
    if (agent) {
      const oldDisplayName = oldName || agent.display_name || agentId.toUpperCase();
      agent.display_name = newName;
      changes.push("config.json");
      if (agent.agents_md && agent.agents_md.includes(oldDisplayName)) {
        agent.agents_md = agent.agents_md.replaceAll(oldDisplayName, newName);
        changes.push("agents_md");
      }
      if (project.trigger_message) {
        const oldMention = `@${oldDisplayName.toLowerCase()}`;
        const newMention = `@${newName.toLowerCase()}`;
        if (project.trigger_message.includes(oldMention)) {
          project.trigger_message = project.trigger_message.replaceAll(oldMention, newMention);
          changes.push("trigger_message");
        }
      }
      if (workDir) {
        const tomlPaths = [
          path.join(workDir, "agentchattr", "config.toml"),
          path.join(workDir, "..", "agentchattr", "config.toml"),
          path.join(workDir, "config.toml"),
        ];
        for (const tomlPath of tomlPaths) {
          if (replaceInFile(tomlPath, `label = "${oldDisplayName}"`, `label = "${newName}"`)) {
            changes.push("agentchattr/config.toml");
            break;
          }
        }
        const claudeMd = path.join(workDir, "CLAUDE.md");
        if (replaceInFileRegex(claudeMd, oldDisplayName, newName)) changes.push("CLAUDE.md");
      }
      if (agent.cwd) {
        const agentsMd = path.join(agent.cwd, "AGENTS.md");
        if (replaceInFile(agentsMd, oldDisplayName, newName)) changes.push("AGENTS.md");
      }
    }
  }

  writeConfigFile(cfg);

  // Sync triggers internally
  if (typeof req.app.get("syncTriggers") === "function") {
    req.app.get("syncTriggers")();
  }

  res.json({ ok: true, changes });
});

// ─── Telegram ──────────────────────────────────────────────────────────────

const BRIDGE_DIR = path.join(CONFIG_DIR, "agentchattr-telegram");

function telegramPidFile(projectId) {
  return path.join(CONFIG_DIR, `telegram-bridge-${projectId}.pid`);
}

function telegramConfigToml(projectId) {
  return path.join(CONFIG_DIR, `telegram-${projectId}.toml`);
}

function isTelegramRunning(projectId) {
  const pf = telegramPidFile(projectId);
  if (!fs.existsSync(pf)) return false;
  const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    fs.unlinkSync(pf);
    return false;
  }
}

function readEnvToken(key) {
  try {
    const content = fs.readFileSync(ENV_PATH, "utf-8");
    const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

function writeEnvToken(key, value) {
  let content = "";
  try { content = fs.readFileSync(ENV_PATH, "utf-8"); } catch {}
  const regex = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) content = content.replace(regex, line);
  else content = content.trimEnd() + (content ? "\n" : "") + line + "\n";
  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
}

function resolveToken(value) {
  if (value.startsWith("env:")) return readEnvToken(value.slice(4)) || "";
  return value;
}

function envKeyForProject(projectId) {
  return `TELEGRAM_BOT_TOKEN_${projectId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function getProjectTelegram(projectId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const project = cfg.projects?.find((p) => p.id === projectId);
    if (!project?.telegram) return null;
    return {
      bot_token: resolveToken(project.telegram.bot_token || ""),
      chat_id: project.telegram.chat_id || "",
      agentchattr_url: cfg.agentchattr_url || "http://127.0.0.1:8300",
    };
  } catch {
    return null;
  }
}

router.get("/api/telegram", (req, res) => {
  const projectId = req.query.project || "";
  if (!projectId) return res.status(400).json({ error: "Missing project" });
  res.json({ running: isTelegramRunning(projectId) });
});

router.post("/api/telegram", async (req, res) => {
  const action = req.query.action;
  const body = req.body || {};

  switch (action) {
    case "test": {
      const { bot_token, chat_id } = body;
      if (!bot_token || !chat_id) return res.json({ ok: false, error: "Missing bot_token or chat_id" });
      const resolved = resolveToken(bot_token);
      if (!resolved) return res.json({ ok: false, error: "Could not resolve bot token from environment" });
      try {
        const r = await fetch(`https://api.telegram.org/bot${resolved}/getChat?chat_id=${chat_id}`);
        const data = await r.json();
        return res.json({ ok: data.ok, error: data.ok ? undefined : data.description });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Connection failed" });
      }
    }
    case "install": {
      try {
        if (!fs.existsSync(BRIDGE_DIR)) {
          execFileSync("gh", ["repo", "clone", "realproject7/agentchattr-telegram", BRIDGE_DIR], { encoding: "utf-8", timeout: 30000 });
        }
        execFileSync("pip3", ["install", "-r", path.join(BRIDGE_DIR, "requirements.txt")], { encoding: "utf-8", timeout: 30000 });
        return res.json({ ok: true });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Install failed" });
      }
    }
    case "start": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      if (isTelegramRunning(projectId)) return res.json({ ok: true, running: true, message: "Already running" });
      const bridgeScript = path.join(BRIDGE_DIR, "telegram_bridge.py");
      if (!fs.existsSync(bridgeScript)) return res.json({ ok: false, error: "Bridge not installed. Click Install Bridge first." });
      const tg = getProjectTelegram(projectId);
      if (!tg || !tg.bot_token || !tg.chat_id) return res.json({ ok: false, error: "Save bot_token and chat_id in project settings first." });
      const tomlPath = telegramConfigToml(projectId);
      const tomlContent = `[telegram]\nbot_token = "${tg.bot_token}"\nchat_id = "${tg.chat_id}"\n\n[agentchattr]\nurl = "${tg.agentchattr_url}"\n`;
      fs.writeFileSync(tomlPath, tomlContent, { mode: 0o600 });
      fs.chmodSync(tomlPath, 0o600);
      try {
        const child = spawn("python3", [bridgeScript, "--config", tomlPath], { detached: true, stdio: "ignore" });
        child.unref();
        if (child.pid) fs.writeFileSync(telegramPidFile(projectId), String(child.pid));
        return res.json({ ok: true, running: true, pid: child.pid });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Start failed" });
      }
    }
    case "stop": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      try {
        const pf = telegramPidFile(projectId);
        if (fs.existsSync(pf)) {
          const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
          if (pid) process.kill(pid, "SIGTERM");
          fs.unlinkSync(pf);
        }
        return res.json({ ok: true, running: false });
      } catch (err) {
        return res.json({ ok: false, error: err.message || "Stop failed" });
      }
    }
    case "status":
      return res.json({ running: isTelegramRunning(body.project_id || "") });
    case "save-token": {
      const projectId = body.project_id;
      if (!projectId) return res.json({ ok: false, error: "Missing project_id" });
      const envKey = envKeyForProject(projectId);
      writeEnvToken(envKey, body.bot_token);
      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = JSON.parse(raw);
        const project = cfg.projects?.find((p) => p.id === projectId);
        if (project?.telegram) {
          project.telegram.bot_token = `env:${envKey}`;
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
        }
      } catch {}
      return res.json({ ok: true, env_key: envKey });
    }
    default:
      return res.status(400).json({ error: "Unknown action" });
  }
});

module.exports = router;

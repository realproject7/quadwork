import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

function getProject(projectId: string) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return cfg.projects?.find((p: { id: string }) => p.id === projectId) || null;
  } catch {
    return null;
  }
}

function getMemoryPaths(project: { working_dir: string; memory_cards_dir?: string; shared_memory_path?: string; butler_scripts_dir?: string }) {
  const workDir = project.working_dir || "";
  return {
    cardsDir: project.memory_cards_dir || path.join(workDir, "..", "agent-memory", "cards"),
    sharedMemoryPath: project.shared_memory_path || path.join(workDir, "..", "agent-memory", "shared-memory.md"),
    butlerDir: project.butler_scripts_dir || path.join(workDir, "..", "agent-memory", "bin"),
  };
}

// GET /api/memory?project=X&action=cards|status|shared-memory|settings
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project") || "";
  const action = req.nextUrl.searchParams.get("action") || "cards";
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const paths = getMemoryPaths(project);

  if (action === "cards") {
    return listCards(paths.cardsDir, req.nextUrl.searchParams.get("search") || "");
  }
  if (action === "status") {
    return injectionStatus(project, paths.sharedMemoryPath);
  }
  if (action === "shared-memory") {
    return readSharedMemory(paths.sharedMemoryPath);
  }
  if (action === "settings") {
    return NextResponse.json({
      memory_cards_dir: project.memory_cards_dir || "",
      shared_memory_path: project.shared_memory_path || "",
      butler_scripts_dir: project.butler_scripts_dir || "",
    });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// POST /api/memory?project=X&action=butler|save-memory|save-settings
export async function POST(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project") || "";
  const action = req.nextUrl.searchParams.get("action") || "";
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const paths = getMemoryPaths(project);

  if (action === "butler") {
    const body = await req.json();
    return runButler(paths.butlerDir, body.command);
  }
  if (action === "save-memory") {
    const body = await req.json();
    return saveSharedMemory(paths.sharedMemoryPath, body.content);
  }
  if (action === "save-settings") {
    const body = await req.json();
    return saveSettings(projectId, body);
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

function listCards(cardsDir: string, search: string) {
  try {
    if (!fs.existsSync(cardsDir)) return NextResponse.json([]);
    const files = fs.readdirSync(cardsDir).filter((f) => f.endsWith(".md"));
    const cards = files.map((f) => {
      const content = fs.readFileSync(path.join(cardsDir, f), "utf-8");
      const lines = content.split("\n");
      const title = lines.find((l) => l.startsWith("# "))?.replace("# ", "") || f;
      const dateLine = lines.find((l) => /date:|created:/i.test(l));
      const agentLine = lines.find((l) => /agent:|source:/i.test(l));
      const tagLine = lines.find((l) => /tags:/i.test(l));
      return {
        file: f,
        title,
        date: dateLine?.split(":").slice(1).join(":").trim() || "",
        agent: agentLine?.split(":").slice(1).join(":").trim() || "",
        tags: tagLine?.split(":").slice(1).join(":").trim() || "",
        content,
      };
    });
    if (search) {
      const q = search.toLowerCase();
      return NextResponse.json(cards.filter((c) =>
        c.title.toLowerCase().includes(q) || c.agent.toLowerCase().includes(q) || c.tags.toLowerCase().includes(q) || c.content.toLowerCase().includes(q)
      ));
    }
    return NextResponse.json(cards);
  } catch {
    return NextResponse.json([]);
  }
}

function injectionStatus(project: { agents?: Record<string, { cwd: string }> }, sharedMemoryPath: string) {
  const agents = project.agents || {};
  const status: Record<string, { injected: boolean; lastModified: string | null }> = {};
  for (const [id, agent] of Object.entries(agents)) {
    const targetPath = path.join(agent.cwd || "", "shared-memory.md");
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      status[id] = { injected: true, lastModified: stat.mtime.toISOString() };
    } else {
      status[id] = { injected: false, lastModified: null };
    }
  }
  const sourceExists = fs.existsSync(sharedMemoryPath);
  return NextResponse.json({ agents: status, sourceExists });
}

function readSharedMemory(sharedMemoryPath: string) {
  try {
    const content = fs.readFileSync(sharedMemoryPath, "utf-8");
    return NextResponse.json({ content, path: sharedMemoryPath });
  } catch {
    return NextResponse.json({ content: "", path: sharedMemoryPath });
  }
}

function saveSharedMemory(sharedMemoryPath: string, content: string) {
  try {
    const dir = path.dirname(sharedMemoryPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sharedMemoryPath, content);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function saveSettings(projectId: string, settings: { memory_cards_dir?: string; shared_memory_path?: string; butler_scripts_dir?: string }) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const project = cfg.projects?.find((p: { id: string }) => p.id === projectId);
    if (!project) return NextResponse.json({ ok: false, error: "Project not found" });
    if (settings.memory_cards_dir !== undefined) project.memory_cards_dir = settings.memory_cards_dir || undefined;
    if (settings.shared_memory_path !== undefined) project.shared_memory_path = settings.shared_memory_path || undefined;
    if (settings.butler_scripts_dir !== undefined) project.butler_scripts_dir = settings.butler_scripts_dir || undefined;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function runButler(butlerDir: string, command: string) {
  const allowed = ["butler-scan.sh", "butler-consolidate.sh", "inject.sh"];
  if (!allowed.includes(command)) {
    return NextResponse.json({ ok: false, error: `Unknown command: ${command}` });
  }
  const scriptPath = path.join(butlerDir, command);
  if (!fs.existsSync(scriptPath)) {
    return NextResponse.json({ ok: false, error: `Script not found: ${scriptPath}` });
  }
  try {
    const output = execFileSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 30000,
      cwd: path.dirname(butlerDir),
    });
    return NextResponse.json({ ok: true, output });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

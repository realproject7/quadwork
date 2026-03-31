import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { projects: [] };
  }
}

function writeConfig(cfg: unknown) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function replaceInFile(filePath: string, oldStr: string, newStr: string): boolean {
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

// POST /api/rename — propagate name changes
export async function POST(req: NextRequest) {
  const { type, projectId, oldName, newName, agentId } = await req.json();
  const cfg = readConfig();
  const project = cfg.projects?.find((p: { id: string }) => p.id === projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const changes: string[] = [];
  const workDir = project.working_dir || "";

  if (type === "project") {
    project.name = newName;
    changes.push("config.json");

    if (project.trigger_message && project.trigger_message.includes(oldName)) {
      project.trigger_message = project.trigger_message.replaceAll(oldName, newName);
      changes.push("trigger_message");
    }

    // Propagate to CLAUDE.md in working directory
    if (workDir) {
      const claudeMd = path.join(workDir, "CLAUDE.md");
      if (replaceInFile(claudeMd, oldName, newName)) changes.push("CLAUDE.md");
    }
  }

  if (type === "agent" && agentId) {
    const agent = project.agents?.[agentId];
    if (agent) {
      const oldDisplayName = agent.display_name || agentId.toUpperCase();
      agent.display_name = newName;
      changes.push("config.json");

      // Update AGENTS.md seed
      if (agent.agents_md && agent.agents_md.includes(oldDisplayName)) {
        agent.agents_md = agent.agents_md.replaceAll(oldDisplayName, newName);
        changes.push("agents_md");
      }

      // Update trigger message @mentions
      if (project.trigger_message) {
        const oldMention = `@${oldDisplayName.toLowerCase()}`;
        const newMention = `@${newName.toLowerCase()}`;
        if (project.trigger_message.includes(oldMention)) {
          project.trigger_message = project.trigger_message.replaceAll(oldMention, newMention);
          changes.push("trigger_message");
        }
      }

      // Propagate to AgentChattr config.toml (in working_dir or parent agentchattr dir)
      // AgentChattr config.toml has [agents.X] sections with label = "Display Name"
      if (workDir) {
        // Try common AgentChattr config.toml locations
        const tomlPaths = [
          path.join(workDir, "agentchattr", "config.toml"),
          path.join(workDir, "..", "agentchattr", "config.toml"),
          path.join(workDir, "config.toml"),
        ];
        for (const tomlPath of tomlPaths) {
          if (replaceInFile(tomlPath, `label = "${oldDisplayName}`, `label = "${newName}`)) {
            changes.push("agentchattr/config.toml");
            break;
          }
        }
      }

      // Propagate to CLAUDE.md in working directory
      if (workDir) {
        const claudeMd = path.join(workDir, "CLAUDE.md");
        if (replaceInFile(claudeMd, oldDisplayName, newName)) changes.push("CLAUDE.md");
      }

      // Propagate to AGENTS.md files in agent worktree cwds
      if (agent.cwd) {
        const agentsMd = path.join(agent.cwd, "AGENTS.md");
        if (replaceInFile(agentsMd, oldDisplayName, newName)) changes.push("AGENTS.md");
      }
    }
  }

  writeConfig(cfg);

  // Notify backend to sync triggers
  const port = cfg.port || 3001;
  fetch(`http://127.0.0.1:${port}/api/triggers/sync`, { method: "POST" }).catch(() => {});

  return NextResponse.json({ ok: true, changes });
}

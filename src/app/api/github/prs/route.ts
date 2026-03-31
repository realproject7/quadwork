import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".quadwork", "config.json");
const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function getRepo(projectId: string): string | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const project = cfg.projects?.find((p: { id: string }) => p.id === projectId);
    const repo = project?.repo;
    if (repo && REPO_RE.test(repo)) return repo;
    return null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("project") || "";
  const repo = getRepo(projectId);

  if (!repo) {
    return NextResponse.json({ error: "No repo configured for project" }, { status: 400 });
  }

  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "-R", repo, "--json", "number,title,state,author,assignees,reviews,statusCheckRollup,url,createdAt", "--limit", "50"],
      { encoding: "utf-8", timeout: 15000 }
    );
    return NextResponse.json(JSON.parse(out));
  } catch (err) {
    return NextResponse.json(
      { error: "gh pr list failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}

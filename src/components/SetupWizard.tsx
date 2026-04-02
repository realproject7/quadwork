"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type StepStatus = "pending" | "active" | "done" | "error" | "skipped";

interface Step {
  id: string;
  label: string;
  status: StepStatus;
  error?: string;
  optional?: boolean;
}

const INITIAL_STEPS: Step[] = [
  { id: "name", label: "Project Name", status: "active" },
  { id: "repo", label: "GitHub Repo", status: "pending" },
  { id: "protection", label: "Branch Protection", status: "pending", optional: true },
  { id: "backend", label: "CLI Backend", status: "pending" },
  { id: "workdir", label: "Working Directory", status: "pending" },
  { id: "worktrees", label: "Worktree Setup", status: "pending" },
  { id: "seeds", label: "Seed Files", status: "pending" },
  { id: "agentchattr", label: "AgentChattr Config", status: "pending", optional: true },
  { id: "config", label: "Save Config", status: "pending" },
];

const BACKENDS: { value: string; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

export default function SetupWizard() {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [currentStep, setCurrentStep] = useState(0);

  // Form state
  const [projectName, setProjectName] = useState("");
  const [repo, setRepo] = useState("");
  // Per-project AgentChattr config (populated by agentchattr-config step)
  const [chattrConfig, setChattrConfig] = useState<{ agentchattr_token?: string; agentchattr_port?: number; mcp_http_port?: number; mcp_sse_port?: number }>({});
  const [backends, setBackends] = useState<Record<string, string>>({
    head: "claude", reviewer1: "claude", reviewer2: "claude", dev: "claude",
  });
  const [workingDir, setWorkingDir] = useState("");
  const [reviewerUser, setReviewerUser] = useState("");
  const [reviewerTokenPath, setReviewerTokenPath] = useState("");
  const [loading, setLoading] = useState(false);

  // Read default_backend from global config to initialize agent backends
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.ok ? r.json() : null)
      .then((cfg) => {
        const defaultBackend = cfg?.default_backend;
        if (defaultBackend && (defaultBackend === "claude" || defaultBackend === "codex")) {
          setBackends({ head: defaultBackend, reviewer1: defaultBackend, reviewer2: defaultBackend, dev: defaultBackend });
        }
      })
      .catch(() => {});
  }, []);

  const updateStep = (idx: number, updates: Partial<Step>) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...updates } : s)));
  };

  const goNext = () => {
    updateStep(currentStep, { status: "done" });
    const next = currentStep + 1;
    if (next < steps.length) {
      updateStep(next, { status: "active" });
      setCurrentStep(next);
    }
  };

  const skipStep = () => {
    updateStep(currentStep, { status: "skipped" });
    const next = currentStep + 1;
    if (next < steps.length) {
      updateStep(next, { status: "active" });
      setCurrentStep(next);
    }
  };

  const apiCall = async (step: string, body: Record<string, unknown>) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/setup?step=${step}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setLoading(false);
      return data;
    } catch {
      setLoading(false);
      return { ok: false, error: "Request failed" };
    }
  };

  const verifyRepo = async () => {
    const result = await apiCall("verify-repo", { repo });
    if (result.ok) {
      goNext();
    } else {
      updateStep(currentStep, { status: "error", error: result.error });
    }
  };

  const createWorktrees = async () => {
    const result = await apiCall("create-worktrees", { workingDir, repo });
    if (result.ok) {
      goNext();
    } else {
      updateStep(currentStep, { status: "error", error: result.errors?.join(", ") || result.error });
    }
  };

  const seedFiles = async () => {
    const result = await apiCall("seed-files", { workingDir, projectName, repo, reviewerUser, reviewerTokenPath });
    if (result.ok) goNext();
    else updateStep(currentStep, { status: "error", error: result.error });
  };

  const saveConfig = async () => {
    // Use directory basename as project ID (matches CLI wizard)
    const id = workingDir.split("/").pop() || projectName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const result = await apiCall("add-config", { id, name: projectName, repo, workingDir, backends, ...chattrConfig });
    if (result.ok) {
      updateStep(currentStep, { status: "done" });
      setTimeout(() => router.push(`/project/${id}`), 500);
    } else {
      updateStep(currentStep, { status: "error", error: result.error });
    }
  };

  const step = steps[currentStep];

  return (
    <div className="h-full overflow-y-auto p-6 max-w-4xl">
      <h1 className="text-lg font-semibold text-text tracking-tight mb-6">New Project Setup</h1>

      <div className="flex gap-8">
        {/* Step indicator */}
        <div className="w-48 shrink-0">
          {steps.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2 py-1.5">
              <span className={`w-5 h-5 flex items-center justify-center text-[10px] border ${
                s.status === "done" ? "border-accent text-accent" :
                s.status === "error" ? "border-error text-error" :
                s.status === "active" ? "border-accent text-accent bg-accent/10" :
                s.status === "skipped" ? "border-border text-text-muted line-through" :
                "border-border text-text-muted"
              }`}>
                {s.status === "done" ? "✓" : s.status === "error" ? "!" : s.status === "skipped" ? "—" : i + 1}
              </span>
              <span className={`text-[11px] ${
                s.status === "active" ? "text-text font-semibold" :
                s.status === "done" ? "text-accent" :
                "text-text-muted"
              }`}>
                {s.label}
              </span>
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="flex-1 border border-border p-4">
          {step?.id === "name" && (
            <div>
              <h2 className="text-sm font-semibold text-text mb-3">Project Name</h2>
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="My Project"
                className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent mb-3"
              />
              <button onClick={goNext} disabled={!projectName} className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
                Next
              </button>
            </div>
          )}

          {step?.id === "repo" && (
            <div>
              <h2 className="text-sm font-semibold text-text mb-3">GitHub Repository</h2>
              <input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/repo"
                className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent mb-3"
              />
              {step.error && <p className="text-[11px] text-error mb-2">{step.error}</p>}
              <button onClick={verifyRepo} disabled={!repo || loading} className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
                {loading ? "Verifying..." : "Verify & Continue"}
              </button>
            </div>
          )}

          {step?.id === "protection" && (
            <div>
              <h2 className="text-sm font-semibold text-text mb-3">Branch Protection</h2>
              <p className="text-[11px] text-text-muted mb-3">Configure branch protection on <code className="text-accent">main</code>. Run these commands or configure via GitHub UI:</p>
              <div className="border border-border bg-bg-surface p-3 mb-3 text-[11px] space-y-2">
                <div>
                  <p className="text-text-muted mb-1">Enable branch protection via gh CLI:</p>
                  <div className="flex items-center gap-2">
                    <code className="text-accent flex-1 select-all">{`gh api repos/${repo}/branches/main/protection -X PUT -f "required_pull_request_reviews[required_approving_review_count]=1" -f "enforce_admins=false" -f "required_status_checks=null" -f "restrictions=null"`}</code>
                    <button onClick={() => navigator.clipboard.writeText(`gh api repos/${repo}/branches/main/protection -X PUT -f "required_pull_request_reviews[required_approving_review_count]=1" -f "enforce_admins=false" -f "required_status_checks=null" -f "restrictions=null"`)} className="text-[10px] text-text-muted hover:text-accent shrink-0">copy</button>
                  </div>
                </div>
                <div>
                  <p className="text-text-muted mb-1">Or manually in GitHub UI:</p>
                  <div className="flex items-center gap-2">
                    <code className="text-accent flex-1 select-all">{`https://github.com/${repo}/settings/branches`}</code>
                    <button onClick={() => navigator.clipboard.writeText(`https://github.com/${repo}/settings/branches`)} className="text-[10px] text-text-muted hover:text-accent shrink-0">copy</button>
                  </div>
                  <p className="text-text mt-1">→ Add rule for &quot;main&quot; → Require 1 approval → Save</p>
                </div>
                <div>
                  <p className="text-text-muted mb-1">Add reviewer as collaborator (replace USERNAME):</p>
                  <div className="flex items-center gap-2">
                    <code className="text-accent flex-1 select-all">{`gh api repos/${repo}/collaborators/USERNAME -X PUT -f permission=push`}</code>
                    <button onClick={() => navigator.clipboard.writeText(`gh api repos/${repo}/collaborators/USERNAME -X PUT -f permission=push`)} className="text-[10px] text-text-muted hover:text-accent shrink-0">copy</button>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={goNext} className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors">
                  Done
                </button>
                <button onClick={skipStep} className="px-3 py-1.5 text-[12px] text-text-muted border border-border hover:text-text transition-colors">
                  Skip
                </button>
              </div>
            </div>
          )}

          {step?.id === "backend" && (
            <div>
              <h2 className="text-sm font-semibold text-text mb-3">CLI Backend per Agent</h2>
              <div className="border border-border mb-3">
                {["head", "reviewer1", "reviewer2", "dev"].map((agent) => (
                  <div key={agent} className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 last:border-b-0">
                    <span className="text-[11px] text-text font-semibold w-10">{agent.charAt(0).toUpperCase() + agent.slice(1)}</span>
                    <span className="text-[10px] text-text-muted w-16">{agent === "head" ? "Owner" : agent.startsWith("reviewer") ? "Reviewer" : "Builder"}</span>
                    <select
                      value={backends[agent]}
                      onChange={(e) => setBackends({ ...backends, [agent]: e.target.value })}
                      className="bg-transparent border border-border px-2 py-0.5 text-[11px] text-text outline-none focus:border-accent cursor-pointer"
                    >
                      {BACKENDS.map((b) => <option key={b.value} value={b.value} className="bg-bg-surface">{b.label}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <h2 className="text-sm font-semibold text-text mb-2 mt-4">Reviewer Credentials</h2>
              <p className="text-[11px] text-text-muted mb-2">Used by reviewer1/reviewer2 to post GitHub reviews</p>
              <input
                value={reviewerUser}
                onChange={(e) => setReviewerUser(e.target.value)}
                placeholder="Reviewer GitHub username"
                className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent mb-2"
              />
              <input
                value={reviewerTokenPath}
                onChange={(e) => setReviewerTokenPath(e.target.value)}
                placeholder="Token file path (default: ~/.quadwork/reviewer-token)"
                className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent mb-3"
              />
              <button onClick={goNext} className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors">
                Next
              </button>
            </div>
          )}

          {step?.id === "workdir" && (
            <div>
              <h2 className="text-sm font-semibold text-text mb-3">Working Directory</h2>
              <input
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                placeholder="/path/to/project"
                className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent mb-3"
              />
              <button onClick={goNext} disabled={!workingDir} className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
                Next
              </button>
            </div>
          )}

          {step?.id === "worktrees" && (
            <div>
              <h2 className="text-sm font-semibold text-text mb-3">Create Worktrees</h2>
              <p className="text-[11px] text-text-muted mb-3">Creates 4 git worktrees as sibling directories: <code className="text-accent">{workingDir ? `${workingDir.split("/").pop()}-head/` : "project-head/"}</code>, etc.</p>
              {step.error && <p className="text-[11px] text-error mb-2">{step.error}</p>}
              <div className="flex gap-2">
                <button onClick={createWorktrees} disabled={loading} className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
                  {loading ? "Creating..." : "Create Worktrees"}
                </button>
                <button onClick={skipStep} className="px-3 py-1.5 text-[12px] text-text-muted border border-border hover:text-text transition-colors">
                  Skip
                </button>
              </div>
            </div>
          )}

          {step?.id === "seeds" && (
            <div>
              <h2 className="text-sm font-semibold text-text mb-3">Seed Files</h2>
              <p className="text-[11px] text-text-muted mb-3">Creates default AGENTS.md + CLAUDE.md in each worktree</p>
              {step.error && <p className="text-[11px] text-error mb-2">{step.error}</p>}
              <div className="flex gap-2">
                <button onClick={seedFiles} disabled={loading} className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
                  {loading ? "Creating..." : "Create Seed Files"}
                </button>
                <button onClick={skipStep} className="px-3 py-1.5 text-[12px] text-text-muted border border-border hover:text-text transition-colors">
                  Skip
                </button>
              </div>
            </div>
          )}

          {step?.id === "agentchattr" && (
            <div>
              <h2 className="text-sm font-semibold text-text mb-3">AgentChattr Configuration</h2>
              <p className="text-[11px] text-text-muted mb-3">Add agents to AgentChattr config.toml and restart the server.</p>
              {step.error && <p className="text-[11px] text-error mb-2">{step.error}</p>}
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    // Pre-compute available ports for the new project
                    let agentchattr_port = 8300, mcp_http_port = 8200, mcp_sse_port = 8201;
                    try {
                      const cfgRes = await fetch("/api/config");
                      if (cfgRes.ok) {
                        const cfg = await cfgRes.json();
                        const usedChattr = new Set((cfg.projects || []).map((p: { agentchattr_url?: string }) => {
                          try { return parseInt(new URL(p.agentchattr_url || "").port, 10); } catch { return 0; }
                        }).filter(Boolean));
                        const usedMcp = new Set((cfg.projects || []).flatMap((p: { mcp_http_port?: number; mcp_sse_port?: number }) => [p.mcp_http_port, p.mcp_sse_port]).filter(Boolean));
                        while (usedChattr.has(agentchattr_port)) agentchattr_port++;
                        while (usedMcp.has(mcp_http_port)) mcp_http_port++;
                        mcp_sse_port = mcp_http_port + 1;
                        while (usedMcp.has(mcp_sse_port)) mcp_sse_port++;
                      }
                    } catch {}
                    const result = await apiCall("agentchattr-config", { workingDir, projectName, repo, backends, agentchattr_port, mcp_http_port, mcp_sse_port });
                    if (result.ok) {
                      setChattrConfig({ agentchattr_token: result.agentchattr_token, agentchattr_port: result.agentchattr_port, mcp_http_port: result.mcp_http_port, mcp_sse_port: result.mcp_sse_port });
                      goNext();
                    } else updateStep(currentStep, { status: "error", error: result.error });
                  }}
                  disabled={loading}
                  className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50"
                >
                  {loading ? "Updating..." : "Update AgentChattr Config"}
                </button>
                <button onClick={skipStep} className="px-3 py-1.5 text-[12px] text-text-muted border border-border hover:text-text transition-colors">
                  Skip
                </button>
              </div>
            </div>
          )}

          {step?.id === "config" && (
            <div>
              <h2 className="text-sm font-semibold text-text mb-3">Save Configuration</h2>
              <div className="border border-border bg-bg-surface p-3 mb-3 text-[11px] text-text space-y-1">
                <p><strong>Name:</strong> {projectName}</p>
                <p><strong>Repo:</strong> {repo}</p>
                <p><strong>Backends:</strong> {Object.entries(backends).map(([a, b]) => `${a.toUpperCase()}=${b}`).join(", ")}</p>
                <p><strong>Directory:</strong> {workingDir}</p>
                <p><strong>Agents:</strong> Head, Reviewer1, Reviewer2, Dev</p>
              </div>
              {step.error && <p className="text-[11px] text-error mb-2">{step.error}</p>}
              <button onClick={saveConfig} disabled={loading} className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
                {loading ? "Saving..." : "Save & Open Project"}
              </button>
            </div>
          )}

          {currentStep >= steps.length && (
            <div className="text-center py-8">
              <p className="text-accent text-sm font-semibold">Setup complete!</p>
              <p className="text-[11px] text-text-muted mt-2">Redirecting to project dashboard...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

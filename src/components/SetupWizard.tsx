"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

/* ── Types ─────────────────────────────────────────────────────────────── */

type StepStatus = "pending" | "active" | "done" | "error" | "skipped";

interface Step {
  id: string;
  label: string;
  subtitle: string;
  status: StepStatus;
  error?: string;
}

interface Repo {
  name: string;
  description?: string;
  isPrivate?: boolean;
}

/* ── Constants ─────────────────────────────────────────────────────────── */

const INITIAL_STEPS: Step[] = [
  { id: "name", label: "Project Name", subtitle: "Name your project", status: "active" },
  { id: "repo", label: "GitHub Repo", subtitle: "Connect a repository", status: "pending" },
  { id: "models", label: "Agent Models", subtitle: "Configure CLI backends", status: "pending" },
  { id: "workdir", label: "Working Directory", subtitle: "Set the local path", status: "pending" },
  { id: "workspaces", label: "Create Workspaces", subtitle: "Worktrees + seed files", status: "pending" },
  { id: "launch", label: "Ready to Launch", subtitle: "Review & start", status: "pending" },
];

const BACKENDS: { value: string; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

const AGENTS = [
  { key: "head", label: "T1 — Head", role: "Owner / Final Guard", desc: "Merges PRs, makes final calls" },
  { key: "reviewer1", label: "T2a — Reviewer 1", role: "Design Reviewer", desc: "Reviews architecture & design" },
  { key: "reviewer2", label: "T2b — Reviewer 2", role: "Code Reviewer", desc: "Reviews implementation quality" },
  { key: "dev", label: "T3 — Developer", role: "Full-Stack Builder", desc: "Implements features & fixes" },
];

/* ── Component ─────────────────────────────────────────────────────────── */

function WorkdirStep({ repo, workingDir, setWorkingDir, error, onNext }: {
  repo: string; workingDir: string; setWorkingDir: (v: string) => void; error?: string; onNext: () => void;
}) {
  const [detecting, setDetecting] = useState(true);
  const [detected, setDetected] = useState<{ found: boolean; path: string | null; suggested: string } | null>(null);
  const [showManual, setShowManual] = useState(false);
  const slug = repo ? repo.split("/")[1] : "project";

  useEffect(() => {
    if (!repo) { setDetecting(false); return; }
    fetch(`/api/setup/detect-clone?repo=${encodeURIComponent(repo)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        setDetected(data);
        if (data?.found && data.path) setWorkingDir(data.path);
        else if (data?.suggested) setWorkingDir(data.suggested);
        setDetecting(false);
      })
      .catch(() => setDetecting(false));
  }, [repo, setWorkingDir]);

  return (
    <div>
      <h2 className="text-sm font-semibold text-text mb-1">Where is your project?</h2>
      <p className="text-[11px] text-text-muted mb-3">
        Your project&apos;s git repository on your local machine. QuadWork will create 4 agent workspaces next to this directory.
      </p>

      {detecting && <p className="text-[11px] text-text-muted mb-3">Scanning for existing clone...</p>}

      {!detecting && detected?.found && (
        <div className="border border-accent/30 bg-accent/5 p-3 mb-4 text-[11px]">
          <p className="text-accent font-semibold mb-1">Found existing clone</p>
          <p className="text-text font-mono">{detected.path}</p>
          <div className="flex gap-2 mt-2">
            <button onClick={onNext} className="px-3 py-1 bg-accent text-bg text-[11px] font-semibold hover:bg-accent-dim transition-colors">
              Use this
            </button>
            <button onClick={() => { setShowManual(true); setWorkingDir(""); }} className="px-3 py-1 text-[11px] text-text-muted border border-border hover:text-text transition-colors">
              Choose different path
            </button>
          </div>
        </div>
      )}

      {!detecting && !detected?.found && !showManual && (
        <div className="border border-border bg-bg-surface p-3 mb-4 text-[11px]">
          <p className="text-text-muted mb-1">No local clone found for <span className="text-accent">{repo}</span></p>
          <p className="text-text-muted mb-2">Setup will clone it to:</p>
          <p className="text-text font-mono mb-2">{detected?.suggested || `~/Projects/${slug}`}</p>
          <div className="flex gap-2">
            <button onClick={onNext} disabled={!workingDir.trim()} className="px-3 py-1 bg-accent text-bg text-[11px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
              Clone here & continue
            </button>
            <button onClick={() => setShowManual(true)} className="px-3 py-1 text-[11px] text-text-muted border border-border hover:text-text transition-colors">
              Choose different path
            </button>
          </div>
        </div>
      )}

      {(showManual || (!detecting && !detected)) && (
        <>
          <input
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder={`~/Projects/${slug}`}
            className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent mb-2"
          />
          <button onClick={onNext} disabled={!workingDir.trim()} className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50">
            Next
          </button>
        </>
      )}

      {error && <p className="text-[11px] text-error mt-2">{error}</p>}

      <div className="border border-border bg-bg-surface p-3 mt-4 text-[11px] text-text-muted font-mono space-y-0.5">
        <p className="text-[10px] uppercase tracking-wider text-text-muted mb-1 font-sans">Workspace layout</p>
        <p className="text-accent">{slug}/              &larr; your repo</p>
        <p>{slug}-head/         &larr; Head agent</p>
        <p>{slug}-dev/          &larr; Dev agent</p>
        <p>{slug}-reviewer1/    &larr; Reviewer1</p>
        <p>{slug}-reviewer2/    &larr; Reviewer2</p>
      </div>
    </div>
  );
}

export default function SetupWizard() {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [currentStep, setCurrentStep] = useState(0);

  // Form state
  const [projectName, setProjectName] = useState("");
  const [repo, setRepo] = useState("");
  const [repoSearch, setRepoSearch] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoManual, setRepoManual] = useState(false);
  const [ghUser, setGhUser] = useState("");
  const [enableProtection, setEnableProtection] = useState(false);
  const [backends, setBackends] = useState<Record<string, string>>({
    head: "claude", reviewer1: "claude", reviewer2: "claude", dev: "claude",
  });
  const [autoApprove, setAutoApprove] = useState(true);
  const [showReviewerCreds, setShowReviewerCreds] = useState(false);
  const [reviewerUser, setReviewerUser] = useState("");
  const [reviewerTokenMode, setReviewerTokenMode] = useState<"paste" | "file">("paste");
  const [reviewerTokenValue, setReviewerTokenValue] = useState("");
  const [reviewerTokenPath, setReviewerTokenPath] = useState("~/.quadwork/reviewer-token");
  const [workingDir, setWorkingDir] = useState("");
  const [chattrConfig, setChattrConfig] = useState<{ agentchattr_token?: string; agentchattr_port?: number; mcp_http_port?: number; mcp_sse_port?: number }>({});
  const [loading, setLoading] = useState(false);
  const [workspaceLog, setWorkspaceLog] = useState<string[]>([]);
  const [launchStatus, setLaunchStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customPorts, setCustomPorts] = useState({ chattr: 0, mcpHttp: 0, mcpSse: 0 });
  // #419 / quadwork#308: draft-string mirror of customPorts so each
  // field can be cleared and retyped without the onChange
  // `parseInt || 0` clobbering the buffer. Committed on blur.
  const [customPortsDraft, setCustomPortsDraft] = useState({ chattr: "", mcpHttp: "", mcpSse: "" });
  const commitPortDraft = (key: "chattr" | "mcpHttp" | "mcpSse") => {
    const raw = customPortsDraft[key];
    const n = parseInt(raw, 10);
    const clamped = Number.isFinite(n) && n > 0 && n <= 65535 ? n : 0;
    setCustomPorts((prev) => ({ ...prev, [key]: clamped }));
    setCustomPortsDraft((prev) => ({ ...prev, [key]: clamped ? String(clamped) : "" }));
  };
  const [autoDetectedPorts, setAutoDetectedPorts] = useState({ chattr: 0, mcpHttp: 0, mcpSse: 0 });
  const [cliStatus, setCliStatus] = useState<{ claude: boolean; codex: boolean } | null>(null);

  // Fetch CLI status on mount
  useEffect(() => {
    fetch("/api/cli-status")
      .then((r) => r.json())
      .then((status: { claude: boolean; codex: boolean }) => {
        setCliStatus(status);
        // Default all agents to the available CLI when only one is installed
        const availableCli = status.claude && !status.codex ? "claude"
          : !status.claude && status.codex ? "codex"
          : null;
        if (availableCli) {
          setBackends({ head: availableCli, reviewer1: availableCli, reviewer2: availableCli, dev: availableCli });
        } else if (status.claude && status.codex) {
          // Both available — use mixed defaults for review diversity
          setBackends({ head: "codex", dev: "claude", reviewer1: "codex", reviewer2: "claude" });
        }
      })
      .catch(() => {});
  }, []);

  // Fetch GitHub user on mount
  useEffect(() => {
    fetch("/api/github/user")
      .then((r) => r.json())
      .then((d) => { if (d.login) setGhUser(d.login); })
      .catch(() => {});
  }, []);

  // Fetch repos when ghUser is set
  useEffect(() => {
    if (!ghUser) return;
    setReposLoading(true);
    fetch(`/api/github/repos?owner=${encodeURIComponent(ghUser)}`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setRepos(d); })
      .catch(() => {})
      .finally(() => setReposLoading(false));
  }, [ghUser]);

  const updateStep = useCallback((idx: number, updates: Partial<Step>) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...updates } : s)));
  }, []);

  const goNext = useCallback(() => {
    setSteps((prev) => prev.map((s, i) => {
      if (i === currentStep) return { ...s, status: "done" as StepStatus };
      if (i === currentStep + 1) return { ...s, status: "active" as StepStatus };
      return s;
    }));
    setCurrentStep((c) => c + 1);
  }, [currentStep]);

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

  // Step: verify repo
  const verifyRepo = async () => {
    const result = await apiCall("verify-repo", { repo });
    if (result.ok) {
      goNext();
    } else {
      updateStep(currentStep, { status: "error", error: result.error });
    }
  };

  // Step: create workspaces (worktrees + seed files in sequence)
  const createWorkspaces = async () => {
    setLoading(true);
    setWorkspaceLog([]);

    // Save reviewer token first if pasted
    if (showReviewerCreds && reviewerTokenMode === "paste" && reviewerTokenValue) {
      setWorkspaceLog((l) => [...l, "Saving reviewer token..."]);
      try {
        const tokenRes = await fetch("/api/setup/save-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: reviewerTokenValue }),
        });
        const tokenData = await tokenRes.json();
        if (tokenData.ok) {
          setWorkspaceLog((l) => [...l, `Token saved to ${tokenData.path}`]);
        }
      } catch {}
    }

    // 1. Create worktrees
    setWorkspaceLog((l) => [...l, "Creating worktrees..."]);
    const wtResult = await apiCall("create-worktrees", { workingDir, repo });
    if (!wtResult.ok) {
      setWorkspaceLog((l) => [...l, `Error: ${wtResult.errors?.join(", ") || wtResult.error}`]);
      updateStep(currentStep, { status: "error", error: wtResult.errors?.join(", ") || wtResult.error });
      setLoading(false);
      return;
    }
    setWorkspaceLog((l) => [...l, "Worktrees created."]);

    // 2. Seed files
    setWorkspaceLog((l) => [...l, "Writing seed files..."]);
    const effectiveTokenPath = showReviewerCreds
      ? (reviewerTokenMode === "file" ? reviewerTokenPath : "~/.quadwork/reviewer-token")
      : "";
    const seedResult = await apiCall("seed-files", {
      workingDir,
      projectName,
      repo,
      reviewerUser: showReviewerCreds ? reviewerUser : "",
      reviewerTokenPath: effectiveTokenPath,
    });
    if (!seedResult.ok) {
      setWorkspaceLog((l) => [...l, `Error: ${seedResult.error}`]);
      updateStep(currentStep, { status: "error", error: seedResult.error });
      setLoading(false);
      return;
    }
    setWorkspaceLog((l) => [...l, "Seed files written."]);
    setWorkspaceLog((l) => [...l, "Done."]);
    setLoading(false);
    goNext();
  };

  // Step: launch (agentchattr-config + add-config + redirect)
  const launchProject = async () => {
    setLaunchStatus("running");

    // 1. Determine ports: use custom if set, otherwise auto-detect free ports
    let agentchattr_port: number, mcp_http_port: number, mcp_sse_port: number;

    if (showAdvanced && customPorts.chattr > 0) {
      // Validate custom ports against collisions
      agentchattr_port = customPorts.chattr;
      mcp_http_port = customPorts.mcpHttp || customPorts.chattr - 100;
      mcp_sse_port = customPorts.mcpSse || mcp_http_port + 1;
      const portsToCheck = [agentchattr_port, mcp_http_port, mcp_sse_port];
      try {
        const checks = await Promise.all(
          portsToCheck.map((p) => fetch(`/api/port-check?port=${p}`).then((r) => r.json()))
        );
        const busy = checks.filter((c) => !c.free).map((c) => c.port);
        if (busy.length > 0) {
          setLaunchStatus("error");
          updateStep(currentStep, { status: "error", error: `Port${busy.length > 1 ? "s" : ""} ${busy.join(", ")} already in use` });
          return;
        }
      } catch {}
    } else {
      // Auto-detect free ports via server-side check (run inline if not yet ready)
      if (!autoDetectedPorts.chattr) {
        try {
          const chattrRes = await fetch("/api/port-check/auto?start=8300&count=1");
          const chattrData = await chattrRes.json();
          const mcpRes = await fetch("/api/port-check/auto?start=8200&count=2");
          const mcpData = await mcpRes.json();
          agentchattr_port = chattrData.ports?.[0] || 8300;
          mcp_http_port = mcpData.ports?.[0] || 8200;
          mcp_sse_port = mcpData.ports?.[1] || 8201;
        } catch {
          agentchattr_port = 8300;
          mcp_http_port = 8200;
          mcp_sse_port = 8201;
        }
      } else {
        agentchattr_port = autoDetectedPorts.chattr;
        mcp_http_port = autoDetectedPorts.mcpHttp;
        mcp_sse_port = autoDetectedPorts.mcpSse;
      }
    }

    const chattrResult = await apiCall("agentchattr-config", {
      workingDir, projectName, repo, backends,
      agentchattr_port, mcp_http_port, mcp_sse_port,
    });
    if (chattrResult.ok) {
      setChattrConfig({
        agentchattr_token: chattrResult.agentchattr_token,
        agentchattr_port: chattrResult.agentchattr_port,
        mcp_http_port: chattrResult.mcp_http_port,
        mcp_sse_port: chattrResult.mcp_sse_port,
      });
    }

    // 2. Save config
    const id = workingDir.split("/").pop() || projectName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const configResult = await apiCall("add-config", {
      id, name: projectName, repo, workingDir, backends, auto_approve: autoApprove,
      ...(chattrResult.ok ? {
        agentchattr_token: chattrResult.agentchattr_token,
        agentchattr_port: chattrResult.agentchattr_port,
        mcp_http_port: chattrResult.mcp_http_port,
        mcp_sse_port: chattrResult.mcp_sse_port,
      } : chattrConfig),
    });

    if (configResult.ok) {
      setLaunchStatus("done");
      updateStep(currentStep, { status: "done" });
      setTimeout(() => router.push(`/project/${id}`), 1200);
    } else {
      setLaunchStatus("error");
      updateStep(currentStep, { status: "error", error: configResult.error });
    }
  };

  // Auto-detect free ports when reaching the launch step
  useEffect(() => {
    if (steps[currentStep]?.id !== "launch") return;
    (async () => {
      try {
        // Get 1 free port starting from 8300 (chattr)
        const chattrRes = await fetch("/api/port-check/auto?start=8300&count=1");
        const chattrData = await chattrRes.json();
        // Get 2 free ports starting from 8200 (mcp http + sse)
        const mcpRes = await fetch("/api/port-check/auto?start=8200&count=2");
        const mcpData = await mcpRes.json();
        const detected = {
          chattr: chattrData.ports?.[0] || 8300,
          mcpHttp: mcpData.ports?.[0] || 8200,
          mcpSse: mcpData.ports?.[1] || 8201,
        };
        setAutoDetectedPorts(detected);
        if (!customPorts.chattr) {
          setCustomPorts(detected);
          setCustomPortsDraft({
            chattr: detected.chattr ? String(detected.chattr) : "",
            mcpHttp: detected.mcpHttp ? String(detected.mcpHttp) : "",
            mcpSse: detected.mcpSse ? String(detected.mcpSse) : "",
          });
        }
      } catch {}
    })();
  }, [currentStep, steps]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredRepos = repos.filter((r) =>
    r.name.toLowerCase().includes(repoSearch.toLowerCase())
  );

  const step = steps[currentStep];

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-border">
        <h1 className="text-lg font-semibold text-text tracking-tight">
          Set Up Your AI Dev Team
        </h1>
        <p className="text-[11px] text-text-muted mt-1">
          Configure agents, connect your repo, and launch a multi-agent development workflow in minutes.
        </p>
      </div>

      <div className="flex h-[calc(100%-80px)]">
        {/* Left: Steps + Content */}
        <div className="flex-1 flex gap-6 p-6 overflow-y-auto">
          {/* Step sidebar */}
          <div className="w-44 shrink-0">
            {steps.map((s, i) => (
              <div key={s.id} className="flex items-start gap-2 py-2">
                <span className={`w-5 h-5 flex items-center justify-center text-[10px] border shrink-0 mt-0.5 ${
                  s.status === "done" ? "border-accent text-accent" :
                  s.status === "error" ? "border-error text-error" :
                  s.status === "active" ? "border-accent text-accent bg-accent/10" :
                  s.status === "skipped" ? "border-border text-text-muted line-through" :
                  "border-border text-text-muted"
                }`}>
                  {s.status === "done" ? "\u2713" : s.status === "error" ? "!" : i + 1}
                </span>
                <div>
                  <span className={`text-[11px] block leading-tight ${
                    s.status === "active" ? "text-text font-semibold" :
                    s.status === "done" ? "text-accent" :
                    "text-text-muted"
                  }`}>
                    {s.label}
                  </span>
                  <span className="text-[10px] text-text-muted block">{s.subtitle}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Step content */}
          <div className="flex-1 border border-border p-5 min-h-0">
            {/* Step 1: Project Name */}
            {step?.id === "name" && (
              <div>
                <h2 className="text-sm font-semibold text-text mb-1">Name your project</h2>
                <p className="text-[11px] text-text-muted mb-4">
                  This name identifies your project in the dashboard and agent configs.
                </p>
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="e.g. My DeFi App"
                  className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent mb-4"
                  autoFocus
                />
                <button
                  onClick={goNext}
                  disabled={!projectName.trim()}
                  className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            )}

            {/* Step 2: GitHub Repo */}
            {step?.id === "repo" && (
              <div>
                <h2 className="text-sm font-semibold text-text mb-1">Connect a GitHub repository</h2>
                <p className="text-[11px] text-text-muted mb-4">
                  Select an existing repo or enter one manually. Agents will work within this repo.
                </p>

                {!repoManual && (
                  <>
                    {ghUser && (
                      <p className="text-[11px] text-text-muted mb-2">
                        Showing repos for <span className="text-accent">{ghUser}</span>
                      </p>
                    )}
                    <input
                      value={repoSearch}
                      onChange={(e) => setRepoSearch(e.target.value)}
                      placeholder="Search repos..."
                      className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent mb-2"
                    />
                    {reposLoading && <p className="text-[11px] text-text-muted mb-2">Loading...</p>}
                    <div className="max-h-40 overflow-y-auto border border-border mb-3">
                      {filteredRepos.map((r) => (
                        <button
                          key={r.name}
                          onClick={() => setRepo(`${ghUser}/${r.name}`)}
                          className={`w-full text-left px-3 py-1.5 text-[11px] border-b border-border/50 last:border-b-0 hover:bg-accent/5 transition-colors ${
                            repo === `${ghUser}/${r.name}` ? "bg-accent/10 text-accent" : "text-text"
                          }`}
                        >
                          <span className="font-semibold">{r.name}</span>
                          {r.isPrivate && <span className="text-[10px] text-text-muted ml-2">private</span>}
                          {r.description && <span className="text-[10px] text-text-muted ml-2">{r.description}</span>}
                        </button>
                      ))}
                      {!reposLoading && filteredRepos.length === 0 && (
                        <p className="px-3 py-2 text-[11px] text-text-muted">No repos found.</p>
                      )}
                    </div>
                    <button
                      onClick={() => setRepoManual(true)}
                      className="text-[11px] text-text-muted hover:text-accent transition-colors mb-3 block"
                    >
                      Enter manually instead
                    </button>
                  </>
                )}

                {repoManual && (
                  <>
                    <input
                      value={repo}
                      onChange={(e) => setRepo(e.target.value)}
                      placeholder="owner/repo"
                      className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent mb-2"
                    />
                    <button
                      onClick={() => setRepoManual(false)}
                      className="text-[11px] text-text-muted hover:text-accent transition-colors mb-3 block"
                    >
                      Back to repo list
                    </button>
                  </>
                )}

                {/* Branch protection toggle */}
                <label className="flex items-center gap-2 mb-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableProtection}
                    onChange={(e) => setEnableProtection(e.target.checked)}
                    className="accent-accent"
                  />
                  <span className="text-[11px] text-text-muted">
                    Enable branch protection on <code className="text-accent">main</code>
                  </span>
                </label>

                {enableProtection && (
                  <div className="border border-border bg-bg-surface p-3 mb-4 text-[11px] space-y-2">
                    <p className="text-text-muted">Run this after setup, or configure in GitHub UI:</p>
                    <div className="flex items-center gap-2">
                      <code className="text-accent flex-1 select-all text-[10px] break-all">
                        {`gh api repos/${repo || "owner/repo"}/branches/main/protection -X PUT -f "required_pull_request_reviews[required_approving_review_count]=1" -f "enforce_admins=false" -f "required_status_checks=null" -f "restrictions=null"`}
                      </code>
                      <button
                        onClick={() => navigator.clipboard.writeText(`gh api repos/${repo}/branches/main/protection -X PUT -f "required_pull_request_reviews[required_approving_review_count]=1" -f "enforce_admins=false" -f "required_status_checks=null" -f "restrictions=null"`)}
                        className="text-[10px] text-text-muted hover:text-accent shrink-0"
                      >
                        copy
                      </button>
                    </div>
                  </div>
                )}

                {step.error && <p className="text-[11px] text-error mb-2">{step.error}</p>}
                <button
                  onClick={verifyRepo}
                  disabled={!repo || loading}
                  className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50"
                >
                  {loading ? "Verifying..." : "Verify & Continue"}
                </button>
              </div>
            )}

            {/* Step 3: Agent Models */}
            {step?.id === "models" && (
              <div>
                <h2 className="text-sm font-semibold text-text mb-1">Configure agent CLI backends</h2>
                <p className="text-[11px] text-text-muted mb-4">
                  Each agent runs its own CLI instance. Pick the backend for each role.
                </p>

                {/* Single-CLI friendly message */}
                {cliStatus && !cliStatus.claude && cliStatus.codex && (
                  <div className="border border-accent/20 bg-accent/5 p-3 mb-4 text-[11px]">
                    <p className="text-text">You have Codex CLI installed — great! All 4 agents will use Codex.</p>
                    <p className="text-text-muted mt-1.5">
                      Tip: Installing Claude Code too gives your team different AI perspectives,
                      which can improve code review quality. You can add it anytime:
                    </p>
                    <p className="text-accent mt-1 font-mono text-[10px]">npm install -g @anthropic-ai/claude-code</p>
                    <p className="text-text-muted mt-1.5">For now, Codex CLI handles everything perfectly. Let&apos;s continue!</p>
                  </div>
                )}
                {cliStatus && cliStatus.claude && !cliStatus.codex && (
                  <div className="border border-accent/20 bg-accent/5 p-3 mb-4 text-[11px]">
                    <p className="text-text">You have Claude Code installed — great! All 4 agents will use Claude.</p>
                    <p className="text-text-muted mt-1.5">
                      Tip: Installing Codex CLI too gives your team different AI perspectives,
                      which can improve code review quality. You can add it anytime:
                    </p>
                    <p className="text-accent mt-1 font-mono text-[10px]">npm install -g codex</p>
                    <p className="text-text-muted mt-1.5">For now, Claude Code handles everything perfectly. Let&apos;s continue!</p>
                  </div>
                )}

                <div className="border border-border mb-4">
                  {AGENTS.map((agent) => (
                    <div key={agent.key} className="flex items-center justify-between px-3 py-2 border-b border-border/50 last:border-b-0">
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] text-text font-semibold block">{agent.label}</span>
                        <span className="text-[10px] text-text-muted">{agent.desc}</span>
                      </div>
                      <select
                        value={backends[agent.key]}
                        onChange={(e) => setBackends({ ...backends, [agent.key]: e.target.value })}
                        className="bg-transparent border border-border px-2 py-0.5 text-[11px] text-text outline-none focus:border-accent cursor-pointer ml-3"
                      >
                        {BACKENDS.map((b) => (
                          <option
                            key={b.value}
                            value={b.value}
                            className="bg-bg-surface"
                            disabled={cliStatus ? !cliStatus[b.value as keyof typeof cliStatus] : false}
                          >
                            {b.label}{cliStatus && !cliStatus[b.value as keyof typeof cliStatus] ? " (not installed)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>

                {/* Auto-approve toggle */}
                <label className="flex items-center gap-2 mb-3 cursor-pointer" title="Enable permission bypass flags so agents can work autonomously without prompting for approval on every action">
                  <input
                    type="checkbox"
                    checked={autoApprove}
                    onChange={(e) => setAutoApprove(e.target.checked)}
                    className="accent-accent"
                  />
                  <span className="text-[11px] text-text">
                    Auto-approve agent actions
                  </span>
                  <span className="text-[10px] text-text-muted">
                    (required for autonomous work)
                  </span>
                </label>

                {/* Reviewer credentials toggle */}
                <label className="flex items-center gap-2 mb-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showReviewerCreds}
                    onChange={(e) => setShowReviewerCreds(e.target.checked)}
                    className="accent-accent"
                  />
                  <span className="text-[11px] text-text-muted">
                    Configure reviewer credentials (for GitHub PR reviews)
                  </span>
                </label>

                {showReviewerCreds && (
                  <div className="border border-border p-3 mb-4 space-y-3">
                    <div>
                      <label className="text-[11px] text-text-muted block mb-1">Reviewer GitHub username</label>
                      <input
                        value={reviewerUser}
                        onChange={(e) => setReviewerUser(e.target.value)}
                        placeholder="github-username"
                        className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-text-muted block mb-2">Token source</label>
                      <div className="flex gap-4 mb-2">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="tokenMode"
                            checked={reviewerTokenMode === "paste"}
                            onChange={() => setReviewerTokenMode("paste")}
                            className="accent-accent"
                          />
                          <span className="text-[11px] text-text">Paste token</span>
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name="tokenMode"
                            checked={reviewerTokenMode === "file"}
                            onChange={() => setReviewerTokenMode("file")}
                            className="accent-accent"
                          />
                          <span className="text-[11px] text-text">Use existing file</span>
                        </label>
                      </div>
                      {reviewerTokenMode === "paste" ? (
                        <>
                          <input
                            value={reviewerTokenValue}
                            onChange={(e) => setReviewerTokenValue(e.target.value)}
                            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                            type="password"
                            className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
                          />
                          <div className="mt-2 text-[10px] text-text-muted leading-relaxed">
                            <p>Paste a GitHub <span className="text-text">Personal Access Token (classic)</span>.</p>
                            <p className="mt-1">
                              Create one at{" "}
                              <a
                                href="https://github.com/settings/tokens"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent hover:underline"
                              >
                                github.com/settings/tokens
                              </a>
                              {" "}&#8594; Generate new token (classic)
                            </p>
                            <p className="mt-1">
                              Required permission: <span className="text-accent">repo</span> (Full control of private repositories)
                              <br />
                              <span className="text-text-muted">Needed for reading PRs, posting reviews, and approving/requesting changes</span>
                            </p>
                          </div>
                        </>
                      ) : (
                        <>
                          <input
                            value={reviewerTokenPath}
                            onChange={(e) => setReviewerTokenPath(e.target.value)}
                            placeholder="~/.quadwork/reviewer-token"
                            className="w-full bg-transparent border border-border px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
                          />
                          {reviewerTokenPath && !reviewerTokenPath.startsWith("~/.quadwork") && !reviewerTokenPath.startsWith(String.raw`${process.env.HOME}/.quadwork`) && (
                            <p className="text-[10px] text-[#ffcc00] mt-1">
                              This path may be inside a git repository. Consider using the default ~/.quadwork/ location to avoid accidentally committing tokens.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}

                <button
                  onClick={goNext}
                  className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors"
                >
                  Next
                </button>
              </div>
            )}

            {/* Step 4: Working Directory */}
            {step?.id === "workdir" && (
              <WorkdirStep
                repo={repo}
                workingDir={workingDir}
                setWorkingDir={setWorkingDir}
                error={step.error}
                onNext={goNext}
              />
            )}

            {/* Step 5: Create Workspaces */}
            {step?.id === "workspaces" && (
              <div>
                <h2 className="text-sm font-semibold text-text mb-1">Create workspaces</h2>
                <p className="text-[11px] text-text-muted mb-4">
                  This creates git worktrees for each agent and writes seed configuration files (AGENTS.md, CLAUDE.md) into each workspace.
                </p>
                {step.error && <p className="text-[11px] text-error mb-2">{step.error}</p>}
                {workspaceLog.length > 0 && (
                  <div className="border border-border bg-bg-surface p-3 mb-4 text-[11px] text-text-muted space-y-0.5 font-mono">
                    {workspaceLog.map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                )}
                <button
                  onClick={createWorkspaces}
                  disabled={loading}
                  className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50"
                >
                  {loading ? "Creating..." : "Create Worktrees & Seed Files"}
                </button>
              </div>
            )}

            {/* Step 6: Ready to Launch */}
            {step?.id === "launch" && (
              <div>
                <h2 className="text-sm font-semibold text-text mb-1">Ready to launch</h2>
                <p className="text-[11px] text-text-muted mb-4">
                  Everything is configured. Review the summary and launch your AI dev team.
                </p>

                {/* Team roster */}
                <div className="border border-border mb-4">
                  <div className="px-3 py-1.5 border-b border-border bg-bg-surface">
                    <span className="text-[11px] text-text font-semibold">Team Roster</span>
                  </div>
                  {AGENTS.map((agent) => (
                    <div key={agent.key} className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 last:border-b-0">
                      <span className="text-[11px] text-text font-semibold">{agent.label}</span>
                      <span className="text-[10px] text-text-muted">{agent.role}</span>
                      <span className="text-[11px] text-accent">{backends[agent.key] === "claude" ? "Claude Code" : "Codex"}</span>
                    </div>
                  ))}
                </div>

                {/* Advanced: Custom ports */}
                <div className="mb-4">
                  <label className="flex items-center gap-2 cursor-pointer mb-2">
                    <input
                      type="checkbox"
                      checked={showAdvanced}
                      onChange={(e) => setShowAdvanced(e.target.checked)}
                      className="accent-accent"
                    />
                    <span className="text-[11px] text-text-muted">Custom ports</span>
                  </label>
                  {showAdvanced && (
                    <div className="border border-border p-3 space-y-2">
                      <div className="grid grid-cols-3 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-text-muted uppercase tracking-wider">AgentChattr port</label>
                          <input
                            type="number"
                            value={customPortsDraft.chattr}
                            onChange={(e) => setCustomPortsDraft({ ...customPortsDraft, chattr: e.target.value })}
                            onBlur={() => commitPortDraft("chattr")}
                            placeholder={String(autoDetectedPorts.chattr || 8300)}
                            className="bg-transparent border border-border px-2 py-1 text-[11px] text-text outline-none focus:border-accent"
                          />
                          {autoDetectedPorts.chattr > 0 && (
                            <span className="text-[10px] text-text-muted">auto-detected: {autoDetectedPorts.chattr}</span>
                          )}
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-text-muted uppercase tracking-wider">MCP HTTP port</label>
                          <input
                            type="number"
                            value={customPortsDraft.mcpHttp}
                            onChange={(e) => setCustomPortsDraft({ ...customPortsDraft, mcpHttp: e.target.value })}
                            onBlur={() => commitPortDraft("mcpHttp")}
                            placeholder={String(autoDetectedPorts.mcpHttp || 8200)}
                            className="bg-transparent border border-border px-2 py-1 text-[11px] text-text outline-none focus:border-accent"
                          />
                          {autoDetectedPorts.mcpHttp > 0 && (
                            <span className="text-[10px] text-text-muted">auto-detected: {autoDetectedPorts.mcpHttp}</span>
                          )}
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-text-muted uppercase tracking-wider">MCP SSE port</label>
                          <input
                            type="number"
                            value={customPortsDraft.mcpSse}
                            onChange={(e) => setCustomPortsDraft({ ...customPortsDraft, mcpSse: e.target.value })}
                            onBlur={() => commitPortDraft("mcpSse")}
                            placeholder={String(autoDetectedPorts.mcpSse || 8201)}
                            className="bg-transparent border border-border px-2 py-1 text-[11px] text-text outline-none focus:border-accent"
                          />
                          {autoDetectedPorts.mcpSse > 0 && (
                            <span className="text-[10px] text-text-muted">auto-detected: {autoDetectedPorts.mcpSse}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {step.error && <p className="text-[11px] text-error mb-2">{step.error}</p>}
                {launchStatus === "done" && (
                  <p className="text-[11px] text-accent mb-2">Project saved. Redirecting to dashboard...</p>
                )}
                <button
                  onClick={launchProject}
                  disabled={launchStatus === "running" || launchStatus === "done"}
                  className="px-5 py-2 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-50"
                >
                  {launchStatus === "running" ? "Launching..." : launchStatus === "done" ? "Launched!" : "Launch Project"}
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

        {/* Right: Live Preview Panel */}
        <div className="w-64 shrink-0 border-l border-border p-4 overflow-y-auto bg-bg-surface/50">
          <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-3">
            Configuration Preview
          </h3>
          <div className="space-y-3 text-[11px]">
            <div>
              <span className="text-text-muted block mb-0.5">Project</span>
              <span className="text-text">{projectName || "\u2014"}</span>
            </div>
            <div>
              <span className="text-text-muted block mb-0.5">Repository</span>
              <span className="text-text">{repo || "\u2014"}</span>
              {enableProtection && <span className="text-[10px] text-accent block">+ branch protection</span>}
            </div>
            <div>
              <span className="text-text-muted block mb-0.5">Backends</span>
              {Object.entries(backends).map(([agent, backend]) => (
                <div key={agent} className="flex justify-between">
                  <span className="text-text capitalize">{agent}</span>
                  <span className="text-accent">{backend}</span>
                </div>
              ))}
            </div>
            {showReviewerCreds && reviewerUser && (
              <div>
                <span className="text-text-muted block mb-0.5">Reviewer</span>
                <span className="text-text">@{reviewerUser}</span>
              </div>
            )}
            <div>
              <span className="text-text-muted block mb-0.5">Directory</span>
              <span className="text-text font-mono text-[10px]">{workingDir || "\u2014"}</span>
            </div>
            <div>
              <span className="text-text-muted block mb-0.5">Status</span>
              <div className="space-y-0.5">
                {steps.map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5">
                    <span className={`text-[10px] ${
                      s.status === "done" ? "text-accent" :
                      s.status === "error" ? "text-error" :
                      s.status === "active" ? "text-text" :
                      "text-text-muted"
                    }`}>
                      {s.status === "done" ? "\u2713" : s.status === "error" ? "\u2717" : s.status === "active" ? "\u25cf" : "\u25cb"}
                    </span>
                    <span className={`text-[10px] ${s.status === "active" ? "text-text" : "text-text-muted"}`}>
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

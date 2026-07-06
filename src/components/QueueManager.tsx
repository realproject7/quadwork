"use client";

import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { sessionTokenParam, sessionTokenHeaders } from "@/lib/sessionToken";

interface Issue {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
}

interface QueueManagerProps {
  projectId: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function generateTemplate(issues: Issue[], repo: string): string {
  const date = today();
  const lines: string[] = [
    `# Task Queue — ${date}`,
    "",
    `Repo: \`${repo}\``,
    "",
    "## Batch 1",
    "",
  ];

  issues.forEach((issue, i) => {
    lines.push(`${i + 1}. [${repo}#${issue.number}](https://github.com/${repo}/issues/${issue.number}) — ${issue.title} (task/${issue.number}-slug)`);
  });

  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("1. Assign ONE ticket at a time to @dev");
  lines.push("2. Wait for @re1 AND @re2 to both approve before merging");
  lines.push("3. After merge, immediately assign the next ticket");
  lines.push("4. PR titles: [#<issue>] Short description");
  lines.push("5. Branch naming: task/<issue-number>-<slug>");
  lines.push("6. NEVER store keys/secrets");
  lines.push("7. Communicate via project chat by tagging agents");
  lines.push("8. Do NOT push to main — only merge approved PRs");
  lines.push("");

  return lines.join("\n");
}

function generatePrompt(queueContent: string, repo: string): string {
  return `@head Work through this queue top-to-bottom. Assign ONE ticket at a time to
   @dev. After each PR is merged, assign the next ticket immediately.
  All tickets are autonomous — no operator gates.

  IMPORTANT — Repo context:
  - All work is on repo ${repo}.
  - Use -R ${repo} for ALL gh commands (issues, PRs, merges).
  - Branches, PRs, and issues are all on ${repo}.

${queueContent}

  Start now. Assign the first ticket to @dev.`;
}

export default function QueueManager({ projectId }: QueueManagerProps) {
  const [content, setContent] = useState("");
  const [repo, setRepo] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);

  // Fetch repo from config
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.ok ? r.json() : null)
      .then((cfg) => {
        const project = cfg?.projects?.find((p: { id: string }) => p.id === projectId);
        if (project?.repo) setRepo(project.repo);
      })
      .catch(() => {});
  }, [projectId]);

  const generateFromIssues = useCallback(() => {
    fetch(`/api/github/issues?project=${encodeURIComponent(projectId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((issues: Issue[]) => {
        const open = issues.filter((i) => i.state === "OPEN");
        setContent(generateTemplate(open, repo));
      })
      .catch(() => {
        setContent(generateTemplate([], repo));
      });
  }, [projectId, repo]);

  const exportMd = () => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `queue-${today()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const prompt = generatePrompt(content, repo);

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sendToHead = async () => {
    try {
      const cfgRes = await fetch("/api/config");
      if (!cfgRes.ok) throw new Error("config");
      const cfg = await cfgRes.json();

      // #968: auth the PTY-driving calls (WS + writes).
      const auth = await sessionTokenHeaders();
      const tok = await sessionTokenParam();

      // Same-origin: all API calls go to the same host
      let res = await fetch(`/api/agents/${projectId}/head/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ text: prompt + "\n" }),
      });

      // If no session exists, create one and start the Head agent
      if (res.status === 404) {
        const project = cfg.projects?.find((p: { id: string }) => p.id === projectId);
        const headCommand = project?.agents?.head?.command || "claude";

        // Open WebSocket to create PTY session
        // In dev mode, WS connects directly to Express backend since Next.js doesn't proxy WS
        const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const backendPort = cfg.port || 8400;
        const currentPort = parseInt(window.location.port, 10);
        const wsHost = (currentPort && currentPort !== backendPort)
          ? `${window.location.hostname}:${backendPort}`
          : window.location.host;
        const wsUrl = `${wsProto}//${wsHost}/ws/terminal?project=${encodeURIComponent(projectId)}&agent=head${tok ? `&${tok}` : ""}`;
        const ws = new WebSocket(wsUrl);
        try {
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("WebSocket failed"));
            setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
          });

          // #973: poll /api/sessions until the PTY the WS just spawned is
          // registered, instead of a fixed 500ms sleep a slow spawn on a
          // busy event loop could outrun — which would write the head
          // command into a shell that isn't ready yet.
          const sessionReady = await new Promise<boolean>((resolve) => {
            const deadline = Date.now() + 5000;
            const probe = async () => {
              try {
                const sres = await fetch("/api/sessions");
                if (sres.ok) {
                  const list = await sres.json();
                  if (Array.isArray(list) && list.some((s) => s && s.projectId === projectId && s.agentId === "head")) {
                    resolve(true);
                    return;
                  }
                }
              } catch { /* transient — keep probing */ }
              if (Date.now() < deadline) setTimeout(probe, 150);
              else resolve(false);
            };
            probe();
          });
          if (!sessionReady) throw new Error("session did not come up");

          // Start the Head agent CLI in the PTY shell
          await fetch(`/api/agents/${projectId}/head/write`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ text: `${headCommand}\n` }),
          });

          // Wait for the agent CLI to initialize before sending the prompt.
          // There's no liveness signal for CLI readiness (the session is
          // already live), so this stays a short fixed warm-up.
          await new Promise((r) => setTimeout(r, 3000));

          // Now write the queue prompt to the running agent
          res = await fetch(`/api/agents/${projectId}/head/write`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ text: prompt + "\n" }),
          });
        } finally {
          // #973: the bootstrap WS existed only to spawn the PTY; the real
          // Head terminal attaches as its own viewer. Close it so it doesn't
          // leak open for the lifetime of the page. (The server keeps the
          // PTY alive with zero viewers — it's torn down only on stop/reset.)
          try { ws.close(); } catch { /* already closing */ }
        }
      }

      if (res.ok) {
        setSent(true);
        setTimeout(() => setSent(false), 3000);
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`Send failed: ${err.error || res.status}`);
      }
    } catch {
      await copyPrompt();
      alert("Could not reach backend. Prompt copied to clipboard instead.");
    }
  };

  return (
    <div className="h-full flex flex-col p-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold text-text tracking-tight">Task Queue</h1>
          <p className="text-xs text-text-muted mt-0.5">{repo || projectId}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={generateFromIssues}
            className="px-3 py-1.5 text-[12px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
          >
            Generate Template
          </button>
          <button
            onClick={exportMd}
            className="px-3 py-1.5 text-[12px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
          >
            Export .md
          </button>
        </div>
      </div>

      {/* Editor + Preview split */}
      <div className="flex-1 min-h-0 grid grid-cols-2 gap-0 border border-border mb-4">
        {/* Editor */}
        <div className="flex flex-col border-r border-border">
          <div className="px-3 py-1.5 border-b border-border">
            <span className="text-[10px] text-text-muted uppercase tracking-wider">Editor</span>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="# Task Queue&#10;&#10;Paste or generate a queue template..."
            className="flex-1 bg-bg-surface p-3 text-[12px] text-text outline-none resize-none"
          />
        </div>

        {/* Preview */}
        <div className="flex flex-col">
          <div className="px-3 py-1.5 border-b border-border">
            <span className="text-[10px] text-text-muted uppercase tracking-wider">Preview</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 text-[12px] text-text">
            {content ? (
              // react-markdown (no raw-HTML/rehype-raw) renders untrusted GitHub
              // issue titles inertly — javascript: hrefs are stripped and any raw
              // HTML is escaped (#969). Mirrors the safe pattern in
              // OvernightQueueWidget.tsx.
              <div className="text-[12px] text-text
                [&_h1]:text-base [&_h1]:font-bold [&_h1]:text-text [&_h1]:mt-2 [&_h1]:mb-2
                [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-accent [&_h2]:mt-4 [&_h2]:mb-1
                [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-text [&_h3]:mt-3 [&_h3]:mb-1
                [&_p]:my-1.5
                [&_ul]:my-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_ul]:text-text-muted
                [&_ol]:my-1.5 [&_ol]:pl-4 [&_ol]:list-decimal
                [&_li]:my-0.5 [&_strong]:text-text
                [&_code]:text-accent [&_code]:text-[11px] [&_code]:bg-bg [&_code]:px-1
                [&_a]:text-accent [&_a]:hover:underline">
                <ReactMarkdown
                  components={{
                    // Preserve the prior new-tab behavior so clicking a preview
                    // link doesn't navigate away from (and discard) the queue
                    // editor. react-markdown still sanitizes the href.
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop react-markdown's `node` prop; it's not a valid DOM attr
                    a: ({ node, ...props }) => (
                      <a {...props} target="_blank" rel="noopener noreferrer" />
                    ),
                  }}
                >
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <span className="text-text-muted">Preview will appear here...</span>
            )}
          </div>
        </div>
      </div>

      {/* Guide */}
      <div className="mb-4 px-3 py-2 border border-border bg-bg-surface text-[11px] text-text-muted">
        <strong className="text-text">How to use:</strong> Click &quot;Generate Template&quot; to auto-fill from open issues. Edit the queue, organize into batches, then click &quot;Start Queue&quot; to generate and send the Head initiation prompt.
      </div>

      {/* Start Queue */}
      <div className="border border-border">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-[11px] text-text-muted uppercase tracking-wider">Start Queue</span>
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className="text-[10px] text-text-muted hover:text-text transition-colors"
          >
            {showPrompt ? "▾ hide prompt" : "▸ show prompt"}
          </button>
        </div>

        {showPrompt && (
          <div className="px-3 py-2 border-b border-border bg-bg-surface max-h-48 overflow-y-auto">
            <pre className="text-[11px] text-text-muted whitespace-pre-wrap">{prompt}</pre>
          </div>
        )}

        <div className="flex items-center gap-2 px-3 py-3">
          <button
            onClick={sendToHead}
            className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors"
          >
            {sent ? "Sent to Head" : "Send to Head Terminal"}
          </button>
          <button
            onClick={copyPrompt}
            className="px-3 py-1.5 text-[12px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
          >
            {copied ? "Copied" : "Copy Prompt"}
          </button>
        </div>
      </div>
    </div>
  );
}

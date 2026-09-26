"use client";

import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { sessionTokenHeaders } from "@/lib/sessionToken";
import { qualifiedQueueToken, sanitizeRemoteTitle } from "@/lib/batchIdentity";

interface Issue {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
  repo_key: string;
  repo: string;
  url?: string;
}

interface Repository {
  key: string;
  repo: string;
  primary?: boolean;
}

interface QueueManagerProps {
  projectId: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function generateTemplate(issues: Issue[], repositories: Repository[]): string {
  const date = today();
  const lines: string[] = [
    `# Task Queue — ${date}`,
    "",
  ];

  if (repositories.length === 1) {
    lines.push(`Repo: \`${repositories[0].repo}\``);
  } else {
    lines.push("Repositories:");
    for (const repository of repositories) lines.push(`- \`${repository.key}\`: \`${repository.repo}\``);
  }

  lines.push("", "## Active Batch", "", "Batch: 1", "");

  const registered = new Map(repositories.map((repository) => [repository.key, repository.repo]));
  let omitted = 0;
  for (const issue of issues) {
    const token = qualifiedQueueToken(issue);
    if (!token || registered.get(issue.repo_key) !== issue.repo) {
      omitted += 1;
      continue;
    }
    lines.push(`- ${token} ${sanitizeRemoteTitle(issue.title)}`);
  }

  if (issues.length === 0) lines.push("(no open issues)");
  if (omitted > 0) {
    lines.push("", `> ${omitted} issue${omitted === 1 ? " was" : "s were"} omitted because repository identity was missing or unregistered.`);
  }

  lines.push("", "## Holds", "", "(none)");
  lines.push("", "## Backlog", "", "(none)");
  lines.push("", "## Done", "", "(none)");

  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("1. Head reads this file at startup and after every merge, cut, or batch closure.");
  lines.push("2. One Dev build task at a time. Head may assign the next independent task with a");
  lines.push("   disjoint file boundary while RE1 and RE2 review the previous candidate;");
  lines.push("   dependent or overlapping tasks wait.");
  lines.push("3. Merge only after the server's [MERGE GATE DUE] for the exact PR SHA and Head's");
  lines.push("   own live gate. Head never manually fans implementation reviewers.");
  lines.push("4. After a merge or cut, move terminal items to ## Done and assign the next");
  lines.push("   non-conflicting item.");
  lines.push("5. PR titles: [#<issue>] Short description");
  lines.push("6. Branch naming: task/<issue-number>-<slug>");
  lines.push("7. NEVER store keys/secrets");
  lines.push("8. Do NOT push to main — only merge approved PRs");
  lines.push("");

  return lines.join("\n");
}

function generatePrompt(queueContent: string, repositories: Repository[], allowDirectStart: boolean): string {
  const repositoryLines = repositories.length > 0
    ? repositories.map((repository) => `  - ${repository.key}: ${repository.repo}`).join("\n")
    : "  - No registered repository identity was returned; do not guess or mutate a repository.";
  const opening = allowDirectStart
    ? `@head Work through this queue top-to-bottom. Assign ONE ticket at a time to
   @dev. After each PR is merged, assign the next ticket immediately.
  All tickets are autonomous — no operator gates.`
    : `@head Review this queue as a non-executable draft only. Do not assign a worker,
  start a batch, or wake any role from this text. This installation is V2-activated;
  execution requires the server-issued assignment workflow that serializes the
  current installation, batch, qualified item set, and opaque attempt first.`;
  const closing = allowDirectStart
    ? "Start now. Assign the first ticket to @dev."
    : "Report draft corrections only. Do not start or assign this queue.";
  return `${opening}

  IMPORTANT — Repository context:
  - Resolve every qualified work token against this registered map:
${repositoryLines}
  - Use -R with the repository named by each token for ALL gh commands.
  - Never guess primary for an unknown, malformed, or ambiguous token.

${queueContent}

  ${closing}`;
}

export default function QueueManager({ projectId }: QueueManagerProps) {
  const [content, setContent] = useState("");
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [v2Activated, setV2Activated] = useState<boolean | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);

  // Fetch the canonical repository map. Legacy projects may not persist this
  // array yet; their /api/github/issues rows still carry the normalized
  // `primary` binding and hydrate it when Generate Template is clicked.
  useEffect(() => {
    setRepositories([]);
    setV2Activated(null);
    fetch("/api/config")
      .then((r) => r.ok ? r.json() : null)
      .then((cfg) => {
        setV2Activated(typeof cfg?.installation_id === "string" && cfg.installation_id.length > 0);
        const project = cfg?.projects?.find((p: { id: string }) => p.id === projectId);
        const configured = Array.isArray(project?.repositories)
          ? project.repositories.filter((entry: Repository) =>
            typeof entry?.key === "string" && !!entry.key && typeof entry?.repo === "string" && !!entry.repo)
          : [];
        if (configured.length > 0) setRepositories(configured);
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
        let resolvedRepositories = repositories;
        if (resolvedRepositories.length === 0) {
          // Pre-activation compatibility has exactly one normalized binding on
          // the GitHub rows. Never learn a multi-repository topology from row
          // data: activated projects must use the locked config map above.
          const candidates = new Map<string, Repository>();
          let conflictingBinding = false;
          for (const issue of open) {
            if (typeof issue.repo_key !== "string" || !issue.repo_key || typeof issue.repo !== "string" || !issue.repo) continue;
            const existing = candidates.get(issue.repo_key);
            if (existing && existing.repo !== issue.repo) conflictingBinding = true;
            else candidates.set(issue.repo_key, { key: issue.repo_key, repo: issue.repo, primary: true });
          }
          if (!conflictingBinding && candidates.size === 1) resolvedRepositories = [...candidates.values()];
        }
        setRepositories(resolvedRepositories);
        setContent(generateTemplate(open, resolvedRepositories));
      })
      .catch(() => {
        setContent(generateTemplate([], repositories));
      });
  }, [projectId, repositories]);

  const exportMd = () => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `queue-${today()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const directStartBlocked = v2Activated !== false;
  const prompt = generatePrompt(content, repositories, !directStartBlocked);

  const copyPrompt = async () => {
    try {
      const cfgRes = await fetch("/api/config");
      if (!cfgRes.ok) throw new Error("config");
      const cfg = await cfgRes.json();
      const activated = typeof cfg?.installation_id === "string" && cfg.installation_id.length > 0;
      setV2Activated(activated);
      await navigator.clipboard.writeText(generatePrompt(content, repositories, !activated));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      alert("Could not verify assignment authority. Nothing was copied.");
    }
  };

  const sendToHead = async () => {
    try {
      const cfgRes = await fetch("/api/config");
      if (!cfgRes.ok) throw new Error("config");
      const cfg = await cfgRes.json();
      const activated = typeof cfg?.installation_id === "string" && cfg.installation_id.length > 0;
      setV2Activated(activated);
      if (activated) {
        alert("V2 setup is active. Start this queue through the server-issued assignment workflow; no Head session was started or written.");
        return;
      }

      // Authenticate the prompt write to the existing Head session.
      const auth = await sessionTokenHeaders();

      // Same-origin: all API calls go to the same host
      const res = await fetch(`/api/agents/${encodeURIComponent(projectId)}/head/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ text: prompt + "\n" }),
      });

      if (res.status === 404) {
        alert("Head is stopped. Start Head from the project terminal controls, then retry Send to Head.");
        return;
      }

      if (res.ok) {
        setSent(true);
        setTimeout(() => setSent(false), 3000);
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`Send failed: ${err.error || res.status}`);
      }
    } catch {
      alert("Could not verify assignment authority. Nothing was sent or copied.");
    }
  };

  return (
    <div className="h-full flex flex-col p-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold text-text tracking-tight">Task Queue</h1>
          <p className="text-xs text-text-muted mt-0.5">
            {repositories.length > 0 ? repositories.map((repository) => repository.repo).join(" · ") : projectId}
          </p>
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
        <strong className="text-text">How to use:</strong> Click &quot;Generate Template&quot; to auto-fill from open issues. Edit the queue and organize it into batches. {directStartBlocked ? "This V2 queue is a draft until the server-issued assignment workflow starts it." : "Then click Start Queue to generate and send the Head initiation prompt."}
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
            disabled={directStartBlocked}
            title={directStartBlocked ? "V2 execution requires a server-issued assignment" : undefined}
            className="px-4 py-1.5 bg-accent text-bg text-[12px] font-semibold hover:bg-accent-dim transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent"
          >
            {directStartBlocked ? "Server Assignment Required" : sent ? "Sent to Head" : "Send to Head Terminal"}
          </button>
          <button
            onClick={copyPrompt}
            className="px-3 py-1.5 text-[12px] border border-border text-text-muted hover:text-text hover:border-accent transition-colors"
          >
            {copied ? "Copied" : "Copy Prompt"}
          </button>
          {directStartBlocked && (
            <span role="status" className="text-[11px] text-text-muted">
              Direct Head wake is disabled; copy produces a review-only draft.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

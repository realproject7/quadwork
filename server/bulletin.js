/**
 * Bulletin Board — inter-project communication (#471).
 *
 * Stores posts as markdown in ~/.quadwork/bulletin/YYYY-MM.md with
 * a JSON counter file (index.json) for sequential post IDs per project.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const BULLETIN_DIR = path.join(os.homedir(), ".quadwork", "bulletin");
const INDEX_PATH = path.join(BULLETIN_DIR, "index.json");

/** Ensure the bulletin directory exists. */
function ensureDir() {
  if (!fs.existsSync(BULLETIN_DIR)) fs.mkdirSync(BULLETIN_DIR, { recursive: true });
}

/** Two-letter uppercase prefix from project ID (e.g. "quadwork" → "QW"). */
function projectPrefix(projectId) {
  const clean = projectId.replace(/[^a-zA-Z0-9]/g, "");
  if (clean.length === 0) return "XX";
  if (clean.length === 1) return clean.toUpperCase().padEnd(2, "X");
  return clean.slice(0, 2).toUpperCase();
}

/** Current month key: "YYYY-MM". */
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Read the counter index. Returns { [projectId]: number }. */
function readIndex() {
  ensureDir();
  if (!fs.existsSync(INDEX_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")); } catch { return {}; }
}

/** Increment counter for a project, return the new number. */
function nextCounter(projectId) {
  const idx = readIndex();
  const n = (idx[projectId] || 0) + 1;
  idx[projectId] = n;
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2));
  return n;
}

/** Generate a post ID like "QW-0042". */
function generatePostId(projectId) {
  const n = nextCounter(projectId);
  return `${projectPrefix(projectId)}-${String(n).padStart(4, "0")}`;
}

/** Path to a monthly bulletin file. */
function monthFilePath(month) {
  return path.join(BULLETIN_DIR, `${month}.md`);
}

/** Format a date as "YYYY-MM-DD HH:MM". */
function formatDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Append a new post to the current month's bulletin file.
 * Returns the generated post ID.
 */
function createPost({ from_project, from_agent, to_project, content, status }) {
  ensureDir();
  const postId = generatePostId(from_project);
  const now = formatDate(new Date());
  const month = currentMonth();
  const filePath = monthFilePath(month);

  // Escape bare "---" lines in content so they don't corrupt the
  // post delimiter when the file is parsed back.
  const safeContent = content.replace(/^---$/gm, "\\-\\-\\-");

  const block = [
    "---",
    `## [${postId}] ${from_project} → ${to_project} | ${now}`,
    `From: ${from_agent}@${from_project}`,
    `To: ${to_project}`,
    `Status: ${status || "open"}`,
    "",
    safeContent,
    "",
    "---",
    "",
  ].join("\n");

  fs.appendFileSync(filePath, block);
  return { post_id: postId, month };
}

/**
 * Append a reply to an existing post. Searches all monthly files
 * starting from the most recent.
 */
function addReply(postId, { from_project, from_agent, content }) {
  ensureDir();
  const files = bulletinFiles();
  for (const f of files) {
    const text = fs.readFileSync(f, "utf-8");
    const marker = `## [${postId}]`;
    const idx = text.indexOf(marker);
    if (idx === -1) continue;

    // Find the closing "---" after this post
    const closingIdx = text.indexOf("\n---", idx + marker.length);
    if (closingIdx === -1) continue;

    const now = formatDate(new Date());
    const replyBlock = `\n> **Reply** ${from_agent}@${from_project} | ${now}\n> ${content.replace(/\n/g, "\n> ")}\n`;

    const updated = text.slice(0, closingIdx) + replyBlock + text.slice(closingIdx);
    fs.writeFileSync(f, updated);
    return true;
  }
  return false;
}

/**
 * Update the status of a post (open → closed or vice versa).
 */
function updateStatus(postId, newStatus) {
  ensureDir();
  const files = bulletinFiles();
  for (const f of files) {
    const text = fs.readFileSync(f, "utf-8");
    const marker = `## [${postId}]`;
    if (!text.includes(marker)) continue;

    const updated = text.replace(
      new RegExp(`(## \\[${postId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*?Status: )\\w+`),
      `$1${newStatus}`
    );
    if (updated !== text) {
      fs.writeFileSync(f, updated);
      return true;
    }
  }
  return false;
}

/** List all bulletin files sorted newest first. */
function bulletinFiles() {
  ensureDir();
  return fs.readdirSync(BULLETIN_DIR)
    .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .map((f) => path.join(BULLETIN_DIR, f));
}

/**
 * Parse a single post block into a structured object.
 * Input: the text between two "---" delimiters (inclusive of header).
 */
function parsePost(block) {
  const headerMatch = block.match(/## \[([A-Z]{2}-\d{4})\] (\S+) → (\S+) \| (.+)/);
  if (!headerMatch) return null;
  const [, id, from_project, to_project, date] = headerMatch;

  const fromMatch = block.match(/From: (.+)/);
  const statusMatch = block.match(/Status: (\w+)/);
  const from_agent = fromMatch ? fromMatch[1] : "";

  // Extract content: everything between the Status line and replies/closing
  const statusEnd = block.indexOf("\n", block.indexOf("Status:"));
  const repliesStart = block.indexOf("\n> **Reply**");
  const closingDash = block.lastIndexOf("\n---");
  const contentEnd = repliesStart !== -1 ? repliesStart : (closingDash !== -1 ? closingDash : block.length);
  // Unescape "---" lines that were escaped on write.
  const content = block.slice(statusEnd + 1, contentEnd).trim().replace(/^\\-\\-\\-$/gm, "---");

  // Extract replies
  const replies = [];
  const replyRegex = /> \*\*Reply\*\* (.+?) \| (.+)\n((?:> .*\n?)*)/g;
  let m;
  while ((m = replyRegex.exec(block)) !== null) {
    replies.push({
      from: m[1],
      date: m[2],
      content: m[3].replace(/^> /gm, "").trim(),
    });
  }

  return {
    id,
    from_project,
    to_project,
    from_agent,
    date,
    status: statusMatch ? statusMatch[1] : "open",
    content,
    replies,
  };
}

/**
 * Read and parse posts from a specific month.
 * Optionally filter by project (from or to) and status.
 */
function readPosts({ month, project, status } = {}) {
  const m = month || currentMonth();
  const filePath = monthFilePath(m);
  if (!fs.existsSync(filePath)) return { posts: [], month: m };

  const text = fs.readFileSync(filePath, "utf-8");
  // Split on "---" delimiters — each post is between two delimiters
  const blocks = text.split(/^---$/m).filter((b) => b.trim());
  const posts = blocks.map(parsePost).filter(Boolean).reverse();

  let filtered = posts;
  if (project) {
    filtered = filtered.filter(
      (p) => p.from_project === project || p.to_project === project
    );
  }
  if (status && status !== "all") {
    filtered = filtered.filter((p) => p.status === status);
  }

  return { posts: filtered, month: m };
}

/**
 * Read latest N posts across all months (for the home page panel).
 */
function readLatestPosts(limit = 10) {
  const files = bulletinFiles();
  const all = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf-8");
    const blocks = text.split(/^---$/m).filter((b) => b.trim());
    const posts = blocks.map(parsePost).filter(Boolean);
    // Reverse so newest posts within this month come first
    posts.reverse();
    all.push(...posts);
    if (all.length >= limit) break;
  }
  return all.slice(0, limit);
}

module.exports = {
  createPost,
  addReply,
  updateStatus,
  readPosts,
  readLatestPosts,
  projectPrefix,
  BULLETIN_DIR,
};

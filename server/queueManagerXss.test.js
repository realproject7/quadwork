// #969: QueueManager markdown XSS guard (EPIC #967 Phase 1).
//
// QueueManager's preview used to build HTML with a hand-rolled `renderMarkdown`
// and inject it via `dangerouslySetInnerHTML`. GitHub issue titles flow into
// that markdown (generateTemplate, line ~50: `... — ${issue.title}`), so a
// title like `[x](javascript:alert(1))` or one with an attribute-breakout
// (`" onmouseover=...`) produced a live, executable link. The fix replaces the
// renderer with react-markdown (no rehype-raw), matching the safe pattern in
// OvernightQueueWidget.tsx.
//
// This test has two halves:
//   (A) Static guard — the component must not regress back to raw-HTML
//       injection or the hand-rolled renderer.
//   (B) Behavioral guard — render react-markdown (the renderer QueueManager now
//       uses) over a queue line carrying a malicious issue title and assert the
//       output is inert (no javascript: href, no raw HTML element), while
//       ordinary markdown still renders as real tags.
//
// Runs under the plain-node runner: react-markdown is ESM (dynamic import) and
// react-dom/server renders to a string with no DOM. Run with
// `node server/queueManagerXss.test.js`.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const ROOT = path.resolve(__dirname, "..");
const COMPONENT = path.join(ROOT, "src", "components", "QueueManager.tsx");

// (A) Static guard: no raw-HTML injection path survives in the component.
function staticGuard() {
  const src = fs.readFileSync(COMPONENT, "utf8");
  assert.ok(
    !/dangerouslySetInnerHTML/.test(src),
    "QueueManager must not use dangerouslySetInnerHTML (#969)",
  );
  assert.ok(
    !/function\s+renderMarkdown/.test(src),
    "QueueManager must not reintroduce the hand-rolled renderMarkdown (#969)",
  );
  assert.ok(
    /from\s+["']react-markdown["']/.test(src) && /<ReactMarkdown/.test(src),
    "QueueManager must render the preview via react-markdown (#969)",
  );
}

// (B) Behavioral guard against the actual renderer.
async function behavioralGuard() {
  const { default: ReactMarkdown } = await import("react-markdown");
  const render = (md) => renderToStaticMarkup(React.createElement(ReactMarkdown, null, md));

  // Malicious issue titles, embedded exactly as generateTemplate does
  // (`${i + 1}. [${repo}#${n}](url) — ${issue.title}`).
  const line = (n, title) =>
    `${n}. [o/r#${n}](https://github.com/o/r/issues/${n}) — ${title}`;

  const attackTitles = [
    "Fix [click me](javascript:alert(1)) crash", // javascript: link
    'Broken "](javascript:alert(2)) title', // attribute-breakout attempt
    '<img src=x onerror=alert(3)> title', // raw HTML element
    'title with onmouseover="alert(4)" attr', // event-handler attribute
  ];

  for (const [i, title] of attackTitles.entries()) {
    const html = render(line(i + 1, title));
    // No anchor may carry a javascript: (or other unsafe) URL.
    assert.ok(
      !/href\s*=\s*["']\s*javascript:/i.test(html),
      `malicious title #${i + 1} produced a javascript: href: ${html}`,
    );
    // Raw HTML must be escaped, never emitted as real elements/handlers.
    assert.ok(!/<img/i.test(html), `raw <img> survived for title #${i + 1}: ${html}`);
    assert.ok(!/<script/i.test(html), `raw <script> survived for title #${i + 1}: ${html}`);
    // An event handler is only dangerous inside a real opening tag; escaped
    // text like `&lt;img onerror=...&gt;` is inert. Match on*= only within `<…>`.
    assert.ok(
      !/<[a-z][a-z0-9]*\b[^>]*\son[a-z]+\s*=/i.test(html),
      `live event-handler attribute survived for title #${i + 1}: ${html}`,
    );
  }

  // The raw-HTML title must be escaped (rendered as text, not a live element).
  assert.match(
    render(line(3, "<img src=x onerror=alert(3)> title")),
    /&lt;img src=x onerror=alert\(3\)&gt;/,
    "raw HTML in a title must be escaped to inert text",
  );

  // The specific javascript: link is neutralized to an empty href, not dropped
  // to plain text — proves react-markdown's URL sanitization is the mechanism.
  const neutralized = render(line(1, "Fix [click me](javascript:alert(1)) crash"));
  assert.ok(
    /<a href="">click me<\/a>/.test(neutralized),
    `expected the javascript: link to be neutralized to an empty href: ${neutralized}`,
  );

  // Positive control: legitimate markdown still renders as real tags so the
  // preview keeps working (headings, lists, bold, code, safe links).
  const ok = render("# H1\n\n## H2\n\n- item **bold** `code` [link](https://ok.com)");
  assert.match(ok, /<h1>H1<\/h1>/, "heading renders");
  assert.match(ok, /<h2>H2<\/h2>/, "subheading renders");
  assert.match(ok, /<li>.*<strong>bold<\/strong>/s, "list item + bold render");
  assert.match(ok, /<code>code<\/code>/, "inline code renders");
  assert.match(ok, /<a href="https:\/\/ok\.com">link<\/a>/, "safe link renders");
}

(async () => {
  staticGuard();
  await behavioralGuard();
  console.log("server/queueManagerXss.test.js: all assertions passed");
  process.exit(0);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

// --- #538: PTY output secret scrubbing ---
// Redact likely secrets from both live PTY streaming and scrollback
// replay so echoed credentials are not exposed to dashboard clients.
//
// Threat model: QuadWork binds to 127.0.0.1 only. The scrub is
// defense-in-depth — it reduces exposure if a secret is accidentally
// echoed, but cannot catch every possible format. Operators who handle
// highly sensitive credentials should avoid echoing them in agent
// terminals.
//
// Live chunks from term.onData() are typically line-aligned (shell
// flushes on newline), so per-chunk scrubbing catches the vast majority
// of secrets. A secret split across two chunks is a theoretical edge
// case that the scrollback scrub (which sees the full buffer) covers
// on reconnect.

// Patterns that indicate a line contains a secret value.
const _SECRET_NAME_RE = /\b\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PASSPHRASE|AUTH)\w*\s*[=:]/i;
// Known API key prefixes (Anthropic, GitHub, OpenAI, etc.).
const _API_KEY_PREFIX_RE = /\b(sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|ghu_[A-Za-z0-9]{36,}|ghs_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9-]{20,}|xoxp-[A-Za-z0-9-]{20,})\b/;
// Bearer authorization headers.
const _BEARER_RE = /\bBearer\s+[A-Za-z0-9_.+/=-]{20,}/i;
const _REDACTED = "[REDACTED]";

function scrubSecrets(text) {
  if (!text) return text;
  return text.split("\n").map((line) => {
    // Strip ANSI escape codes for pattern matching, but redact the
    // original line (preserves terminal formatting around non-secret
    // lines while ensuring secrets inside styled output are caught).
    const plain = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    if (_SECRET_NAME_RE.test(plain)) {
      // Redact the value portion after the = or : delimiter.
      return line.replace(/([=:])\s*\S.*/, `$1 ${_REDACTED}`);
    }
    if (_API_KEY_PREFIX_RE.test(plain)) {
      return line.replace(_API_KEY_PREFIX_RE, _REDACTED);
    }
    if (_BEARER_RE.test(plain)) {
      return line.replace(/\bBearer\s+[A-Za-z0-9_.+/=-]{20,}/gi, `Bearer ${_REDACTED}`);
    }
    return line;
  }).join("\n");
}

function scrubScrollback(buf) {
  if (!buf || buf.length === 0) return buf;
  return Buffer.from(scrubSecrets(buf.toString("utf-8")), "utf-8");
}

module.exports = { scrubSecrets, scrubScrollback, _REDACTED };

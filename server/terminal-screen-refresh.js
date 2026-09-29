// Ask an interactive PTY application to repaint its screen without sending
// user input. A real size transition raises the platform's normal resize
// notification; restoring the exact dimensions leaves the PTY at its current
// viewer size.
function refreshTerminalScreen(term, dimensions) {
  if (!term || typeof term.resize !== "function" || !dimensions) return false;
  const { cols, rows } = dimensions;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return false;

  let temporary;
  if (cols > 1) temporary = { cols: cols - 1, rows };
  else if (rows > 1) temporary = { cols, rows: rows - 1 };
  else return false;

  try {
    term.resize(temporary.cols, temporary.rows);
  } finally {
    term.resize(cols, rows);
  }
  return true;
}

module.exports = { refreshTerminalScreen };

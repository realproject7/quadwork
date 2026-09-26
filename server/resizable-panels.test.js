"use strict";

const assert = require("node:assert/strict");
const {
  TERMINAL_DIVIDER_SIZE,
  TERMINAL_MIN_PANE_SIZE,
  RAIL_DIVIDER_SIZE,
  RAIL_MIN_TERMINAL_SIZE,
  COLUMN_DIVIDER_SIZE,
  CHAT_MIN_COLUMN_SIZE,
  RAIL_MIN_COLUMN_SIZE,
  clampColumnRatio,
  stepColumnRatio,
  dashboardColumnTemplate,
  clampTerminalSplitRatio,
  terminalGridLayout,
  railPanelMinimum,
  clampRailPair,
} = require("../src/lib/panelResize");

function renderedSize(ratios, id, totalPx, dividerCount) {
  const available = totalPx - dividerCount * RAIL_DIVIDER_SIZE;
  const totalWeight = Object.values(ratios).reduce((total, value) => total + value, 0);
  return (ratios[id] / totalWeight) * available;
}

(() => {
  const total = 600;
  const minimum = TERMINAL_MIN_PANE_SIZE / (total - TERMINAL_DIVIDER_SIZE);
  assert.equal(clampTerminalSplitRatio(-1, total), minimum, "column splitter cannot pass the left minimum");
  assert.equal(clampTerminalSplitRatio(2, total), 1 - minimum, "column splitter cannot pass the right minimum");
  assert.equal(clampTerminalSplitRatio(0.5, total), 0.5, "row splitter retains a centered ratio");
  console.log("  PASS: terminal column and row split ratios clamp to usable pane bounds");

  const three = terminalGridLayout(3);
  assert.equal(three.hasVerticalSplit, true);
  assert.equal(three.hasHorizontalSplit, true);
  assert.deepEqual(three.positions[2], { gridColumn: "1 / 4", gridRow: "3" }, "three-agent layout preserves the full-width bottom terminal");
  const four = terminalGridLayout(4);
  assert.equal(four.fourOrMore, true);
  assert.deepEqual(four.positions, [
    { gridColumn: "1", gridRow: "1" },
    { gridColumn: "3", gridRow: "1" },
    { gridColumn: "1", gridRow: "3" },
    { gridColumn: "3", gridRow: "3" },
  ], "four-agent layout keeps all terminal quadrants addressable");
  console.log("  PASS: three- and four-agent terminal layouts retain their split geometry");

  const initial = { terminals: 1, github: 1, operator: 1 };
  const compressed = clampRailPair({
    ratios: initial,
    before: "terminals",
    after: "github",
    totalPx: 900,
    requestedBefore: -100,
  });
  assert.ok(renderedSize(compressed, "terminals", 900, 2) >= RAIL_MIN_TERMINAL_SIZE - 0.001, "drag cannot clip the terminal's lower row");
  assert.ok(renderedSize(compressed, "github", 900, 2) >= railPanelMinimum("github") - 0.001, "drag preserves the adjacent panel minimum");

  const keyboardNudge = clampRailPair({
    ratios: compressed,
    before: "terminals",
    after: "github",
    totalPx: 900,
    requestedBefore: compressed.terminals + 0.05,
  });
  assert.ok(keyboardNudge.terminals > compressed.terminals, "keyboard nudge grows the requested rail panel");
  assert.ok(renderedSize(keyboardNudge, "github", 900, 2) >= railPanelMinimum("github") - 0.001, "keyboard nudge also respects the adjacent minimum");
  console.log("  PASS: rail drag and keyboard nudges preserve terminal and adjacent-panel bounds");

  // #1187: the chat/rail divider stops where the panel headers still fit on
  // one line. Header widths measured live at 1260px (Geist Mono, en): chat
  // 328.7px, widest rail header (Operator Features) 223.7px.
  assert.ok(CHAT_MIN_COLUMN_SIZE >= 329, "the chat column minimum fits the measured chat header");
  assert.ok(RAIL_MIN_COLUMN_SIZE >= 224, "the rail column minimum fits the widest measured rail header");
  // Dashboard widths at lg: 1024 with the expanded sidebar, 1260 and 1920 with the collapsed one.
  for (const total of [816, 1196, 1856]) {
    const chatAtLeftStop = clampColumnRatio(-1, total) * total;
    const railAtRightStop = total - COLUMN_DIVIDER_SIZE - clampColumnRatio(2, total) * total;
    assert.ok(Math.abs(chatAtLeftStop - CHAT_MIN_COLUMN_SIZE) < 0.001, `${total}px: the left stop keeps the chat column at its minimum`);
    assert.ok(Math.abs(railAtRightStop - RAIL_MIN_COLUMN_SIZE) < 0.001, `${total}px: the right stop keeps the rail column at its minimum`);
    assert.equal(clampColumnRatio(0.5, total), 0.5, `${total}px: a centered ratio is unchanged`);
  }
  // The grid template enforces the same minimums as the drag/keyboard clamp.
  assert.equal(
    dashboardColumnTemplate(0.5),
    `minmax(${CHAT_MIN_COLUMN_SIZE}px, 50%) ${COLUMN_DIVIDER_SIZE}px minmax(${RAIL_MIN_COLUMN_SIZE}px, 1fr)`,
  );
  console.log("  PASS: the chat/rail divider stops keep both columns wide enough for their headers");

  // The rail also holds the terminal grid. At the right stop the grid keeps its
  // own minimum (two 120px panes and the 4px split), its split can still move,
  // and at the 50% split a running HEAD tile header fits: 164.7px measured in
  // Geist Mono (HEAD, "Verified", stop, restart and /c buttons).
  assert.ok(RAIL_MIN_COLUMN_SIZE >= TERMINAL_MIN_PANE_SIZE * 2 + TERMINAL_DIVIDER_SIZE, "the terminal grid fits the rail at its stop");
  assert.ok(clampTerminalSplitRatio(0, RAIL_MIN_COLUMN_SIZE) < 0.5, "the terminal split can still move at the rail stop");
  assert.ok((RAIL_MIN_COLUMN_SIZE - TERMINAL_DIVIDER_SIZE) / 2 >= 164.7, "a running HEAD tile header fits at the 50% split");
  assert.ok(CHAT_MIN_COLUMN_SIZE + COLUMN_DIVIDER_SIZE + RAIL_MIN_COLUMN_SIZE <= 816, "both minimums fit the narrowest lg dashboard");
  console.log("  PASS: the rail stop keeps the terminal grid and its tile headers whole");

  // A stop set at a wide window leaves the saved ratio past the stop once the
  // window shrinks; the grid shows the stop. The first arrow press away from
  // it must move the divider a full step from where it is shown.
  for (const [stop, step] of [[2, -0.05], [-1, 0.05]]) {
    const saved = clampColumnRatio(stop, 1856);
    const shown = clampColumnRatio(saved, 816);
    assert.notEqual(saved, shown, "the saved ratio is past the narrow window's stop");
    assert.ok(Math.abs(stepColumnRatio(saved, step, 816) - shown - step) < 1e-9, `the first ${step < 0 ? "ArrowLeft" : "ArrowRight"} press moves the divider`);
  }
  assert.ok(Math.abs(stepColumnRatio(0.5, 0.05, 1196) - 0.55) < 1e-9, "a step inside the range is unchanged");
  assert.equal(stepColumnRatio(clampColumnRatio(2, 1196), 0.05, 1196), clampColumnRatio(2, 1196), "a step past the stop stays at the stop");
  console.log("  PASS: the first arrow press after a window shrink moves the divider");

  console.log("\n6 passed, 0 failed\n");
})();

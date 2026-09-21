"use strict";

const assert = require("node:assert/strict");
const {
  TERMINAL_DIVIDER_SIZE,
  TERMINAL_MIN_PANE_SIZE,
  RAIL_DIVIDER_SIZE,
  RAIL_MIN_TERMINAL_SIZE,
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

  console.log("\n3 passed, 0 failed\n");
})();

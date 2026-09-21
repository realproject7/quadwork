"use strict";

const TERMINAL_DIVIDER_SIZE = 4;
const TERMINAL_MIN_PANE_SIZE = 120;
const RAIL_DIVIDER_SIZE = 4;
const RAIL_MIN_PANEL_SIZE = 120;
const RAIL_MIN_TERMINAL_SIZE = RAIL_MIN_PANEL_SIZE * 2 + TERMINAL_DIVIDER_SIZE + 28;

function clampTerminalSplitRatio(ratio, totalPx) {
  const available = Math.max(1, totalPx - TERMINAL_DIVIDER_SIZE);
  const minimum = Math.min(0.5, TERMINAL_MIN_PANE_SIZE / available);
  return Math.min(1 - minimum, Math.max(minimum, ratio));
}

function terminalGridLayout(agentCount) {
  const fourOrMore = agentCount >= 4;
  return {
    fourOrMore,
    hasVerticalSplit: agentCount >= 2,
    hasHorizontalSplit: agentCount >= 3,
    positions: fourOrMore
      ? [
          { gridColumn: "1", gridRow: "1" },
          { gridColumn: "3", gridRow: "1" },
          { gridColumn: "1", gridRow: "3" },
          { gridColumn: "3", gridRow: "3" },
        ]
      : [
          { gridColumn: "1", gridRow: "1" },
          { gridColumn: "3", gridRow: "1" },
          { gridColumn: "1 / 4", gridRow: "3" },
        ],
  };
}

function railPanelMinimum(id) {
  return id === "terminals" ? RAIL_MIN_TERMINAL_SIZE : RAIL_MIN_PANEL_SIZE;
}

function clampRailPair({ ratios, before, after, totalPx, dividerCount = 2, requestedBefore }) {
  const available = Math.max(1, totalPx - RAIL_DIVIDER_SIZE * dividerCount);
  const totalWeight = Object.values(ratios).reduce((total, value) => total + value, 0);
  const pairTotal = ratios[before] + ratios[after];
  const requestedMinimumBefore = (railPanelMinimum(before) * totalWeight) / available;
  const requestedMinimumAfter = (railPanelMinimum(after) * totalWeight) / available;
  const scale = Math.min(1, pairTotal / (requestedMinimumBefore + requestedMinimumAfter));
  const minimumBefore = requestedMinimumBefore * scale;
  const minimumAfter = requestedMinimumAfter * scale;
  const nextBefore = Math.min(pairTotal - minimumAfter, Math.max(minimumBefore, requestedBefore));
  return {
    ...ratios,
    [before]: nextBefore,
    [after]: pairTotal - nextBefore,
  };
}

module.exports = {
  TERMINAL_DIVIDER_SIZE,
  TERMINAL_MIN_PANE_SIZE,
  RAIL_DIVIDER_SIZE,
  RAIL_MIN_PANEL_SIZE,
  RAIL_MIN_TERMINAL_SIZE,
  clampTerminalSplitRatio,
  terminalGridLayout,
  railPanelMinimum,
  clampRailPair,
};

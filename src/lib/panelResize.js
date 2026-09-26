"use strict";

const TERMINAL_DIVIDER_SIZE = 4;
const TERMINAL_MIN_PANE_SIZE = 120;
const RAIL_DIVIDER_SIZE = 4;
const RAIL_MIN_PANEL_SIZE = 120;
const RAIL_MIN_TERMINAL_SIZE = RAIL_MIN_PANEL_SIZE * 2 + TERMINAL_DIVIDER_SIZE + 28;
// #1187: the chat/rail divider stops where every panel header still fits on
// one line with all of its controls. Measured at 1260px in Geist Mono: the
// chat header (title, ?, "Filter system log: off") needs 329px. The rail holds
// the terminal grid: at its 50% split a running HEAD tile header (Verified,
// stop, restart, /c) needs 164.7px, so the rail needs 2 × 164.7 + 4 = 333.5px.
// 340 + 4 + 340 still fits the narrowest lg dashboard (816px).
const COLUMN_DIVIDER_SIZE = 4;
const CHAT_MIN_COLUMN_SIZE = 340;
const RAIL_MIN_COLUMN_SIZE = 340;

function clampColumnRatio(ratio, totalPx) {
  const minimum = CHAT_MIN_COLUMN_SIZE / totalPx;
  const maximum = (totalPx - COLUMN_DIVIDER_SIZE - RAIL_MIN_COLUMN_SIZE) / totalPx;
  return Math.min(maximum, Math.max(minimum, ratio));
}

// A window resize can leave the saved ratio past a stop, where the grid shows
// the stop instead. Step from the shown position so the first arrow press moves.
function stepColumnRatio(ratio, step, totalPx) {
  return clampColumnRatio(clampColumnRatio(ratio, totalPx) + step, totalPx);
}

// The grid keeps the same minimums, so a window resize after a drag cannot
// squeeze either column below its headers either.
function dashboardColumnTemplate(ratio) {
  return `minmax(${CHAT_MIN_COLUMN_SIZE}px, ${ratio * 100}%) ${COLUMN_DIVIDER_SIZE}px minmax(${RAIL_MIN_COLUMN_SIZE}px, 1fr)`;
}

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
};

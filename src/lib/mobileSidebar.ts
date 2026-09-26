// #1198: the mobile menu button lives in TopHeader.tsx (so keyboard Tab
// reaches it before the header's own controls — TopHeader sits first in the
// DOM, see layout.tsx), but the drawer it opens is owned by Sidebar.tsx.
// Cross-component signal, same window-event pub/sub shape as idle.ts's
// IDLE_EVENT — kept out of the Sidebar component module so callers that only
// need the event (ChatPresets, closing itself when the drawer opens) don't
// have to import the whole Sidebar component.
export const OPEN_MOBILE_SIDEBAR_EVENT = "quadwork:open-mobile-sidebar";

export function openMobileSidebar(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_MOBILE_SIDEBAR_EVENT));
}

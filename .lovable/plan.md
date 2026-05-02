## Auto-close mobile sidebar after nav click

**Problem:** When the Lovable chat panel is expanded the preview viewport gets narrow, and the sidebar (`AppSidebar`) renders as a mobile overlay drawer (shadcn `Sidebar` `Sheet` mode) toggled by the top-right icon. Clicking a nav item routes to the page but leaves the overlay open, covering the content the user just navigated to.

**Fix:** In `src/components/trader/AppSidebar.tsx`, use the `isMobile` and `setOpenMobile` values that the `useSidebar` hook already exposes. Add an `onClick` handler on each `NavLink` that closes the mobile drawer **only when `isMobile` is true**. Desktop / wide-viewport behavior is unchanged.

### Changes

1. Pull `isMobile` and `setOpenMobile` from the existing `useSidebar()` call.
2. Add a small `handleNavClick` that calls `setOpenMobile(false)` only when `isMobile` is true.
3. Wire `onClick={handleNavClick}` onto the `NavLink` in the section-items map.

### Files touched

- `src/components/trader/AppSidebar.tsx` — ~5 lines added, no logic changes elsewhere.

No other files, no DB, no edge functions, no styling changes. Behavior on wide viewports is identical.
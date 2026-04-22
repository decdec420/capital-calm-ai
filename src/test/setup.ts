// jest-dom is only needed for component-level DOM assertions. The
// _shared/* logic tests don't touch the DOM, so we lazy-load it with
// a dynamic import and swallow resolution failures — that way a flaky
// transitive dep tree in CI won't nuke the pure-logic suite.
async function loadJestDom() {
  try {
    // @ts-ignore — optional dep, types may not resolve in all envs
    await import("@testing-library/jest-dom");
  } catch {
    // Optional — fine for logic-only tests.
  }
}
void loadJestDom();

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

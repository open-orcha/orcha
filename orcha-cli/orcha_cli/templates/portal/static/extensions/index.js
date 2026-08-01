/* Orcha portal extensions entrypoint (SEAM B / #212) — CORE STUB, intentionally empty.
 *
 * Core ships this file empty so /assets/extensions/index.js never 404s (zero CSP / log
 * noise). A downstream distribution REPLACES this file to register nav items, settings
 * tabs, and task-detail sections via `window.OrchaExt` (defined by
 * modules/app-extensions.js, which loads before this file on every page):
 *
 *   window.OrchaExt.registerNavItem({ id, label, href, order });
 *   window.OrchaExt.registerSettingsTab({ id, label, render(el) });
 *   window.OrchaExt.registerTaskDetailSection({ id, order, render(el, task) });
 *
 * THE ONE RULE: extensions register ONLY through window.OrchaExt. They must never patch
 * or reach into any core file — that defeats the seam and breaks clean upgrades.
 */

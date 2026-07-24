/* Orcha shared portal module: snapshot mutation and theme controls. */
// Ensure a live object exists BEFORE we capture D, so pages can mutate it in
// place (Object.assign) without invalidating this reference.
window.ORCHA = window.ORCHA || { container: null, agents: [], tasks: [], requests: [] };
const D = window.ORCHA;

// In-place snapshot update: keep the SAME object so `D` (and every captured
// reference in the pages) stays valid across the 3s poll. Returns D.
function applySnapshot(fresh) {
  if (!fresh || typeof fresh !== "object") return D;
  // replace known collections wholesale; copy scalars/other keys too
  Object.keys(fresh).forEach((k) => { D[k] = fresh[k]; });
  // SPEC-1: reconcile the topbar autonomy switch with the fresh snapshot (the topbar is
  // built once by mountShell; the 5s poll updates D.container but not the topbar markup).
  try { paintAutonomy(); } catch (e) {}
  // SPEC-3: keep the notification badge (NEEDS-YOU count) fresh, and repaint the open
  // panel's live action-queue zone, on every poll/event-stream refresh.
  try { paintNotifications(); } catch (e) {}
  return D;
}

/* ---- theme ----------------------------------------------------------- */
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("orcha:theme", t); } catch (e) {}
}
function currentTheme() {
  try { return localStorage.getItem("orcha:theme") || "auto"; } catch (e) { return "auto"; }
}
// What the page ACTUALLY renders right now. "auto" has no palette of its own — the
// default vars are dark, and [data-theme="auto"] only flips to light under
// @media (prefers-color-scheme: light) (styles.css). So on a dark-preference OS
// "auto" is visually identical to "dark". cycleTheme advances from this RESOLVED
// value so a single click always produces a visible change — the old 3-state
// auto→dark→light cycle made the first auto→dark step invisible on a dark OS, which
// is the "requires double-click" bug (GH #239). "auto" remains the pre-click default
// (set at load, L873); once the user clicks they get an explicit dark/light toggle.
function resolvedTheme() {
  const t = currentTheme();
  if (t === "dark" || t === "light") return t;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch (e) { return "dark"; }
}
function cycleTheme() {
  const next = resolvedTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  toast("Theme · " + next, "ok");
  syncThemeLabel();
  const tb = document.getElementById("themeBtn");
  if (tb) tb.setAttribute("title", "Theme: " + next + " — click to cycle");
}
function syncThemeLabel() {
  const el = document.getElementById("themeLabel");
  if (el) el.textContent = currentTheme();
}

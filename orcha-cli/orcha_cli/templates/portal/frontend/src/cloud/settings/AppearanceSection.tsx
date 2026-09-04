/**
 * ORCHA CLOUD — Appearance settings section. React port of the vanilla
 * modules/settings-appearance.js skin picker + the settings.html appearance
 * card, plus an explicit theme choice (auto / dark / light).
 *
 * Apply mechanics (vanilla parity, modules/app-state.js applyTheme +
 * settings-appearance.js applySkin):
 *  - theme: set data-theme on <html>, write localStorage "orcha:theme" (the
 *    key the open shell's pre-paint script and theme toggle read), then queue
 *    the debounced per-user prefs PUT (mig 040) via src/cloud/projects/prefs.
 *  - skin: "classic" = the shipped look (NO attribute); any other id is
 *    applied as data-skin on <html>; write localStorage "orcha:skin"; queue
 *    the same prefs PUT. Every vanilla page's pre-paint <head> script reads
 *    the same key — but the SPA's index.html pre-paint script only restores
 *    the THEME, so bootAppearance() below re-applies the persisted skin at
 *    app boot (module-level; this module is imported from extensions.ts).
 */
import { useState } from "react";
import { Icon, useToast } from "../../components/ui";
import * as prefs from "../projects/prefs";
import "./settings-cards.css";
import "./appearance.css";

/* ---- skins: verbatim port of the vanilla SKINS table --------------------- */
export const SKINS = [
  { id: "classic", name: "Classic", desc: "Teal accent, rounded corners, soft shadows — the original Orcha look.",
    sw: ["#111620", "#1fc7cd", "#f2a83c", "#e8edf6"] },
  { id: "swiss", name: "Swiss", desc: "Electric indigo, sharp corners, mono status chips — dense engineering grid.",
    sw: ["#151517", "#5a72ff", "#ff7a52", "#f2f2ee"] },
  { id: "minimal", name: "Minimalist", desc: "clean · gold",
    sw: ["#161616", "#c9a24b", "#f5f0e6", "#ffffff"] },
  { id: "gold", name: "Gold", desc: "Desktop's amber accent, hairline borders — the same minimalist chrome, matched.",
    sw: ["#141311", "#f0b94b", "#1d1b18", "#efe9df"] },
];

export function currentSkin(): string {
  try {
    const s = localStorage.getItem("orcha:skin");
    return SKINS.some((k) => k.id === s) ? (s as string) : "classic";
  } catch { return "classic"; }
}

export function applySkin(id: string): void {
  const d = document.documentElement;
  if (id === "classic") d.removeAttribute("data-skin");
  else d.setAttribute("data-skin", id);
  try { localStorage.setItem("orcha:skin", id); } catch { /* private mode */ }
  // per-user prefs (mig 040): mirror the pick to the account (debounced PUT).
  prefs.queuePut();
}

/* ---- theme (auto / dark / light) — same write contract as the shell ------ */
export const THEMES = ["auto", "dark", "light"] as const;

export function currentTheme(): string {
  try { return localStorage.getItem("orcha:theme") || "auto"; } catch { return "auto"; }
}

export function applyThemeChoice(t: string): void {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("orcha:theme", t); } catch { /* private mode */ }
  // per-user prefs (mig 040): localStorage stays the instant local write; a
  // debounced PUT mirrors it to the signed-in user's server prefs (no-op when
  // trust is off / the login is unmapped — prefs stays inactive).
  prefs.queuePut();
}

/* ---- boot hook ------------------------------------------------------------
 * The SPA's index.html pre-paint script restores only data-theme; the skin
 * attribute must be restored here (same contract as the vanilla pre-paint
 * script: s && s !== 'classic' → data-skin). Also kick the once-per-load
 * /api/prefs sync (vanilla data.js) so SERVER WINS on load and the debounced
 * PUT queue activates for the writers above. Runs at module import — this
 * module is imported from extensions.ts, i.e. at app boot. */
export function bootAppearance(): void {
  try {
    const s = localStorage.getItem("orcha:skin");
    if (s && s !== "classic") document.documentElement.setAttribute("data-skin", s);
  } catch { /* private mode */ }
  try { void prefs.sync(); } catch { /* no fetch (harness) — localStorage only */ }
}
bootAppearance();

/* ---- the section (renders its own settings card) -------------------------- */
export function AppearanceSection() {
  const toast = useToast();
  const [theme, setTheme] = useState(currentTheme());
  const [skin, setSkin] = useState(currentSkin());

  const pickTheme = (t: string) => {
    if (t === theme) return;
    applyThemeChoice(t);
    setTheme(t);
    toast("Theme · " + t, "ok");
  };

  const pickSkin = (id: string) => {
    if (id === skin) return;
    applySkin(id);
    setSkin(id);
    toast("Design · " + (SKINS.find((k) => k.id === id) || { name: "" }).name, "ok");
  };

  return (
    <div className="card set-card">
      <div className="card-h"><h2>Appearance</h2></div>
      <div className="card-b">
        <div className="lead">
          How the portal looks in this browser — applies instantly, per device. Theme picks
          dark / light (auto follows your system); the design tiles pick the design language.
        </div>
        <div className="theme-row">
          <span className="theme-lab">Theme</span>
          <div className="aut theme-seg" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <span
                key={t}
                className={"seg" + (t === theme ? " on" : "")}
                role="radio"
                aria-checked={t === theme}
                tabIndex={0}
                onClick={() => pickTheme(t)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickTheme(t); } }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="skin-grid" id="skinGrid">
          {SKINS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={"skin-tile" + (k.id === skin ? " on" : "")}
              data-skin={k.id}
              onClick={() => pickSkin(k.id)}
            >
              <div className="sw">{k.sw.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
              <div className="nm">{k.name}{k.id === skin && <Icon name="check" cls="" />}</div>
              <div className="ds">{k.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

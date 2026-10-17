/**
 * Settings › Interface (Orcha V2, arch §2.3 key `interface`, alias
 * `appearance`).
 *
 * Appearance: System / Light / Dark (shell/theme.ts). The choice is stored in
 * localStorage `orcha:theme` ("auto" | "light" | "dark") and, when signed in,
 * the per-user `/api/prefs` bag (server wins on load). Inside the Embodent
 * desktop app the host owns the theme, so the control is read-only there.
 * The decorative skins (classic/swiss/minimal/gold) stay retired: a stored
 * skin is disclosed, never applied, rewritten or deleted.
 *
 * Everything shown is real: the keyboard shortcuts are the ones the V2 shell
 * binds (shell/chrome.tsx, components/primitives/List.tsx), and the sidebar
 * note describes the shell's persisted width / collapse behavior.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SettingRow, SettingRows, SettingsGroup } from "./settingsUi";
import { PlanUsageSettings } from "./PlanUsageSettings";
import * as prefs from "../../cloud/projects/prefs";
import { RAIL_TOGGLE_KEY } from "../../shell/nav";
import { setThemePref, THEME_LABEL, useTheme, type ThemePref } from "../../shell/theme";

const SKIN_NAMES: Record<string, string> = {
  classic: "Classic", swiss: "Swiss", minimal: "Minimalist", gold: "Gold",
};

/** The stored appearance choice (theme is live again; skin is disclosure-only). */
export function legacyAppearance(): { theme: string; skin: string | null } {
  let skin: string | null = null;
  let theme = "";
  try {
    skin = localStorage.getItem("orcha:skin");
    theme = localStorage.getItem("orcha:theme") || ""; // "" = never chosen
  } catch { /* private mode */ }
  return { theme, skin };
}

/** Human copy for a stored retired SKIN, else null. The theme is not
 *  disclosed any more — it is a live setting again (Appearance). */
export function legacyNote(p: { theme: string; skin: string | null }): string | null {
  if (!p.skin || p.skin === "classic") return null;
  return `Your earlier choice (${SKIN_NAMES[p.skin] || p.skin} design) is kept on file but no longer changes the look.`;
}

const THEME_OPTIONS: ThemePref[] = ["auto", "light", "dark"];

/** Where the theme choice is kept (pure, tested). */
export function themeStorageNote(accountPrefs: boolean, managed: "managed" | "dark" | null): string {
  if (managed === "managed") return "Set by the Embodent app — change it in the app's Settings › Appearance.";
  if (managed === "dark") return "This version of the Embodent app is dark only — update it to choose a theme.";
  return accountPrefs ? "Saved to your account" : "Saved in this browser";
}

/** A tiny window thumbnail in one theme (colours are fixed per preview, not the live tokens). */
function ThemeThumb({ kind }: { kind: "light" | "dark" }) {
  return (
    <span className="set-theme-pv" data-pv={kind} aria-hidden="true">
      <span className="pv-side"><i /><i /><i /></span>
      <span className="pv-panel"><i className="pv-title" /><i /><i /><i className="pv-short" /><b /></span>
    </span>
  );
}

/**
 * System / Light / Dark as three preview tiles — ONE radiogroup, roving ←/→,
 * selection applies instantly. Disabled inside the desktop app (host-owned).
 */
export function ThemePicker({ accountPrefs }: { accountPrefs: boolean }) {
  const { pref, managed } = useTheme();
  const ref = useRef<HTMLDivElement | null>(null);
  const locked = managed !== null;
  const pick = (p: ThemePref) => { if (!locked) setThemePref(p); };
  const onKey = (e: ReactKeyboardEvent) => {
    const i = THEME_OPTIONS.indexOf(pref);
    let j = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % THEME_OPTIONS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = THEME_OPTIONS.length - 1;
    if (j < 0 || locked) return;
    e.preventDefault();
    pick(THEME_OPTIONS[j]);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-theme-opt="${THEME_OPTIONS[j]}"]`)?.focus());
  };
  return (
    <div className="set-theme-wrap">
      <div ref={ref} className="set-theme" role="radiogroup" aria-label="Theme" aria-disabled={locked || undefined} onKeyDown={onKey}>
        {THEME_OPTIONS.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            className="set-theme-opt"
            data-theme-opt={o}
            aria-checked={pref === o}
            tabIndex={pref === o ? 0 : -1}
            disabled={locked}
            onClick={() => pick(o)}
          >
            {o === "auto" ? (
              <span className="set-theme-split" aria-hidden="true"><ThemeThumb kind="light" /><ThemeThumb kind="dark" /></span>
            ) : <ThemeThumb kind={o} />}
            <span className="set-theme-l">{THEME_LABEL[o]}</span>
          </button>
        ))}
      </div>
      <span className="set-note" id="setThemeStore">{themeStorageNote(accountPrefs, managed)}</span>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["⌘K / Ctrl+K", "Search and commands in this project (not inside code editors or terminals)"],
  ["/", "Open search when you are not typing in a field"],
  ["C", "Create a new task when you are not typing"],
  ["↑ ↓", "Move between rows in a list; Enter opens the focused row"],
  ["Esc", "Close the open dialog, menu or search and return focus"],
  [RAIL_TOGGLE_KEY, "Collapse or expand the sidebar when you are not typing"],
  ["⌥Space / Alt+Space", "Dictate into the focused field: hold to talk, or tap to start and tap again to finish (change it in Settings › Voice)"],
];

/**
 * Where the sidebar layout is kept (pure, tested; IF-RAIL-COLLAPSE). With
 * account prefs active (/api/prefs non-null) the collapsed/expanded state is
 * part of the synced bag (prefs.localPrefs "sidebar"); the drag width is not.
 */
export function sidebarStorageNote(accountPrefs: boolean): string {
  return accountPrefs ? "Collapse saved to your account · width in this browser" : "Saved in this browser";
}

export function InterfaceSection() {
  const note = legacyNote(legacyAppearance());
  const [accountPrefs, setAccountPrefs] = useState(prefs.active());
  useEffect(() => {
    let alive = true;
    void prefs.sync().then(() => { if (alive) setAccountPrefs(prefs.active()); });
    return () => { alive = false; };
  }, []);
  return (
    <>
      <SettingsGroup settab="interface" title="Appearance" flush>
        <SettingRows>
          <SettingRow label="Theme" desc="System follows your device's light or dark setting." stack>
            <ThemePicker accountPrefs={accountPrefs} />
          </SettingRow>
        </SettingRows>
      </SettingsGroup>
      {/* a retired skin that no longer applies — one muted line, only when it exists */}
      {note ? <p className="set-note set-legacy" id="legacyAppearance" data-settab="interface">{note}</p> : null}
      <SettingsGroup settab="interface" title="Sidebar" flush>
        <SettingRows>
          <SettingRow
            label="Width and collapse"
            desc="Drag the sidebar edge to resize, or collapse it to icons."
          >
            <span className="set-note" id="setSidebarStore">{sidebarStorageNote(accountPrefs)}</span>
          </SettingRow>
          <SettingRow label="Favorites" desc="Pinned projects and their order.">
            <span className="set-note">Saved in this browser</span>
          </SettingRow>
        </SettingRows>
      </SettingsGroup>
      <PlanUsageSettings />
      <SettingsGroup settab="interface" title="Keyboard shortcuts" flush>
        <dl className="set-keys" aria-label="Keyboard shortcuts">
          {SHORTCUTS.map(([k, d]) => (
            <div className="set-key" key={k}>
              <dt>{k.split(" / ").map((part, i) => (
                <span key={part}>{i > 0 ? <span className="set-key-or">or</span> : null}<kbd>{part}</kbd></span>
              ))}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </SettingsGroup>
    </>
  );
}

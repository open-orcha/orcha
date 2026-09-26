/** Pure builders for the `executeJavaScript` snippets run inside each embedded portal
 *  WebContentsView to read/apply appearance. Kept as plain string builders (no Electron
 *  imports) so they're unit-testable without a real WebContents — index.ts is the only
 *  caller that actually executes them. */
import type { Appearance } from './appearanceStore'

/** Reads the portal's own "orcha:theme"/"orcha:skin" localStorage keys, returning
 *  {theme, skin} (each null when absent/private-mode-blocked). Evaluated with
 *  `executeJavaScript` — the returned value must be JSON-serializable (it is: a plain
 *  object of strings/nulls). */
export function buildReadAppearanceScript(): string {
  return `(() => {
    try {
      return {
        theme: window.localStorage.getItem('orcha:theme') || null,
        skin: window.localStorage.getItem('orcha:skin') || null
      };
    } catch (e) {
      return { theme: null, skin: null };
    }
  })()`
}

/** Writes `appearance` into the portal's own "orcha:theme"/"orcha:skin" localStorage keys
 *  AND applies it live to the DOM — mirrors the portal's OWN apply contract exactly (see
 *  resources/orcha-templates/portal/frontend/src/cloud/settings/AppearanceSection.tsx's
 *  applyThemeChoice/applySkin): data-theme is always set to the theme value; data-skin is
 *  set for any non-"classic" skin and REMOVED for "classic" (classic is the no-attribute
 *  default, not a value to write). A null field is left untouched (skip that key) rather
 *  than clobbering it with an empty string. JSON.stringify the values in so this stays a
 *  single self-contained expression the caller can hand straight to executeJavaScript. */
export function buildApplyAppearanceScript(appearance: Appearance): string {
  const theme = JSON.stringify(appearance.theme)
  const skin = JSON.stringify(appearance.skin)
  return `(() => {
    try {
      const theme = ${theme};
      const skin = ${skin};
      if (theme !== null) {
        document.documentElement.setAttribute('data-theme', theme);
        try { window.localStorage.setItem('orcha:theme', theme); } catch (e) {}
      }
      if (skin !== null) {
        if (skin === 'classic') document.documentElement.removeAttribute('data-skin');
        else document.documentElement.setAttribute('data-skin', skin);
        try { window.localStorage.setItem('orcha:skin', skin); } catch (e) {}
      }
    } catch (e) {}
  })()`
}

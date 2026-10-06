/**
 * ORCHA CLOUD — the settings section registered under the legacy key
 * `appearance` (extensions.settingsSections). It renders the shared Interface
 * section (pages/settings/InterfaceSection), whose Appearance group holds the
 * System / Light / Dark theme picker.
 *
 * Stored-preference contract (docs/orcha-v2-design-system.md §2.2):
 *  - localStorage `orcha:theme` ("auto" | "light" | "dark") and the per-user
 *    `/api/prefs` bag (mig 040, key `theme`) — SERVER WINS on sync, mirrored
 *    by src/cloud/projects/prefs.ts, APPLIED by src/shell/theme.ts.
 *  - `orcha:skin` stays retired: kept, disclosed, never applied.
 *  - bootAppearance() (run at import; this module is imported from
 *    extensions.ts) kicks the once-per-load /api/prefs sync.
 */
import * as prefs from "../projects/prefs";
import { InterfaceSection } from "../../pages/settings/InterfaceSection";
import "./settings-cards.css";

export function bootAppearance(): void {
  try { void prefs.sync(); } catch { /* no fetch (harness) — localStorage only */ }
}
bootAppearance();

export function AppearanceSection() {
  return <InterfaceSection />;
}

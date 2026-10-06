/**
 * ORCHA CLOUD extension registry — the one open-frontend file Cloud owns.
 * Upstream sync contract: copy frontend/src/** from open Orcha verbatim
 * EXCEPT this file and src/cloud/**. Cloud premium pages register here;
 * a route sharing a path with an open page REPLACES it (access model:
 * CloudHome owns "/" — the vanilla home-boot redirect that sends a bare
 * multi-project "/" to the /projects landing, else renders the open HomePage).
 */
import type { ComponentType } from "react";
import { accountMenu, fetchIdentity, lastTrusted, resetIdentity, type Me } from "./cloud/identity";
import { ProjectsPage } from "./cloud/projects/ProjectsPage";
import { CloudHome } from "./cloud/projects/homeGate";
import { MetricsPage } from "./cloud/metrics/MetricsPage";
import { GitHubPage } from "./cloud/github/GitHubPage";
import { CodeSpacePage } from "./cloud/codespace/CodeSpacePage";
import { codeOnly } from "./cloud/shared/CodeOnlyGate";
import { DevicePage } from "./cloud/device/DevicePage";
import { MembersPage, MembersSection } from "./cloud/members/MembersPage";
// Importing the appearance module also runs its module-level boot hook: the
// once-per-load /api/prefs sync. The theme (System / Light / Dark) is applied by
// shell/theme.ts, which re-applies when the server bag lands; the retired skin
// is kept (not applied, not deleted) and disclosed in Settings › Interface.
import { AppearanceSection } from "./cloud/settings/AppearanceSection";
import { GitHubAccessSection } from "./cloud/settings/GitHubAccessSection";
import { ProviderKeysSection } from "./cloud/settings/ProviderKeysSection";
import { PairingSection } from "./cloud/settings/pairing";

export interface ExtensionRoute {
  path: string;
  element: ComponentType;
}

export interface ExtensionNavItem {
  key: string;
  href: string;
  ico: string;
  label: string;
  count?: (snap: import("./types").Snapshot | null) => number | null;
  attn?: boolean;
}

// Identity + account-menu seam. NOTE: these three declarations are being added
// to open Orcha's extensions.ts upstream in exactly this shape — added here
// ahead of the vendored copy so the next upstream sync is a no-op diff on the
// contract. Open's Shell does not consume them in this repo's copy yet, so
// they are inert until that sync.
export interface Identity {
  agent_id?: string | null;
  alias?: string | null;
  github_login?: string | null;
  member_role?: string | null;
  avatar_url?: string | null;
  grants?: string[] | null; // mig 039 per-member grants (owner implies all)
}

export interface AccountMenuItem {
  label: string;
  href?: string;
  onClick?: () => void;
  danger?: boolean;
}

// Settings-section + topbar-action seam. NOTE: like the identity seam above,
// these declarations match what open Orcha's extensions.ts carries upstream in
// EXACTLY this shape — added here ahead of the vendored copy so the next
// upstream sync is a no-op diff on the contract. The vendored SettingsPage/
// Shell in this repo may not consume them yet; they are inert until that sync.
export interface SettingsSection { key: string; title: string; element: ComponentType } // renders its own <div className="card">…

export interface Extensions {
  routes: ExtensionRoute[];
  nav: ExtensionNavItem[];
  identity?: (cid: string | null) => Promise<Identity | null>;
  // V2 (QA): after `identity` resolves, was the sign-in TRUSTED (verified proxy
  // lane)? With a null identity that is the honest viewer (non-member) state —
  // never the self-host fail-open state, where the legacy human pick applies.
  identityTrusted?: (cid: string | null) => boolean;
  accountMenu?: (identity: Identity | null) => AccountMenuItem[];
  // PS-16: a side-channel re-ask of the identity that BYPASSES the provider's
  // per-page cache. Resolves null when there is no verdict (network, timeout,
  // non-2xx) — the caller then keeps what it has. When the answer differs from
  // what is on screen, the caller calls identityInvalidate() and re-runs the
  // normal identity ask, so a live role change (e.g. demoted to viewer) flips
  // the open UI without a reload.
  identityProbe?: (cid: string | null) => Promise<{ identity: Identity | null; trusted: boolean } | null>;
  identityInvalidate?: () => void;
  settingsSections?: SettingsSection[];
  // General-tab card toggles (consumed by the open SettingsPage): key:false
  // hides the open Anthropic-key card, models:false the model-selection card.
  // Cloud hides the key card and re-homes the Anthropic KeyCard inside the
  // Provider keys section so every provider key has ONE home (vanilla
  // settings.html kept all key cards together under the Workspace tab).
  settingsGeneral?: { key?: boolean; models?: boolean };
  topbarActions?: ComponentType[];   // V2: rendered in the header's compact secondary slot (keep empty unless essential)
}

/** PS-16: GET /api/me uncached (see Extensions.identityProbe). */
export function probeMe(cid: string | null): Promise<Me | null> {
  if (!cid) return Promise.resolve(null);
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), 8_000) : null;
  return fetch("/api/me?cid=" + encodeURIComponent(cid), ctl ? { signal: ctl.signal, cache: "no-store" } : { cache: "no-store" })
    .then(async (r) => {
      if (!r.ok) return null;
      const d = (await r.json()) as { identity?: Me["identity"]; trusted?: boolean } | null;
      return { identity: (d && d.identity) || null, trusted: !!(d && d.trusted) };
    })
    .catch(() => null)
    .finally(() => { if (t) clearTimeout(t); });
}

export const extensions: Extensions = {
  routes: [
    { path: "/", element: CloudHome },
    { path: "/projects", element: ProjectsPage },
    { path: "/metrics", element: MetricsPage },
    // General mode hides these tabs; a direct URL shows a calm notice instead (U04)
    { path: "/github", element: codeOnly("github", GitHubPage) },
    { path: "/code", element: codeOnly("code", CodeSpacePage) },
    { path: "/auth/device", element: DevicePage },   // matches the backend page route
    { path: "/members", element: MembersPage },
  ],
  // Project-section entries (V2 project tab bar + palette, arch §8; the
  // sidebar no longer repeats them — D1). No "projects" entry: the /projects
  // hub is the sidebar's "All projects" footer link. Icons are unique per
  // destination (git mark for GitHub, bar chart for Metrics; Activity = pulse).
  nav: [
    { key: "github", href: "/github", ico: "git", label: "GitHub" },
    { key: "code", href: "/code", ico: "code", label: "Code" },
    { key: "metrics", href: "/metrics", ico: "chart", label: "Metrics" },
  ],
  // The /api/me layer + the sign-out account menu (src/cloud/identity.ts —
  // vanilla data.js fetchMe / app-shell.js actingMenuHtml, ported).
  identity: fetchIdentity,
  identityTrusted: lastTrusted,
  accountMenu,
  identityProbe: probeMe,
  identityInvalidate: resetIdentity,
  // Cloud settings tabs, mirroring vanilla settings.html's grouping order —
  // Workspace (keys + models) → Collaboration (Members, Phone pairing) →
  // Appearance. General (models) + Provider keys cover the old Workspace tab;
  // the open Anthropic-key card is hidden (settingsGeneral.key) because the
  // Provider keys section renders it as its FIRST card, keys all in one home.
  settingsSections: [
    { key: "provider-keys", title: "Provider keys", element: ProviderKeysSection },
    { key: "github-access", title: "GitHub access", element: GitHubAccessSection },
    { key: "members", title: "Members", element: MembersSection },
    { key: "pairing", title: "Phone pairing", element: PairingSection },
    { key: "appearance", title: "Appearance", element: AppearanceSection },
  ],
  settingsGeneral: { key: false },
  // V2 (S-17): the project switcher became the sidebar Projects list and "Pair
  // phone" moved to each project's ⋯ menu + Settings › Devices & pairing, so
  // the header carries no duplicate switcher. The seam stays for downstreams.
  topbarActions: [],
};

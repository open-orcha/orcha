/**
 * Desktop embedded-mode bridge — portal side (docs/orcha-v2-architecture.md §7).
 *
 * The desktop host (C) attaches a dedicated, origin-checked preload to portal
 * WebContentsViews that exposes `window.orchaHost` (version 1). The capability
 * object is authoritative: embedded mode ⇔ host present AND it declares the
 * "sidebar" capability — then the HOST owns the persistent sidebar and the
 * portal renders header + content only. `?embed=desktop` on the first load URL
 * is only a pre-paint hint (index.html sets <html data-embed="desktop"> so the
 * portal sidebar never flashes); if no capable host shows up, the hint is
 * dropped and the portal renders its own sidebar (web mode).
 *
 * Message shapes mirror desktop/src/shared/embed.ts (C). Every inbound message
 * is shape-checked here too; navigation only accepts same-origin safe paths.
 */

/** "theme": the host owns the colour theme (it drives prefers-color-scheme via
 *  Electron nativeTheme) — shell/theme.ts then follows System. */
export type HostCapability = "sidebar" | "notifications" | "stackControl" | "theme" | "revealPath";

export type HostToPortal =
  | { type: "navigate"; path: string }
  | { type: "openSearch" }
  | { type: "hostModal"; open: boolean };

export interface LiveAgentMsg {
  alias: string;
  status: string;
  task: string | null;
  updatedAt: string | null;
}

export type PortalToHost =
  | { type: "ready"; version: 1 }
  | { type: "route"; path: string; search: string; title: string }
  | { type: "attention"; cid: string | null; count: number | null; partial: boolean }
  | { type: "liveAgents"; cid: string | null; agents: LiveAgentMsg[] }
  | { type: "requestHostAction"; action: "startStack" | "stopStack" | "openManager" | "addProject" }
  /** "revealPath": show an agent worktree folder in Finder. The host only accepts a path
   *  inside a known project's .orcha-worktrees folder. */
  | { type: "revealPath"; path: string };

export interface OrchaHostApi {
  version: 1;
  capabilities: HostCapability[];
  project: string;
  send(msg: PortalToHost): void;
  on(cb: (msg: HostToPortal) => void): () => void;
}

declare global {
  interface Window {
    orchaHost?: unknown;
  }
}

/** The host API when a v1-compatible host is present, else null. */
export function getHost(): OrchaHostApi | null {
  if (typeof window === "undefined") return null;
  const h = window.orchaHost as Partial<OrchaHostApi> | undefined;
  if (!h || h.version !== 1) return null;
  if (!Array.isArray(h.capabilities) || typeof h.send !== "function" || typeof h.on !== "function") return null;
  return h as OrchaHostApi;
}

/** Embedded ⇔ the host owns the sidebar. */
export function isEmbedded(host: OrchaHostApi | null = getHost()): boolean {
  return !!host && host.capabilities.includes("sidebar");
}

/** Same-origin, single-slash absolute path (the desktop deep-link safe-path rule). */
export function isSafePath(path: unknown): path is string {
  return typeof path === "string" && /^\/(?![/\\])/.test(path) && !/[\u0000-\u001f]/.test(path);
}

/** Validate an inbound host message; unknown / malformed → null (dropped). */
export function parseHostMessage(m: unknown): HostToPortal | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (o.type === "navigate" && isSafePath(o.path)) return { type: "navigate", path: o.path };
  if (o.type === "openSearch") return { type: "openSearch" };
  if (o.type === "hostModal" && typeof o.open === "boolean") return { type: "hostModal", open: o.open };
  return null;
}

/**
 * Reconcile the pre-paint hint with the real capability: keep
 * <html data-embed="desktop"> only when a sidebar-capable host is present;
 * set it if the host is present without the hint (e.g. a reload that lost the
 * query). Returns the resolved embedded flag.
 */
export function syncEmbedAttribute(host: OrchaHostApi | null = getHost()): boolean {
  const d = document.documentElement;
  const embedded = isEmbedded(host);
  if (embedded) d.setAttribute("data-embed", "desktop");
  else d.removeAttribute("data-embed");
  return embedded;
}

/** Send, swallowing host errors (the host validates and may drop). */
export function sendToHost(msg: PortalToHost, host: OrchaHostApi | null = getHost()): void {
  if (!host) return;
  try { host.send(msg); } catch { /* host went away — web mode keeps working */ }
}

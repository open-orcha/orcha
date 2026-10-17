/**
 * Project scope (?cid=) resolution & propagation.
 *
 * A single-container open stack never shows cid in the URL (no noise). On a
 * multi-container stack (cloud, or any stack reached via an explicit ?cid=)
 * the resolved cid must survive every internal navigation, so:
 *  - `resolveCidScope` resolves the cid like api/client.resolveCid AND records
 *    whether the stack is multi-container (presence of ?cid= in the URL is
 *    itself treated as multi — the link that brought us here was scoped);
 *  - `ensureCidInLocation` history.replaceState's ?cid= into the current URL
 *    (preserving path, other params and hash);
 *  - `installCidLinkInterceptor` registers ONE document-level capture-phase
 *    click listener that upgrades same-origin <a> hrefs lacking cid just
 *    before navigation — every internal link inherits scope with zero page
 *    edits. (SPA <Link> navigations bypass the DOM href; the Shell re-applies
 *    ensureCidInLocation on every route change to cover those.)
 */
import { getJSON } from "../api/client";

export interface CidScope {
  cid: string | null;
  multi: boolean;
}

export function cidFromUrl(search?: string): string | null {
  return new URLSearchParams(search ?? window.location.search).get("cid");
}

/** ?cid= wins (and implies multi); else the sole/active container from /api/containers. */
export async function resolveCidScope(): Promise<CidScope> {
  const q = cidFromUrl();
  if (q) return { cid: q, multi: true };
  const list = await getJSON<unknown>("/api/containers");
  const arr = Array.isArray(list)
    ? (list as { id: string; status?: string }[])
    : ((list as { containers?: { id: string; status?: string }[] }).containers ?? []);
  const active = arr.find((c) => c.status === "active") || arr[0];
  return { cid: active ? active.id : null, multi: arr.length > 1 };
}

/** Append ?cid= to an href when absent (same-origin relative form; query & hash preserved). */
export function withCid(href: string, cid: string): string {
  let u: URL;
  try {
    u = new URL(href, window.location.href);
  } catch {
    return href;
  }
  if (u.searchParams.has("cid")) return href;
  u.searchParams.set("cid", cid);
  return u.pathname + u.search + u.hash;
}

/** replaceState ?cid= into the CURRENT url when scoped (multi) and missing. */
export function ensureCidInLocation(scope: CidScope): void {
  if (!scope.multi || !scope.cid) return;
  const u = new URL(window.location.href);
  if (u.searchParams.has("cid")) return;
  u.searchParams.set("cid", scope.cid);
  try {
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  } catch {
    /* sandboxed/about: contexts */
  }
}

/** Is this anchor a plain same-origin navigation we should scope? */
export function shouldUpgradeAnchor(a: HTMLAnchorElement, e: MouseEvent): boolean {
  if (e.defaultPrevented) return false;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const target = a.getAttribute("target");
  if (target && target !== "_self") return false;
  if (a.hasAttribute("download")) return false;
  const raw = a.getAttribute("href");
  if (!raw || raw.startsWith("#")) return false; // hash-only / empty
  let u: URL;
  try {
    u = new URL(raw, window.location.href);
  } catch {
    return false;
  }
  if (u.origin !== window.location.origin) return false;
  // same-page hash jump spelled as a full path
  if (u.hash && u.pathname === window.location.pathname && u.search === window.location.search) return false;
  if (u.searchParams.has("cid")) return false;
  return true;
}

/**
 * ONE document-level capture-phase click interceptor: rewrites qualifying
 * anchors' hrefs to carry ?cid= at the last moment before the browser (or
 * router) acts on them. No-op while the scope is single-container or the cid
 * is unknown. Returns the uninstaller.
 */
export function installCidLinkInterceptor(getScope: () => CidScope): () => void {
  const onClick = (e: MouseEvent) => {
    const scope = getScope();
    if (!scope.multi || !scope.cid) return; // single-container open stack: no URL noise
    const t = e.target;
    const a = t instanceof Element ? t.closest("a") : null;
    if (!a || !(a instanceof HTMLAnchorElement)) return;
    if (!shouldUpgradeAnchor(a, e)) return;
    a.setAttribute("href", withCid(a.getAttribute("href") as string, scope.cid));
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}


/* ---- programmatic navigation that keeps project scope ---------------------
 * The click interceptor upgrades <a> clicks, but raw `location.href = ...`
 * assignments bypass it entirely — on a multi-project stack that full load
 * re-resolves to the DEFAULT container and silently switches projects.
 * SnapshotProvider registers the live scope here; navigateScoped is the only
 * sanctioned way to hard-navigate. */
let _currentScope: CidScope = { cid: null, multi: false };
export function registerScope(scope: CidScope): void {
  _currentScope = scope;
}
export function navigateScoped(href: string): void {
  const s = _currentScope;
  window.location.href = s.multi && s.cid ? withCid(href, s.cid) : href;
}

/* ---- V2 project switching (docs/orcha-v2-architecture.md §4) -------------
 * Switching projects stays a FULL navigation with ?cid=<target> — the
 * guarantee that no in-memory state (snapshot, identity, drafts, streams)
 * from project A survives into project B. The landing path keeps the current
 * section when it is project-scoped, and drops entity params (an entity id
 * from project A is meaningless in project B). */
export const PROJECT_SECTIONS = [
  "/", "/tasks", "/agents", "/requests", "/needs", "/activity",
  "/code", "/github", "/metrics", "/settings", "/members",
];
export const ENTITY_PARAMS = ["task", "req", "agent", "pr", "issue", "path", "line", "thread", "run", "item", "ref", "browse", "new"];

/** The URL a project switch lands on (pure; exported for tests). */
export function projectSwitchHref(cid: string, fromPath?: string, fromSearch?: string): string {
  const path = fromPath ?? window.location.pathname;
  const section = PROJECT_SECTIONS.includes(path) ? path : "/";
  const q = new URLSearchParams(section === path ? (fromSearch ?? window.location.search) : "");
  ENTITY_PARAMS.forEach((k) => q.delete(k));
  q.set("cid", cid);
  return section + "?" + q.toString();
}

/** Full-navigation project switch (`path` overrides the landing path). */
export function switchProject(cid: string, path?: string): void {
  const href = path ? withCidForced(path, cid) : projectSwitchHref(cid);
  window.location.assign(href);
}

/** Like withCid, but REPLACES an existing cid (target project wins). */
export function withCidForced(href: string, cid: string): string {
  let u: URL;
  try {
    u = new URL(href, window.location.href);
  } catch {
    return href;
  }
  u.searchParams.set("cid", cid);
  return u.pathname + u.search + u.hash;
}

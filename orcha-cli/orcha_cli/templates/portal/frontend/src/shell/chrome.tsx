/**
 * Shell chrome state shared by the persistent sidebar, the header and the
 * command palette: palette open/close + global hotkeys, the Execution controls
 * popover (so the palette can open it), the narrow-width drawer, and the
 * desktop embedded-mode bridge (docs/orcha-v2-architecture.md §7).
 *
 * `AppFrame` (registered as a layout route in main.tsx) mounts the sidebar
 * ONCE for every in-app page, so navigating between sections never remounts
 * it (scroll, expanded rows and the project list survive). A page rendered
 * without the frame (unit tests mounting a page directly) gets the same chrome
 * from <Shell>, which renders its own sidebar in that case.
 */
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { isEditingTarget, isEditorOrTerminal } from "../components/primitives/focus";
import { useAttention } from "../state/attention";
import { getHost, parseHostMessage, sendToHost, syncEmbedAttribute, type OrchaHostApi } from "../state/host";
import { useActingAuthority, useSnapshot } from "../state/SnapshotProvider";
import { useToast } from "../components/ui";
import { liveAgents } from "./liveAgents";
import { CREATE_TASK_KEY } from "./search/providers";

const CommandPalette = lazy(() => import("./search/Palette").then((m) => ({ default: m.CommandPalette })));
// Shell-owned global composer: the SAME New task dialog the Tasks page uses,
// opened over whatever route you are on (Esc leaves you where you were).
const GlobalComposer = lazy(() => import("./GlobalComposer"));

/** Where "New task" opens (pure, tested): the Tasks page owns its own composer
 *  (`?new=1` — it also selects the created task); every other route gets the
 *  Shell's global modal and stays put. */
export function composeTarget(pathname: string): "tasks-page" | "global" {
  return pathname === "/tasks" ? "tasks-page" : "global";
}

export interface Chrome {
  /** true inside AppFrame: the frame renders the sidebar, Shell must not */
  framed: boolean;
  /** desktop host owns navigation (sidebar hidden, header + content only) */
  embedded: boolean;
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  execOpen: boolean;
  setExecOpen: (open: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  hostModal: boolean;
  /** Open the New task composer over the current route (Linear "c"); on /tasks it defers to the page. */
  openCompose: (opts?: { assignee?: string | null }) => void;
  composeOpen: boolean;
}

const ChromeCtx = createContext<Chrome | null>(null);

export function useChrome(): Chrome | null {
  return useContext(ChromeCtx);
}

/** "New task" from anywhere: the Shell composer over the current route when a
 *  ChromeProvider is mounted, else the Tasks page composer (`/tasks?new=1`). */
export function useOpenCompose(): (opts?: { assignee?: string | null }) => void {
  const chrome = useContext(ChromeCtx);
  const navigate = useNavigate();
  return useCallback((opts?: { assignee?: string | null }) => {
    if (chrome) { chrome.openCompose(opts); return; }
    navigate("/tasks?new=1" + (opts?.assignee ? "&for=" + encodeURIComponent(opts.assignee) : ""));
  }, [chrome, navigate]);
}

/** Resolve embedded mode once per page load (capability is authoritative). */
function useHost(): { host: OrchaHostApi | null; embedded: boolean } {
  return useMemo(() => {
    const host = getHost();
    const embedded = typeof document !== "undefined" ? syncEmbedAttribute(host) : false;
    return { host, embedded };
  }, []);
}

export function ChromeProvider({ framed, children }: { framed: boolean; children: ReactNode }) {
  const { host, embedded } = useHost();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [execOpen, setExecOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hostModal, setHostModal] = useState(false);
  const [compose, setCompose] = useState<{ assignee: string | null } | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { snap, cid, multi } = useSnapshot();
  const attention = useAttention();

  const openPalette = useCallback(() => { if (!hostModal) setPaletteOpen(true); }, [hostModal]);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openCompose = useCallback((opts?: { assignee?: string | null }) => {
    setPaletteOpen(false);
    if (composeTarget(location.pathname) === "tasks-page") {
      const sp = new URLSearchParams(location.search);
      sp.set("new", "1");
      if (opts?.assignee) sp.set("for", opts.assignee); else sp.delete("for");
      navigate({ pathname: "/tasks", search: "?" + sp.toString() });
      return;
    }
    setCompose({ assignee: opts?.assignee ?? null });
  }, [location.pathname, location.search, navigate]);

  // "c" (Linear's create key) reads the latest openCompose / open state via refs
  // so the keydown listener is not re-bound on every route change.
  const composeRef = useRef(openCompose);
  composeRef.current = openCompose;
  const busyRef = useRef(false);
  busyRef.current = paletteOpen || !!compose || hostModal;
  // same rule as the palette's New task action: never impersonate a human
  const authority = useActingAuthority();
  const toast = useToast();
  const denyRef = useRef<string | null>(null);
  denyRef.current = authority.human ? null : (authority.reason || "Pick an acting human first — actions never impersonate a human");
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // global hotkeys: Cmd/Ctrl+K toggles the palette everywhere EXCEPT inside
  // CodeMirror / xterm (they may bind it); "/" opens it only when focus is not
  // in any text entry, editor or terminal; "c" opens the New task composer
  // under the same rule, and never while a dialog, menu or popover is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = (e.target as Element | null) ?? document.activeElement;
      if (isCreateKey(e) && !e.defaultPrevented && !busyRef.current
        && !isEditingTarget(target) && !isEditingTarget(document.activeElement) && !overlayOpen()) {
        e.preventDefault();
        if (denyRef.current) toastRef.current(denyRef.current, "warn");
        else composeRef.current();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        if (isEditorOrTerminal(target)) return;
        e.preventDefault();
        setPaletteOpen((v) => !v && !hostModal);
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditingTarget(target) && !isEditingTarget(document.activeElement)) {
        if (document.querySelector(".v2-overlay, .overlay.show")) return;
        e.preventDefault();
        setPaletteOpen(!hostModal);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hostModal]);

  // navigation closes transient chrome
  useEffect(() => { setDrawerOpen(false); setExecOpen(false); }, [location.pathname]);

  // drawer: Escape closes, and <html data-drawer> drives the CSS
  useEffect(() => {
    const d = document.documentElement;
    if (drawerOpen) d.setAttribute("data-drawer", "open");
    else d.removeAttribute("data-drawer");
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); d.removeAttribute("data-drawer"); };
  }, [drawerOpen]);

  /* ---- desktop host bridge (only when a v1 host is present) --------------- */
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const cidRef = useRef(cid);
  cidRef.current = cid;
  useEffect(() => {
    if (!host) return;
    sendToHost({ type: "ready", version: 1 }, host);
    const off = host.on((raw) => {
      const m = parseHostMessage(raw);
      if (!m) return;
      if (m.type === "navigate") {
        // A path scoped to a DIFFERENT container than the one this page
        // resolved must be a full load: the provider resolves cid once, so an
        // SPA navigate would show project Y's data under project X's URL.
        if (hostPathNeedsFullLoad(m.path, cidRef.current)) window.location.assign(m.path);
        else navRef.current(m.path);
      }
      else if (m.type === "openSearch") setPaletteOpen(true);
      else if (m.type === "hostModal") {
        setHostModal(m.open);
        if (m.open) { setPaletteOpen(false); setExecOpen(false); }
      }
    });
    return () => { try { off(); } catch { /* host gone */ } };
  }, [host]);

  // The ?cid= pin is a raw history.replaceState the router never observes,
  // and the host derives the open container from `search` — so on multi-
  // container stacks always report the RESOLVED cid (re-sent once it resolves).
  const lastRouteRef = useRef<string | null>(null);
  useEffect(() => {
    if (!host) return;
    const search = routeSearchWithCid(location.search, cid, multi);
    const sig = location.pathname + search + "\u0000" + location.key;
    if (lastRouteRef.current === sig) return; // cid resolved without changing what the host sees
    lastRouteRef.current = sig;
    sendToHost({ type: "route", path: location.pathname, search, title: document.title }, host);
  }, [host, location.pathname, location.search, location.key, cid, multi]);

  useEffect(() => {
    if (!host) return;
    sendToHost({ type: "attention", cid, count: attention.count, partial: attention.partial }, host);
  }, [host, cid, attention.count, attention.partial]);

  const agentsSig = useMemo(() => JSON.stringify(liveAgents(snap, 5).map((a) => [a.alias, a.status, a.task, a.updatedAt])), [snap]);
  useEffect(() => {
    if (!host) return;
    sendToHost({ type: "liveAgents", cid, agents: liveAgents(snap, 5).map((a) => ({ alias: a.alias, status: a.status, task: a.task, updatedAt: a.updatedAt })) }, host);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, cid, agentsSig]);

  const value = useMemo<Chrome>(() => ({
    framed, embedded, paletteOpen, openPalette, closePalette, execOpen, setExecOpen, drawerOpen, setDrawerOpen, hostModal,
    openCompose, composeOpen: !!compose,
  }), [framed, embedded, paletteOpen, openPalette, closePalette, execOpen, drawerOpen, hostModal, openCompose, compose]);

  return (
    <ChromeCtx.Provider value={value}>
      {children}
      {paletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette onClose={closePalette} embedded={embedded} openExecutionControls={() => setExecOpen(true)} openCompose={openCompose} />
        </Suspense>
      ) : null}
      {compose ? (
        <Suspense fallback={null}>
          <GlobalComposer
            initialAssignee={compose.assignee}
            onClose={() => setCompose(null)}
            onCreated={(taskId) => {
              setCompose(null);
              if (taskId) navigate({ pathname: "/tasks", search: "?task=" + encodeURIComponent(taskId) });
            }}
          />
        </Suspense>
      ) : null}
    </ChromeCtx.Provider>
  );
}

/** The New task hotkey (Linear "c"): a bare c — no modifier, not a held repeat. Pure, tested. */
export { CREATE_TASK_KEY };
export function isCreateKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat">): boolean {
  return e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat;
}

/** A modal dialog, menu or popover (Popover renders only while open) is open: single-key hotkeys stay off. */
function overlayOpen(): boolean {
  return !!document.querySelector(
    '.v2-overlay, .overlay.show, [aria-modal="true"], .v2-popover, #ncFloat.show',
  );
}

/** Router search + the resolved cid on multi-container stacks (pure, tested). */
export function routeSearchWithCid(search: string, cid: string | null, multi: boolean): string {
  if (!cid || !multi) return search;
  const p = new URLSearchParams(search);
  if (p.get("cid") === cid) return search;
  p.set("cid", cid);
  return "?" + p.toString();
}

/**
 * Host navigate → full load when the path names another container (pure, tested).
 * Before the portal's cid has resolved, the page's own ?cid= (what the
 * provider is resolving) stands in for it: a path naming a DIFFERENT container
 * — or any container while this page has none pinned — is a full load, so an
 * in-flight resolution can never pair project X's URL with project Y's data.
 */
export function hostPathNeedsFullLoad(path: string, currentCid: string | null, locationSearch?: string): boolean {
  let target: string | null = null;
  try { target = new URL(path, "http://x").searchParams.get("cid"); } catch { return false; }
  if (!target) return false;
  if (currentCid) return target !== currentCid;
  let pinned: string | null = null;
  try {
    pinned = new URLSearchParams(locationSearch ?? (typeof window !== "undefined" ? window.location.search : "")).get("cid");
  } catch { pinned = null; }
  return target !== pinned;
}

/** Layout route: persistent sidebar + the routed page (which renders <Shell> header/content). */
export function AppFrame({ sidebar }: { sidebar: ReactNode }) {
  return (
    <ChromeProvider framed>
      <FrameBody sidebar={sidebar} />
    </ChromeProvider>
  );
}

function FrameBody({ sidebar }: { sidebar: ReactNode }) {
  const chrome = useChrome();
  return (
    <div className="v2-app">
      {chrome?.embedded ? null : sidebar}
      <div className="v2-frame-main">
        <Outlet />
      </div>
    </div>
  );
}

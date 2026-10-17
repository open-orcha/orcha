/**
 * The route table (owner: B). Every pre-V2 URL keeps rendering the same page
 * (parity R-01…R-18); V2 adds /needs (D) and /activity (E) when those pages
 * exist (./optionalPages). A downstream extension route with the SAME path
 * replaces the open one (Cloud's CloudHome owns "/").
 *
 * In-app pages render inside <AppFrame> — the persistent sidebar is mounted
 * once and survives navigation. Standalone pages (the /auth/device token page)
 * render without any chrome, exactly as before.
 */
import { lazy, Suspense, type ComponentType } from "react";
import { Route, Routes } from "react-router-dom";
import { HomePage } from "../pages/home/HomePage";
import { AgentsPage } from "../pages/agents/AgentsPage";
import { OrgPage } from "../pages/org/OrgPage";
import { RoutinesPage } from "../pages/routines/RoutinesPage";
import { TasksPage } from "../pages/tasks/TasksPage";
import { RequestsPage } from "../pages/requests/RequestsPage";
import { SettingsPage } from "../pages/settings/SettingsPage";
import { OnboardingPage } from "../pages/onboarding/OnboardingPage";
import { extensions } from "../extensions";
import { Skeleton } from "../components/primitives/Layout";
import { AppFrame } from "./chrome";
import { Sidebar } from "./Sidebar";
import { loadActivityPage, loadNeedsPage } from "./optionalPages";

/* ---- cross-document view transitions (tokens.css `@view-transition`) -------
 * A project switch is a full load. When the new document calls
 * history.replaceState (the ?cid= re-pin) or is revealed hidden/prerendered,
 * Chromium aborts the automatic transition and REJECTS its promises — an
 * unhandled "Transition was aborted because of invalid state" on every switch.
 * Guard: skip the transition when the page is not visible, and always observe
 * the promises so an abort is a no-op instead of a page error. */
type VT = { ready?: Promise<unknown>; finished?: Promise<unknown>; updateCallbackDone?: Promise<unknown>; skipTransition?: () => void };
type RevealEvent = Event & { viewTransition?: VT | null; activation?: { entry?: { url?: string } | null } | null };
export function guardViewTransition(e: RevealEvent, visibility: string = typeof document !== "undefined" ? document.visibilityState : "visible", skip = false): void {
  const vt = e.viewTransition;
  if (!vt) return;
  const swallow = () => {};
  vt.ready?.catch(swallow);
  vt.finished?.catch(swallow);
  vt.updateCallbackDone?.catch(swallow);
  if (skip || visibility !== "visible") vt.skipTransition?.();
}

/**
 * Should the OUTGOING page skip its cross-document transition (pure, tested)?
 * A project switch (different ?cid), a hash deep link (/settings#tab=…) or an
 * unknown destination lands on a document that re-pins its URL / scrolls on
 * load — Chromium then aborts the transition inside the NEW document before
 * its module script can observe the promises (the unhandled "Transition was
 * aborted because of invalid state" on every switch). Skipping on the old
 * side means the new document never receives a transition to abort.
 */
export function skipSwapTransition(fromHref: string, toHref: string | null | undefined): boolean {
  if (!toHref) return true;
  let from: URL, to: URL;
  try { from = new URL(fromHref); to = new URL(toHref, fromHref); } catch { return true; }
  if (to.origin !== from.origin) return true;
  if (to.hash) return true;
  return (to.searchParams.get("cid") ?? "") !== (from.searchParams.get("cid") ?? "");
}

if (typeof window !== "undefined") {
  window.addEventListener("pagereveal", (e) => guardViewTransition(e as RevealEvent));
  window.addEventListener("pageswap", (e) => {
    const ev = e as RevealEvent;
    guardViewTransition(ev, undefined, skipSwapTransition(window.location.href, ev.activation?.entry?.url));
  });
}

export interface RouteSpec {
  path: string;
  element: ComponentType;
  /** rendered without the V2 frame (no sidebar/header) */
  standalone?: boolean;
}

/** Paths rendered without chrome (they were chrome-less before V2 too). */
export const STANDALONE_PATHS = ["/auth/device"];

const OPEN_ROUTES: RouteSpec[] = [
  { path: "/", element: HomePage },
  { path: "/agents", element: AgentsPage },
  { path: "/org", element: OrgPage },
  { path: "/routines", element: RoutinesPage },
  { path: "/tasks", element: TasksPage },
  { path: "/requests", element: RequestsPage },
  { path: "/settings", element: SettingsPage },
  { path: "/onboarding", element: OnboardingPage },
];

function lazyPage<K extends string>(load: (() => Promise<Record<K, ComponentType>>) | null, name: K): ComponentType | null {
  if (!load) return null;
  const Lazy = lazy(async (): Promise<{ default: ComponentType }> => ({ default: (await load())[name] }));
  return function LazyPage() {
    return (
      <Suspense fallback={<div className="v2-content"><Skeleton lines={6} label="Loading page" /></div>}>
        <Lazy />
      </Suspense>
    );
  };
}

const NeedsPage = lazyPage(loadNeedsPage, "NeedsPage");
const ActivityPage = lazyPage(loadActivityPage, "ActivityPage");

/** The resolved route table (exported for route-compatibility tests). */
export function routeTable(): RouteSpec[] {
  const v2: RouteSpec[] = [
    ...(NeedsPage ? [{ path: "/needs", element: NeedsPage }] : []),
    ...(ActivityPage ? [{ path: "/activity", element: ActivityPage }] : []),
  ];
  const overridden = new Set(extensions.routes.map((r) => r.path));
  const all = [...extensions.routes, ...OPEN_ROUTES.filter((r) => !overridden.has(r.path)), ...v2.filter((r) => !overridden.has(r.path))];
  return all.map((r) => ({ ...r, standalone: STANDALONE_PATHS.includes(r.path) }));
}

export function AppRoutes() {
  const table = routeTable();
  return (
    <Routes>
      {table.filter((r) => r.standalone).map((r) => (
        <Route key={r.path} path={r.path} element={<r.element />} />
      ))}
      <Route element={<AppFrame sidebar={<Sidebar />} />}>
        {table.filter((r) => !r.standalone).map((r) => (
          <Route key={r.path} path={r.path} element={<r.element />} />
        ))}
        {/* unknown path → the project Overview, never a blank page (R-13) */}
        <Route path="*" element={<HomePage />} />
      </Route>
    </Routes>
  );
}

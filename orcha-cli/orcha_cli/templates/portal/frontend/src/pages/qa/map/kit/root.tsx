/**
 * The root every ported QA view renders inside: the design tokens (`.qa-port`), the styles those
 * views share, one confirm dialog, and `useRouter` / `useSearchParams` / `usePathname` on the
 * portal's router. `refresh` re-reads the view's data (QaNav.refresh).
 */
import "@xyflow/react/dist/style.css";
import "../utilities.css";
import "../port.css";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams as useRouterSearchParams } from "react-router-dom";
import { ConfirmProvider } from "./confirm";

const RefreshCtx = createContext<() => void>(() => {});

export function PortRoot({ refresh, children, className }: { refresh: () => void; children: ReactNode; className?: string }) {
  return (
    <RefreshCtx.Provider value={refresh}>
      {/* The confirm dialog inside the root: its tokens and utilities live under `.qa-port`. */}
      <div className={"qa-port qa-port-root" + (className ? " " + className : "")}>
        <ConfirmProvider>{children}</ConfirmProvider>
      </div>
    </RefreshCtx.Provider>
  );
}

export function useRouter() {
  const navigate = useNavigate();
  const refresh = useContext(RefreshCtx);
  return useMemo(() => ({
    push: (href: string) => { navigate(href); },
    replace: (href: string) => { navigate(href, { replace: true }); },
    refresh,
    back: () => { navigate(-1); },
  }), [navigate, refresh]);
}

export function useSearchParams(): URLSearchParams {
  return useRouterSearchParams()[0];
}

export function usePathname(): string {
  return useLocation().pathname;
}

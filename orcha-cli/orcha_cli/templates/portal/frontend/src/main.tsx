import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ToastProvider } from "./components/ui";
import { SnapshotProvider, useSnapshot } from "./state/SnapshotProvider";
import { PortalDictationProvider } from "./dictation/PortalDictation";
import { initTheme } from "./shell/theme";
import { AppRoutes } from "./shell/routes";

// Routing: react-router BrowserRouter over clean URLs (/tasks?task=…). Every
// page URL is served by an explicit FastAPI page route that returns the built
// SPA shell (portal_backend/dashboard_routes.py), so a hard reload of any
// route works. (GAP-08: an older comment here claimed hash routing.)
// The shared token layer (static/styles.css, served at /assets/styles.css) is
// linked at runtime: an href in index.html would get base-prefixed by Vite.
if (!document.querySelector('link[href="/assets/styles.css"]')) {
  // fallback only — the build injects a blocking <link> (vite sharedCssPlugin)
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/assets/styles.css";
  document.head.appendChild(l);
}
// Appearance (System / Light / Dark): apply the resolved theme before the first
// React render and keep it live (index.html already did it pre-paint).
initTheme();

/** Dictation for every text field (src/dictation): needs the project id for the cloud engine. */
function DictationRoot({ children }: { children: React.ReactNode }) {
  const { cid } = useSnapshot();
  return <PortalDictationProvider cid={cid}>{children}</PortalDictationProvider>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <SnapshotProvider>
        <DictationRoot>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </DictationRoot>
      </SnapshotProvider>
    </ToastProvider>
  </React.StrictMode>,
);

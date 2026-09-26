import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/ui";
import { SnapshotProvider } from "./state/SnapshotProvider";
import { initTheme } from "./shell/Shell";
import { HomePage } from "./pages/home/HomePage";
import { AgentsPage } from "./pages/agents/AgentsPage";
import { TasksPage } from "./pages/tasks/TasksPage";
import { RequestsPage } from "./pages/requests/RequestsPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { OnboardingPage } from "./pages/onboarding/OnboardingPage";
import { extensions } from "./extensions";

// Hash routing keeps the SPA servable from ONE static file (/assets/dist/) with
// the FastAPI backend untouched — no history-fallback route needed server-side.
// The shared token layer (static/styles.css, served at /assets/styles.css) is
// linked at runtime: an href in index.html would get base-prefixed by Vite.
if (!document.querySelector('link[href="/assets/styles.css"]')) {
  // fallback only — the build injects a blocking <link> (vite sharedCssPlugin)
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/assets/styles.css";
  document.head.appendChild(l);
}
initTheme();

// Open page routes. A downstream extension route with the SAME path replaces
// the open one (e.g. Cloud's access-model landing overriding "/"), so the
// registry can both add and override without forking this file.
const OPEN_ROUTES: { path: string; element: React.ComponentType }[] = [
  { path: "/", element: HomePage },
  { path: "/agents", element: AgentsPage },
  { path: "/tasks", element: TasksPage },
  { path: "/requests", element: RequestsPage },
  { path: "/settings", element: SettingsPage },
  { path: "/onboarding", element: OnboardingPage },
];
const overridden = new Set(extensions.routes.map((r) => r.path));
const routes = [...extensions.routes, ...OPEN_ROUTES.filter((r) => !overridden.has(r.path))];

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <SnapshotProvider>
        <BrowserRouter>
          <Routes>
            {routes.map((r) => (
              <Route key={r.path} path={r.path} element={<r.element />} />
            ))}
            <Route path="*" element={<HomePage />} />
          </Routes>
        </BrowserRouter>
      </SnapshotProvider>
    </ToastProvider>
  </React.StrictMode>,
);

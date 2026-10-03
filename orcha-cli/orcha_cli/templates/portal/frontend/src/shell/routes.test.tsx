/**
 * Route compatibility (parity R-01…R-19): every pre-V2 URL — with its query
 * string and hash — still renders the same page inside the V2 frame; unknown
 * paths fall back to the Overview (never blank); /auth/device stays
 * standalone; the Vite dev server serves every routed path (GAP-09).
 * Pages are mocked: this suite is about the ROUTE TABLE, not page content.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";

function Probe({ name }: { name: string }) {
  const loc = useLocation();
  return <div data-testid="page">{name}|{loc.pathname}{loc.search}{loc.hash}</div>;
}
vi.mock("../pages/home/HomePage", () => ({ HomePage: () => <Probe name="home" /> }));
vi.mock("../pages/agents/AgentsPage", () => ({ AgentsPage: () => <Probe name="agents" /> }));
vi.mock("../pages/tasks/TasksPage", () => ({ TasksPage: () => <Probe name="tasks" /> }));
vi.mock("../pages/requests/RequestsPage", () => ({ RequestsPage: () => <Probe name="requests" /> }));
vi.mock("../pages/settings/SettingsPage", () => ({ SettingsPage: () => <Probe name="settings" /> }));
vi.mock("../pages/onboarding/OnboardingPage", () => ({ OnboardingPage: () => <Probe name="onboarding" /> }));
vi.mock("../cloud/projects/homeGate", () => ({ CloudHome: () => <Probe name="home" /> }));
vi.mock("../cloud/projects/ProjectsPage", () => ({ ProjectsPage: () => <Probe name="projects" /> }));
vi.mock("../cloud/metrics/MetricsPage", () => ({ MetricsPage: () => <Probe name="metrics" /> }));
vi.mock("../cloud/github/GitHubPage", () => ({ GitHubPage: () => <Probe name="github" /> }));
vi.mock("../cloud/codespace/CodeSpacePage", () => ({ CodeSpacePage: () => <Probe name="code" /> }));
vi.mock("../cloud/device/DevicePage", () => ({ DevicePage: () => <Probe name="device" /> }));
vi.mock("../cloud/members/MembersPage", () => ({ MembersPage: () => <Probe name="members" />, MembersSection: () => null }));

import { AppRoutes, routeTable, STANDALONE_PATHS } from "./routes";
import { HAS_ACTIVITY_PAGE, HAS_NEEDS_PAGE } from "./optionalPages";

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json({ containers: [{ id: "c1", name: "Website", status: "active" }] });
    if (url.startsWith("/api/containers/c1")) {
      return json({ container: { id: "c1", name: "Website", status: "active", autonomy_level: "plan" }, agents: [], tasks: [], requests: [] });
    }
    return json({});
  }) as unknown as typeof fetch;
}

function at(url: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[url]}>
          <AppRoutes />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const LEGACY: [string, string][] = [
  ["/", "home"],
  ["/?cid=c1", "home"],
  ["/projects", "projects"],
  ["/tasks?task=t1&cid=c1", "tasks"],
  ["/requests?req=r1", "requests"],
  ["/agents?agent=Atlas", "agents"],
  ["/settings#tab=pairing", "settings"],
  ["/settings#tab=general", "settings"],
  ["/settings#tab=provider-keys", "settings"],
  ["/settings#tab=appearance", "settings"],
  ["/onboarding?new=1", "onboarding"],
  ["/onboarding?step=create-agent", "onboarding"],
  ["/metrics?agent=a1", "metrics"],
  ["/github?pr=12", "github"],
  ["/github?browse=1&ref=main&path=src", "github"],
  ["/code?path=src/a.ts&line=3&thread=x", "code"],
  ["/members", "members"],
];

describe("route compatibility", () => {
  beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); stubFetch(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it.each(LEGACY)("%s renders the %s page inside the V2 frame with its URL intact", async (url, name) => {
    at(url);
    const page = await screen.findByTestId("page");
    expect(page.textContent).toBe(name + "|" + url);
    expect(document.getElementById("sidebar")).toBeTruthy(); // framed
  });

  it("unknown paths fall back to the Overview (never blank)", async () => {
    at("/no/such/page?x=1");
    expect((await screen.findByTestId("page")).textContent).toBe("home|/no/such/page?x=1");
  });

  it("/auth/device stays standalone (no sidebar/header chrome)", async () => {
    at("/auth/device");
    expect((await screen.findByTestId("page")).textContent).toBe("device|/auth/device");
    expect(document.getElementById("sidebar")).toBeNull();
    expect(STANDALONE_PATHS).toEqual(["/auth/device"]);
  });

  it("the sidebar is mounted ONCE by the frame (it does not remount per page)", async () => {
    at("/tasks");
    await screen.findByTestId("page");
    await waitFor(() => expect(document.querySelectorAll("#sidebar")).toHaveLength(1));
  });

  it("/needs and /activity are registered exactly when their pages exist", () => {
    const paths = routeTable().map((r) => r.path);
    expect(paths.includes("/needs")).toBe(HAS_NEEDS_PAGE);
    expect(paths.includes("/activity")).toBe(HAS_ACTIVITY_PAGE);
  });

  it("every routed path is served by the Vite dev server too (GAP-09)", () => {
    const cfg = readFileSync(resolve(__dirname, "../../vite.config.ts"), "utf8");
    const list = cfg.slice(cfg.indexOf("PAGE_ROUTES = ["), cfg.indexOf("];", cfg.indexOf("PAGE_ROUTES = [")));
    for (const r of routeTable()) expect(list).toContain(`"${r.path}"`);
    for (const p of ["/needs", "/activity"]) expect(list).toContain(`"${p}"`);
  });
});

describe("desktop embedded mode (arch §7)", () => {
  beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); stubFetch(); });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete window.orchaHost;
    document.documentElement.removeAttribute("data-embed");
  });

  it("a sidebar-capable host hides the portal sidebar and hears ready/route/attention; host navigate uses the SPA router", async () => {
    let listener: ((m: unknown) => void) | null = null;
    const send = vi.fn();
    window.orchaHost = {
      version: 1, capabilities: ["sidebar", "notifications"], project: "orcha-x", send,
      on: (cb: (m: unknown) => void) => { listener = cb; return () => { listener = null; }; },
    };
    at("/tasks?cid=c1");
    await screen.findByTestId("page");
    expect(document.getElementById("sidebar")).toBeNull();
    expect(document.documentElement.getAttribute("data-embed")).toBe("desktop");
    const types = () => send.mock.calls.map((c) => (c[0] as { type: string }).type);
    await waitFor(() => expect(types()).toContain("ready"));
    expect(send.mock.calls.find((c) => c[0].type === "route")![0]).toMatchObject({ type: "route", path: "/tasks", search: "?cid=c1" });
    // attention: null before the snapshot, then a real count — never a fake 0
    await waitFor(() => expect(send.mock.calls.some((c) => c[0].type === "attention" && c[0].count === 0 && c[0].cid === "c1")).toBe(true));
    expect(send.mock.calls.find((c) => c[0].type === "attention")![0].count).toBeNull();
    // host → portal navigate (validated), unsafe paths dropped
    listener!({ type: "navigate", path: "//evil.example/x" });
    listener!({ type: "navigate", path: "/requests?req=r9&cid=c1" });
    await waitFor(() => expect(screen.getByTestId("page").textContent).toBe("requests|/requests?req=r9&cid=c1"));
    expect(send.mock.calls.filter((c) => c[0].type === "route").map((c) => c[0].path)).toEqual(["/tasks", "/requests"]);
  });

  it("a host WITHOUT the sidebar capability keeps the portal sidebar (web mode)", async () => {
    window.orchaHost = { version: 1, capabilities: ["notifications"], project: "orcha-x", send: vi.fn(), on: () => () => {} };
    at("/tasks");
    await screen.findByTestId("page");
    expect(document.getElementById("sidebar")).toBeTruthy();
    expect(document.documentElement.hasAttribute("data-embed")).toBe(false);
  });
});

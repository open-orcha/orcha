/**
 * Parity round 2 (shell) regressions:
 *  - e2e-permissions extra: the bell's accessible name agrees in number
 *    ("1 decision needs you", not "need you").
 *  - e2e-owner-flows extra: the Plan-only autonomy confirm no longer promises
 *    agents "resume" while wakes are off (changing autonomy never resumes wakes).
 *  - shell r2 / e2e-permissions extra: a 403 / 404 snapshot drops the tab bar
 *    and the empty project-avatar placeholder (no nameless circle).
 *  - shell r1+r2: /onboarding lights the Overview tab.
 *  - wave4 "Not found" (503): a listed project whose snapshot 5xx's is not an
 *    Orcha outage — no Wi-Fi-off glyph beside the named stale bar.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { extensions } from "../extensions";
import { SnapshotProvider, _setActingIdentity, _setActingAuth } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { Shell, answeredConnectionText, autonomyImpact, bellAriaLabel, headerTabPage } from "./Shell";

type Route = (url: string, init?: RequestInit) => Response | null;
const json = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

function snapWith(container: Record<string, unknown>) {
  return {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: true, ...container },
    agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
    tasks: [], requests: [],
  };
}

function stubFetch(o: { snapStatus?: number; container?: Record<string, unknown>; extra?: Route } = {}) {
  const snapStatus = o.snapStatus ?? 200;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const r = o.extra?.(url, init);
    if (r) return r;
    if (url.startsWith("/api/containers?") || url === "/api/containers") return json({ containers: [{ id: "c1", name: "Orcha", status: "active" }] });
    if (url.startsWith("/api/containers/c1") && (!init || !init.method || init.method === "GET")) {
      return snapStatus === 200 ? json(snapWith(o.container ?? {})) : json({ detail: "boom" }, snapStatus);
    }
    return json({});
  }) as unknown as typeof fetch;
}

function mountShell(page: string, title: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <Shell page={page} title={title}><div>body</div></Shell>
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  delete extensions.identity;
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
  _resetProjectsForTests();
  document.documentElement.removeAttribute("data-conn");
});
beforeEach(() => { localStorage.clear(); });

describe("bell accessible name agrees in number", () => {
  it("singular / plural / partial / none", () => {
    expect(bellAriaLabel({ n: 0, label: "0" }, 1, "1")).toBe("Notifications · 1 decision needs you");
    expect(bellAriaLabel({ n: 1, label: "1" }, 9, "9")).toBe("Notifications — 1 unread · 9 decisions need you");
    expect(bellAriaLabel({ n: 0, label: "0" }, 1, "1+")).toBe("Notifications · 1+ decisions need you");
    expect(bellAriaLabel({ n: 0, label: "0" }, 0, "0")).toBe("Notifications");
    expect(bellAriaLabel({ n: 0, label: "0" }, null, "")).toBe("Notifications");
  });
});

describe("autonomy confirm copy never promises a resume", () => {
  it("pure: wakes on vs off", () => {
    expect(autonomyImpact("plan", false)).not.toMatch(/resume/i);
    expect(autonomyImpact("plan", true)).toMatch(/applies once wakes are turned back on/);
    expect(autonomyImpact("plan", true)).toMatch(/does not resume/);
    expect(autonomyImpact("pr", false)).toBe("Agents execute approved plans up to an open PR. You still merge.");
    expect(autonomyImpact("bogus", false)).toBe("");
  });

  it("while wakes are OFF, the Plan-only confirm says the level applies once wakes are on", async () => {
    stubFetch({ container: { autonomy_level: "pr", wakes_enabled: false } });
    mountShell("tasks", "Tasks");
    await waitFor(() => expect(document.getElementById("execBtn")).toBeTruthy());
    fireEvent.click(document.getElementById("execBtn")!);
    const plan = await waitFor(() => {
      const b = Array.from(document.querySelectorAll('#autTop [role="radio"]')).find((x) => x.textContent === "Plan-only") as HTMLElement;
      expect(b).toBeTruthy();
      return b;
    });
    fireEvent.click(plan);
    expect(await screen.findByText("Set autonomy to Plan-only?")).toBeInTheDocument();
    const dlg = screen.getByText(/applies once wakes are turned back on/);
    expect(dlg.textContent).not.toMatch(/Agents resume/);
  });
});

describe("header tab for a page", () => {
  it("maps /onboarding to the Overview tab; non-project pages have none", () => {
    expect(headerTabPage("onboarding")).toBe("home");
    expect(headerTabPage("tasks")).toBe("tasks");
    expect(headerTabPage("settings")).toBeNull();
    expect(headerTabPage("needs")).toBeNull();
  });

  it("renders /onboarding with the Overview tab current", async () => {
    stubFetch();
    mountShell("onboarding", "Setup");
    await waitFor(() => expect(document.querySelector(".v2-header-pname")?.textContent).toBe("Orcha"));
    const cur = document.querySelector('.v2-ptab[aria-current="page"]');
    expect(cur?.getAttribute("data-section")).toBe("home");
  });
});

describe("a 403 / 404 snapshot: no nameless project circle", () => {
  it.each([[403], [404]])("status %i: no pending avatar placeholder and no tab bar", async (st) => {
    stubFetch({ snapStatus: st });
    mountShell("home", "Overview");
    await screen.findByText(st === 403 ? /not a member of this project/ : /Project not found/, { selector: ".v2-stalebar-msg" }, { timeout: 5000 });
    expect(document.querySelector(".v2-header-pav.is-pending")).toBeNull();
    expect(document.querySelector(".v2-ptabs")).toBeNull();
    expect(document.querySelector("#topbar")!.className).not.toMatch(/has-tabs/);
  });
});

describe("a listed project's 5xx is not an Orcha outage (wave4 Not found)", () => {
  it("pure: answered text", () => {
    expect(answeredConnectionText("server", "billing")).toBe("Connected — billing is unreachable");
    expect(answeredConnectionText("server", null)).toBeNull();
    expect(answeredConnectionText("network", "billing")).toBeNull();
    expect(answeredConnectionText("forbidden", null)).toMatch(/not a member/);
  });

  it("renders the named stale bar and NO Wi-Fi-off glyph", async () => {
    stubFetch({ snapStatus: 503 });
    mountShell("home", "Overview");
    await screen.findByText(/Orcha is unreachable/, { selector: ".v2-stalebar-msg" }, { timeout: 5000 });
    await waitFor(() => expect(screen.getByText("Connected — Orcha is unreachable")).toBeInTheDocument());
    expect(document.querySelector(".v2-conn.is-offline")).toBeNull();
  });
});

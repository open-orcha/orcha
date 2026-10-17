/**
 * Parity round 1 (shell) regressions:
 *  - e2e-permissions-6 / EX-08: a member without manage_autonomy sees the
 *    wakes / autonomy controls LOCKED with the grant reason (no confirm bound
 *    to a 403); owners and grant holders still act; trust off stays permissive.
 *  - EX-09: execution error toasts never leak the API path / container id.
 *  - SH-123 / SH-077 / HDR-NOTMEMBER / e2e-permissions-25 / e2e-scope-live-8 /
 *    wave4 "Not found": a 403 / 404 snapshot is an ANSWER, not "Can't reach
 *    Orcha"; a 5xx on a listed project names the project.
 *  - NC: an unknown notification type shows its humanized type (old UI parity).
 *  - wave4 header: the current tab is re-centred when the strip shrinks.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { extensions, type Identity } from "../extensions";
import { OFFLINE_REASON, SnapshotProvider, _setActingIdentity, _setActingAuth } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { HomePage } from "../pages/home/HomePage";
import {
  EXEC_GRANT_REASON, NOT_MEMBER_REASON, apiErrorText, correctAuthorityReason, execControlDenial,
  ncFallbackLabel, snapshotErrorKind, staleBanner, staleDetail,
} from "./Shell";
import { currentTabVisible } from "./ProjectTabs";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: true },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

type Route = (url: string, init?: RequestInit) => Response | null;
const json = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

function stubFetch(extra?: Route, snapStatus = 200) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const r = extra?.(url, init);
    if (r) return r;
    if (url.startsWith("/api/containers?") || url === "/api/containers") return json({ containers: [{ id: "c1", name: "Orcha", status: "active" }] });
    if (url.startsWith("/api/containers/c1") && (!init || !init.method || init.method === "GET")) {
      return snapStatus === 200 ? json(rawSnap) : json({ detail: "not a member of this project" }, snapStatus);
    }
    return json({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <HomePage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

async function openExec() {
  await waitFor(() => expect(document.getElementById("execBtn")).toBeTruthy());
  fireEvent.click(document.getElementById("execBtn")!);
  await waitFor(() => expect(document.getElementById("notifTop")).toBeTruthy());
}

afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  delete extensions.identity;
  _setActingIdentity(null);
  _setActingAuth({ pending: false, trusted: false });
  _resetProjectsForTests();
});
beforeEach(() => { localStorage.clear(); });

describe("execution controls honour the manage_autonomy grant (e2e-permissions-6 / EX-08)", () => {
  it("pure gate: owner / grant holder act; member without the grant and viewer don't; trust off permissive", () => {
    expect(execControlDenial(null)).toBeNull();
    expect(execControlDenial({ member_role: "owner" })).toBeNull();
    expect(execControlDenial({ member_role: "member", grants: ["manage_autonomy"] })).toBeNull();
    expect(execControlDenial({ member_role: "member", grants: ["manage_keys", "assign_reviewers"] })).toBe(EXEC_GRANT_REASON);
    expect(execControlDenial({ member_role: "member", grants: null })).toBe(EXEC_GRANT_REASON);
    expect(execControlDenial({ member_role: "viewer", grants: ["manage_autonomy"] })).toMatch(/viewer/);
  });

  it("a member without the grant sees the switch + levels locked with the reason, and no confirm opens", async () => {
    stubFetch();
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_keys"] }) as Identity;
    mount();
    await screen.findAllByText("Orcha");
    await openExec();
    await waitFor(() => {
      const sw = document.querySelector('#notifTop [role="switch"]') as HTMLElement;
      expect(sw.getAttribute("aria-disabled")).toBe("true");
      expect(sw.getAttribute("title")).toBe(EXEC_GRANT_REASON);
    });
    const full = Array.from(document.querySelectorAll('#autTop [role="radio"]')).find((b) => b.textContent === "Full") as HTMLElement;
    expect(full.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(full);
    expect(screen.queryByText("Set autonomy to Full?")).toBeNull();
    fireEvent.click(document.querySelector('#notifTop [role="switch"]')!);
    expect(screen.queryByText("Pause all agent wakes?")).toBeNull();
  });

  it("a member WITH manage_autonomy can still open the confirm", async () => {
    stubFetch();
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_autonomy"] }) as Identity;
    mount();
    await screen.findAllByText("Orcha");
    await openExec();
    await waitFor(() => expect(document.querySelector('#notifTop [role="switch"]')!.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(document.querySelector('#notifTop [role="switch"]')!);
    expect(await screen.findByText("Pause all agent wakes?")).toBeInTheDocument();
  });
});

describe("error toasts never leak the API path (EX-09)", () => {
  it("apiErrorText keeps the server detail / status only", () => {
    const e = new Error("/api/containers/03be128d-94cb/wakes → 403: this action requires the owner role") as Error & { status?: number };
    e.status = 403;
    expect(apiErrorText(e)).toBe("this action requires the owner role");
    expect(apiErrorText(new Error("/api/containers/03be128d/autonomy → 500"))).toBe("status 500");
    expect(apiErrorText(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(apiErrorText(new Error("/api/containers/abc"))).toBe("request failed");
  });

  it("a 403 on pause shows 'Couldn't pause wakes — <detail>' without the URL", async () => {
    stubFetch((url, init) => (url.endsWith("/wakes") && init?.method === "POST"
      ? json({ detail: "this action requires the owner role or the 'manage_autonomy' permission" }, 403) : null));
    mount();
    await screen.findAllByText("Orcha");
    await openExec();
    fireEvent.click(document.querySelector('#notifTop [role="switch"]')!);
    fireEvent.click(await screen.findByRole("button", { name: "Pause all wakes" }));
    const t = await screen.findByText(/Couldn't pause wakes/);
    expect(t.textContent).toContain("manage_autonomy");
    expect(t.textContent).not.toMatch(/\/api\/|c1/);
  });
});

describe("a 403 / 404 snapshot is not an outage (SH-123 / SH-077 / e2e-scope-live-8)", () => {
  it("classifies the snapshot failure by its HTTP status", () => {
    expect(snapshotErrorKind(null)).toBeNull();
    expect(snapshotErrorKind("/api/containers/x → 403")).toBe("forbidden");
    expect(snapshotErrorKind("/api/containers/x → 401")).toBe("forbidden");
    expect(snapshotErrorKind("/api/containers/x → 404")).toBe("not_found");
    expect(snapshotErrorKind("/api/containers/not-a-uuid → 400")).toBe("not_found");
    expect(snapshotErrorKind("/api/containers/x → 503")).toBe("server");
    expect(snapshotErrorKind("Failed to fetch")).toBe("network");
  });

  it("banner copy: member / not-found / named-unreachable / true outage", () => {
    expect(staleBanner("forbidden", false, null, null)).toMatchObject({ msg: expect.stringMatching(/not a member/), retry: false, toProjects: true });
    expect(staleBanner("not_found", false, null, null)).toMatchObject({ msg: expect.stringMatching(/^Project not found/), retry: false, toProjects: true });
    expect(staleBanner("server", false, null, "billing")).toMatchObject({ msg: "billing is unreachable · no project data loaded", retry: true });
    expect(staleBanner("server", false, null, null).msg).toBe("Can't reach Embodent · no project data loaded");
    expect(staleBanner("network", true, "10:13", "billing").msg).toBe("Can't reach Embodent · showing data from 10:13");
  });

  it("details never show the raw endpoint or container id", () => {
    expect(staleDetail("/api/containers/0000-beef → 503")).toBe("The server answered 503");
    expect(staleDetail("Failed to fetch")).toBe("Failed to fetch");
  });

  it("the offline reason is replaced by the membership reason on a 403", () => {
    const a = { human: null, readOnly: true, pending: false, reason: OFFLINE_REASON };
    expect(correctAuthorityReason(a, "forbidden").reason).toBe(NOT_MEMBER_REASON);
    expect(correctAuthorityReason(a, "not_found").reason).toBe("Project not found");
    expect(correctAuthorityReason(a, "network").reason).toBe(OFFLINE_REASON);
    const other = { ...a, reason: "Your role is viewer (read-only)" };
    expect(correctAuthorityReason(other, "forbidden")).toBe(other);
  });

  it("renders the not-a-member banner with an All projects link, no Retry, no offline glyph", async () => {
    stubFetch(undefined, 403);
    mount();
    const bar = await screen.findByText(/You're not a member of this project/, {}, { timeout: 5000 });
    const alert = bar.closest(".v2-stalebar")!;
    expect(alert.textContent).not.toMatch(/Can't reach Embodent/);
    expect(alert.querySelector('a[href$="/projects"]')?.textContent).toBe("All projects");
    expect(alert.textContent).not.toMatch(/Retry/);
    expect(document.querySelector(".v2-conn.is-offline")).toBeNull();
    expect(document.documentElement.getAttribute("data-conn")).toBeNull();
  });
});

describe("notification fallback label (NC parity)", () => {
  it("humanizes an unknown type, falls back to the link kind, never the raw string", () => {
    expect(ncFallbackLabel(undefined, "some_unknown_type")).toBe("Some unknown type");
    expect(ncFallbackLabel("task", "task_comment_added")).toBe("Task comment added");
    expect(ncFallbackLabel("task", "")).toBe("Task update");
    expect(ncFallbackLabel(undefined, "{weird json}")).toBe("Notification");
  });
});

describe("project tabs keep the current tab clear of the fades (wave4 header)", () => {
  function strip(scrollLeft: number, clientWidth: number, cur: { left: number; width: number }) {
    const el = document.createElement("div");
    const a = document.createElement("a");
    a.setAttribute("aria-current", "page");
    el.appendChild(a);
    Object.defineProperties(el, {
      scrollWidth: { value: 509 }, clientWidth: { value: clientWidth }, offsetLeft: { value: 0 },
      scrollLeft: { value: scrollLeft, writable: true },
    });
    Object.defineProperties(a, { offsetLeft: { value: cur.left }, offsetWidth: { value: cur.width } });
    return el;
  }
  it("flags a current tab cut by the end fade", () => {
    expect(currentTabVisible(strip(0, 143, { left: 200, width: 74 }))).toBe(false); // "Reques|"
    expect(currentTabVisible(strip(165 - 28, 143, { left: 165, width: 74 }))).toBe(true);
    expect(currentTabVisible(strip(0, 600, { left: 200, width: 74 }))).toBe(true); // no overflow
  });
});

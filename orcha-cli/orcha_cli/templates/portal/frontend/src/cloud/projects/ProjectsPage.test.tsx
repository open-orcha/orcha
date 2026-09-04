/**
 * ProjectsPage — the access-model landing renders the membership-filtered grid
 * from GET /api/containers and every Open link carries ?cid= (full href — that
 * is project switching). fetch is stubbed; matches foundation.test.ts style.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { ProjectsPage } from "./ProjectsPage";
import * as prefs from "./prefs";

interface Call { url: string; method: string; body: unknown }

const containers = [
  {
    id: "c1", name: "quantal-ehr", description: "The EHR build", status: "active",
    github_repo: "quantal/ehr", agents: 3, tasks: 12, needs_you: 2,
    member_count: 2,
    members: [
      { alias: "kedar", github_login: "kedar-gh", member_role: "owner" },
      { alias: "sam", github_login: null, member_role: "member" },
    ],
  },
  {
    id: "c2", name: "api-gateway", description: null, status: "provisioning",
    github_repo: null, agents: 1, tasks: 0, needs_you: 0,
    member_count: 4, members: null, // roster privacy: count only
  },
];

function stubFetch(opts?: { prefs?: Record<string, string> | null }): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/prefs") return json({ prefs: opts?.prefs ?? null });
    if (url === "/api/containers") return json({ containers });
    if (url.startsWith("/api/me")) return json({ identity: { github_login: "kedar-gh" }, trusted: true });
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount() {
  return render(
    <ToastProvider>
      <ProjectsPage />
    </ToastProvider>,
  );
}

describe("ProjectsPage (access-model landing)", () => {
  beforeEach(() => { localStorage.clear(); prefs._resetForTests(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders one card per membership from GET /api/containers", async () => {
    const calls = stubFetch();
    mount();
    expect(await screen.findByText("quantal-ehr")).toBeInTheDocument();
    expect(screen.getByText("api-gateway")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers" && c.method === "GET")).toBe(true);
    // card fields the vanilla page reads
    expect(screen.getByText("The EHR build")).toBeInTheDocument();
    expect(screen.getByText("quantal/ehr")).toBeInTheDocument();
    expect(screen.getByText("Needs you · 2")).toBeInTheDocument();
    expect(screen.getByText("No description yet.")).toBeInTheDocument(); // null description fallback
    expect(screen.getByText("4 members")).toBeInTheDocument(); // roster privacy: count, never names
    expect(screen.getByText("New project")).toBeInTheDocument();
  });

  it("Open links carry ?cid=<id> to '/' (full href navigation)", async () => {
    stubFetch();
    mount();
    await screen.findByText("quantal-ehr");
    const opens = screen.getAllByRole("link", { name: /Open/ });
    expect(opens.map((a) => a.getAttribute("href"))).toEqual(["/?cid=c1", "/?cid=c2"]);
  });

  it("identity chip comes from /api/me?cid=<first project>", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("quantal-ehr");
    await waitFor(() => expect(calls.some((c) => c.url === "/api/me?cid=c1")).toBe(true));
    expect(await screen.findByText("kedar-gh")).toBeInTheDocument();
  });

  it("default stars render only when server prefs are active (mig 040)", async () => {
    stubFetch({ prefs: { default_cid: "c2" } });
    mount();
    await screen.findByText("quantal-ehr");
    const stars = document.querySelectorAll("[data-def-cid]");
    expect(stars.length).toBe(2);
    expect(document.querySelector('[data-def-cid="c2"]')).toHaveClass("on");
    expect(document.querySelector('[data-def-cid="c1"]')).not.toHaveClass("on");
  });

  it("self-host (prefs null) paints NO stars at all", async () => {
    stubFetch({ prefs: null });
    mount();
    await screen.findByText("quantal-ehr");
    expect(document.querySelectorAll("[data-def-cid]").length).toBe(0);
  });
});

describe("ProjectsPage local repo badge (Orcha Cloud local run, Addendum 2)", () => {
  beforeEach(() => { localStorage.clear(); prefs._resetForTests(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("a local binding renders the workspace name + Local chip, not a github.com link", async () => {
    const localContainers = [
      { id: "c3", name: "quantal-local", description: "Local dev", status: "active",
        github_repo: "local", agents: 1, tasks: 0, needs_you: 0, member_count: 1, members: null },
    ];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
      if (url === "/api/prefs") return json({ prefs: null });
      if (url === "/api/containers") return json({ containers: localContainers });
      if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
      return json({});
    }) as unknown as typeof fetch;
    mount();
    // the card title AND the badge's own local label both read "quantal-local"
    expect(await screen.findAllByText("quantal-local")).toHaveLength(2);
    expect(screen.getByText("Local")).toBeInTheDocument();
    const badge = document.querySelector(".prepo")!;
    expect(badge.querySelector("a")).toBeNull();
  });
});

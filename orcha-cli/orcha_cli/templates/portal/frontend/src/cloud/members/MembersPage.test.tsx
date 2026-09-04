/**
 * MembersPage — roster render from the stubbed wire contract, roster privacy,
 * and the exact human-gated invite mutation body. fetch is stubbed; snapshot
 * flows through the real SnapshotProvider + mapSnapshot, matching
 * foundation.test.ts / HomePage.test.tsx style.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";
import { resetPlan } from "../shared/plan";
import { MembersPage, MembersSection } from "./MembersPage";

interface Call { url: string; method: string; body: unknown }

const TEAM_PLAN = { plan: "team", features: { members: true }, upgrade_url: "https://orcha.nursoftai.com/#pricing" };
const SOLO_PLAN = { plan: "solo", features: { members: false }, upgrade_url: "https://orcha.nursoftai.com/#pricing" };

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
  ],
  tasks: [],
  requests: [],
};

const roster = {
  members: [
    { agent_id: "h1", alias: "kedar", github_login: "kedar-gh", member_role: "owner", grants: [], pending: false },
    { agent_id: "h2", alias: "sam", github_login: "sam-gh", member_role: "member", grants: ["manage_keys"], pending: true },
  ],
  restricted: false,
};

function stubFetch(
  overrides: { members?: unknown; me?: unknown; plan?: unknown; memberStatus?: number } = {},
): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json(overrides.me ?? { identity: null, trusted: false });
    // Every existing test in this file predates plan gating and exercises the
    // roster/invite UI directly, so the default here is "team" (unlocked) —
    // solo-gating behavior gets its own describe block below with an explicit override.
    if (url === "/api/plan") return json(overrides.plan ?? TEAM_PLAN);
    if (url === "/api/containers/c1/members") {
      if ((init?.method || "GET") === "POST") {
        if (overrides.memberStatus === 402) {
          return json({ detail: { premium: "members", message: "Members needs Team.", upgrade_url: "https://orcha.nursoftai.com/#pricing" } }, 402);
        }
        return json({ agent_id: "h3" }, 201);
      }
      return json(overrides.members ?? roster);
    }
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <MembersPage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("MembersPage roster (wire-contract render)", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); resetPlan(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the roster rows from GET /members: logins, role chips, pending + grants tags", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("kedar-gh")).toBeInTheDocument();
    expect(screen.getByText("sam-gh")).toBeInTheDocument();
    // vanilla parity: login shown as the name, alias demoted to .mem-sub
    const subs = Array.from(document.querySelectorAll(".mem-sub")).map((e) => e.textContent);
    expect(subs).toContain("sam");
    expect(document.querySelector(".tag.role-owner")).toHaveTextContent("owner");
    expect(document.querySelector(".tag.role-member")).toHaveTextContent("member");
    expect(document.querySelector(".tag.mem-pending")).toHaveTextContent("pending");
    expect(document.querySelector(".tag.mem-grants")).toHaveTextContent("+1");
    // trust-off fallback actor is permissive-owner → the invite bar renders
    expect(screen.getByPlaceholderText("GitHub username to invite…")).toBeInTheDocument();
    // the LAST owner's row never offers demote/remove (backend 400s both)
    const rows = document.querySelectorAll(".mem-row");
    expect(rows[0].querySelector(".mem-acts")).toBeNull();
    expect(rows[1].querySelector(".mem-acts")).not.toBeNull();
  });

  it("roster privacy: restricted:true renders only your membership + the note, no invite bar", async () => {
    stubFetch({
      members: {
        members: [{ agent_id: "h2", alias: "sam", github_login: "sam-gh", member_role: "member", grants: [], pending: false }],
        restricted: true,
      },
      me: { identity: { agent_id: "h2", alias: "sam", github_login: "sam-gh", member_role: "member", grants: [] }, trusted: true },
    });
    mount();
    expect(await screen.findByText("sam-gh")).toBeInTheDocument();
    expect(screen.getByText("you")).toBeInTheDocument();
    expect(document.querySelector(".mem-restricted")).toHaveTextContent("The full member list is visible to owners");
    expect(screen.queryByPlaceholderText("GitHub username to invite…")).not.toBeInTheDocument();
    expect(document.querySelector(".mem-acts")).toBeNull();
  });
});

describe("MembersSection (the settings-tab card)", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); resetPlan(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the vanilla settings.html Members card standalone (no Shell/route needed)", async () => {
    stubFetch();
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MembersSection />
        </SnapshotProvider>
      </ToastProvider>,
    );
    // card chrome: title + lead verbatim from the vanilla Collaboration-tab card
    const title = document.querySelector(".set-card .card-h h2");
    expect(title).toHaveTextContent("Members");
    expect(document.querySelector(".set-card .lead")).toHaveTextContent(
      "owners can invite collaborators, change roles, and assign task reviewers",
    );
    expect(document.querySelector("#membersCard")).not.toBeNull();
    // the same roster body the /members page renders
    expect(await screen.findByText("kedar-gh")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("GitHub username to invite…")).toBeInTheDocument();
  });

  it("Invite from the section POSTs the byte-exact body", async () => {
    const calls = stubFetch();
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MembersSection />
        </SnapshotProvider>
      </ToastProvider>,
    );
    await screen.findByText("kedar-gh");
    fireEvent.change(screen.getByPlaceholderText("GitHub username to invite…"), {
      target: { value: "hubot" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Invite/ }));
    await waitFor(() => {
      const inv = calls.find((c) => c.url === "/api/containers/c1/members" && c.method === "POST");
      expect(inv).toBeTruthy();
      expect(inv!.body).toEqual({ github_login: "hubot", role: "member", actor_agent_id: "h1" });
    });
  });
});

describe("MembersPage mutations (exact wire bodies, human-gated)", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); resetPlan(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Invite POSTs {github_login, role, actor_agent_id} to /api/containers/{cid}/members", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("kedar-gh");
    fireEvent.change(screen.getByPlaceholderText("GitHub username to invite…"), {
      target: { value: "hubot" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Invite/ }));
    await waitFor(() => {
      const inv = calls.find((c) => c.url === "/api/containers/c1/members" && c.method === "POST");
      expect(inv).toBeTruthy();
      // exact body parity with settings-members.js doInvite (actor = trust-off fallback human)
      expect(inv!.body).toEqual({ github_login: "hubot", role: "member", actor_agent_id: "h1" });
    });
    // success path reloads the roster from the server
    await waitFor(() => {
      const gets = calls.filter((c) => c.url === "/api/containers/c1/members" && c.method === "GET");
      expect(gets.length).toBeGreaterThan(1);
    });
  });
});

describe("MembersPage plan gating (docs/orcha-cloud-local-run.md addendum)", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); resetPlan(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("solo plan renders PremiumGate instead of the roster+invite UI", async () => {
    stubFetch({ plan: SOLO_PLAN });
    mount();
    expect(await screen.findByText("Members is an Orcha Cloud Team feature.", { exact: false })).toBeInTheDocument();
    // the pitch (contract item 7: invite, roles, grants, GitHub-verified identity)
    expect(screen.getByText(/Invite teammates/)).toBeInTheDocument();
    expect(screen.getByText(/owner, member, viewer/)).toBeInTheDocument();
    expect(screen.getByText(/Granular per-member permission grants/)).toBeInTheDocument();
    expect(screen.getByText(/GitHub-verified identity/)).toBeInTheDocument();
    // no roster, no invite affordances
    expect(screen.queryByText("kedar-gh")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("GitHub username to invite…")).not.toBeInTheDocument();
  });

  it("solo plan's upgrade button opens the server-provided upgrade_url", async () => {
    stubFetch({ plan: { ...SOLO_PLAN, upgrade_url: "https://example.com/team" } });
    mount();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    fireEvent.click(await screen.findByRole("button", { name: /Upgrade to Orcha Cloud Team/ }));
    expect(openSpy).toHaveBeenCalledWith("https://example.com/team", "_blank", "noopener");
  });

  it("team plan renders the roster+invite UI unchanged", async () => {
    stubFetch({ plan: TEAM_PLAN });
    mount();
    expect(await screen.findByText("kedar-gh")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("GitHub username to invite…")).toBeInTheDocument();
    expect(screen.queryByText(/Team feature/)).not.toBeInTheDocument();
  });

  it("belt-and-braces: a 402 with the premium detail shape from a mutation swaps to the gate", async () => {
    stubFetch({ plan: TEAM_PLAN, memberStatus: 402 });
    mount();
    await screen.findByText("kedar-gh");
    fireEvent.change(screen.getByPlaceholderText("GitHub username to invite…"), {
      target: { value: "hubot" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Invite/ }));
    expect(await screen.findByText("Members is an Orcha Cloud Team feature.", { exact: false })).toBeInTheDocument();
  });
});

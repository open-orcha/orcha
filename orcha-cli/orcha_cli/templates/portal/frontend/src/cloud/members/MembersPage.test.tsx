/**
 * MembersPage — roster render from the stubbed wire contract, roster privacy,
 * and the exact human-gated invite mutation body. fetch is stubbed; snapshot
 * flows through the real SnapshotProvider + mapSnapshot, matching
 * foundation.test.ts / HomePage.test.tsx style.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";
import { resetPlan } from "../shared/plan";
import { MembersPage, MembersSection, membersRedirectTarget, removeBlockedReason } from "./MembersPage";

interface Call { url: string; method: string; body: unknown }

const TEAM_PLAN = { plan: "team", features: { members: true }, upgrade_url: "https://orcha.quantallabs.ai" };
const SOLO_PLAN = { plan: "solo", features: { members: false }, upgrade_url: "https://orcha.quantallabs.ai" };

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
          return json({ detail: { premium: "members", message: "Members needs Team.", upgrade_url: "https://orcha.quantallabs.ai" } }, 402);
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

// /members now redirects to Settings › Members & access, which renders the
// SAME MembersSection — so the roster behavior is exercised through it.
function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <MembersSection />
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
    // ONE name per row (D12): the login; the alias lives in the tooltip only
    expect(document.querySelector(".mem-sub")).toBeNull();
    expect(screen.getByText("sam-gh")).toHaveAttribute("title", "@sam-gh · alias sam");
    // the role shows ONCE per row: a tag when read-only (last owner), the select when editable
    expect(document.querySelector(".tag.role-owner")).toHaveTextContent("Owner");
    expect(document.querySelector(".tag.role-member")).toBeNull();
    // the role control is the v2 ghost menu (no native <select> / OS caret)
    expect(screen.getByRole("button", { name: "Project role for sam-gh: Member" })).toHaveAttribute("aria-haspopup", "menu");
    expect(document.querySelector("select")).toBeNull();
    expect(document.querySelector(".tag.mem-pending")).toHaveTextContent("pending");
    // the grant count lives ONCE, in the Permissions button (no "+N" chip beside it);
    // its tooltip lists the human labels
    expect(document.querySelector(".tag.mem-grants")).toBeNull();
    const perms = screen.getByRole("button", { name: "Permissions for sam-gh: 1 extra" });
    expect(perms).toHaveTextContent("Permissions · 1");
    expect(perms.getAttribute("title")).toBe("API keys & model settings");
    // trust-off fallback actor is permissive-owner → the invite bar renders
    expect(screen.getByPlaceholderText("GitHub username to invite…")).toBeInTheDocument();
    // the LAST owner's row never offers demote/remove (backend 400s both);
    // its role chip sits IN the Role column slot (MEM-V1), not beside the name
    const rows = document.querySelectorAll(".mem-row");
    expect(rows[0].querySelector(".mem-role-btn")).toBeNull();
    expect(rows[0].querySelector(".mem-remove")).toBeNull();
    expect(rows[0].querySelector(".mem-acts .mem-role-slot .tag.role-owner")).not.toBeNull();
    expect(rows[1].querySelector(".mem-acts .mem-role-btn")).not.toBeNull();
  });

  it("Linear members table: round D7 avatars, a muted column header with the count, chips, one break per managed row", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("kedar-gh")).toBeInTheDocument();
    // every face is the shared round Avatar primitive (decorative: the name is printed beside it)
    const faces = Array.from(document.querySelectorAll(".mem-row .mem-av"));
    expect(faces).toHaveLength(2);
    faces.forEach((f) => {
      expect(f).toHaveClass("v2-av");
      expect(f).toHaveAttribute("aria-hidden", "true");
    });
    // no legacy square/hand-rolled GitHub tile
    expect(document.querySelector(".mem-gh")).toBeNull();
    // the column header says how many people, and labels the role column only when roles are editable
    const cols = document.querySelector(".mem-cols")!;
    expect(cols).toHaveTextContent("Member");
    expect(cols).toHaveTextContent("2 people");
    expect(cols).toHaveTextContent("Role");
    // chips are the D8 Chip primitive (rounded-full, 1px border, dot)
    expect(document.querySelector(".tag.mem-pending")).toHaveClass("v2-chip");
    expect(document.querySelector(".tag.role-owner")).toHaveClass("v2-chip");
    // an editable card lays EVERY row out on the same grid (MEM-V1)
    const rows = document.querySelectorAll(".mem-row");
    expect(rows[0].querySelector(".mem-break")).not.toBeNull();
    expect(rows[1].querySelector(".mem-break")).not.toBeNull();
    // remove is a small circular icon button with a specific accessible name
    const remove = screen.getByRole("button", { name: "Remove access for sam-gh" });
    expect(remove).toHaveClass("mem-remove");
  });

  it("a read-only roster has no Role column header", async () => {
    stubFetch({
      me: { identity: { agent_id: "h2", alias: "sam", github_login: "sam-gh", member_role: "viewer", grants: [] }, trusted: true },
    });
    mount();
    expect(await screen.findByText("kedar-gh")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("#memReadOnly")).not.toBeNull());
    expect(document.querySelector(".mem-cols")).not.toHaveTextContent("Role");
    expect(document.querySelector(".mem-break")).toBeNull();
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

  it("a viewer sees why nothing is editable instead of controls silently missing", async () => {
    stubFetch({
      me: { identity: { agent_id: "h2", alias: "sam", github_login: "sam-gh", member_role: "viewer", grants: [] }, trusted: true },
    });
    mount();
    expect(await screen.findByText("kedar-gh")).toBeInTheDocument();
    expect(document.querySelector("#memReadOnly")).toHaveTextContent(/viewer/);
    expect(screen.queryByPlaceholderText("GitHub username to invite…")).not.toBeInTheDocument();
  });

  it("long logins get a title tooltip on the truncating name span", async () => {
    stubFetch();
    mount();
    const el = await screen.findByText("kedar-gh");
    expect(el).toHaveClass("mem-name-t");
    expect(el).toHaveAttribute("title", "@kedar-gh · alias kedar");
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
    // no repeated "Members" heading/description: the page or the Settings
    // section supplies the single title + one-line description
    expect(document.querySelector(".set-card .card-h h2")).toBeNull();
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
    expect(await screen.findByText("Members is a Embodent Cloud Team feature.", { exact: false })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: /Upgrade to Embodent Cloud Team/ }));
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
    expect(await screen.findByText("Members is a Embodent Cloud Team feature.", { exact: false })).toBeInTheDocument();
  });
});

describe("/members has ONE home: Settings › Members & access (review r1)", () => {
  afterEach(() => { cleanup(); });

  it("membersRedirectTarget keeps the query (cid) and lands on the members tab", () => {
    expect(membersRedirectTarget("?cid=c1")).toBe("/settings?cid=c1#tab=members");
    expect(membersRedirectTarget("")).toBe("/settings#tab=members");
  });

  it("MembersPage redirects to /settings?…#tab=members (replace)", () => {
    function Where() {
      const l = useLocation();
      return <div data-testid="where">{l.pathname + l.search + l.hash}</div>;
    }
    render(
      <MemoryRouter initialEntries={["/members?cid=c1"]}>
        <Routes>
          <Route path="/members" element={<MembersPage />} />
          <Route path="/settings" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("where")).toHaveTextContent("/settings?cid=c1#tab=members");
  });
});

describe("Remove access: never on your own row or the last owner (authority, brief §3)", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); resetPlan(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("removeBlockedReason: self and sole owner are blocked; others are allowed", () => {
    const ctx = { meId: "h1", ownerCount: 2 };
    expect(removeBlockedReason({ agent_id: "h1", member_role: "owner" }, ctx)).toBe("You can't remove yourself");
    expect(removeBlockedReason({ agent_id: "h2", member_role: "member" }, ctx)).toBeNull();
    expect(removeBlockedReason({ agent_id: "h3", member_role: "owner" }, { meId: "h1", ownerCount: 1 })).toBe("A project needs at least one owner");
    expect(removeBlockedReason({ agent_id: "h3", member_role: "owner" }, { meId: "h1", ownerCount: 2 })).toBeNull();
    expect(removeBlockedReason({ agent_id: "h2", member_role: "member" }, { meId: null, ownerCount: 1 })).toBeNull();
  });

  it("an owner's own row has no enabled Remove; clicking it opens no dialog; another member's still does", async () => {
    const two = {
      members: [
        { agent_id: "h1", alias: "kedar", github_login: "kedar-gh", member_role: "owner", grants: [], pending: false },
        { agent_id: "h9", alias: "co", github_login: "co-gh", member_role: "owner", grants: [], pending: false },
        { agent_id: "h2", alias: "sam", github_login: "sam-gh", member_role: "member", grants: [], pending: false },
      ],
      restricted: false,
    };
    stubFetch({
      members: two,
      me: { identity: { agent_id: "h1", alias: "kedar", github_login: "kedar-gh", member_role: "owner", grants: [] }, trusted: true },
    });
    mount();
    await screen.findByText("kedar-gh");
    const self = await screen.findByRole("button", { name: "Remove access for kedar-gh" });
    expect(self).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(self);
    expect(screen.queryByText("Remove access for kedar-gh?")).toBeNull();
    const other = screen.getByRole("button", { name: "Remove access for sam-gh" });
    expect(other).not.toHaveAttribute("aria-disabled");
    fireEvent.click(other);
    expect(await screen.findByText("Remove access for sam-gh?")).toBeInTheDocument();
  });

  it("the Permissions column is labelled when the roster is manageable", async () => {
    stubFetch();
    mount();
    await screen.findByText("kedar-gh");
    const cols = document.querySelector(".mem-cols")!;
    expect(cols).toHaveTextContent("Role");
    expect(cols).toHaveTextContent("Permissions");
  });
});

describe("Members r2 polish — role menu + one identity label", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); resetPlan(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("the row role menu PATCHes {role, actor_agent_id} with the picked role", async () => {
    const calls = stubFetch();
    mount();
    const btn = await screen.findByRole("button", { name: "Project role for sam-gh: Member" });
    fireEvent.click(btn);
    const menu = await screen.findByRole("menu", { name: "Project role for sam-gh" });
    const viewer = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).find((e) => e.textContent === "Viewer")!;
    // the current role is the checked item
    const member = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).find((e) => e.textContent === "Member")!;
    expect(member).toHaveAttribute("aria-checked", "true");
    fireEvent.click(viewer);
    await waitFor(() => {
      const p = calls.find((c) => c.method === "PATCH");
      expect(p).toBeTruthy();
      expect(p!.url).toBe("/api/containers/c1/members/h2");
      expect(p!.body).toEqual({ role: "viewer", actor_agent_id: "h1" });
    });
  });

  it("picking the current role again does not PATCH", async () => {
    const calls = stubFetch();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Project role for sam-gh: Member" }));
    const menu = await screen.findByRole("menu");
    fireEvent.click(Array.from(menu.querySelectorAll('[role="menuitemradio"]')).find((e) => e.textContent === "Member")!);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("the invite role menu feeds the POST body", async () => {
    const calls = stubFetch();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Role for the invite: Member" }));
    const menu = await screen.findByRole("menu", { name: "Role for the invite" });
    fireEvent.click(Array.from(menu.querySelectorAll('[role="menuitemradio"]')).find((e) => e.textContent === "Viewer")!);
    expect(screen.getByRole("button", { name: "Role for the invite: Viewer" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("GitHub username to invite…"), { target: { value: "hubot" } });
    fireEvent.click(screen.getByRole("button", { name: /^Invite$/ }));
    await waitFor(() => {
      const inv = calls.find((c) => c.method === "POST");
      expect(inv!.body).toEqual({ github_login: "hubot", role: "viewer", actor_agent_id: "h1" });
    });
  });

  it("your own row shows one identity (login + you); the alias moves to the tooltip", async () => {
    stubFetch({
      me: { identity: { agent_id: "h1", alias: "kedar", github_login: "kedar-gh", member_role: "owner", grants: [] }, trusted: true },
    });
    mount();
    const name = await screen.findByText("kedar-gh");
    const row = name.closest(".mem-row")!;
    expect(row.querySelector(".mem-you")).toHaveTextContent("you");
    expect(row.querySelector(".mem-sub")).toBeNull();
    expect(name).toHaveAttribute("title", "@kedar-gh · alias kedar");
    // other members show one name too — the alias is in the tooltip
    const sam = screen.getByText("sam-gh");
    expect(sam.closest(".mem-row")!.querySelector(".mem-sub")).toBeNull();
    expect(sam).toHaveAttribute("title", "@sam-gh · alias sam");
  });
});

describe("Members r4 — permissions popover + quiet invite", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); resetPlan(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Permissions opens a popover checklist (no inline block); Save PATCHes {grants}", async () => {
    const calls = stubFetch();
    mount();
    const btn = await screen.findByRole("button", { name: "Permissions for sam-gh: 1 extra" });
    expect(btn).toHaveAttribute("aria-haspopup", "dialog");
    expect(document.querySelector(".mem-item .mem-perms")).toBeNull();
    fireEvent.click(btn);
    const pop = await screen.findByRole("dialog", { name: "Permissions for sam-gh" });
    expect(pop.closest(".mem-item")).toBeNull(); // a popover, not an inline expansion
    const boxes = pop.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(6);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true); // manage_keys
    const save = Array.from(pop.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    expect(save).toBeDisabled();
    fireEvent.click(boxes[2]); // manage_repo
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => {
      const p = calls.find((c) => c.method === "PATCH");
      expect(p!.url).toBe("/api/containers/c1/members/h2");
      expect(p!.body).toEqual({ grants: ["manage_keys", "manage_repo"], actor_agent_id: "h1" });
    });
    expect(screen.queryByRole("dialog", { name: "Permissions for sam-gh" })).toBeNull();
  });

  it("Invite is disabled until the username is non-empty", async () => {
    const calls = stubFetch();
    mount();
    const invite = await screen.findByRole("button", { name: /^Invite$/ });
    expect(invite).toBeDisabled();
    const input = screen.getByPlaceholderText("GitHub username to invite…");
    fireEvent.change(input, { target: { value: "   " } });
    expect(invite).toBeDisabled();
    fireEvent.change(input, { target: { value: "hubot" } });
    expect(invite).not.toBeDisabled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

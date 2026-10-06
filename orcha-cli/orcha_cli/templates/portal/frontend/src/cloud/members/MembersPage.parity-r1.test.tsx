/**
 * Members & access — parity round 1 fixes:
 *  MEM-006   failure toasts are words (FastAPI 422 arrays, object details), never
 *            "(422)" or "[object Object]"; an invalid GitHub login can't be sent.
 *  MEM-V1    an editable card lays every row on the same grid: a row you can't
 *            edit shows its role chip IN the Role column; "Permissions" header
 *            only for owners (the only ones with that column).
 *  MEM-BUSY  an in-flight mutation disables controls in place, it never
 *            collapses the card into the read-only view.
 *  role toast names the role ("Viewer"), not the raw key.
 *  viewer    a viewer's Permissions popover offers only the roster grant (the
 *            one grant a read-only role honours), not six no-op checkboxes.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";
import { resetPlan } from "../shared/plan";
import { GH_LOGIN_RE, MembersSection, grantsForRole, memErrText } from "./MembersPage";

const TEAM_PLAN = { plan: "team", features: { members: true }, upgrade_url: "https://x/#pricing" };
const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [], requests: [],
};
const roster = {
  members: [
    { agent_id: "h1", alias: "kedar", github_login: "kedar-gh", member_role: "owner", grants: [], pending: false },
    { agent_id: "h2", alias: "sam", github_login: "sam-gh", member_role: "member", grants: ["manage_keys"], pending: false },
    { agent_id: "h3", alias: "tomas", github_login: "tomas-v", member_role: "viewer", grants: [], pending: false },
  ],
  restricted: false,
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | null;
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

function stub(opts: { me?: unknown; mutate?: Handler } = {}) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json(opts.me ?? { identity: null, trusted: false });
    if (url === "/api/plan") return json(TEAM_PLAN);
    if (url.startsWith("/api/containers/c1/members")) {
      if (method !== "GET" && opts.mutate) {
        const r = await opts.mutate(url, init);
        if (r) return r;
      }
      return method === "GET" ? json(roster) : json({ ok: true });
    }
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter><MembersSection /></HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

beforeEach(() => { localStorage.clear(); resetIdentity(); resetPlan(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("memErrText (MEM-006)", () => {
  it("maps each FastAPI detail shape to words", () => {
    expect(memErrText({ status: 403, body: { detail: "only owners may do that" } })).toBe("only owners may do that");
    expect(memErrText({
      status: 422,
      body: { detail: [{ type: "string_pattern_mismatch", loc: ["body", "github_login"], msg: "String should match pattern", input: "a b" }] },
    })).toBe("That isn't a valid GitHub username.");
    expect(memErrText({ status: 422, body: { detail: [{ type: "missing", loc: ["body", "role"], msg: "Field required" }] } })).toBe("Field required");
    expect(memErrText({ status: 402, body: { detail: { message: "Members needs Team." } } })).toBe("Members needs Team.");
    expect(memErrText({ status: 0, body: null })).toBe("Couldn't reach the server.");
    expect(memErrText({ status: 500, body: null })).not.toMatch(/500|\(/);
  });
  it("GH_LOGIN_RE mirrors the backend's MemberCreate pattern", () => {
    expect(GH_LOGIN_RE.test("octo-cat")).toBe(true);
    expect(GH_LOGIN_RE.test("bad login")).toBe(false);
    expect(GH_LOGIN_RE.test("-lead")).toBe(false);
    expect(GH_LOGIN_RE.test("a--b")).toBe(false);
  });
});

describe("invite (MEM-006)", () => {
  it("a 422 array detail toasts a readable sentence, never [object Object] or a status code", async () => {
    stub({ mutate: () => json({ detail: [{ type: "string_pattern_mismatch", loc: ["body", "github_login"], msg: "x", input: "x" }] }, 422) });
    mount();
    await screen.findByText("kedar-gh");
    fireEvent.change(screen.getByLabelText("GitHub username to invite"), { target: { value: "newbie" } });
    fireEvent.click(document.querySelector("#memInvite")!);
    expect(await screen.findByText("Couldn't invite newbie: That isn't a valid GitHub username.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\[object Object\]|\(422\)/);
  });

  it("an invalid login disables Invite with a hint and sends nothing", async () => {
    stub();
    mount();
    await screen.findByText("kedar-gh");
    fireEvent.change(screen.getByLabelText("GitHub username to invite"), { target: { value: "not a login" } });
    const btn = document.querySelector<HTMLButtonElement>("#memInvite")!;
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "That isn't a valid GitHub username");
    expect(document.querySelector("#memLoginHint")).not.toBeNull();
    const posts = (global.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.filter(([, i]) => i?.method === "POST");
    expect(posts).toHaveLength(0);
  });
});

describe("row grid (MEM-V1)", () => {
  it("a manage_members member: the owner row's role chip sits in the Role slot; no Permissions header", async () => {
    stub({ me: { identity: { agent_id: "h2", alias: "sam", github_login: "sam-gh", member_role: "member", grants: ["manage_members"] }, trusted: true } });
    mount();
    await screen.findByText("kedar-gh");
    await waitFor(() => expect(document.querySelector(".mem-cols")).toHaveTextContent("Role"));
    expect(document.querySelector(".mem-cols")).not.toHaveTextContent("Permissions");
    const ownerRow = document.querySelectorAll(".mem-row")[0];
    expect(ownerRow.querySelector(".mem-meta .tag.role-owner")).toBeNull();
    expect(ownerRow.querySelector(".mem-acts .mem-role-slot .tag.role-owner")).toHaveTextContent("Owner");
    expect(ownerRow.querySelector(".mem-acts .mem-x-slot")).not.toBeNull();
    expect(ownerRow.querySelector(".mem-remove")).toBeNull();
  });
});

describe("in-flight mutation (MEM-BUSY) and the role toast", () => {
  it("keeps the editable card while a role change is in flight, then toasts the role's label", async () => {
    let release: (r: Response) => void = () => {};
    stub({ mutate: () => new Promise<Response>((res) => { release = res; }) });
    mount();
    await screen.findByText("sam-gh");
    fireEvent.click(screen.getByRole("button", { name: "Project role for sam-gh: Member" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Viewer" }));
    // mid-flight: no read-only collapse, controls disabled in place
    await waitFor(() => expect(screen.getByRole("button", { name: "Project role for sam-gh: Member" })).toBeDisabled());
    expect(document.querySelector("#memReadOnly")).toBeNull();
    expect(document.querySelector("#memInvite")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove access for sam-gh" })).toBeDisabled();
    await act(async () => { release(json({ ok: true })); });
    expect(await screen.findByText("Role updated — Viewer.")).toBeInTheDocument();
  });
});

describe("viewer permissions", () => {
  it("grantsForRole: a viewer only gets the roster grant", () => {
    expect(grantsForRole("viewer").map(([g]) => g)).toEqual(["manage_members"]);
    expect(grantsForRole("member").length).toBe(6);
  });
  it("a viewer's popover offers only the roster grant and says they're read-only", async () => {
    stub();
    mount();
    await screen.findByText("tomas-v");
    fireEvent.click(screen.getByRole("button", { name: /Permissions for tomas-v/ }));
    const dlg = await screen.findByRole("dialog", { name: "Permissions for tomas-v" });
    expect(dlg).toHaveTextContent("Viewers are read-only");
    expect(dlg.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(dlg).toHaveTextContent("Members — invite, remove, see the roster");
  });
});

/**
 * Settings — full-QA round 2 (portal-settings-etc fixer):
 *  S1  a non-member (the snapshot answered 403) sees ONE "not a member" line on
 *      Models & providers / Integrations / Members — no per-card "Couldn't load"
 *      + Retry; a 403 inside the Members / GitHub cards reads the same, no Retry.
 *  D9  a signed-in GitHub user who belongs to no project gets "ask an owner to
 *      invite you" on Devices & pairing — no desktop sign-in offer, no
 *      "needs GitHub sign-in (self-hosted)" line.
 *  I6  a viewer on Integrations sees the GitHub token status only — no
 *      editable secret field, no Save/Test/Remove.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../../cloud/identity";
import { GitHubAccessSection } from "../../cloud/settings/GitHubAccessSection";
import { DEVICE_NOT_A_MEMBER, deviceListDenial } from "../../cloud/device/DeviceTokens";
import { MembersSection } from "../../cloud/members/MembersPage";
import { resetPlan } from "../../cloud/shared/plan";
import { SettingsPage } from "./SettingsPage";

type Route = (url: string, method: string) => { status: number; data: unknown } | null;
const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "active" };
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;
const ORIG_ROUTES = extensions.routes;

function install(opts: { snapStatus?: number; route?: Route } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    const hit = opts.route ? opts.route(url, method) : null;
    if (hit) return res(hit.data, hit.status);
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1") {
      if (opts.snapStatus) return res({ detail: "GitHub user 'stranger-dan' is not a member of this project" }, opts.snapStatus);
      return res({ container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" }, agents: [HUMAN], tasks: [], requests: [] });
    }
    // every project-scoped card read 403s for a non-member
    if (url.startsWith("/api/containers/c1/")) return res({ detail: "not a member of this project" }, 403);
    if (url.startsWith("/api/me")) return res({ identity: null, trusted: true });
    if (url === "/api/prefs") return res({ prefs: null });
    if (url === "/api/github/repos") return res({ available: false, repos: [] });
    return res({});
  }));
}

function asIdentity(id: Identity | null, trusted = true) {
  extensions.identity = async () => id;
  extensions.identityTrusted = () => trusted;
}

function renderAt(tab: string) {
  window.history.replaceState(null, "", window.location.pathname + "#tab=" + tab);
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter><SettingsPage /></MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  delete extensions.settingsGeneral;
  localStorage.clear();
  resetIdentity();
  extensions.settingsSections = [
    { key: "github-access", title: "GitHub access", element: GitHubAccessSection },
    { key: "members", title: "Members", element: () => <div id="membersCard">MEMBERS CARD</div> },
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete extensions.settingsSections;
  extensions.identity = ORIG_IDENTITY;
  extensions.identityTrusted = ORIG_TRUSTED;
  extensions.routes = ORIG_ROUTES;
});

describe("S1: a non-member sees 'not a member' once per section", () => {
  for (const tab of ["provider-keys", "github-access", "members"]) {
    it(tab + ": one line, no Couldn't load, no Retry", async () => {
      asIdentity(null, true);
      install({ snapStatus: 403 });
      renderAt(tab);
      await waitFor(() => expect(document.getElementById("setNotMember")).not.toBeNull());
      expect(screen.getAllByText("You're not a member of this project.")).toHaveLength(1);
      expect(screen.queryByText(/Couldn.t load/)).toBeNull();
      expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
      expect(document.getElementById("membersCard")).toBeNull();
    });
  }

  it("general (NEW-G6w): only the not-a-member line — no Work type / Template sections", async () => {
    asIdentity(null, true);
    install({ snapStatus: 403 });
    renderAt("general");
    await waitFor(() => expect(screen.getAllByText("You're not a member of this project.")).toHaveLength(1));
    expect(screen.queryByText(/Work type/)).toBeNull();
    expect(screen.queryByText(/Couldn.t read the mode/)).toBeNull();
    expect(screen.queryByText(/Apply a template/)).toBeNull();
  });

  it("a 403 inside the GitHub card reads 'not a member' with no Retry", async () => {
    install();
    render(<ToastProvider><SnapshotProvider><GitHubAccessSection /></SnapshotProvider></ToastProvider>);
    expect(await screen.findByText("You're not a member of this project.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });
});

describe("S1: a 403 inside the Members card", () => {
  it("reads 'not a member' with no Retry", async () => {
    resetPlan();
    install({ route: (url) => (url === "/api/plan" ? { status: 200, data: { plan: "team", features: { members: true }, upgrade_url: "x" } } : null) });
    render(<ToastProvider><SnapshotProvider><MemoryRouter><MembersSection /></MemoryRouter></SnapshotProvider></ToastProvider>);
    expect(await screen.findByText("You're not a member of this project.")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load members/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });
});

describe("D9: a signed-in GitHub user with no project", () => {
  it("deviceListDenial tells the two 403s apart", () => {
    expect(deviceListDenial("device tokens require a verified GitHub identity")).toBe("unavailable");
    expect(deviceListDenial("GitHub user 'stranger-dan' is not a member of any project")).toBe("not_member");
    expect(deviceListDenial(undefined)).toBe("unavailable");
  });

  it("pairing says 'ask an owner to invite you' and offers no desktop sign-in", async () => {
    extensions.routes = [{ path: "/auth/device", element: () => null }];
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] }, true);
    install({
      route: (url) => {
        if (url.startsWith("/api/me")) return { status: 200, data: { identity: null, trusted: true } };
        if (url === "/api/device-tokens") return { status: 403, data: { detail: "GitHub user 'stranger-dan' is not a member of any project" } };
        return null;
      },
    });
    renderAt("pairing");
    expect(await screen.findByText(DEVICE_NOT_A_MEMBER)).toBeInTheDocument();
    expect(screen.queryByText(/Sign in the desktop app/)).toBeNull();
    expect(screen.queryByText(/isn't available on this self-hosted portal/)).toBeNull();
  });
});

describe("I6: a viewer sees GitHub token status only", () => {
  it("no secret input, no Save/Test/Remove — just the status line", async () => {
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] }, true);
    install({
      route: (url, method) => {
        if (url.startsWith("/api/me")) return { status: 200, data: { identity: { agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] }, trusted: true } };
        if (url === "/api/containers/c1/settings/github-pat" && method === "GET")
          return { status: 200, data: { configured: true, source: "db", masked: "ghp_...WXYZ", set_at: null } };
        return null;
      },
    });
    renderAt("github-access");
    expect(await screen.findByText("Personal access token configured")).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById("ga-locked")).not.toBeNull());
    expect(screen.getByText("ghp_...WXYZ")).toBeInTheDocument();
    expect(document.getElementById("ga-input")).toBeNull();
    expect(document.getElementById("ga-save")).toBeNull();
    expect(document.getElementById("ga-test")).toBeNull();
    expect(document.getElementById("ga-remove")).toBeNull();
  });
});

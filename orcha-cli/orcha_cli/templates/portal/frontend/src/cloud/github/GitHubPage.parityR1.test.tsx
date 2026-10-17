/**
 * GitHubPage — parity round 1 (code-github fixer):
 *  - e2e-permissions-16: Connect repo is disabled with the reason for a viewer
 *    and for a member without manage_repo; an owner / granted member keeps it
 *  - wave4 review: with NOTHING focused, ↓ (or j) lands on the first row, and
 *    Enter then opens it
 *  - a body-level {available:false, reason:"unreachable"} never prints
 *    "Couldn't load from GitHub (200)" or the bare reason code
 *  - repoConnectBlockedReason / bindErrorText (pure)
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { focusFirstGhRowFromIdle, GitHubPage } from "./GitHubPage";
import { bindErrorText, MANAGE_REPO_REASON, repoConnectBlockedReason } from "./repoPermissions";

const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};
const ISSUES = {
  available: true,
  repo: "acme/app",
  issues: [
    { number: 231, title: "Collapsed sidebar rail", labels: [], assignee: null, updated_at: "2026-08-01T00:00:00Z" },
    { number: 228, title: "Model field empty", labels: [], assignee: null, updated_at: "2026-07-31T00:00:00Z" },
  ],
};
const NOT_CONNECTED = { available: false, reason: "repo_not_connected" };

let issuesBody: unknown = ISSUES;
let binding: string | null = "acme/app";
let lastSearch = "";
function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}
function stub() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith("/api/containers/c1/github/pulls") ? { available: true, repo: binding, pulls: [] }
      : url.startsWith("/api/containers/c1/github/issues") ? issuesBody
      : url === "/api/containers/c1/github" ? { repo: binding }
      : url.startsWith("/api/github/repos") ? { available: true, source: "app", repos: [{ full_name: "acme/app" }] }
      : url.startsWith("/api/containers/c1") ? SNAP
      : url === "/api/containers" ? [{ id: "c1", status: "active" }]
      : {};
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}
function actAs(id: Identity | null) {
  if (id) {
    extensions.identity = async () => id;
    extensions.identityTrusted = () => true;
  } else {
    delete extensions.identity;
    delete extensions.identityTrusted;
  }
}
function mount(entry = "/github") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <GitHubPage />
          <LocationProbe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const VIEWER: Identity = { agent_id: "h1", alias: "kedar", member_role: "viewer" };
const MEMBER_NO_GRANT: Identity = { agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_keys"] };
const MEMBER_GRANTED: Identity = { agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_repo"] };

describe("repoConnectBlockedReason / bindErrorText (pure)", () => {
  const ok = { pending: false, readOnly: false, reason: null };
  it("mirrors enforce_grant(manage_repo): owner / granted member / trust-off allowed", () => {
    expect(repoConnectBlockedReason(ok, { member_role: "owner" })).toBeNull();
    expect(repoConnectBlockedReason(ok, MEMBER_GRANTED)).toBeNull();
    expect(repoConnectBlockedReason(ok, null)).toBeNull();
    expect(repoConnectBlockedReason(ok, MEMBER_NO_GRANT)).toBe(MANAGE_REPO_REASON);
    expect(repoConnectBlockedReason({ pending: false, readOnly: true, reason: "Your role is viewer (read-only)" }, VIEWER))
      .toBe("Your role is viewer (read-only)");
    expect(repoConnectBlockedReason({ pending: true, readOnly: false, reason: "Resolving your identity…" }, null)).toBe("Resolving your identity…");
  });
  it("never renders a raw status or an array detail", () => {
    expect(bindErrorText(400, "local repository source is not available here")).toBe("local repository source is not available here");
    expect(bindErrorText(422, null)).toBe("That repository name isn't valid.");
    expect(bindErrorText(403, null)).toMatch(/permission/);
    expect(bindErrorText(0, null)).toMatch(/Couldn't reach Embodent/);
    expect(bindErrorText(500, null)).not.toMatch(/500/);
  });
});

describe("GitHubPage parity r1", () => {
  beforeEach(() => { localStorage.clear(); issuesBody = ISSUES; binding = "acme/app"; lastSearch = ""; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); actAs(null); });

  it("viewer: the not-connected Connect repo CTA is disabled with the reason", async () => {
    actAs(VIEWER);
    binding = null;
    issuesBody = NOT_CONNECTED;
    stub();
    mount();
    await screen.findByText("No repository connected");
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect repo" })).toBeDisabled());
    expect(screen.getByText(/Your role is viewer \(read-only\) — ask an owner/)).toBeInTheDocument();
  });

  it("member without manage_repo: disabled with the grant reason; with manage_repo: enabled", async () => {
    actAs(MEMBER_NO_GRANT);
    binding = null;
    issuesBody = NOT_CONNECTED;
    stub();
    const view = mount();
    await screen.findByText("No repository connected");
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect repo" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Connect repo" })).toHaveAttribute("title", MANAGE_REPO_REASON);
    view.unmount();
    actAs(MEMBER_GRANTED);
    mount();
    await screen.findByText("No repository connected");
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect repo" })).not.toBeDisabled());
  });

  it("↓ with nothing focused lands on the first row; Enter opens it", async () => {
    stub();
    mount();
    await screen.findByText("Collapsed sidebar rail");
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(document.activeElement).toBe(document.querySelector('[data-gh-row="issue:231"]'));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await waitFor(() => expect(lastSearch).toContain("issue=231"));
  });

  it("↓ while typing in Search does not steal focus", async () => {
    stub();
    mount();
    await screen.findByText("Collapsed sidebar rail");
    const search = document.getElementById("ghSearch") as HTMLInputElement;
    search.focus();
    const ev = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
    expect(focusFirstGhRowFromIdle(ev)).toBe(false);
    expect(document.activeElement).toBe(search);
  });

  it("a 200 {available:false, reason:'unreachable'} never prints '(200)' or the bare reason", async () => {
    issuesBody = { available: false, reason: "unreachable" };
    stub();
    mount();
    expect(await screen.findByText("Couldn't load from GitHub")).toBeInTheDocument();
    expect(screen.queryByText(/\(200\)/)).toBeNull();
    expect(screen.getByText("GitHub didn't respond. Check the connection and try again.")).toBeInTheDocument();
  });
});

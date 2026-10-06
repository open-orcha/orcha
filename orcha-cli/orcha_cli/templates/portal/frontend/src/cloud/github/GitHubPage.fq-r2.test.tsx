/**
 * GitHubPage — full-QA round 2 (portal-settings-etc fixer):
 *  G09   a viewer can't dispatch: Start and "Assign to an agent" are disabled
 *        with the read-only reason (no "Pick an acting human first" toast);
 *  G10b  a non-member sees ONE "not a member" state — not the token-403 card
 *        with Check GitHub access / Change repo / Connect repo;
 *  G13   a bound repo answered "not connected" names the missing token, never
 *        "no GitHub repo is connected to this project".
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { GitHubPage, isMembershipDenial } from "./GitHubPage";

const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan", github_repo: "acme/app" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }, { id: "a1", alias: "forge", kind: "ai", status: "idle" }],
  tasks: [],
  requests: [],
};
const ISSUE = { number: 11, title: "Flaky login", labels: [], assignee: null, updated_at: "2026-08-01T00:00:00Z", body: "x", state: "open", user: { login: "o" } };
const ISSUES = { available: true, repo: "acme/app", issues: [ISSUE] };

type R = { status: number; body: unknown };
let routes: (url: string) => R | null = () => null;
function stub() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = routes(url);
    const r: R = hit ?? (url.startsWith("/api/containers/c1/github/pulls") ? { status: 200, body: { available: true, repo: "acme/app", pulls: [] } }
      : url.startsWith("/api/containers/c1/github/issues/11") ? { status: 200, body: { available: true, repo: "acme/app", issue: ISSUE, comments: [] } }
      : url.startsWith("/api/containers/c1/github/issues") ? { status: 200, body: ISSUES }
      : url === "/api/containers/c1/github" ? { status: 200, body: { repo: "acme/app" } }
      : url.startsWith("/api/containers/c1") ? { status: 200, body: SNAP }
      : url === "/api/containers" ? { status: 200, body: [{ id: "c1", status: "active" }] }
      : { status: 200, body: {} });
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as unknown as Response;
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
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("GitHubPage full-QA r2", () => {
  beforeEach(() => { localStorage.clear(); routes = () => null; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); actAs(null); });

  it("G09: a viewer's Start and Assign are disabled with the read-only reason", async () => {
    actAs({ agent_id: "h1", alias: "kedar", member_role: "viewer" });
    stub();
    mount("/github?issue=11");
    await waitFor(() => {
      const start = document.querySelector<HTMLButtonElement>(".gh-start-split.is-primary .gh-start");
      expect(start).not.toBeNull();
      expect(start!).toBeDisabled();
    });
    const start = document.querySelector<HTMLButtonElement>(".gh-start-split.is-primary .gh-start")!;
    expect(start.title).toMatch(/viewer/i);
    const dd = document.querySelector<HTMLButtonElement>(".gh-start-split.is-primary .gh-start-dd")!;
    expect(dd).toBeDisabled();
    expect(dd.title).toMatch(/viewer/i);
  });

  it("G09: an owner keeps Start enabled", async () => {
    actAs({ agent_id: "h1", alias: "kedar", member_role: "owner" });
    stub();
    mount("/github?issue=11");
    await waitFor(() => expect(document.querySelector(".gh-start-split.is-primary .gh-start")).not.toBeNull());
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>(".gh-start-split.is-primary .gh-start")!).not.toBeDisabled());
  });

  it("G10b: a non-member sees only the not-a-member state", async () => {
    actAs(null);
    routes = (url) => (url.startsWith("/api/containers/c1") && !url.includes("/github")
      ? { status: 403, body: { detail: "GitHub user 'nora-nobody' is not a member of this project" } }
      : url.startsWith("/api/containers/c1/github")
        ? { status: 403, body: { detail: "GitHub user 'nora-nobody' is not a member of this project" } }
        : null);
    stub();
    mount();
    expect(await screen.findByText("You're not a member of this project.")).toBeInTheDocument();
    expect(screen.queryByText(/token can.t access/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Check GitHub access" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Change repo|Connect repo/ })).toBeNull();
    expect(isMembershipDenial("GitHub user 'x' is not a member of this project")).toBe(true);
    expect(isMembershipDenial("Resource not accessible by personal access token")).toBe(false);
  });

  it("G13: a bound repo answered 'not connected' says the token is missing", async () => {
    actAs(null);
    routes = (url) => (url.startsWith("/api/containers/c1/github/issues")
      ? { status: 200, body: { available: false, reason: "repo_not_connected", detail: "no GitHub repo is connected to this project" } }
      : null);
    stub();
    mount();
    expect(await screen.findByText("Can't reach acme/app")).toBeInTheDocument();
    expect(screen.queryByText(/no GitHub repo is connected to this project/)).toBeNull();
    expect(screen.getByText(/No GitHub token can read this repository/)).toBeInTheDocument();
  });
});

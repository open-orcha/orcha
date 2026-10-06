/**
 * Parity round 1 (code-github fixer) regressions for Code Space:
 *  - viewer / non-member: Edit, commit (checkboxes, message, Commit), Push and
 *    Propose are disabled with the reason — the server refuses them
 *    (trusted_actor) — while a member keeps them (wave4 review, "Code");
 *  - a binary file offers no Edit toggle (parity extra);
 *  - an unreachable project (5xx) is ONE page state, not a tree error beside
 *    an "empty" landing (wave4 review);
 *  - Connect repo is disabled with the reason for a viewer (e2e-permissions-16).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { _resetProjectsForTests } from "../../state/projects";
import { ChangesTab } from "./ChangesTab";
import { CodeSpacePage } from "./CodeSpacePage";
import { DraftsBar } from "./DraftsBar";

// the real identity seam (no module mocks): the provider resolves the
// signed-in identity, and useActingAuthority derives viewer / member from it
const VIEWER: Identity = { agent_id: "h1", alias: "kedar", member_role: "viewer", github_login: "kedar" };
const MEMBER: Identity = { agent_id: "h1", alias: "kedar", member_role: "member", github_login: "kedar", grants: [] };
function actAs(id: Identity) {
  extensions.identity = async () => id;
  extensions.identityTrusted = () => true;
}
function Wrap({ children }: { children: ReactNode }) {
  return <ToastProvider><SnapshotProvider>{children}</SnapshotProvider></ToastProvider>;
}
const VIEWER_REASON = "Your role is viewer (read-only)";

const SNAP = {
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};
const TREE_ROOT = {
  ref: "HEAD", path: "",
  entries: [{ name: "a.ts", path: "a.ts", type: "file" }, { name: "logo.png", path: "logo.png", type: "file" }],
};
const FILE_A = { ref: "HEAD", path: "a.ts", content: "const x = 1;", size: 12, blob_sha: "blobA" };
const FILE_PNG = { ref: "HEAD", path: "logo.png", binary: true, size: 2048 };
const DIRTY = {
  available: true, dirty: true,
  files: [{ path: "a.ts", status: "M", additions: 1, deletions: 0 }],
  summary: { files: 1, additions: 1, deletions: 0 },
};

type Over = (url: string) => { status?: number; body: unknown } | null;
function stub(over?: Over) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    const o = over ? over(url) : null;
    if (o) return reply(o.body, o.status ?? 200);
    if (url.includes("/code/worktree/available")) return reply({ available: true });
    if (url.includes("/code/worktree/branch")) return reply({ available: true, branch: "main", ahead: 2, remote: "git@github.com:acme/app.git" });
    if (url.includes("/code/worktree/changes")) return reply(DIRTY);
    if (url.includes("/github/browse/tree")) return reply(TREE_ROOT);
    if (url.includes("/github/browse/file")) return reply(url.includes("logo.png") ? FILE_PNG : FILE_A);
    if (url.includes("/code/threads")) return reply({ threads: [] });
    if (url.includes("/code/outline")) return reply({ available: true, ref: "HEAD", path: "a.ts", symbols: [] });
    if (url.startsWith("/api/containers/c1")) return reply(SNAP);
    if (url === "/api/containers") return reply([{ id: "c1", status: "active" }]);
    return reply({});
  }) as unknown as typeof fetch;
}

function mountPage(entry = "/code?path=a.ts") {
  return render(<Wrap><MemoryRouter initialEntries={[entry]}><CodeSpacePage /></MemoryRouter></Wrap>);
}

describe("Code Space write gate (viewer)", () => {
  beforeEach(() => { localStorage.clear(); actAs(MEMBER); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); delete extensions.identity; delete extensions.identityTrusted; });

  it("viewer: Edit is disabled with the reason; a member gets it enabled", async () => {
    actAs(VIEWER);
    stub();
    const view = mountPage();
    const edit = await screen.findByRole("button", { name: /^Edit/ });
    await waitFor(() => expect(edit).toBeDisabled());
    expect(edit).toHaveAttribute("title", VIEWER_REASON);
    view.unmount();
    actAs(MEMBER);
    mountPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Edit/ })).not.toBeDisabled());
  });

  it("viewer: commit checkboxes, message, Commit and Push are all disabled", async () => {
    actAs(VIEWER);
    stub();
    render(<Wrap><ChangesTab cid="c1" onOpenChange={vi.fn()} /></Wrap>);
    const box = await screen.findByRole("checkbox", { name: "Include a.ts in the next commit" });
    await waitFor(() => expect(box).toBeDisabled());
    const msg = screen.getByRole("textbox");
    expect(msg).toBeDisabled();
    fireEvent.change(msg, { target: { value: "try anyway" } });
    const commit = screen.getByRole("button", { name: /Commit 1 file/ });
    expect(commit).toBeDisabled();
    expect(commit).toHaveAttribute("title", VIEWER_REASON);
    const push = await screen.findByRole("button", { name: "Push" });
    expect(push).toBeDisabled();
    expect(push).toHaveAttribute("title", VIEWER_REASON);
  });

  it("member: commit + push stay enabled", async () => {
    stub();
    render(<Wrap><ChangesTab cid="c1" onOpenChange={vi.fn()} /></Wrap>);
    await screen.findByRole("checkbox", { name: "Include a.ts in the next commit" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "msg" } });
    expect(screen.getByRole("button", { name: /Commit 1 file/ })).not.toBeDisabled();
    expect(await screen.findByRole("button", { name: "Push" })).not.toBeDisabled();
  });

  it("viewer: Propose is disabled even with a message", async () => {
    actAs(VIEWER);
    stub();
    render(
      <Wrap>
        <DraftsBar cid="c1" gitRef="HEAD" drafts={[{ path: "a.ts", content: "x", baseHash: null, savedAt: 1 }]}
          onOpenDraft={vi.fn()} onDraftsChanged={vi.fn()} />
      </Wrap>,
    );
    fireEvent.click(screen.getByText("Propose changes…"));
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: "Fix" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Propose" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Propose" })).toHaveAttribute("title", VIEWER_REASON);
  });
});

describe("Code Space states", () => {
  beforeEach(() => { localStorage.clear(); actAs(MEMBER); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); delete extensions.identity; delete extensions.identityTrusted; });

  it("a binary file offers no Edit toggle", async () => {
    stub();
    const view = mountPage("/code?path=logo.png");
    // an image is previewed from its raw bytes (never shown as text) …
    await waitFor(() => expect(view.container.querySelector('.fp[data-kind="image"]')).not.toBeNull());
    expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).includes("/github/browse/raw?") && String(u).includes("path=logo.png"))).toBe(true);
    // … and still offers no Edit toggle
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });

  it("an unreachable project (503) renders one page state (no landing, no tree error); the shell bar owns Retry", async () => {
    stub((url) => (url.startsWith("/api/containers/c1") ? { status: 503, body: { detail: "project database unreachable: connection refused (host x-db:5432)" } } : null));
    mountPage("/code");
    expect(await screen.findByText("Can't reach this project")).toBeInTheDocument();
    expect(screen.queryByText(/No threads yet/)).toBeNull();
    expect(screen.queryByText(/Couldn.t load \(503\)/)).toBeNull();
    // exactly ONE Retry on screen (the shell's stale bar) — never twice
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    // the raw DB text is never on the page body
    expect(document.querySelector(".cs-shell")!.textContent).not.toContain("x-db:5432");
  });

  it("parity r2: an unreachable project is named from the project list (snapshot has no name)", async () => {
    stub((url) => {
      if (url.startsWith("/api/containers/c1")) return { status: 503, body: { detail: "project database unreachable" } };
      if (url.startsWith("/api/containers")) return { body: [{ id: "c1", name: "data-ingestion-pipeline-v2", status: "active" }] };
      return null;
    });
    _resetProjectsForTests(); // the list store is module-global — drop earlier tests' rows
    mountPage("/code?cid=c1");
    expect(await screen.findByText("Can't reach data-ingestion-pipeline-v2")).toBeInTheDocument();
  });

  it("snapshot fine but the code tree 5xx: the page state carries collapsed Details + its own Retry", async () => {
    stub((url) => (url.includes("/github/browse/tree") ? { status: 503, body: { detail: "project database unreachable: connection refused (host x-db:5432)" } } : null));
    mountPage("/code");
    expect(await screen.findByText("Can't reach Acme")).toBeInTheDocument();
    const details = document.querySelector(".cs-unreachable-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("HTTP 503");
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls));
  });

  it("not connected + viewer: Connect repo is disabled with the reason (e2e-permissions-16)", async () => {
    actAs(VIEWER);
    stub((url) => (url.includes("/github/browse/tree") ? { body: { available: false, reason: "repo_not_connected" } } : null));
    mountPage("/code");
    const cta = await screen.findByRole("button", { name: "Connect repo" });
    expect(cta).toBeDisabled();
    expect(screen.getByText(/Your role is viewer \(read-only\) — ask an owner/)).toBeInTheDocument();
  });
});

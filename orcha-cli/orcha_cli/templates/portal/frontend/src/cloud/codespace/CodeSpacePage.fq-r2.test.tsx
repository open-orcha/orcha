/**
 * Code Space — full-QA round 2 (portal-settings-etc fixer):
 *  C14c  the line gutter is a keyboard button: focusable, labelled, Enter opens
 *        the thread composer on that line;
 *  C18   a project WITH a bound repo that browse can't read says "Can't reach
 *        <repo>" (Check GitHub access), never "No repository connected";
 *        a repo-scope not_found names the repository, a no_token reason is an
 *        access problem;
 *  C10   the Push button explains itself: no remote / no upstream / nothing.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { classifyDetailError, unavailableError } from "../github/ghlib";
import { pushState } from "./ChangesTab";
import { CodeSpacePage } from "./CodeSpacePage";

const AGENTS = [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }];
const TREE_ROOT = { ref: "HEAD", path: "", entries: [{ name: "a.ts", path: "a.ts", type: "file" }] };
const FILE_A = { ref: "HEAD", path: "a.ts", content: "one\ntwo\nthree", size: 13 };

function stub(opts: { tree?: unknown; repo?: string | null } = {}) {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(opts.tree ?? TREE_ROOT);
    if (url.startsWith("/api/containers/c1/github/browse/file")) return json(FILE_A);
    if (url.startsWith("/api/containers/c1/code/threads")) return json({ threads: [] });
    if (url.startsWith("/api/containers/c1/code/outline")) return json({ available: true, ref: "HEAD", path: "a.ts", language: null, symbols: [] });
    if (url.startsWith("/api/containers/c1")) {
      return json({
        container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan", github_repo: opts.repo ?? null },
        agents: AGENTS, tasks: [], requests: [],
      });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

function mount(entry: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <CodeSpacePage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("Code Space — full-QA r2", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("C14c: the gutter is a focusable button; Enter starts a thread on that line", async () => {
    stub();
    mount("/code?path=a.ts");
    const g = await screen.findByRole("button", { name: "Start a thread on line 2" });
    expect(g).toHaveAttribute("tabindex", "0");
    g.focus();
    fireEvent.keyDown(g, { key: "Enter" });
    expect(document.querySelector('[data-cs-line="2"]')!.className).toContain("selected");
  });

  it("C18: a bound repo that browse calls not-connected names the repo + GitHub access", async () => {
    stub({ repo: "acme/orcha-web", tree: { available: false, reason: "repo_not_connected", detail: "no GitHub repo is connected to this project" } });
    mount("/code");
    expect(await screen.findByText("Can't reach acme/orcha-web")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check GitHub access" }).getAttribute("href")).toContain("#tab=github-access");
    expect(screen.queryByText(/No repository connected/i)).toBeNull();
  });

  it("C18: a no_token answer for the bound repo is the same page state, with the server's reason", async () => {
    stub({ repo: "acme/orcha-web", tree: { available: false, reason: "no_token", repo: "acme/orcha-web", detail: "no GitHub token can read acme/orcha-web — add one in Settings → GitHub access" } });
    mount("/code");
    expect(await screen.findByText("Can't reach acme/orcha-web")).toBeInTheDocument();
    expect(screen.getByText(/No GitHub token can read acme\/orcha-web/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check GitHub access" })).toBeInTheDocument();
  });

  it("C18: an unbound project still shows the one not-connected state", async () => {
    stub({ repo: null, tree: { available: false, reason: "repo_not_connected", detail: "no GitHub repo is connected to this project" } });
    mount("/code");
    expect(await screen.findByText(/No (GitHub )?repo(sitory)? connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/Can't reach/)).toBeNull();
  });

  it("C18/G13: repo-scope not_found names the repository; no_token is an access problem", () => {
    const nf = unavailableError({ available: false, reason: "not_found", detail: "issue or pull request not found" })!;
    expect(nf.kind).toBe("error");
    expect(nf.detail).toMatch(/^Repository or ref not found/);
    expect(nf.detail).not.toMatch(/issue or pull request/);
    // item scope (a file read) keeps not_found
    expect(unavailableError({ available: false, reason: "not_found" }, 200, "item")!.kind).toBe("not_found");
    const nt = unavailableError({ available: false, reason: "no_token", detail: null })!;
    expect(nt.kind).toBe("no_access");
    expect(nt.detail).toMatch(/Settings › Integrations/);
    expect(classifyDetailError(200, { reason: "no_token" }).kind).toBe("no_access");
  });

  it("C10: Push says why it's unavailable", () => {
    expect(pushState({ remote: undefined, ahead: undefined })).toEqual({ enabled: false, title: "No remote configured" });
    expect(pushState({ remote: "git@github.com:o/r.git", ahead: undefined })).toEqual({ enabled: true, title: "Push and set upstream" });
    expect(pushState({ remote: "git@github.com:o/r.git", ahead: 0 })).toEqual({ enabled: false, title: "Nothing to push" });
    expect(pushState({ remote: "git@github.com:o/r.git", ahead: 2 })).toEqual({ enabled: true, title: "Push 2 commits" });
  });
});

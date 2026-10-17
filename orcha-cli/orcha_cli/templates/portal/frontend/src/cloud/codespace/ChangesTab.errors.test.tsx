/**
 * Screen review r3 — commit/push HTTP failures. sendJson used to ignore
 * r.ok, so a 403/500 commit toasted "Nothing to commit", and a non-JSON 502
 * threw out of .then() leaving the Commit button stuck on "Committing…".
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { ChangesTab } from "./ChangesTab";
import { commitWorktree, pushWorktree, saveWorktreeFile } from "./worktreeApi";

const ONE_DIRTY = {
  available: true,
  dirty: true,
  files: [{ path: "src/a.ts", status: "M", additions: 3, deletions: 1 }],
  summary: { files: 1, additions: 3, deletions: 1 },
};

const json = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 500 ? "Internal Server Error" : status === 502 ? "Bad Gateway" : "",
  json: async () => payload,
});
const nonJson = (status: number) => ({
  ok: false,
  status,
  statusText: "Bad Gateway",
  json: async () => { throw new SyntaxError("Unexpected token <"); },
});

function mockCommit(commitResponse: () => unknown) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/worktree/branch")) return json({ available: false });
    if (u.endsWith("/worktree/commit") && init?.method === "POST") return commitResponse();
    if (u.endsWith("/worktree/changes")) return json(ONE_DIRTY);
    return json({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function commitOnce() {
  render(<ToastProvider><ChangesTab cid="c1" onOpenChange={vi.fn()} /></ToastProvider>);
  await screen.findByText("src/a.ts");
  fireEvent.change(screen.getByPlaceholderText("Commit message"), { target: { value: "msg" } });
  fireEvent.click(screen.getByRole("button", { name: /commit 1 file/i }));
}

describe("worktree write errors", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("a 500 JSON commit says Couldn't commit with the server detail, and the button recovers", async () => {
    mockCommit(() => json({ detail: "git index.lock exists" }, 500));
    await commitOnce();
    expect(await screen.findByText("Couldn't commit: git index.lock exists")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to commit")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /commit 1 file/i })).not.toBeDisabled());
  });

  it("a non-JSON 502 commit does not leave the button stuck", async () => {
    mockCommit(() => nonJson(502));
    await commitOnce();
    expect(await screen.findByText("Couldn't commit: HTTP 502 Bad Gateway")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /commit 1 file/i })).not.toBeDisabled());
  });

  it("a 403 commit is not reported as nothing to commit", async () => {
    mockCommit(() => json({ detail: "Viewers can't commit" }, 403));
    await commitOnce();
    expect(await screen.findByText("Couldn't commit: Viewers can't commit")).toBeInTheDocument();
  });

  it("the route's honest nothing_committed payload still reads as Nothing to commit", async () => {
    mockCommit(() => json({ available: true, ok: false, reason: "nothing_committed" }));
    await commitOnce();
    expect(await screen.findByText("Nothing to commit")).toBeInTheDocument();
  });

  it("commitWorktree resolves (never rejects) on network failure", async () => {
    global.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(commitWorktree("c1", ["a"], "m")).resolves.toEqual({ ok: false, reason: "http", status: 0, detail: "Failed to fetch" });
  });

  it("pushWorktree maps HTTP failures to {ok:false, detail}", async () => {
    global.fetch = vi.fn(async () => nonJson(502)) as unknown as typeof fetch;
    await expect(pushWorktree("c1")).resolves.toEqual({ ok: false, detail: "Couldn't push: HTTP 502 Bad Gateway" });
    global.fetch = vi.fn(async () => json({ detail: [{ msg: "field required" }] }, 422)) as unknown as typeof fetch;
    await expect(pushWorktree("c1")).resolves.toEqual({ ok: false, detail: "Couldn't push: field required" });
  });

  it("saveWorktreeFile keeps drift payloads and maps HTTP errors to reason http", async () => {
    global.fetch = vi.fn(async () => json({ available: true, ok: false, reason: "drift", current_hash: "h2" })) as unknown as typeof fetch;
    await expect(saveWorktreeFile("c1", "a", "x", "h1")).resolves.toMatchObject({ ok: false, reason: "drift", current_hash: "h2" });
    global.fetch = vi.fn(async () => json({ detail: "boom" }, 500)) as unknown as typeof fetch;
    await expect(saveWorktreeFile("c1", "a", "x", "h1")).resolves.toMatchObject({ ok: false, reason: "http", status: 500, detail: "boom" });
  });
});

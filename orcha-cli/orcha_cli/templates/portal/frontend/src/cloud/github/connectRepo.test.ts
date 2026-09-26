/**
 * connectRepo — pure helpers behind the Connect-repo picker (Orcha Cloud
 * local run, Addendum 2): the local-sentinel guard, the repo-list split, and
 * the two fetch/PUT wrappers against a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGithubRepos,
  isLocalRepo,
  LOCAL_REPO_SENTINEL,
  putRepoBinding,
  repoDisplayName,
  splitRepoEntries,
} from "./connectRepo";

afterEach(() => { vi.restoreAllMocks(); });

describe("isLocalRepo / repoDisplayName", () => {
  it("recognizes exactly the 'local' sentinel", () => {
    expect(isLocalRepo("local")).toBe(true);
    expect(isLocalRepo("acme/local")).toBe(false);
    expect(isLocalRepo(null)).toBe(false);
    expect(isLocalRepo(undefined)).toBe(false);
    expect(LOCAL_REPO_SENTINEL).toBe("local");
  });

  it("shows the local dirname (or a fallback) for a local binding, the raw owner/name otherwise", () => {
    expect(repoDisplayName("local", "quantal-ehr")).toBe("quantal-ehr");
    expect(repoDisplayName("local", null)).toBe("This machine");
    expect(repoDisplayName("acme/app", "quantal-ehr")).toBe("acme/app");
    expect(repoDisplayName(null)).toBe("");
  });
});

describe("splitRepoEntries", () => {
  it("pulls the prepended local entry out of the GitHub list", () => {
    const { local, github } = splitRepoEntries([
      { full_name: "local", name: "quantal-ehr", source_kind: "local" },
      { full_name: "acme/app", private: false },
      { full_name: "acme/lib", private: true },
    ]);
    expect(local).toEqual({ full_name: "local", name: "quantal-ehr", source_kind: "local" });
    expect(github.map((r) => r.full_name)).toEqual(["acme/app", "acme/lib"]);
  });

  it("handles a payload with no local entry (defensive against the parallel backend gap)", () => {
    const { local, github } = splitRepoEntries([{ full_name: "acme/app" }]);
    expect(local).toBeNull();
    expect(github.map((r) => r.full_name)).toEqual(["acme/app"]);
  });

  it("handles undefined/empty input", () => {
    expect(splitRepoEntries(undefined)).toEqual({ local: null, github: [] });
    expect(splitRepoEntries([])).toEqual({ local: null, github: [] });
  });
});

function jsonResponse(data: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => data } as unknown as Response;
}

describe("fetchGithubRepos", () => {
  it("passes cid through as a query param and returns the parsed payload", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse({ available: true, source: "pat", repos: [{ full_name: "acme/app" }] });
    }) as unknown as typeof fetch;
    const payload = await fetchGithubRepos("c1");
    expect(calls).toEqual(["/api/github/repos?cid=c1"]);
    expect(payload.available).toBe(true);
    expect(payload.repos).toHaveLength(1);
  });

  it("degrades to available:false on a network error (never throws)", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const payload = await fetchGithubRepos(null);
    expect(payload).toEqual({ available: false, repos: [] });
  });

  it("degrades to available:false on a non-2xx response", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ detail: "nope" }, 500)) as unknown as typeof fetch;
    const payload = await fetchGithubRepos("c1");
    expect(payload).toEqual({ available: false, repos: [] });
  });
});

describe("putRepoBinding", () => {
  it("PUTs the sentinel for a local choice", async () => {
    let call: { url: string; init: RequestInit } | null = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: String(input), init: init! };
      return jsonResponse({ repo: "local" });
    }) as unknown as typeof fetch;
    const res = await putRepoBinding("c1", "local");
    expect(res.ok).toBe(true);
    expect(call!.url).toBe("/api/containers/c1/github");
    expect(call!.init.method).toBe("PUT");
    expect(JSON.parse(String(call!.init.body))).toEqual({ repo: "local" });
  });

  it("PUTs an owner/name repo for a GitHub choice", async () => {
    let body: unknown = null;
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ repo: "acme/app" });
    }) as unknown as typeof fetch;
    await putRepoBinding("c1", "acme/app");
    expect(body).toEqual({ repo: "acme/app" });
  });

  it("surfaces a failed PUT's status/detail instead of throwing", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ detail: "bad repo" }, 422)) as unknown as typeof fetch;
    const res = await putRepoBinding("c1", "not-a-repo");
    expect(res).toEqual({ ok: false, status: 422, detail: "bad repo" });
  });
});

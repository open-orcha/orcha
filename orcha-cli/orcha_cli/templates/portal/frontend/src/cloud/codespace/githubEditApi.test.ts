/**
 * githubEditApi.ts — fetch wrappers over the code/github/{editable,propose}
 * CONTRACT. Mocked fetch (symbolsApi.test.ts's precedent).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGithubEditable, proposeChanges } from "./githubEditApi";

function stubJson(data: unknown, status = 200) {
  global.fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => data }) as unknown as Response) as unknown as typeof fetch;
}

describe("fetchGithubEditable", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hits the editable endpoint and returns true when available", async () => {
    stubJson({ available: true });
    const ok = await fetchGithubEditable("c1");
    expect(ok).toBe(true);
    const calledUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl).toBe("/api/containers/c1/code/github/editable");
  });

  it("returns false when available:false (e.g. local_source)", async () => {
    stubJson({ available: false, reason: "local_source" });
    expect(await fetchGithubEditable("c1")).toBe(false);
  });

  it("returns false when available is omitted", async () => {
    stubJson({});
    expect(await fetchGithubEditable("c1")).toBe(false);
  });

  it("degrades to false on a thrown network error", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await fetchGithubEditable("c1")).toBe(false);
  });

  it("encodes the cid in the URL", async () => {
    stubJson({ available: true });
    await fetchGithubEditable("c/1");
    const calledUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl).toBe("/api/containers/c%2F1/code/github/editable");
  });
});

describe("proposeChanges", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the body and returns an ok result", async () => {
    stubJson({ available: true, ok: true, pr_number: 7, pr_url: "https://github.com/o/r/pull/7", branch: "orcha/edits", commit_sha: "abc" });
    const res = await proposeChanges("c1", {
      base_ref: "HEAD",
      message: "Fix typo\n\nDetails here.",
      files: [{ path: "a.ts", content: "x", base_hash: "h1" }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.pr_number).toBe(7);
      expect(res.pr_url).toBe("https://github.com/o/r/pull/7");
    }
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("/api/containers/c1/code/github/propose");
    expect((init as RequestInit).method).toBe("POST");
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.files[0]).toEqual({ path: "a.ts", content: "x", base_hash: "h1" });
    expect(sentBody.files[0].base_hash).not.toBeUndefined();
  });

  it("passes null base_hash through for a new file", async () => {
    stubJson({ ok: false, reason: "github_error", detail: "boom" });
    await proposeChanges("c1", {
      base_ref: "HEAD",
      message: "Add file",
      files: [{ path: "new.ts", content: "x", base_hash: null }],
    });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.files[0].base_hash).toBeNull();
  });

  it("surfaces a drift result with stale paths", async () => {
    stubJson({ ok: false, reason: "drift", paths: ["a.ts"] });
    const res = await proposeChanges("c1", { base_ref: "HEAD", message: "m", files: [] });
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === "drift") expect(res.paths).toEqual(["a.ts"]);
  });

  it("surfaces a github_error result with detail", async () => {
    stubJson({ ok: false, reason: "github_error", detail: "rate limited" });
    const res = await proposeChanges("c1", { base_ref: "HEAD", message: "m", files: [] });
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === "github_error") expect(res.detail).toBe("rate limited");
  });
});

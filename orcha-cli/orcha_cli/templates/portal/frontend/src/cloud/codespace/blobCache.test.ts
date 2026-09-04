/**
 * blobCache.ts tests — jsdom has no IndexedDB, so every read/write test
 * injects a tiny in-memory stub via __setBlobDbForTests instead of touching
 * the real opener. Keying + the isCacheableSha guard are exercised directly
 * (pure functions, no DB needed).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __setBlobDbForTests,
  blobKey,
  getCachedBlob,
  isCacheableSha,
  putCachedBlob,
  type BlobCacheDb,
  type CachedBlob,
} from "./blobCache";

function makeInMemoryDb(): BlobCacheDb {
  const store = new Map<string, CachedBlob>();
  return {
    get: async (key) => store.get(key),
    put: async (key, value) => {
      store.set(key, value);
    },
  };
}

describe("blobKey", () => {
  it("joins cid/sha/path with colons", () => {
    expect(blobKey("c1", "abc123", "src/a.ts")).toBe("c1:abc123:src/a.ts");
  });

  it("produces distinct keys for different paths under the same sha", () => {
    expect(blobKey("c1", "sha1", "a.ts")).not.toBe(blobKey("c1", "sha1", "b.ts"));
  });

  it("produces distinct keys for different cids under the same sha/path", () => {
    expect(blobKey("c1", "sha1", "a.ts")).not.toBe(blobKey("c2", "sha1", "a.ts"));
  });
});

describe("isCacheableSha", () => {
  it("accepts a full 40-hex-char sha", () => {
    expect(isCacheableSha("a".repeat(40))).toBe(true);
    expect(isCacheableSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });

  it("accepts uppercase hex too", () => {
    expect(isCacheableSha("A".repeat(40))).toBe(true);
  });

  it("rejects moving refs and short/partial shas", () => {
    expect(isCacheableSha("HEAD")).toBe(false);
    expect(isCacheableSha("main")).toBe(false);
    expect(isCacheableSha("a1b2c3")).toBe(false); // short sha
    expect(isCacheableSha("")).toBe(false);
    expect(isCacheableSha("g".repeat(40))).toBe(false); // not hex
  });
});

describe("getCachedBlob / putCachedBlob (in-memory stub)", () => {
  afterEach(() => {
    __setBlobDbForTests(null);
  });

  it("round-trips a blob under a cacheable sha", async () => {
    __setBlobDbForTests(makeInMemoryDb());
    const sha = "a".repeat(40);
    expect(await getCachedBlob("c1", sha, "src/a.ts")).toBeUndefined();
    await putCachedBlob("c1", sha, "src/a.ts", { content: "hello", truncated: false, binary: false });
    const got = await getCachedBlob("c1", sha, "src/a.ts");
    expect(got).toEqual({ content: "hello", truncated: false, binary: false });
  });

  it("misses for a different path under the same sha", async () => {
    __setBlobDbForTests(makeInMemoryDb());
    const sha = "b".repeat(40);
    await putCachedBlob("c1", sha, "a.ts", { content: "A", truncated: false, binary: false });
    expect(await getCachedBlob("c1", sha, "b.ts")).toBeUndefined();
  });

  it("misses for a different cid under the same sha/path (namespacing)", async () => {
    __setBlobDbForTests(makeInMemoryDb());
    const sha = "c".repeat(40);
    await putCachedBlob("c1", sha, "a.ts", { content: "A", truncated: false, binary: false });
    expect(await getCachedBlob("c2", sha, "a.ts")).toBeUndefined();
  });

  it("never reads or writes for a non-cacheable ref (HEAD/branch/short sha)", async () => {
    const db = makeInMemoryDb();
    __setBlobDbForTests(db);
    await putCachedBlob("c1", "HEAD", "a.ts", { content: "A", truncated: false, binary: false });
    expect(await getCachedBlob("c1", "HEAD", "a.ts")).toBeUndefined();
    // confirm nothing was ever written under any key for this path
    expect(await db.get(blobKey("c1", "HEAD", "a.ts"))).toBeUndefined();
  });

  it("stores binary/truncated flags faithfully, including an omitted content", async () => {
    __setBlobDbForTests(makeInMemoryDb());
    const sha = "d".repeat(40);
    await putCachedBlob("c1", sha, "img.png", { content: undefined, truncated: false, binary: true });
    expect(await getCachedBlob("c1", sha, "img.png")).toEqual({ content: undefined, truncated: false, binary: true });
  });
});

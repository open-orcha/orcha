/**
 * draftStore.ts tests — jsdom has no IndexedDB, so every read/write test
 * injects a tiny in-memory stub via __setDraftDbForTests instead of touching
 * the real opener (blobCache.test.ts's precedent).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __setDraftDbForTests,
  deleteDraft,
  draftKey,
  getDraft,
  listDrafts,
  putDraft,
  type DraftDb,
} from "./draftStore";

interface StoredDraft {
  cid: string;
  ref: string;
  path: string;
  content: string;
  baseHash: string | null;
  savedAt: number;
}

function makeInMemoryDb(): DraftDb {
  const store = new Map<string, StoredDraft>();
  return {
    get: async (key) => store.get(key),
    put: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    getAll: async () => Array.from(store.values()),
  };
}

describe("draftKey", () => {
  it("joins cid/ref/path with colons", () => {
    expect(draftKey("c1", "HEAD", "src/a.ts")).toBe("c1:HEAD:src/a.ts");
  });

  it("produces distinct keys for different paths under the same ref", () => {
    expect(draftKey("c1", "HEAD", "a.ts")).not.toBe(draftKey("c1", "HEAD", "b.ts"));
  });

  it("produces distinct keys for different refs under the same path", () => {
    expect(draftKey("c1", "HEAD", "a.ts")).not.toBe(draftKey("c1", "main", "a.ts"));
  });

  it("produces distinct keys for different cids", () => {
    expect(draftKey("c1", "HEAD", "a.ts")).not.toBe(draftKey("c2", "HEAD", "a.ts"));
  });
});

describe("getDraft / putDraft / deleteDraft (in-memory stub)", () => {
  afterEach(() => {
    __setDraftDbForTests(null);
  });

  it("returns undefined for a miss", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    expect(await getDraft("c1", "HEAD", "a.ts")).toBeUndefined();
  });

  it("round-trips a draft with a base hash", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "hello", baseHash: "deadbeef" });
    const got = await getDraft("c1", "HEAD", "a.ts");
    expect(got?.content).toBe("hello");
    expect(got?.baseHash).toBe("deadbeef");
    expect(typeof got?.savedAt).toBe("number");
  });

  it("round-trips a new file (null base hash)", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "new.ts", { content: "export {}", baseHash: null });
    const got = await getDraft("c1", "HEAD", "new.ts");
    expect(got?.baseHash).toBeNull();
  });

  it("overwrites an existing draft and bumps savedAt", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "v1", baseHash: "h1" });
    const first = await getDraft("c1", "HEAD", "a.ts");
    await putDraft("c1", "HEAD", "a.ts", { content: "v2", baseHash: "h1" });
    const second = await getDraft("c1", "HEAD", "a.ts");
    expect(second?.content).toBe("v2");
    expect(second!.savedAt).toBeGreaterThanOrEqual(first!.savedAt);
  });

  it("deletes a draft", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "hello", baseHash: null });
    await deleteDraft("c1", "HEAD", "a.ts");
    expect(await getDraft("c1", "HEAD", "a.ts")).toBeUndefined();
  });

  it("namespaces by cid and ref (a draft under one scope misses in another)", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "hello", baseHash: null });
    expect(await getDraft("c2", "HEAD", "a.ts")).toBeUndefined();
    expect(await getDraft("c1", "main", "a.ts")).toBeUndefined();
  });
});

describe("listDrafts (in-memory stub)", () => {
  afterEach(() => {
    __setDraftDbForTests(null);
  });

  it("returns an empty list when there are no drafts", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    expect(await listDrafts("c1", "HEAD")).toEqual([]);
  });

  it("lists only drafts for the given cid+ref, sorted by path", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "z.ts", { content: "z", baseHash: null });
    await putDraft("c1", "HEAD", "a.ts", { content: "a", baseHash: "h" });
    await putDraft("c1", "main", "b.ts", { content: "b", baseHash: null }); // different ref
    await putDraft("c2", "HEAD", "c.ts", { content: "c", baseHash: null }); // different cid

    const list = await listDrafts("c1", "HEAD");
    expect(list.map((d) => d.path)).toEqual(["a.ts", "z.ts"]);
    expect(list[0].content).toBe("a");
    expect(list[0].baseHash).toBe("h");
  });

  it("reflects a delete", async () => {
    __setDraftDbForTests(makeInMemoryDb());
    await putDraft("c1", "HEAD", "a.ts", { content: "a", baseHash: null });
    await putDraft("c1", "HEAD", "b.ts", { content: "b", baseHash: null });
    await deleteDraft("c1", "HEAD", "a.ts");
    const list = await listDrafts("c1", "HEAD");
    expect(list.map((d) => d.path)).toEqual(["b.ts"]);
  });
});

/**
 * sha-keyed IndexedDB cache for ref-PINNED file reads (an immutable commit
 * sha, never a moving ref like "HEAD" or a branch name) — CodeSpacePage's
 * committed-file viewer content is addressed by blob/commit sha, so once
 * fetched under a real sha it can be cached forever; any future read of the
 * same (cid, sha, path) is guaranteed byte-identical. NEVER used for
 * worktree reads (worktreeApi.ts's fetchWorktreeFile) — those read the live
 * working tree, which can change under an agent's feet at any moment, so
 * they must always hit the network.
 *
 * No dependency — a tiny hand-rolled wrapper over the browser's IndexedDB
 * (one object store, one DB). `openDb` is injected so tests can swap in an
 * in-memory stub instead of jsdom's (nonexistent) IndexedDB — see
 * blobCache.test.ts.
 */

export interface CachedBlob {
  content: string | undefined;
  truncated: boolean;
  binary: boolean;
}

const DB_NAME = "orcha-cs-blobcache";
const STORE = "blobs";
const DB_VERSION = 1;

// A ref is cache-SAFE only when it's already an immutable sha, not a moving
// name like "HEAD", "main", or a short sha — full 40-hex-char shas are what
// every sha-producing surface in this codebase hands back (worktreeApi's
// FileHistoryCommit.sha, the new worktree save/commit hashes) and what
// History's onSelectCommit navigates ?ref= to (HistoryPanel.tsx). A short or
// symbolic ref is NOT guaranteed immutable and must always hit the network.
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export function isCacheableSha(ref: string): boolean {
  return FULL_SHA_RE.test(ref);
}

// Pure keying function, exported for tests — one string key per (cid, sha,
// path) so a single object store can hold every project's blobs without
// collisions.
export function blobKey(cid: string, sha: string, path: string): string {
  return cid + ":" + sha + ":" + path;
}

export interface BlobCacheDb {
  get(key: string): Promise<CachedBlob | undefined>;
  put(key: string, value: CachedBlob): Promise<void>;
}

// Wraps the real IndexedDB. Any failure (private browsing, quota, a browser
// without IndexedDB) resolves to a no-op cache rather than throwing —
// caching is a pure speed optimization, never a hard dependency.
function openRealDb(): Promise<BlobCacheDb> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(noopDb());
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(noopDb());
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      resolve({
        get(key) {
          return new Promise((res) => {
            try {
              const tx = db.transaction(STORE, "readonly");
              const r = tx.objectStore(STORE).get(key);
              r.onsuccess = () => res(r.result as CachedBlob | undefined);
              r.onerror = () => res(undefined);
            } catch {
              res(undefined);
            }
          });
        },
        put(key, value) {
          return new Promise((res) => {
            try {
              const tx = db.transaction(STORE, "readwrite");
              tx.objectStore(STORE).put(value, key);
              tx.oncomplete = () => res();
              tx.onerror = () => res();
            } catch {
              res();
            }
          });
        },
      });
    };
    req.onerror = () => resolve(noopDb());
  });
}

function noopDb(): BlobCacheDb {
  return {
    get: async () => undefined,
    put: async () => {},
  };
}

let dbPromise: Promise<BlobCacheDb> | null = null;
// Test-only seam: inject a fake BlobCacheDb (in-memory stub) instead of the
// real IndexedDB opener. Never called from application code.
export function __setBlobDbForTests(db: BlobCacheDb | null): void {
  dbPromise = db ? Promise.resolve(db) : null;
}

function getDb(): Promise<BlobCacheDb> {
  if (!dbPromise) dbPromise = openRealDb();
  return dbPromise;
}

// Read-through helper: returns the cached blob for (cid, sha, path), or
// undefined on a miss / uncacheable ref / any storage failure. Callers skip
// the cache entirely (never call this) when `isCacheableSha(sha)` is false.
export async function getCachedBlob(cid: string, sha: string, path: string): Promise<CachedBlob | undefined> {
  if (!isCacheableSha(sha)) return undefined;
  const db = await getDb();
  return db.get(blobKey(cid, sha, path));
}

export async function putCachedBlob(cid: string, sha: string, path: string, blob: CachedBlob): Promise<void> {
  if (!isCacheableSha(sha)) return;
  const db = await getDb();
  await db.put(blobKey(cid, sha, path), blob);
}

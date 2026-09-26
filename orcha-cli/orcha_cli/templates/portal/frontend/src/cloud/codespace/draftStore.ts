/**
 * IndexedDB draft store for GitHub-bound Code Space editing (Phase 4) — a
 * local, never-networked scratch layer for edits made while viewing a file
 * whose container has no writable worktree (worktreeAvailable=false). Mirrors
 * blobCache.ts's pattern exactly: one object store, one DB, an injectable DB
 * seam (__setDraftDbForTests) so tests never touch jsdom's (nonexistent)
 * IndexedDB.
 *
 * Keyed `${cid}:${ref}:${path}` — drafts are scoped to the exact ref they were
 * opened against (Phase 4 only ever writes/reads drafts for ref==="HEAD", the
 * default branch, but the store itself doesn't assume that). A draft holds:
 *   - content   — the human's edited buffer.
 *   - baseHash  — the blob sha the file view loaded when the draft was
 *                 started, or null when unknown/new file (BACKEND CONTRACT:
 *                 passed through to POST .../propose as `base_hash`, and
 *                 refreshed by the drift-recovery "Reload base" action).
 *   - savedAt   — ms epoch of the last autosave-to-draft write, for display
 *                 only (no expiry logic here).
 */

export interface Draft {
  content: string;
  baseHash: string | null;
  savedAt: number;
}

export interface DraftListEntry extends Draft {
  path: string;
}

const DB_NAME = "orcha-cs-draftstore";
const STORE = "drafts";
const DB_VERSION = 1;

export function draftKey(cid: string, ref: string, path: string): string {
  return cid + ":" + ref + ":" + path;
}

// Every stored record also carries cid/ref/path fields (not just content) so
// listDrafts(cid, ref) can scan the one store and filter — IndexedDB has no
// secondary index in this minimal wrapper, and the draft counts here are
// small (a handful of in-flight edits, never a whole repo), so a full-store
// scan is the right amount of machinery.
interface StoredDraft extends Draft {
  cid: string;
  ref: string;
  path: string;
}

export interface DraftDb {
  get(key: string): Promise<StoredDraft | undefined>;
  put(key: string, value: StoredDraft): Promise<void>;
  delete(key: string): Promise<void>;
  getAll(): Promise<StoredDraft[]>;
}

// Wraps the real IndexedDB. Any failure (private browsing, quota, a browser
// without IndexedDB) resolves to a no-op store rather than throwing — drafts
// are a convenience layer, never a hard dependency for viewing/editing.
function openRealDb(): Promise<DraftDb> {
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
              r.onsuccess = () => res(r.result as StoredDraft | undefined);
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
        delete(key) {
          return new Promise((res) => {
            try {
              const tx = db.transaction(STORE, "readwrite");
              tx.objectStore(STORE).delete(key);
              tx.oncomplete = () => res();
              tx.onerror = () => res();
            } catch {
              res();
            }
          });
        },
        getAll() {
          return new Promise((res) => {
            try {
              const tx = db.transaction(STORE, "readonly");
              const r = tx.objectStore(STORE).getAll();
              r.onsuccess = () => res((r.result as StoredDraft[]) || []);
              r.onerror = () => res([]);
            } catch {
              res([]);
            }
          });
        },
      });
    };
    req.onerror = () => resolve(noopDb());
  });
}

function noopDb(): DraftDb {
  return {
    get: async () => undefined,
    put: async () => {},
    delete: async () => {},
    getAll: async () => [],
  };
}

let dbPromise: Promise<DraftDb> | null = null;
// Test-only seam: inject a fake DraftDb (in-memory stub) instead of the real
// IndexedDB opener. Never called from application code.
export function __setDraftDbForTests(db: DraftDb | null): void {
  dbPromise = db ? Promise.resolve(db) : null;
}

function getDb(): Promise<DraftDb> {
  if (!dbPromise) dbPromise = openRealDb();
  return dbPromise;
}

export async function getDraft(cid: string, ref: string, path: string): Promise<Draft | undefined> {
  const db = await getDb();
  const rec = await db.get(draftKey(cid, ref, path));
  if (!rec) return undefined;
  return { content: rec.content, baseHash: rec.baseHash, savedAt: rec.savedAt };
}

export async function putDraft(
  cid: string,
  ref: string,
  path: string,
  draft: { content: string; baseHash: string | null },
): Promise<void> {
  const db = await getDb();
  await db.put(draftKey(cid, ref, path), {
    cid,
    ref,
    path,
    content: draft.content,
    baseHash: draft.baseHash,
    savedAt: Date.now(),
  });
}

export async function deleteDraft(cid: string, ref: string, path: string): Promise<void> {
  const db = await getDb();
  await db.delete(draftKey(cid, ref, path));
}

// Repo-scoped listing (cid + ref) sorted by path — the drafts bar's source of
// truth. A full-store scan (see StoredDraft's doc comment above for why).
export async function listDrafts(cid: string, ref: string): Promise<DraftListEntry[]> {
  const db = await getDb();
  const all = await db.getAll();
  return all
    .filter((d) => d.cid === cid && d.ref === ref)
    .map((d) => ({ path: d.path, content: d.content, baseHash: d.baseHash, savedAt: d.savedAt }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

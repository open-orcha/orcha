/**
 * Shared directory-tree + file-content state machine, extracted out of
 * RepoBrowser.tsx so Code Space (cloud/codespace/**) can drive the exact
 * same lazy-tree/file-fetch behavior without duplicating it. Pure state/
 * effects, no rendering — RepoBrowser.tsx and CodeSpacePage.tsx each render
 * their own markup over this hook's output (the former via BrowseTree/
 * ContentPaneChrome for byte-parity with its pre-refactor markup, the latter
 * with its own gutter-affordance code viewer).
 *
 * Behavior preserved verbatim from RepoBrowser's pre-extraction version:
 *  - root loads on mount + whenever (cid, gitRef) changes; expansion/
 *    selection resets too.
 *  - a deep-linked path expands + lazy-loads every ancestor dir so the
 *    selected file's row is visible in the tree on first paint.
 *  - toggling a dir lazy-loads its children exactly once (cached after).
 *  - file content re-fetches on (cid, gitRef, path) change, token-guarded
 *    against stale async responses.
 *
 * Folder-expand failures are NEVER cached (fix for: a transient failure —
 * e.g. a GitHub rate-limit blip — used to get cached by the lazy tree same as
 * a success, so collapsing/re-expanding the folder never retried and it
 * showed "Couldn't load this folder." permanently). A dir whose cached state
 * carries an `error` is treated as not-yet-loaded: `toggleDir` re-fetches it
 * on the next expand, and `retryDir` re-fetches it in place (without
 * collapsing/re-expanding) for the error row's own click-to-retry affordance.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFile, fetchTree } from "../github/browse/browseApi";
import { parentOf, type BrowseFilePayload } from "../github/browse/browseTypes";
import type { GhError } from "../github/ghlib";
import { buildVisibleRows, type DirState, type TreeRow } from "./browseTree";

export interface UseBrowseTreeResult {
  dirCache: Record<string, DirState>;
  expanded: Set<string>;
  rows: TreeRow[];
  toggleDir: (dirPath: string) => void;
  // Re-fetch a dir that's currently showing an error, IN PLACE — unlike
  // toggleDir (a collapse/expand toggle), this never changes `expanded`; it's
  // what the error row's own "tap to retry" affordance calls while the dir
  // stays expanded and visibly shows the loading state.
  retryDir: (dirPath: string) => void;
  filePayload: BrowseFilePayload | null;
  fileError: GhError | null;
  fileLoading: boolean;
}

export function useBrowseTree(cid: string, gitRef: string, path: string): UseBrowseTreeResult {
  const [dirCache, setDirCache] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));

  const [filePayload, setFilePayload] = useState<BrowseFilePayload | null>(null);
  const [fileError, setFileError] = useState<GhError | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const fileToken = useRef(0);

  const loadDir = useCallback((dirPath: string) => {
    if (!cid) return; // caller resolving cid asynchronously (e.g. from useSnapshot()) — wait for it
    setDirCache((prev) => ({ ...prev, [dirPath]: { loading: true, error: null, entries: prev[dirPath]?.entries ?? null } }));
    fetchTree(cid, gitRef, dirPath).then((res) => {
      if (!res.ok) {
        setDirCache((prev) => ({ ...prev, [dirPath]: { loading: false, error: res.error, entries: null } }));
        return;
      }
      setDirCache((prev) => ({
        ...prev,
        [dirPath]: { loading: false, error: null, entries: res.data.entries, truncated: res.data.truncated },
      }));
    });
  }, [cid, gitRef]);

  useEffect(() => {
    setDirCache({});
    setExpanded(new Set([""]));
    loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, gitRef]);

  useEffect(() => {
    if (!path) return;
    const ancestors: string[] = [];
    let p = parentOf(path);
    while (true) {
      ancestors.unshift(p);
      if (!p) break;
      p = parentOf(p);
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      ancestors.forEach((a) => next.add(a));
      return next;
    });
    ancestors.forEach((a) => {
      setDirCache((prev) => {
        if (prev[a]) return prev;
        loadDir(a);
        return prev;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, cid, gitRef]);

  const toggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        setDirCache((cache) => {
          // A dir cached with an error is treated as never-loaded — a failed
          // load must never block a retry on the next expand (the bug this
          // fixes: re-expanding after a transient failure re-showed the same
          // stale error forever instead of trying again).
          if (!cache[dirPath] || cache[dirPath].error) loadDir(dirPath);
          return cache;
        });
      }
      return next;
    });
  }, [loadDir]);

  // Click-to-retry affordance on the error row itself: re-fetch a failed dir
  // WITHOUT collapsing it first (toggleDir would just close it since it's
  // already in `expanded`) — loadDir alone re-runs the fetch and updates
  // dirCache in place, so the retry's loading/success/error states render
  // right where the error was.
  const retryDir = useCallback((dirPath: string) => {
    loadDir(dirPath);
  }, [loadDir]);

  const rows = useMemo(
    () => buildVisibleRows(dirCache, expanded, dirCache[""]?.entries ?? null),
    [dirCache, expanded],
  );

  useEffect(() => {
    if (!path || !cid) { setFilePayload(null); setFileError(null); return; }
    const myToken = ++fileToken.current;
    setFileLoading(true);
    fetchFile(cid, gitRef, path).then((res) => {
      if (myToken !== fileToken.current) return;
      setFileLoading(false);
      if (!res.ok) { setFileError(res.error); setFilePayload(null); return; }
      setFileError(null);
      setFilePayload(res.data);
    });
  }, [cid, gitRef, path]);

  return { dirCache, expanded, rows, toggleDir, retryDir, filePayload, fileError, fileLoading };
}

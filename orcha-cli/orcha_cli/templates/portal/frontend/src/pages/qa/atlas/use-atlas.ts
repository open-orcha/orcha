import { useCallback, useEffect, useRef, useState } from "react";
import { getAtlas } from "./atlasApi";
import { isFilling, parseAtlas, type Atlas } from "./types";

/** How often the atlas is read while a pass fills it in. */
const FILLING_MS = 3000;

/** Screens that gained or changed a picture between two atlases: they develop in. */
export function freshScreens(prev: Atlas | null, next: Atlas): Set<string> {
  const out = new Set<string>();
  if (!prev) return out;
  const before = new Map(prev.screens.map((s) => [s.id, s]));
  for (const s of next.screens) {
    const old = before.get(s.id);
    const frames = (x: typeof s | undefined) => (x ? Object.values(x.variants).map((v) => v?.frame_url ?? "").join("|") : "");
    if (frames(old) !== frames(s) && Object.values(s.variants).some((v) => v?.frame_url)) out.add(s.id);
  }
  return out;
}

/**
 * The atlas as first read, kept live: QaPage's quiet re-read (`nonce`) reads it again, every few
 * seconds while a pass fills it in, and the screens that gained a picture are marked fresh for a
 * moment. `since` changes refetch it for that date.
 */
export function useAtlas(cid: string, served: Atlas | null, since: string | null, nonce = 0) {
  const [atlas, setAtlas] = useState<Atlas | null>(served);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(atlas);
  const sinceRef = useRef(since);
  const first = useRef(true);

  useEffect(() => {
    current.current = atlas;
  }, [atlas]);

  const load = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      if (!opts.quiet) setLoading(true);
      try {
        const next = parseAtlas(await getAtlas(cid, sinceRef.current));
        const gained = freshScreens(current.current, next);
        setAtlas(next);
        setError(null);
        if (gained.size) setFresh(gained);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!opts.quiet) setLoading(false);
      }
    },
    [cid],
  );

  useEffect(() => {
    sinceRef.current = since;
    if (first.current) {
      first.current = false;
      return;
    }
    void load();
  }, [since, load]);

  // Fresh frames develop once, then settle.
  useEffect(() => {
    if (!fresh.size) return;
    const t = window.setTimeout(() => setFresh(new Set()), 1600);
    return () => window.clearTimeout(t);
  }, [fresh]);

  const reads = useRef(nonce);
  useEffect(() => {
    if (reads.current === nonce) return;
    reads.current = nonce;
    void load({ quiet: true });
  }, [nonce, load]);

  const filling = isFilling(atlas);
  useEffect(() => {
    if (!filling) return;
    const t = window.setInterval(() => void load({ quiet: true }), FILLING_MS);
    return () => window.clearInterval(t);
  }, [filling, load]);

  return { atlas, setAtlas, fresh, loading, error, reload: load };
}

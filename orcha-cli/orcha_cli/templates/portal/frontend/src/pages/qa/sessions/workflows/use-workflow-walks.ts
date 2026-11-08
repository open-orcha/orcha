import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Platform, QaFlow, SessionDetail } from "../../qaApi";
import { getAppModel } from "../api";
import { walksPayloadOf } from "./adapt-walks";
import { normalizeAppModel, type AppModelPayload, type WalksPayload } from "./workflows";

/** How often the App model is read again while a session runs. */
const MODEL_POLL_MS = 8_000;

/**
 * A session's queue and walks as the page reads them: from the session's own live read, so they
 * move with everything else on the page.
 */
export function useWorkflowWalks(detail: SessionDetail, flows: readonly QaFlow[] | null): WalksPayload {
  return useMemo(() => walksPayloadOf(detail, flows), [detail, flows]);
}

/**
 * The platform's App model, the newest version unless one is picked from the history. While
 * `live` a slow poll brings each new version in; a picked older version stays put (the history
 * still updates).
 */
export function useAppModel(cid: string, platform: Platform, live = false, initial: AppModelPayload | null = null) {
  const [data, setData] = useState<AppModelPayload | null>(initial);
  const [picked, setPicked] = useState<number | null>(null);
  const [loading, setLoading] = useState(initial == null);
  const seq = useRef(0);

  const load = useCallback(
    (version: number | null) => {
      const mine = ++seq.current;
      void fetchAppModel(cid, platform, version).then((next) => {
        if (mine !== seq.current) return;
        if (next) setData(next);
        setLoading(false);
      });
    },
    [cid, platform],
  );

  // The first read, when the page had none.
  useEffect(() => {
    if (initial != null) return;
    load(null);
  }, [initial, load]);

  const pickedRef = useRef(picked);
  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => load(pickedRef.current), MODEL_POLL_MS);
    return () => clearInterval(t);
  }, [live, load]);

  const pick = useCallback(
    (version: number | null) => {
      setPicked(version);
      load(version);
    },
    [load],
  );

  return { data, loading, picked, pick };
}

async function fetchAppModel(cid: string, platform: Platform, version: number | null): Promise<AppModelPayload | null> {
  try {
    const raw = await getAppModel(cid, platform, version);
    return raw ? { ...raw, model: normalizeAppModel(raw.model), versions: raw.versions ?? [] } : null;
  } catch {
    return null;
  }
}

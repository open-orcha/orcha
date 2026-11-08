import { useCallback, useEffect, useMemo, useState } from "react";
import { evidenceByDraft, feedItems, latestPlan, type DraftEvidence, type SessionExplorer } from "./lib/drafting-board";
import type { BoardEvent, CorrectionBody, ScenarioEvidence } from "./lib/types";
import { getDraftingBoard, type DraftingBoardData, type RawEvent } from "./api";

/** While the session runs, the board is re-read this often. */
const LIVE_POLL_MS = 2_500;
const IDLE_POLL_MS = 15_000;
const LIVE = new Set(["waiting", "live", "code_only"]);

function boardEvent(e: RawEvent): BoardEvent {
  return {
    id: e.id,
    seq: e.board_seq ?? e.seq,
    kind: e.kind,
    title: e.title,
    body: e.body,
    scenario_id: e.scenario_id,
    screenshot_path: e.frame_id,
    status: e.status,
    reply_to: e.reply_to,
    session_id: e.session_id,
    created_at: e.created_at,
  };
}

/**
 * The drafting session's board (migration 095): what the drafter said as a conversation feed,
 * the explorers of its task, the requests in flight, and every draft's evidence (screens, badges,
 * corrections from screen). A draft outside a pairing still gets its evidence.
 */
export function useDraftingBoard({ sessionId, running, nonce }: { sessionId: string; running: boolean; nonce: number }) {
  const [data, setData] = useState<DraftingBoardData | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const fresh = await getDraftingBoard(sessionId, signal);
        if (!signal?.aborted) setData(fresh);
      } catch {
        // A failed read keeps what is on screen; the next one tries again.
      }
    },
    [sessionId],
  );

  const session = data?.session ?? null;
  const explorers = useMemo<SessionExplorer[]>(
    () => (data?.explorers ?? []).map((e) => ({ id: e.id, status: e.status, device: e.device, target_kind: e.target_kind })),
    [data],
  );
  // A drafter that finished before its explorer is not the end: the explorer still walks.
  const going = explorers.some((e) => e.status === "running" || e.status === "queued");
  const live = running || going || (session ? LIVE.has(session.status) : false);
  const pollMs = live ? LIVE_POLL_MS : IDLE_POLL_MS;
  useEffect(() => {
    const ctl = new AbortController();
    void refresh(ctl.signal);
    const timer = setInterval(() => void refresh(ctl.signal), pollMs);
    return () => {
      ctl.abort();
      clearInterval(timer);
    };
  }, [refresh, pollMs, nonce]);

  const events = useMemo(() => (data?.events ?? []).map(boardEvent), [data]);
  const feed = useMemo(() => feedItems(events), [events]);
  const plan = useMemo(() => latestPlan(events), [events]);
  const evidence: Map<string, DraftEvidence> = useMemo(() => {
    const rows: ScenarioEvidence[] = (data?.evidence ?? []).map((e) => ({
      id: e.id,
      scenario_id: e.scenario_id,
      criterion_index: e.criterion_index,
      status: e.status,
      screenshot_path: e.frame_id,
      screen_name: e.screen_name,
      route: e.route,
      step: e.step,
      run_id: e.run_id,
      matched: e.note,
      code_ref: e.code_ref,
      source: e.source ?? null,
    }));
    return evidenceByDraft(rows, (data?.corrections ?? []).map(boardEvent));
  }, [data]);
  /** The version each draft's newest revision replaced. */
  const versions = useMemo(() => {
    const out = new Map<string, NonNullable<CorrectionBody["before"]>>();
    for (const c of data?.corrections ?? []) {
      const before = (c.body as CorrectionBody | null)?.before;
      if (c.scenario_id && before) out.set(c.scenario_id, before);
    }
    return out;
  }, [data]);
  const waiting = events.filter((e) => e.kind === "request" && (e.status === "open" || e.status === "claimed")).length;
  const screens = events.filter((e) => e.kind === "screen").length;

  return { data, refresh, session, explorers, events, feed, plan, waiting, screens, evidence, versions, running };
}

export type DraftingBoard = ReturnType<typeof useDraftingBoard>;

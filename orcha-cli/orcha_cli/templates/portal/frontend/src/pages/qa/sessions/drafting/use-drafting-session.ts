import { useCallback, useEffect, useMemo, useState } from "react";
import type { QaAuthority } from "../../authority";
import type { QaScenario, SessionDetail, Platform } from "../../qaApi";
import { draftingRequestStatus } from "./adapt";
import type { RawExplorer } from "./api";
import { choiceForRequest, combinedPhase, explorationPassStage, explorationTag, type ExplorationPassRequest, type ExplorationSummary, type FollowUpRequest } from "./lib/draft-sources";
import { draftingPhase, requestSources } from "./lib/drafting-route";
import type { DraftSources, Scenario } from "./lib/types";
import { useDraftActions } from "./use-draft-actions";
import { useDraftRevisions } from "./use-draft-revisions";
import { useDraftingBoard } from "./use-drafting-board";

/** Re-read the drafts this often while a "Revise with Orcha" is out. */
const REVISE_POLL_MS = 4_000;

export interface DraftingProject {
  name: string;
}

/** The explorer as the page's exploration pass reads it. */
function explorePass(e: RawExplorer, draftId: string): ExplorationPassRequest {
  return {
    id: e.id,
    status: e.status,
    created_at: e.created_at,
    started_at: e.started_at,
    finished_at: e.finished_at,
    minutes: e.minutes,
    run_id: e.id,
    error: e.error,
    target_kind: e.target_kind,
    locator: e.locator,
    device: e.device,
    summary: { follow_up: { status: "queued", request_id: draftId } },
    run: { status: e.status === "running" ? "running" : e.status, blockers: e.blockers, blockerTitle: e.blocker_title, blockerFrame: e.blocker_frame, deviceName: e.device },
  };
}

function toDraft(q: QaScenario, feedback: Record<string, { text: string }[]>): Scenario {
  return { ...q, target_kind: null, feedback: feedback[q.id] ?? [], generation_request_id: q.session_id };
}

/**
 * Everything behind a drafting session's page: its status and activity, the explorers of its task,
 * the drafts it and they wrote, reviewing them (accept / discard / revise). The same shape the
 * page's parts read, from the session and its board.
 */
export function useDraftingSession({ cid, detail, auth, agent, nonce, onReload }: { cid: string; detail: SessionDetail; auth: QaAuthority; agent: string | null; nonce: number; onReload: () => void }) {
  const s = detail.session;
  const reqStatus = draftingRequestStatus(s.status);
  const running = s.status === "running";
  const board = useDraftingBoard({ sessionId: s.id, running, nonce });
  const data = board.data;
  const refreshBoard = board.refresh;

  /** Decided here, ahead of the next read: status by id; a discarded one is gone. */
  const [decided, setDecided] = useState<Map<string, Scenario["status"]>>(() => new Map());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const drafts = useMemo(() => {
    const feedback = data?.feedback ?? {};
    const rows = [...detail.drafts, ...(data?.explorer_drafts ?? [])].filter((d) => !removed.has(d.id) && d.status !== "retired" && d.status !== "paused");
    return rows
      .map((d) => ({ ...toDraft(d, feedback), status: decided.get(d.id) ?? d.status }))
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  }, [detail.drafts, data, decided, removed]);

  const revisions = useDraftRevisions(drafts);
  const actions = useDraftActions({
    cid,
    platform: s.platform as Platform,
    auth,
    agent,
    setDrafts: (update) => {
      const before = new Map(drafts.map((d) => [d.id, d.status]));
      const next = update(drafts);
      setDecided((m) => {
        const out = new Map(m);
        for (const d of next) if (before.get(d.id) !== d.status) out.set(d.id, d.status);
        return out;
      });
    },
    removeDraft: (id) => setRemoved((r) => new Set(r).add(id)),
    revisions,
    setError,
    onFeedback: () => void refreshBoard(),
  });

  // While a revision is out the drafts are read again: nothing else would, once it ended.
  const revising = revisions.pendingIds.size > 0;
  useEffect(() => {
    if (!revising) return;
    const t = setInterval(() => onReload(), REVISE_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onReload` is a new function on every render
  }, [revising]);
  const [recentlyUpdated, setRecentlyUpdated] = useState<ReadonlySet<string>>(() => new Set());
  const [watching, setWatching] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (revisions.pendingIds.size > 0) setWatching((w) => new Set([...w, ...revisions.pendingIds]));
  }, [revisions.pendingIds]);
  useEffect(() => {
    const finished = [...watching].filter((id) => !revisions.pendingIds.has(id));
    if (finished.length === 0) return;
    setWatching((w) => new Set([...w].filter((id) => !finished.includes(id))));
    setRecentlyUpdated((r) => new Set([...r, ...finished]));
  }, [watching, revisions.pendingIds]);

  const explorers = data?.explorers ?? [];
  const [viewedExploreId, setViewedExploreId] = useState<string | null>(null);
  const firstExplorer = explorers[0]?.id ?? null;
  const viewed = viewedExploreId && explorers.some((e) => e.id === viewedExploreId) ? viewedExploreId : firstExplorer;
  const viewedRow = explorers.find((e) => e.id === viewed) ?? null;
  const explore = useMemo(() => (viewedRow ? explorePass(viewedRow, s.id) : null), [viewedRow, s.id]);
  const followUp: FollowUpRequest | null = useMemo(
    () => (explore ? { id: s.id, status: reqStatus, error: null, summary: { drafted: detail.drafts.length } } : null),
    [explore, s.id, reqStatus, detail.drafts.length],
  );
  const pass = {
    requestId: viewed,
    explore,
    followUp,
    followUpId: explore ? s.id : null,
    stage: explore ? explorationPassStage(explore, followUp) : null,
    screens: viewedRow?.screens ?? 0,
    actions: viewedRow?.actions ?? 0,
    frames: viewedRow?.frames ?? [],
    busy: false,
  };
  const siblings = useMemo(() => explorers.map((e) => ({ id: e.id, status: e.status, target_kind: e.target_kind })), [explorers]);

  const codePhase = draftingPhase(s.id, reqStatus);
  const phase = combinedPhase(codePhase, pass.stage);
  const sources: DraftSources = requestSources(data?.sources ?? null, "repository");
  const choice = choiceForRequest(sources, Boolean(explore));

  /** Drafts its explorers wrote wear "from exploration <date>". */
  const tags = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of data?.explorer_drafts ?? []) {
      const e = explorers.find((x) => x.id === d.session_id);
      if (e) m.set(d.id, explorationTag(e));
    }
    return m;
  }, [data, explorers]);

  const acceptedIds = useMemo(() => drafts.filter((d) => d.status === "validated").map((d) => d.id), [drafts]);
  const categories = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of drafts) out[d.category?.trim() || "Other"] = (out[d.category?.trim() || "Other"] ?? 0) + 1;
    return out;
  }, [drafts]);

  const gen = {
    requestId: s.id as string | null,
    status: reqStatus as string | null,
    open: running,
    busy: null as "start" | "cancel" | null,
    stopping: false,
    error,
    setError,
    focus: null as string | null,
    exploreRequestId: firstExplorer,
    progress: {
      progress: data?.activity ?? null,
      summary: { drafted: drafts.length, categories },
      error: reqStatus === "failed" ? errorOf(detail) : null,
    },
  };

  const reviseOne = useCallback(
    (id: string) => {
      const draft = drafts.find((d) => d.id === id);
      if (draft) void actions.reviseOne(draft);
    },
    [drafts, actions],
  );

  return {
    auth,
    board,
    drafts,
    revisions,
    recentlyUpdated,
    revising,
    actions,
    gen,
    phase,
    codePhase,
    pass,
    tags,
    started: true,
    sources,
    choice,
    platform: s.platform as Platform,
    siblings,
    viewedExploreId: viewed,
    setViewedExploreId,
    explorations: (data?.explorations ?? null) as ExplorationSummary | null,
    acceptedIds,
    drafted: drafts.length,
    /** Past explorations' screenshots for the stage; only when drafting reads them. */
    frames: sources === "code" || explore ? [] : (data?.frames ?? []),
    reviseOne,
    acceptOne: (id: string) => void actions.acceptMany([id]),
    acceptAll: () => void actions.acceptMany(drafts.map((d) => d.id)),
    acceptRemaining: () => void actions.acceptMany(drafts.filter((d) => d.status !== "validated").map((d) => d.id)),
  };
}

function errorOf(detail: SessionDetail): string | null {
  const r = detail.session.result;
  const e = r && typeof r === "object" ? (r as { error?: unknown; reason?: unknown }) : null;
  return typeof e?.error === "string" ? e.error : typeof e?.reason === "string" ? e.reason : null;
}

export type DraftingSession = ReturnType<typeof useDraftingSession>;

import { useRef, useState } from "react";
import { errText } from "../../parts";
import { createQaTask, qaReviseTaskBody } from "../../runQa";
import { setScenarioStatus } from "../../qaApi";
import type { QaAuthority } from "../../authority";
import type { Platform } from "../../qaApi";
import { useToast } from "../../map/kit";
import { postFeedback } from "./api";
import type { Scenario } from "./lib/types";
import type { DraftRevisions } from "./use-draft-revisions";

/** A discarded draft is retired: it stays in the scenario's history, out of the review. */
export const DISCARD_REASON = "Discarded in review";

/**
 * Scenario-level mutations for the review deck: accept and discard (the scenario status route, a
 * person only), revise (their feedback, then a task for the agent), plus the per-draft feedback
 * text reviewers are typing.
 */
export function useDraftActions({
  cid,
  platform,
  auth,
  agent,
  setDrafts,
  removeDraft,
  revisions,
  setError,
  onFeedback,
}: {
  cid: string;
  platform: Platform;
  auth: QaAuthority;
  /** The agent that drafted them, who revises them. */
  agent: string | null;
  setDrafts: (update: (list: Scenario[]) => Scenario[]) => void;
  removeDraft: (id: string) => void;
  revisions: DraftRevisions;
  setError: (message: string | null) => void;
  /** Read the board again: a person's feedback is on it. */
  onFeedback?: () => void;
}) {
  const { toast } = useToast();
  const [feedbackDrafts, setFeedbackDrafts] = useState<Map<string, string>>(() => new Map());
  /** Revisions being sent right now. A ref, not state: a second click in the same frame must
   * see the first one, before any re-render (two clicks used to send two revisions). */
  const sendingRevise = useRef<Set<string>>(new Set());
  const actor = auth.human?.id ?? null;

  function setFeedback(id: string, value: string) {
    setFeedbackDrafts((m) => new Map(m).set(id, value));
  }

  async function acceptMany(ids: string[]) {
    if (ids.length === 0 || !auth.can) return;
    setError(null);
    try {
      await setScenarioStatus(cid, actor, ids, "validated");
      const set = new Set(ids);
      setDrafts((list) => list.map((s) => (set.has(s.id) ? { ...s, status: "validated" } : s)));
      if (ids.length > 1) toast({ title: `Accepted ${ids.length} scenarios`, variant: "success" });
    } catch (e) {
      setError(ids.length === 1 ? `That scenario could not be accepted: ${errText(e)}` : `Those scenarios could not be accepted: ${errText(e)}`);
    }
  }

  async function discardOne(id: string) {
    if (!auth.can) return;
    setError(null);
    try {
      await setScenarioStatus(cid, actor, [id], "retired", DISCARD_REASON);
      removeDraft(id);
    } catch (e) {
      setError(`That scenario could not be discarded: ${errText(e)}`);
    }
  }

  async function reviseOne(draft: Scenario) {
    const id = draft.id;
    const feedback = (feedbackDrafts.get(id) ?? "").trim();
    if (!feedback || !auth.can || sendingRevise.current.has(id) || revisions.pendingIds.has(id)) return;
    sendingRevise.current.add(id);
    revisions.begin(id);
    let queued = false;
    try {
      await postFeedback(id, feedback, actor);
      const res = await createQaTask(cid, qaReviseTaskBody({ scenarioId: id, name: draft.name, feedback, platform, agentAlias: agent, humanId: actor }));
      revisions.track(id, res?.task_id ? String(res.task_id) : id);
      queued = true;
      setFeedbackDrafts((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });
      onFeedback?.();
    } catch (e) {
      revisions.abort(id, `The revision could not start: ${errText(e)}`);
      queued = true;
    } finally {
      sendingRevise.current.delete(id);
      if (!queued) revisions.abort(id);
    }
  }

  return { feedbackDrafts, setFeedback, acceptMany, discardOne, reviseOne };
}

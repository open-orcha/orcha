import { useCallback, useMemo, useState } from "react";
import type { Scenario } from "./lib/types";

export interface DraftRevisions {
  /** Scenario ids with a revision in flight. */
  pendingIds: ReadonlySet<string>;
  /** Per-scenario error message. */
  errors: ReadonlyMap<string, string>;
  /** Mark a revision as being sent, before its task exists: the card shows "Revising…" and
   * disables the button from the click on, not only once the POST returns. */
  begin: (scenarioId: string) => void;
  /** The POST failed: drop the in-flight mark `begin` set. */
  abort: (scenarioId: string, message?: string) => void;
  /** Start tracking a scenario's revision (right after its task is created). */
  track: (scenarioId: string, requestId: string) => void;
  /** Clear a scenario's tracked error (e.g. once the reviewer edits the feedback again). */
  clearError: (scenarioId: string) => void;
}

/**
 * Tracks `scenario_id -> task id` for drafts with a "Revise with Orcha" task pending. A pending
 * entry clears when the scenario's `updated_at` moves past the moment the task was created: the
 * agent rewrote it in place.
 */
export function useDraftRevisions(drafts: readonly Scenario[]): DraftRevisions {
  const [pending, setPending] = useState<Map<string, { requestId: string; queuedAt: string }>>(() => new Map());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  /** Revisions whose POST is still on its way (no task id yet). */
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());

  const begin = useCallback((scenarioId: string) => {
    setSending((s) => new Set(s).add(scenarioId));
  }, []);

  const abort = useCallback((scenarioId: string, message?: string) => {
    setSending((s) => {
      if (!s.has(scenarioId)) return s;
      const next = new Set(s);
      next.delete(scenarioId);
      return next;
    });
    if (message) setErrors((m) => new Map(m).set(scenarioId, message));
  }, []);

  const clearError = useCallback((scenarioId: string) => {
    setErrors((m) => {
      if (!m.has(scenarioId)) return m;
      const next = new Map(m);
      next.delete(scenarioId);
      return next;
    });
  }, []);

  const track = useCallback(
    (scenarioId: string, requestId: string) => {
      abort(scenarioId);
      clearError(scenarioId);
      setPending((m) => {
        const next = new Map(m);
        next.set(scenarioId, { requestId, queuedAt: new Date().toISOString() });
        return next;
      });
    },
    [abort, clearError],
  );

  // A tracked entry stops being *shown* as pending once the scenario row itself has moved on
  // (the agent's rewrite bumps `updated_at` past the moment the task was created): derived on
  // read rather than written back into `pending`, so this never needs its own effect.
  const pendingIds = useMemo(() => {
    const ids = new Set<string>(sending);
    for (const [scenarioId, entry] of pending) {
      const scenario = drafts.find((s) => s.id === scenarioId);
      if (!scenario || (scenario.updated_at ?? "") <= entry.queuedAt) ids.add(scenarioId);
    }
    return ids;
  }, [pending, drafts, sending]);

  return { pendingIds, errors, begin, abort, track, clearError };
}

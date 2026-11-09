import { useEffect, useState } from "react";
import { Button } from "../map/kit";
import { Dialog } from "../map/kit";
import { fmtDate } from "../map/kit";
import { cn } from "../map/kit";
import { errText, useAgentAlias } from "../parts";
import type { QaScenario } from "../qaApi";
import { listVersions, restoreVersion, type ScenarioVersion } from "./api";
import { HumanGate, useScenarios } from "./context";

export interface HistoryDrawerProps {
  open: boolean;
  /** A version to point at (`?history=`): marked and scrolled to. */
  highlight?: number | null;
  onClose: () => void;
  scenarioId: string;
  /** The restored scenario row (the server applied the snapshot and saved that as a new version). */
  onRestore: (scenario: QaScenario) => void;
}

/** A status change's note on a version ("Paused: Flag off until 2026-11-01", "Resumed
 * automatically: …"; or null. */
export function statusNoteOf(snapshot: unknown): string | null {
  const note = snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>).status_note : null;
  return typeof note === "string" && note.trim() ? note : null;
}

/** Versions drawer (spec §3 "History"): list + Restore. */
export function HistoryDrawer({ open, onClose, scenarioId, onRestore, highlight = null }: HistoryDrawerProps) {
  const [versions, setVersions] = useState<ScenarioVersion[] | null>(null);
  const { auth } = useScenarios();
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listVersions(scenarioId).then(
      (rows) => {
        if (cancelled) return;
        setVersions(rows);
        setError(null);
      },
      (err) => {
        if (!cancelled) setError(errText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, scenarioId]);

  async function restore(version: number) {
    setRestoring(version);
    try {
      onRestore(await restoreVersion(scenarioId, auth.human?.id ?? null, version));
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="History" description="Every save is versioned; restoring saves a new version too.">
      {error ? <p className="select-text text-sm text-danger">{error}</p> : null}
      {versions === null && !error ? <p className="text-sm text-muted">Loading…</p> : null}
      {versions && versions.length === 0 ? <p className="text-sm text-muted">No saved versions yet.</p> : null}
      {versions && versions.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border" data-history-list>
          {versions.map((v) => (
            <li
              key={v.version}
              ref={highlight === v.version ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              className={cn("flex items-center justify-between gap-2 py-2.5", highlight === v.version && "-mx-2 rounded-md bg-primary/[0.07] px-2")}
              aria-current={highlight === v.version ? "true" : undefined}
              data-history-version={v.version}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">Version {v.version}</div>
                <div className="truncate text-xs text-muted">
                  <SavedBy id={v.saved_by_agent_id} /> {fmtDate(v.saved_at)}
                </div>
                {statusNoteOf(v.snapshot) ? (
                  <div className="truncate text-xs text-fg-2" title={statusNoteOf(v.snapshot) ?? undefined} data-history-status-note>
                    {statusNoteOf(v.snapshot)}
                  </div>
                ) : null}
              </div>
              <HumanGate>
                <Button size="sm" loading={restoring === v.version} onClick={() => restore(v.version)} data-restore-version={v.version}>
                  Restore
                </Button>
              </HumanGate>
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}

function SavedBy({ id }: { id: string | null }) {
  const name = useAgentAlias(id);
  return name ? <span>{name} · </span> : null;
}

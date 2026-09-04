/**
 * Phase 2 — Live panel. Lists running runs (container-wide, via the snapshot's
 * per-agent `active_run` — see docs/orcha-code-space-design.md: "No new
 * agent-side instrumentation"; the snapshot ALREADY carries each agent's
 * current running run, so no new backend listing endpoint is needed).
 * Selecting one consumes the EXISTING run stream (hooks/useRunStream.ts) and
 * extracts Edit/Write/MultiEdit tool events (liveEdits.ts) into a painting
 * timeline of per-file patch cards. "Raise hand" on any patch line surfaces
 * the Phase-1 composer pre-tagged at the run's agent — the caller
 * (ThreadRail) renders that composer; this component only reports the pick.
 */
import { useMemo, useState } from "react";
import { diffLineClass } from "../../components/FilesChanged";
import { useRunStream } from "../../hooks/useRunStream";
import { relTime } from "../../lib/format";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Run } from "../../types";
import { extractLiveEdits, groupLiveEditsByFile, type FilePatchCard } from "./liveEdits";

export interface LivePanelProps {
  cid: string;
  agents: Agent[];
  onJumpToLine: (line: number) => void;
  onRaiseHand?: (agentId: string, line: number) => void;
}

interface RunningEntry {
  run: Run;
  agent: Agent;
}

// container-wide running-runs list — every agent whose snapshot active_run is
// live, without a dedicated backend endpoint (design doc precedent).
function runningEntries(agents: Agent[]): RunningEntry[] {
  return agents
    .filter((a) => a.active_run && a.active_run.run_id)
    .map((a) => ({
      agent: a,
      run: {
        run_id: a.active_run!.run_id,
        id: a.active_run!.run_id,
        status: "running",
        agent_id: a.id,
        agent: a.alias,
        started_at: a.active_run!.started_at || undefined,
      } as Run,
    }));
}

export function LivePanel({ agents, onJumpToLine, onRaiseHand }: LivePanelProps) {
  const { snap } = useSnapshot();
  const entries = useMemo(() => runningEntries((snap?.agents ?? agents)), [snap, agents]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const selected = entries.find((e) => (e.run.run_id || e.run.id) === selectedRunId) || null;
  const lines = useRunStream(selected ? selected.run : null);
  const cards = useMemo(() => groupLiveEditsByFile(extractLiveEdits(lines)), [lines]);

  if (!entries.length) {
    return <div className="none" style={{ padding: 10 }}>No agents are running right now.</div>;
  }

  return (
    <>
      <div className="cs-live-runs">
        {entries.map((e) => {
          const rid = e.run.run_id || e.run.id || "";
          return (
            <div
              key={rid}
              className={"cs-live-run-row" + (rid === selectedRunId ? " on" : "")}
              onClick={() => setSelectedRunId(rid === selectedRunId ? null : rid)}
            >
              <span className="cs-live-dot" />
              <span>{e.agent.alias}</span>
              <span className="grow" />
              <span className="muted" style={{ fontSize: 11 }}>{relTime(e.run.started_at)}</span>
            </div>
          );
        })}
      </div>
      {selected ? (
        <div className="cs-patch-timeline" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cards.length ? (
            cards.map((card) => (
              <PatchCard
                key={card.filePath}
                card={card}
                agentId={selected.agent.id}
                onJumpToLine={onJumpToLine}
                onRaiseHand={onRaiseHand}
              />
            ))
          ) : (
            <div className="none" style={{ padding: 10 }}>No file edits yet — watching {selected.agent.alias}…</div>
          )}
        </div>
      ) : null}
    </>
  );
}

function PatchCard({
  card,
  agentId,
  onJumpToLine,
  onRaiseHand,
}: {
  card: FilePatchCard;
  agentId: string;
  onJumpToLine: (line: number) => void;
  onRaiseHand?: (agentId: string, line: number) => void;
}) {
  const allLines = card.edits.flatMap((e) => e.lines);
  return (
    <div className="cs-patch-card">
      <div className="cs-patch-head">
        <span className="cs-patch-path" title={card.filePath} onClick={() => onJumpToLine(1)}>{card.filePath}</span>
        <span className="a">+{card.add}</span>
        <span className="d">−{card.del}</span>
      </div>
      <div className="cs-patch-lines">
        {allLines.map((l, i) => (
          <div key={i} className="cs-patch-line-row">
            <div className={"dl " + diffLineClass(l)}>{l || " "}</div>
            {onRaiseHand ? (
              <button
                type="button"
                className="cs-raise-hand-btn"
                title="Raise hand on this line"
                onClick={() => onRaiseHand(agentId, i + 1)}
              >
                raise hand
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

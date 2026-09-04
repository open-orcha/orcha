/**
 * Phase 4 — Learn tab: aggregates kind=teach|why threads repo-wide (the list
 * endpoint WITHOUT a ?path= filter), grouped by path, filterable by kind/
 * agent, with a full-thread reading view (reuses ThreadView — same reading
 * surface as Phase 1's rail, just entered from a different list).
 */
import { useEffect, useRef, useState } from "react";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { fetchRecentThreads } from "./codespaceApi";
import { anchorLabel, groupByPath, kindLabel, learnThreads, type CodeThreadSummary, type ThreadKind } from "./codespaceTypes";
import { ThreadView } from "./ThreadView";

export interface LearnTabProps {
  cid: string;
  agents: Agent[];
}

type KindFilter = "all" | ThreadKind;

export function LearnTab({ cid, agents }: LearnTabProps) {
  const { bump } = useSnapshot();
  const [threads, setThreads] = useState<CodeThreadSummary[]>([]);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const token = useRef(0);

  useEffect(() => {
    const myToken = ++token.current;
    // repo-wide: the pathless list returns {by_path} COUNTS — threads come
    // from the recent mode (wire contract; the Learn crash was this mismatch).
    fetchRecentThreads(cid, { n: 50 }).then((res) => {
      if (myToken !== token.current) return;
      if (res.ok) setThreads(res.data.threads ?? []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, bump]);

  if (openThreadId) {
    return <ThreadView threadId={openThreadId} onBack={() => setOpenThreadId(null)} />;
  }

  const taught = learnThreads(threads);
  const filtered = taught
    .filter((t) => kindFilter === "all" || t.kind === kindFilter)
    .filter((t) => agentFilter === "all" || t.tagged_agent_id === agentFilter || t.created_by_agent_id === agentFilter);
  const grouped = groupByPath(filtered);
  const aiAgents = agents.filter((a) => a.kind === "ai");

  return (
    <div className="cs-learn">
      <div className="cs-learn-filters" role="group" aria-label="Filter learning threads">
        {(["all", "teach", "why"] as KindFilter[]).map((k) => (
          <button
            key={k}
            type="button"
            className={"cs-learn-filter-btn" + (kindFilter === k ? " on" : "")}
            onClick={() => setKindFilter(k)}
          >
            {k === "all" ? "All" : kindLabel(k as ThreadKind)}
          </button>
        ))}
        <select
          className="cs-agent-select"
          value={agentFilter}
          aria-label="Filter by agent"
          onChange={(e) => setAgentFilter(e.target.value)}
          style={{ flex: "none", width: "auto" }}
        >
          <option value="all">All agents</option>
          {aiAgents.map((a) => <option key={a.id} value={a.id}>@{a.alias}</option>)}
        </select>
      </div>
      {!filtered.length ? (
        <div className="none" style={{ padding: 10 }}>No teach/why threads yet.</div>
      ) : (
        Array.from(grouped.entries()).map(([path, list]) => (
          <div key={path} className="cs-learn-group">
            <div className="cs-learn-group-path">{path}</div>
            {list.map((t) => (
              <div key={t.id} className="cs-thread-chip" onClick={() => setOpenThreadId(t.id)}>
                <div className="row1">
                  <span className={"kind-tag " + t.kind}>{kindLabel(t.kind)}</span>
                  <span className="anchor mono">:{anchorLabel(t.start_line, t.end_line)}</span>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

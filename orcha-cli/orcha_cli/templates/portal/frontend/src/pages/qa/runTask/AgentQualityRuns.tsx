/**
 * The agent's page: what it ran for Quality (`GET /api/agents/{aid}/qa-runs`). Each row says how the
 * run went, what ran, what it cost and when, opens the run, and goes on to what the agent actually
 * did. Nothing when it has run none.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { getJSON } from "../../../api/client";
import { Button, ButtonLink } from "../../../components/primitives";
import { fmtCost } from "../../../cloud/metrics/performance/performanceModel";
import { relTime } from "../../../lib/format";
import { QaStatus, useLoad } from "../parts";
import { viewportWord, type Platform } from "../qaApi";
import { minutesWord, platformWord, plural, sessionKindWord } from "../qaWords";
import { sessionHref } from "../requests/links";
import { isObj, listOf, numberOf, text } from "./read";
import "../qa.css";
import "./runTask.css";

const SHOWN = 5;

export interface AgentQualityRun {
  id: string; title: string; kind: string; platform: Platform; outcome: { word: string; glyph: string };
  note: string | null; cost: number | null; minutes: number | null; device: string | null; startedAt: string | null; didHref: string | null;
}

const OUTCOME: Record<string, { word: string; glyph: string }> = {
  passed: { word: "Passed", glyph: "completed" }, failed: { word: "Failed", glyph: "failed" }, blocked: { word: "Blocked", glyph: "blocked" },
  stopped: { word: "Could not finish", glyph: "blocked" }, running: { word: "Running", glyph: "in_progress" }, ended: { word: "Finished", glyph: "completed" },
};

/** Tolerant: an older server's missing fields stay missing, never shown raw. */
export function readAgentRuns(raw: unknown): { runs: AgentQualityRun[]; cost: number | null } {
  const r = isObj(raw) ? raw : {};
  const runs = listOf<unknown>(r.runs).filter(isObj).map((s): AgentQualityRun => {
    const platform = (text(s.platform) ?? "ios") as Platform;
    const kind = text(s.kind) ?? "check";
    const seconds = numberOf(s.duration_seconds);
    return {
      id: String(s.session_id ?? ""), kind, platform,
      title: text(s.task_title) ?? `${sessionKindWord(kind as never)} on ${platformWord(platform)}`,
      outcome: OUTCOME[text(s.outcome) ?? ""] ?? OUTCOME.ended,
      note: text(s.stop_reason), cost: numberOf(s.cost_usd), minutes: seconds != null ? seconds / 60 : null,
      device: platform === "web" && text(s.device_name) ? viewportWord(text(s.device_name)) : text(s.device_name), startedAt: text(s.started_at), didHref: isObj(s.links) ? text(s.links.worker_run) : null,
    };
  });
  return { runs, cost: isObj(r.totals) ? numberOf(r.totals.cost_usd) : null };
}

function Row({ r }: { r: AgentQualityRun }) {
  const took = r.minutes != null ? (r.minutes < 1 ? "Under a minute" : minutesWord(r.minutes)) : null;
  const facts = [r.outcome.word, sessionKindWord(r.kind as never), r.device, took, r.cost != null ? fmtCost(r.cost) : null, relTime(r.startedAt)].filter(Boolean).join(" · ");
  return (
    <li className="aq-row" data-quality-run={r.outcome.word}>
      <div className="aq-t">
        <QaStatus glyph={r.outcome.glyph} word={r.outcome.word} size={13} />
        <Link to={sessionHref(r.id, r.platform)}>{r.title}</Link>
      </div>
      <div className="aq-m">{facts}{r.note ? <span className="aq-note">{r.note}</span> : null}</div>
      {r.didHref ? <div className="aq-acts"><ButtonLink size="sm" variant="ghost" to={r.didHref}>What it did</ButtonLink></div> : null}
    </li>
  );
}

export function AgentQualityRuns({ agentId, alias }: { agentId: string; alias: string }) {
  const [all, setAll] = useState(false);
  const res = useLoad(async (s) => readAgentRuns(await getJSON<unknown>(`/api/agents/${encodeURIComponent(agentId)}/qa-runs`, s)), [agentId]);
  const rows = res.data?.runs ?? [];
  if (!rows.length) return null;
  const cost = res.data?.cost ?? null;
  return (
    <section className="td-block aq" aria-label={`Quality runs by ${alias}`} data-agent-quality-runs>
      <div className="qa-taskqa-h">
        <div className="td-block-k">Quality runs</div>
        <span className="qa-muted">{plural(rows.length, "run")}{cost != null ? ` · ${fmtCost(cost)}` : ""}</span>
      </div>
      <ul className="qa-plain aq-rows">{(all ? rows : rows.slice(0, SHOWN)).map((r) => <Row key={r.id} r={r} />)}</ul>
      {rows.length > SHOWN ? <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${rows.length}`}</Button> : null}
    </section>
  );
}

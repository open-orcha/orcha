/**
 * Proof-of-work evidence pack — mounted at the top of the verification gate
 * (TaskDetail GateSurface, verify branch) by the integrator:
 *
 *   <EvidencePack taskId={t.id} bump={bump} />
 *
 * One calm row: "Proof  ✓ 3/4 DoD items evidenced · 42 tests passed · ⚠ 1 risk flag  [Details]".
 * Details expand in place:
 *   Definition of done  each line → proven ✓ / not proven ✕ / needs a human ◌ with the
 *                       evidence line behind it and where its proof came from (Quality, tests,
 *                       CI, review or "needs a person"); a changed file reads as weak proof, below
 *                       a verdict or a passing test; a line QA checked shows that proof and its
 *                       screenshot; the agent's own words shown as "Agent says: …" (a claim —
 *                       it never changes the status)
 *   Tests               the suites the runs actually ran (latest run of each command),
 *                       counts from the runner's own summary, the command (mono)
 *   Changes             plain-English summary, risk-flag chips (files in the tooltip),
 *                       links to Live changes / the captured diff / Runs / PR
 *
 * Truthful states: loading, unavailable (with the reason + retry), no runs, no tests.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../../components/ui";
import { Button, Tooltip } from "../../../components/primitives";
import { Filmstrip, FrameLightboxProvider, FrameShapeProvider } from "../../qa/Frames";
import { platformWord } from "../../qa/qaWords";
import { requestIdHref } from "../../qa/requests/links";
import { requestKindWord, requestStatusWord } from "../../qa/requests/words";
import { relTime, clockTime } from "../../../lib/format";
import { EvidenceSummaryLine } from "./EvidenceSummaryLine";
import { evidenceCss } from "./evidenceCss";
import { useEvidence } from "./useEvidence";
import { useLoad } from "../../qa/parts";
import { getTaskQa } from "../../qa/qaApi";
import { lineProof, readFinishDecision, type FinishDecision } from "../../qa/runTask/finishing";
import { useProjectMode } from "../../../lib/projectMode";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { DodItem, EvidencePack as Pack, EvidenceQa, RiskFlag, TestInvocation } from "./evidenceTypes";

export interface EvidencePackProps {
  taskId: string;
  /** re-fetch trigger — pass the snapshot bump */
  bump?: unknown;
  /** start expanded (full task view) */
  defaultOpen?: boolean;
  /** render inside the gate's labelled rows (td-g-row) — default true */
  asGateRow?: boolean;
}

const DOD_META: Record<DodItem["status"], { icon: string; cls: string; label: string }> = {
  proven: { icon: "check", cls: "ev-ok", label: "Proven" },
  not_proven: { icon: "x", cls: "ev-bad", label: "Not proven" },
  needs_human: { icon: "eye", cls: "ev-mut", label: "Needs a human" },
};

/** A line QA judged: the screenshot behind it and the way to the request. */
function QaProof({ item, platform }: { item: DodItem; platform: string | null }) {
  const frames = (item.frame_ids ?? []).map((id) => ({ id, caption: item.text }));
  return (
    <div className="ev-qa" data-qa-proof={item.qa_request_id ?? "qa"}>
      <FrameShapeProvider shape={platform === "web" ? "wide" : "phone"}>
        <Filmstrip label={`QA screenshots for: ${item.text}`} frames={frames} />
      </FrameShapeProvider>
      {item.qa_request_id ? <div className="ev-links"><Link to={requestIdHref(item.qa_request_id)}>Open the QA request</Link></div> : null}
    </div>
  );
}

/** The task's QA requests, one line each. */
function QaRows({ rows }: { rows: EvidenceQa[] }) {
  return (
    <ul className="ev-list" aria-label="QA requests">
      {rows.map((r) => (
        <li className="ev-item" key={r.id}>
          <span className={"ev-glyph " + (r.status === "passed" ? "ev-ok" : r.status === "failed" ? "ev-bad" : "ev-mut")}>
            <Icon name={r.status === "passed" ? "check" : r.status === "failed" ? "x" : "dot"} cls="" />
          </span>
          <div>
            <div className="ev-t"><Link to={requestIdHref(r.id)}>{requestKindWord(r.kind)}{r.platform ? ` on ${platformWord(r.platform)}` : ""}</Link> <span className="ev-m">{requestStatusWord(r.status)}{r.round > 1 ? ` · round ${r.round}` : ""}</span></div>
            {r.summary ? <div className="ev-m">{r.summary}</div> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Where a line's proof came from, and how much it weighs next to a verdict or a passing test. */
function ProofTag({ item }: { item: DodItem }) {
  const p = lineProof(item);
  return (
    <span className={"ev-proof is-" + p.strength} data-proof={p.source} data-strength={p.strength}>
      {p.word}{p.strength === "weak" ? " · weak proof" : ""}
    </span>
  );
}

/** Under "finish by itself": what kept this task from finishing alone, in plain words. */
function FinishWhy({ d }: { d: FinishDecision }) {
  return (
    <div className="ev-why" data-finish-why>
      <p className="ev-why-h">This came to a person because not everything is proven.</p>
      {d.lines.length ? (
        <ul className="ev-why-list" aria-label="Lines not proven">
          {d.lines.map((l) => (
            <li key={l.index ?? l.text}><span className="ev-t">{l.text}</span><span className="ev-m">{l.reason}</span></li>
          ))}
        </ul>
      ) : null}
      {d.reasons.length ? <ul className="ev-why-list" aria-label="Other reasons">{d.reasons.map((r) => <li key={r}><span className="ev-m">{r}</span></li>)}</ul> : null}
    </div>
  );
}

function DodList({ items, qa }: { items: DodItem[]; qa: EvidenceQa[] }) {
  if (!items.length) return <div className="ev-m">No definition of done on this task.</div>;
  return (
    <FrameLightboxProvider>
    <ul className="ev-list" aria-label="Definition of done checklist">
      {items.map((i) => {
        const m = DOD_META[i.status];
        return (
          <li className="ev-item" key={i.index} data-status={i.status}>
            <span className={"ev-glyph " + m.cls} title={m.label} aria-label={m.label}>
              <Icon name={m.icon} cls="" />
            </span>
            <div>
              <div className="ev-t">{i.text} <ProofTag item={i} /></div>
              {i.evidence ? <div className="ev-m">{i.evidence}</div> : <div className="ev-m">No machine evidence</div>}
              {i.basis === "qa" ? <QaProof item={i} platform={qa.find((r) => r.id === i.qa_request_id)?.platform ?? null} /> : null}
              {i.claim ? (
                <div className="ev-claim" title="The agent's own report — a claim, not evidence">
                  <b>Agent says:</b> “{i.claim}”
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
    </FrameLightboxProvider>
  );
}

function invText(inv: TestInvocation): { text: string; cls: string } {
  const c = inv.counts;
  if (c) {
    const bad = c.failed + c.errors;
    const unit = c.unit === "tests" ? "" : " " + c.unit;
    return {
      text: `${c.passed} passed${bad ? ` · ${bad} failed` : ""}${c.skipped ? ` · ${c.skipped} skipped` : ""}${unit}`,
      cls: bad ? "ev-bad" : c.passed ? "ev-ok" : "ev-mut",
    };
  }
  if (inv.outcome === "exit_ok") return { text: "exit 0 · no summary line", cls: "" };
  if (inv.outcome === "exit_failed") return { text: inv.exit_code != null ? `exit ${inv.exit_code}` : "errored", cls: "ev-bad" };
  return { text: "result not captured", cls: "ev-mut" };
}

function TestsList({ pack }: { pack: Pack }) {
  const t = pack.tests;
  if (t.status === "none") {
    return <div className="ev-m">No test command found in {pack.runs.length ? `this task's ${pack.runs.length} run${pack.runs.length === 1 ? "" : "s"}` : "any run (none recorded)"}.</div>;
  }
  return (
    <>
      <ul className="ev-list" aria-label="Test runs">
        {t.latest.map((inv, n) => {
          const x = invText(inv);
          return (
            <li className="ev-item" key={n}>
              <span className={"ev-glyph " + (x.cls || "ev-mut")}>
                <Icon name={x.cls === "ev-bad" ? "x" : x.cls === "ev-ok" ? "check" : "dot"} cls="" />
              </span>
              <div>
                <div className="ev-t">
                  {inv.framework} <span className={x.cls}>{x.text}</span>
                </div>
                <div className="ev-code" title={inv.command}>{inv.command}</div>
              </div>
            </li>
          );
        })}
      </ul>
      {t.earlier ? <div className="ev-m">{t.earlier} earlier run{t.earlier === 1 ? "" : "s"} of the same command{t.earlier === 1 ? "" : "s"} superseded.</div> : null}
    </>
  );
}

function FlagChip({ f }: { f: RiskFlag }) {
  const tip = f.detail + (f.files.length ? "\n" + f.files.join("\n") + (f.count > f.files.length ? `\n+${f.count - f.files.length} more` : "") : "");
  return (
    <Tooltip label={<span style={{ whiteSpace: "pre-line" }}>{tip}</span>}>
      <span className={"ev-chip " + (f.severity === "danger" ? "ev-bad" : "ev-warn")} tabIndex={0} data-flag={f.kind} aria-label={f.label + ": " + f.detail}>
        <span className="ev-dot" aria-hidden="true" />
        <span>{f.label}</span>
      </span>
    </Tooltip>
  );
}

function Changes({ pack }: { pack: Pack }) {
  const c = pack.changes;
  return (
    <>
      <div className="ev-t">{c.summary}</div>
      {pack.branch ? <div className="ev-m">Branch <span className="ev-code">{pack.branch}</span></div> : null}
      {c.unavailable_runs?.length && !c.files ? (
        <div className="ev-m">No diff captured for {c.unavailable_runs.length} run{c.unavailable_runs.length === 1 ? "" : "s"}{c.unavailable_runs[0]?.detail ? ` (${c.unavailable_runs[0].detail})` : ""}.</div>
      ) : null}
      {pack.flags.length ? (
        <div className="ev-chips" aria-label="Risk flags">
          {pack.flags.map((f) => <FlagChip key={f.kind} f={f} />)}
        </div>
      ) : null}
      {pack.links.length ? (
        <div className="ev-links">
          {pack.links.map((l) =>
            l.href.startsWith("http") ? (
              <a key={l.href} href={l.href} target="_blank" rel="noreferrer"><Icon name={l.kind === "pr" ? "pr" : "ext"} cls="v2-ico" />{l.label}</a>
            ) : (
              <Link key={l.href} to={l.href}><Icon name={l.kind === "runs" ? "play" : "git"} cls="v2-ico" />{l.label}</Link>
            ),
          )}
        </div>
      ) : null}
    </>
  );
}

export function EvidenceDetails({ pack, onRebuild }: {
  pack: Pack;
  onRebuild?: () => void;
}) {
  return (
    <div className="ev-body" data-testid="evidence-details">
      <section aria-label="Definition of done">
        <div className="ev-sec-h"><span>Definition of done</span></div>
        <DodList items={pack.dod.items} qa={pack.qa ?? []} />
      </section>
      {pack.qa?.length ? (
        <section aria-label="QA">
          <div className="ev-sec-h"><span>QA</span></div>
          <QaRows rows={pack.qa} />
        </section>
      ) : null}
      <section aria-label="Tests">
        <div className="ev-sec-h"><span>Tests</span></div>
        <TestsList pack={pack} />
      </section>
      <section aria-label="Changes">
        <div className="ev-sec-h"><span>Changes</span></div>
        <Changes pack={pack} />
      </section>
      <div className="ev-foot">
        <span title={clockTime(pack.built_at)}>
          Built {relTime(pack.built_at)} from {pack.runs.length} run{pack.runs.length === 1 ? "" : "s"}
          {pack.round_started_at ? " since the last rejection" : ""}
        </span>
        {onRebuild ? <Button variant="link" size="sm" data-act="evidence-rebuild" onClick={onRebuild}>Rebuild</Button> : null}
      </div>
    </div>
  );
}

export function EvidencePack({ taskId, bump, defaultOpen, asGateRow = true }: EvidencePackProps) {
  const { pack, error, loading, reload, rebuild, unsupported } = useEvidence(taskId, bump);
  const [open, setOpen] = useState(!!defaultOpen);
  const general = useProjectMode(useSnapshot().cid).mode === "general";
  const qa = useLoad((s) => getTaskQa(taskId, s), [taskId]);
  const finish = readFinishDecision(qa.data?.final_decision);
  if (unsupported && !pack) return null;

  let body;
  if (!pack && error) {
    body = (
      <span className="ev-line">
        <span className="ev-part ev-mut">{error}</span>
        <Button variant="link" size="sm" onClick={reload}>Retry</Button>
      </span>
    );
  } else if (!pack) {
    body = <span className="ev-line"><span className="ev-part ev-mut">{loading ? "Gathering evidence…" : "No evidence yet."}</span></span>;
  } else {
    body = (
      <>
        <span className="ev-line">
          <EvidenceSummaryLine summary={pack.summary} short={!defaultOpen} general={general} />
          <Button
            variant="ghost"
            size="sm"
            className="ev-toggle"
            iconRight="chev"
            aria-expanded={open}
            aria-controls={"ev-" + taskId}
            data-act="evidence-toggle"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide" : "Details"}
          </Button>
        </span>
        {finish?.toPerson ? <FinishWhy d={finish} /> : null}
        {open ? (
          <div id={"ev-" + taskId}>
            <EvidenceDetails pack={pack} onRebuild={() => void rebuild()} />
          </div>
        ) : null}
      </>
    );
  }
  return (
    <div className={(asGateRow ? "td-g-row " : "") + "ev-row"} aria-label="Proof of work" data-testid="evidence-pack">
      <style>{evidenceCss}</style>
      {asGateRow ? (
        <span className="td-g-k" title="What the task's runs recorded — tests, changes, and the definition of done checked line by line">Proof</span>
      ) : null}
      <div className={asGateRow ? "td-g-v" : undefined}>{body}</div>
    </div>
  );
}

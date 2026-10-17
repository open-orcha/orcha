/**
 * Proof-of-work evidence pack — mounted at the top of the verification gate
 * (TaskDetail GateSurface, verify branch) by the integrator:
 *
 *   <EvidencePack taskId={t.id} actorId={actor?.id ?? null} noActorReason={noHuman} bump={bump} />
 *
 * One calm row: "Proof  ✓ 3/4 DoD items evidenced · 42 tests passed · ⚠ 1 risk flag · Verdikt pass  [Details]".
 * Details expand in place:
 *   Definition of done  each line → proven ✓ / not proven ✕ / needs a human ◌ with the
 *                       evidence line behind it; the agent's own words shown as
 *                       "Agent says: …" (a claim — it never changes the status)
 *   Tests               the suites the runs actually ran (latest run of each command),
 *                       counts from the runner's own summary, the command (mono)
 *   Changes             plain-English summary, risk-flag chips (files in the tooltip),
 *                       links to Live changes / the captured diff / Runs / PR
 *   Verdikt             latest run, verdicts, screenshots, report; Run / Retry / Cancel
 *
 * Truthful states: loading, unavailable (with the reason + retry), no runs, no tests.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../../components/ui";
import { Button, Tooltip } from "../../../components/primitives";
import { relTime, clockTime } from "../../../lib/format";
import { EvidenceSummaryLine } from "./EvidenceSummaryLine";
import { VerdiktPanel } from "./VerdiktPanel";
import { evidenceCss } from "./evidenceCss";
import { useEvidence } from "./useEvidence";
import { useProjectMode } from "../../../lib/projectMode";
import { useSnapshot } from "../../../state/SnapshotProvider";
import type { DodItem, EvidencePack as Pack, RiskFlag, TestInvocation, VerdiktRun } from "./evidenceTypes";

export interface EvidencePackProps {
  taskId: string;
  /** acting human id for the Verdikt actions (null → disabled with the reason) */
  actorId: string | null;
  noActorReason?: string;
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

function DodList({ items }: { items: DodItem[] }) {
  if (!items.length) return <div className="ev-m">No definition of done on this task.</div>;
  return (
    <ul className="ev-list" aria-label="Definition of done checklist">
      {items.map((i) => {
        const m = DOD_META[i.status];
        return (
          <li className="ev-item" key={i.index} data-status={i.status}>
            <span className={"ev-glyph " + m.cls} title={m.label} aria-label={m.label}>
              <Icon name={m.icon} cls="" />
            </span>
            <div>
              <div className="ev-t">{i.text}</div>
              {i.evidence ? <div className="ev-m">{i.evidence}</div> : <div className="ev-m">{m.label} — no machine evidence</div>}
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

export function EvidenceDetails({ pack, actorId, noActorReason, onVerdikt, onRebuild }: {
  pack: Pack;
  actorId: string | null;
  noActorReason?: string;
  onVerdikt?: (run: VerdiktRun | null) => void;
  onRebuild?: () => void;
}) {
  return (
    <div className="ev-body" data-testid="evidence-details">
      <section aria-label="Definition of done">
        <div className="ev-sec-h"><span>Definition of done</span></div>
        <DodList items={pack.dod.items} />
      </section>
      <section aria-label="Tests">
        <div className="ev-sec-h"><span>Tests</span></div>
        <TestsList pack={pack} />
      </section>
      <section aria-label="Changes">
        <div className="ev-sec-h"><span>Changes</span></div>
        <Changes pack={pack} />
      </section>
      <VerdiktPanel taskId={pack.task_id} latest={pack.verdikt} actorId={actorId} noActorReason={noActorReason} onChanged={onVerdikt} showCriteria={false} previewUrls={pack.preview_urls} />
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

export function EvidencePack({ taskId, actorId, noActorReason, bump, defaultOpen, asGateRow = true }: EvidencePackProps) {
  const { pack, error, loading, reload, rebuild, setPack, unsupported } = useEvidence(taskId, bump);
  const [open, setOpen] = useState(!!defaultOpen);
  const general = useProjectMode(useSnapshot().cid).mode === "general";
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
        {open ? (
          <div id={"ev-" + taskId}>
            <EvidenceDetails
              pack={pack}
              actorId={actorId}
              noActorReason={noActorReason}
              onRebuild={() => void rebuild()}
              onVerdikt={(run) => {
                if (run) setPack({ ...pack, verdikt: run, summary: { ...pack.summary, verdikt: { status: run.status, verdict: run.verdict } } });
                reload();
              }}
            />
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

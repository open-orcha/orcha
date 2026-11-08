/**
 * One imported Quality report, laid out like a run: what it tested on, what the task asked, each
 * scenario with its checks and screenshots, the findings, the screens it covered by feature (the
 * map), and what it did not cover. Everything here is as reported: Re-run proves it in this project.
 */
import { cleanConditions, conditionWords } from "../conditions/conditions";
import { useState } from "react";
import { Button, Chip, EmptyState } from "../../../components/primitives";
import { relTime } from "../../../lib/format";
import type { QaAuthority } from "../authority";
import { Filmstrip, FrameThumb, type FrameItem } from "../Frames";
import { QaStatus, errText, useLoad } from "../parts";
import type { QaNav } from "../QaPage";
import { platformWord, plural, severityTone, severityWord, verdictGlyph, verdictWord } from "../qaWords";
import { addReportDrafts, deleteReport, getReport, reportFrameSrc, rerunIds, tallyWords, type ImportedReport, type ReportCheck, type ReportVerdict } from "./api";

const statusOf = (v: ReportVerdict) => <QaStatus glyph={v ? verdictGlyph(v) : "pending"} word={v ? verdictWord(v) : "Not judged"} show />;

function frames(report: ImportedReport, ids: string[], caption: string): FrameItem[] {
  return ids.map((id, i) => ({ id, caption: `${caption} ${i + 1}`, src: reportFrameSrc(report, id) ?? undefined })).filter((f) => f.src);
}

function Checks({ report, checks, label }: { report: ImportedReport; checks: ReportCheck[]; label: string }) {
  return (
    <ul className="qa-plain qa-report-checks" aria-label={label}>
      {checks.map((c) => (
        <li key={c.index}>
          {statusOf(c.verdict)}
          <span className="qa-report-check">{c.text}{c.note ? <span className="qa-muted">: {c.note}</span> : null}</span>
          <Filmstrip frames={frames(report, c.frame_ids, c.text || label)} label={`Screenshots for ${c.text || label}`} />
        </li>
      ))}
    </ul>
  );
}

export function ImportedReportView({ rid, nav, auth }: { rid: string; nav: QaNav; auth: QaAuthority }) {
  const [tick, setTick] = useState(0);
  const res = useLoad((s) => getReport(rid, s), [rid], nav.nonce + tick);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const back = () => nav.set({ report: null });
  if (res.error && !res.data) return <section className="qa-report-page"><EmptyState tone="danger" title="Couldn't open this report" body={res.error} action={<Button size="sm" onClick={back}>Back to reports</Button>} /></section>;
  const report = res.data;
  if (!report) return null;
  const d = report.data;
  const reruns = rerunIds(report);
  const missing = d.scenarios.filter((s) => !report.matched[s.id]);
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const byFeature = new Map<string, typeof d.screens>();
  for (const s of d.screens) byFeature.set(s.feature || "Other screens", [...(byFeature.get(s.feature || "Other screens") ?? []), s]);
  const builds = [...new Set(d.runs.map((r) => r.app_build).filter(Boolean))];

  return (
    <section className="qa-report-page" data-qa-report={report.id}>
      <button type="button" className="qa-report-back" onClick={back}>‹ Reports</button>
      <header className="qa-report-head">
        <div className="qa-report-titles">
          <h2 className="qa-report-h">{d.task.title}</h2>
          <p className="qa-muted" data-qa-report-reported>
            Reported by {d.task.project}'s run, exported {relTime(d.generated_at)}, imported {relTime(report.created_at)}{report.imported_by ? ` by ${report.imported_by}` : ""}. It proves nothing here until it is re-run.
          </p>
        </div>
        <div className="qa-report-actions">
          {reruns.map((r) => (
            <Button key={r.platform} size="sm" variant="primary" icon="play" disabled={!auth.can}
              onClick={() => nav.runQa("check", null, { scenarioIds: r.ids, platform: r.platform, conditions: r.conditions })} data-qa-report-rerun={r.platform}>
              Re-run {plural(r.ids.length, "scenario")}{reruns.length > 1 ? ` on ${platformWord(r.platform)}` : ""}
            </Button>
          ))}
          {missing.length ? (
            <Button size="sm" busy={busy === "drafts"} disabled={!auth.human}
              onClick={() => void act("drafts", async () => { await addReportDrafts(report.id, auth.human?.id ?? null); setTick((n) => n + 1); })} data-qa-report-drafts>
              Add {plural(missing.length, "missing scenario")} as drafts
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" busy={busy === "remove"} disabled={!auth.human}
            onClick={() => void act("remove", async () => { await deleteReport(report.id, auth.human?.id ?? null); back(); nav.refresh(); })}>Remove</Button>
        </div>
      </header>
      {err ? <p className="qa-error" role="alert">{err}</p> : null}

      <dl className="qa-kv qa-report-kv">
        <div className="qa-kv-row"><dt>Result</dt><dd>{statusOf(d.result)} <span className="qa-muted">· {tallyWords(d.tally)}</span></dd></div>
        <div className="qa-kv-row"><dt>Platforms</dt><dd>{d.setup.platforms.map(platformWord).join(", ")}</dd></div>
        <div className="qa-kv-row"><dt>Devices</dt><dd>{d.setup.devices.join(", ") || "Not recorded"}</dd></div>
        {d.runs.filter((r) => cleanConditions(r.conditions)).map((r) => (
          <div className="qa-kv-row" key={"c-" + r.id}><dt>Conditions</dt><dd data-qa-report-conditions={r.id}>{conditionWords(r.conditions, r.platform).join(" · ")}</dd></div>
        ))}
        {builds.length ? <div className="qa-kv-row"><dt>App build</dt><dd>{builds.join(", ")}</dd></div> : null}
        {d.build.branch ? <div className="qa-kv-row"><dt>Branch</dt><dd><code>{d.build.branch}</code></dd></div> : null}
        {d.build.commit ? <div className="qa-kv-row"><dt>Commit</dt><dd><code>{d.build.commit}</code></dd></div> : null}
        {Object.entries(d.setup.apps).map(([p, a]) => (
          <div className="qa-kv-row" key={p}><dt>{platformWord(p as never)} app</dt><dd>{a.app_name ? `${a.app_name} · ` : ""}<code>{a.app_id || "not set"}</code></dd></div>
        ))}
        {d.setup.accounts.length ? (
          <div className="qa-kv-row"><dt>Test accounts</dt><dd>{d.setup.accounts.map((a) => [a.persona || "Any user", a.needs].filter(Boolean).join(": ")).join("; ")}</dd></div>
        ) : null}
      </dl>

      {d.lines.length ? (
        <section className="qa-report-sec" aria-label="What the task asked">
          <h3 className="qa-report-sub">What the task asked</h3>
          <Checks report={report} checks={d.lines} label="Acceptance lines" />
        </section>
      ) : null}

      <section className="qa-report-sec" aria-label="Scenarios run">
        <h3 className="qa-report-sub">Scenarios run <span className="qa-muted">{d.scenarios.length}</span></h3>
        {d.scenarios.length ? (
          <ul className="qa-plain qa-report-scenarios">
            {d.scenarios.map((s) => (
              <li key={s.id} className="qa-report-scenario" data-qa-report-scenario={s.id}>
                <div className="qa-report-scenario-head">
                  {statusOf(s.verdict)}
                  <span className="qa-report-scenario-name">{s.name}</span>
                  <Chip size="sm">{platformWord(s.platform)}</Chip>
                  <span className="qa-muted">{report.matched[s.id] ? "In this project" : "Not in this project"}</span>
                </div>
                {cleanConditions(s.conditions) ? <p className="qa-muted qa-report-cond" data-qa-report-scenario-conditions={s.id}>Under: {conditionWords(s.conditions, s.platform).join(" · ")}</p> : null}
                <Checks report={report} checks={s.checks} label={s.name} />
              </li>
            ))}
          </ul>
        ) : <p className="qa-muted">No scenario was run.</p>}
      </section>

      {d.findings.length ? (
        <section className="qa-report-sec" aria-label="Findings">
          <h3 className="qa-report-sub">Findings <span className="qa-muted">{d.findings.length}</span></h3>
          <ul className="qa-plain qa-report-findings">
            {d.findings.map((f) => (
              <li key={f.id}>
                <Chip size="sm" dot={severityTone(f.severity)}>{severityWord(f.severity as never)}</Chip>
                <span className="qa-report-check">{f.title}{f.expected ? <span className="qa-muted">. Expected: {f.expected}</span> : null}{f.actual ? <span className="qa-muted">. Saw: {f.actual}</span> : null}</span>
                <Filmstrip frames={frames(report, f.frame_ids, f.title)} label={`Screenshots for ${f.title}`} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.screens.length ? (
        <section className="qa-report-sec" aria-label="Screens covered">
          <h3 className="qa-report-sub">Screens covered <span className="qa-muted">{plural(d.screens.length, "screen")} across {plural(d.features.length, "feature")}</span></h3>
          <div className="qa-report-map" data-qa-report-map>
            {[...byFeature.entries()].map(([feature, screens]) => (
              <div key={feature} className="qa-report-feature">
                <h4 className="qa-report-feature-h">{feature}</h4>
                <ul className="qa-plain qa-report-screens">
                  {screens.map((s) => {
                    const src = reportFrameSrc(report, s.frame_id);
                    return (
                      <li key={s.platform + s.key}>
                        {src ? <FrameThumb frame={{ id: s.frame_id!, caption: s.label, src }} size="sm" label={s.label} />
                          : <span className="qa-report-screen-name">{s.label}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {d.gaps_total ? (
        <section className="qa-report-sec" aria-label="Not covered">
          <h3 className="qa-report-sub">Not covered <span className="qa-muted">{plural(d.gaps_total, "approved scenario")} not run</span></h3>
          <ul className="qa-plain qa-report-gaps">
            {d.gaps.map((g) => <li key={g.id}>{g.name} <span className="qa-muted">· {platformWord(g.platform)}</span></li>)}
            {d.gaps_total > d.gaps.length ? <li className="qa-muted">and {d.gaps_total - d.gaps.length} more</li> : null}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

/**
 * "Start from a template" — pick an industry template, choose what to take from it,
 * review EXACTLY what will be created (server preview), confirm, see the result.
 *
 * Used by onboarding (step "template") and by an existing project (ApplyTemplateDialog,
 * mounted from Settings). Human authority throughout:
 *   - nothing is created until the acting human presses the apply button on the Review
 *     step, whose label states the consequence ("Create 5 agents, 2 routines…");
 *   - the server re-computes the plan and refuses (409) if the project changed since the
 *     review — the UI then shows the fresh plan instead of applying a stale one;
 *   - applying needs the owner role or `manage_agents`; switching the project mode also
 *     needs `manage_autonomy` (the option is disabled with the reason otherwise).
 * Routines are created PAUSED unless the human ticks "Start routines now".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Button, Chip, EmptyState, GlyphSvg, Skeleton, Tooltip } from "../../../components/primitives";
import type { GlyphName } from "../../../components/primitives";
import { Icon } from "../../../components/ui";
import { MODE_LABEL, refreshProjectMode, useProjectMode, type ProjectMode } from "../../../lib/projectMode";
import { useGrantAuthority } from "../../settings/grantAuthority";
import { browserZone, describeSchedule, timeZones } from "../../routines/schedule";
import {
  StalePlanError, applyLabel, prettyRoutineTitle, applyTemplate, getTemplate, listTemplates, previewTemplate,
  type ApplyResult, type ItemStatus, type PlanAction, type TemplateFull, type TemplatePlan, type TemplateSelection, type TemplateSummary,
} from "./templatesApi";
import "./templates.css";

export const TEMPLATE_GLYPH: Record<string, GlyphName> = {
  "software-team": "code",
  "marketing-team": "chart",
  operations: "briefcase",
  research: "flask",
  "customer-support": "mail",
};

type Stage = "pick" | "configure" | "review" | "done";

export interface TemplateApplyFlowProps {
  cid: string;
  /** preselect a template (skips the gallery) */
  initialKey?: string | null;
  /** called after a successful apply, when the human leaves the result screen */
  onDone?: (r: ApplyResult) => void;
  /** leave without applying */
  onCancel?: () => void;
  /** label for the leave button on the result screen */
  doneLabel?: string;
  /** onboarding shows its own title; the dialog hides the flow heading */
  compact?: boolean;
}

function errText(e: unknown): string {
  const x = e as { detail?: string; message?: string };
  return x?.detail || x?.message || "Something went wrong";
}

export function defaultSelection(t: TemplateFull, currentMode: ProjectMode): TemplateSelection {
  return {
    roles: t.roles.map((r) => r.key),
    routines: t.routines.map((r) => r.key),
    enable_routines: false,
    timezone: browserZone(),
    set_mode: t.mode !== currentMode,
    dod_presets: true,
    objective: null,
  };
}

/* ---- gallery ---------------------------------------------------------------- */

export function TemplateGallery({ templates, onPick }: { templates: TemplateSummary[]; onPick: (key: string) => void }) {
  return (
    <ul className="tpl-gallery" aria-label="Templates">
      {templates.map((t) => (
        <li key={t.key}>
          <button type="button" className="tpl-card" data-template={t.key} onClick={() => onPick(t.key)}>
            <span className="tpl-card-ic" aria-hidden="true"><GlyphSvg name={TEMPLATE_GLYPH[t.key] || "box"} size={16} /></span>
            <span className="tpl-card-b">
              <span className="tpl-card-t">
                {t.name}
                <Chip size="sm" dot={t.mode === "general" ? "info" : "neutral"}>{MODE_LABEL[t.mode]}</Chip>
              </span>
              <span className="tpl-card-s">{t.summary}</span>
              <span className="tpl-card-m">
                {t.roles.length} agents · {t.routine_count} routine{t.routine_count === 1 ? "" : "s"} · {t.dod_preset_count} done-criteria presets
              </span>
            </span>
            <Icon name="chev-right" cls="tpl-card-go" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ---- the flow --------------------------------------------------------------- */

export function TemplateApplyFlow({ cid, initialKey, onDone, onCancel, doneLabel = "Done", compact }: TemplateApplyFlowProps) {
  const pm = useProjectMode(cid);
  const apply = useGrantAuthority("manage_agents");
  const modeAuth = useGrantAuthority("manage_autonomy");
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>(initialKey ? "configure" : "pick");
  const [key, setKey] = useState<string | null>(initialKey || null);
  const [full, setFull] = useState<TemplateFull | null>(null);
  const [sel, setSel] = useState<TemplateSelection | null>(null);
  const [plan, setPlan] = useState<TemplatePlan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const zones = useMemo(() => timeZones(), []);
  const headRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    listTemplates(ac.signal).then((d) => setTemplates(d.templates)).catch((e) => { if (!ac.signal.aborted) setLoadErr(errText(e)); });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (!key) { setFull(null); return; }
    const ac = new AbortController();
    setFull(null);
    getTemplate(key, ac.signal).then((t) => { setFull(t); setSel(defaultSelection(t, pm.mode)); })
      .catch((e) => { if (!ac.signal.aborted) setLoadErr(errText(e)); });
    return () => ac.abort();
    // pm.mode read once per template choice (the default for "switch mode")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { headRef.current?.focus(); }, [stage]);

  const canModeSwitch = modeAuth.can;
  const modeDiffers = !!full && full.mode !== pm.mode;
  const effSel: TemplateSelection | null = sel ? { ...sel, set_mode: sel.set_mode && modeDiffers && canModeSwitch } : null;
  const nothingPicked = !!sel && (sel.roles?.length ?? 0) === 0 && (sel.routines?.length ?? 0) === 0 && !sel.dod_presets
    && !(sel.set_mode && modeDiffers) && !(sel.objective || "").trim();

  const review = async () => {
    if (!key || !effSel) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      setPlan(await previewTemplate(cid, key, apply.human?.id ?? null, effSel));
      setStage("review");
    } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };

  const confirm = async () => {
    if (!key || !effSel || !plan || !apply.can) return;
    setBusy(true); setErr(null);
    try {
      const r = await applyTemplate(cid, key, apply.human?.id ?? null, effSel, plan.plan_fingerprint);
      setResult(r);
      setStage("done");
      void refreshProjectMode(cid);
    } catch (e) {
      if (e instanceof StalePlanError) {
        setPlan(e.plan);
        setNotice("The project changed since you opened this review. This is the updated plan — nothing was created yet.");
      } else setErr(errText(e));
    }
    setBusy(false);
  };

  const toggle = (field: "roles" | "routines", k: string) => setSel((s) => {
    if (!s) return s;
    const cur = new Set(s[field] || []);
    if (cur.has(k)) cur.delete(k); else cur.add(k);
    return { ...s, [field]: [...cur] };
  });

  if (loadErr) return <p className="tpl-err" role="alert">Couldn't load templates — {loadErr}.</p>;

  /* -- pick -- */
  if (stage === "pick") {
    return (
      <div className="tpl-flow" data-stage="pick">
        {!compact && <h2 className="tpl-h" tabIndex={-1} ref={headRef}>Start from a template</h2>}
        {templates ? <TemplateGallery templates={templates} onPick={(k) => { setKey(k); setPlan(null); setStage("configure"); }} />
          : <Skeleton lines={5} />}
        {onCancel ? <div className="tpl-actions"><Button variant="ghost" onClick={onCancel}>Cancel</Button></div> : null}
      </div>
    );
  }

  if (!full || !sel) return <div className="tpl-flow"><Skeleton lines={6} /></div>;

  const roleByKey = Object.fromEntries(full.roles.map((r) => [r.key, r]));
  const denied = !apply.pending && !apply.can ? apply.reason : null;

  /* -- configure -- */
  if (stage === "configure") {
    return (
      <div className="tpl-flow" data-stage="configure">
        <div className="tpl-head">
          <span className="tpl-card-ic" aria-hidden="true"><GlyphSvg name={TEMPLATE_GLYPH[full.key] || "box"} size={16} /></span>
          <h2 className="tpl-h" tabIndex={-1} ref={headRef}>{full.name}</h2>
          <Chip size="sm" dot={full.mode === "general" ? "info" : "neutral"}>{MODE_LABEL[full.mode]}</Chip>
          {!initialKey && <Button size="sm" variant="ghost" className="tpl-change" onClick={() => setStage("pick")}>Change template</Button>}
        </div>
        <p className="tpl-lede">{full.summary} Choose what to take — nothing is created until you review and confirm.</p>

        <section className="tpl-sec" aria-labelledby="tplObjH">
          <h3 id="tplObjH">Objective <span className="tpl-opt">optional</span></h3>
          <textarea className="tpl-txa" id="tplObjective" rows={2} maxLength={4000} aria-labelledby="tplObjH"
            placeholder="What should this project achieve?" value={sel.objective || ""}
            onChange={(e) => setSel({ ...sel, objective: e.target.value || null })} />
          <div className="tpl-examples" aria-label="Example objectives">
            {full.objective_examples.map((ex) => (
              <Chip key={ex} size="sm" onClick={() => setSel({ ...sel, objective: ex })} title="Use this example">{ex}</Chip>
            ))}
          </div>
        </section>

        <section className="tpl-sec" aria-labelledby="tplTeamH">
          <h3 id="tplTeamH">Team <span className="tpl-count">{sel.roles?.length ?? 0} of {full.roles.length}</span></h3>
          <ul className="tpl-rows">
            {full.roles.map((r) => {
              const on = (sel.roles || []).includes(r.key);
              const mgr = r.reports_to ? roleByKey[r.reports_to]?.alias : null;
              return (
                <li key={r.key} className="tpl-row">
                  <label className="tpl-check">
                    <input type="checkbox" checked={on} onChange={() => toggle("roles", r.key)} data-role={r.key} />
                    <Avatar alias={r.alias} kind="ai" size={20} decorative />
                    <span className="tpl-row-t">{r.alias}</span>
                    <span className="tpl-row-s">{r.role}</span>
                  </label>
                  <span className="tpl-row-m">{mgr ? <>reports to {mgr}</> : "reports to you"}</span>
                  <details className="tpl-prompt">
                    <summary>Prompt</summary>
                    <pre>{r.prompt}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="tpl-sec" aria-labelledby="tplRtH">
          <h3 id="tplRtH">Routines <span className="tpl-count">{sel.routines?.length ?? 0} of {full.routines.length}</span></h3>
          <ul className="tpl-rows">
            {full.routines.map((r) => (
              <li key={r.key} className="tpl-row">
                <label className="tpl-check">
                  <input type="checkbox" checked={(sel.routines || []).includes(r.key)} onChange={() => toggle("routines", r.key)} data-routine={r.key} />
                  <Icon name="routines" cls="tpl-ico" />
                  <span className="tpl-row-t" title={r.title}>{prettyRoutineTitle(r.title)}</span>
                </label>
                <span className="tpl-row-m">{describeSchedule(r.cron, sel.timezone)}{r.assignee && roleByKey[r.assignee] ? " · " + roleByKey[r.assignee].alias : ""}</span>
              </li>
            ))}
          </ul>
          <div className="tpl-inline">
            <label className="tpl-check">
              <input type="checkbox" id="tplEnable" checked={sel.enable_routines} onChange={(e) => setSel({ ...sel, enable_routines: e.target.checked })} />
              <span>Start routines now</span>
            </label>
            <span className="tpl-row-m">{sel.enable_routines ? "They run on schedule once created." : "Created paused — turn them on in Routines."}</span>
            <label className="tpl-tz">
              <span className="v2-sr">Time zone</span>
              <select className="tpl-sel" value={sel.timezone} aria-label="Time zone for routines" onChange={(e) => setSel({ ...sel, timezone: e.target.value })}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="tpl-sec" aria-labelledby="tplSetH">
          <h3 id="tplSetH">Project</h3>
          <label className="tpl-check tpl-line">
            <input type="checkbox" id="tplPresets" checked={sel.dod_presets} onChange={(e) => setSel({ ...sel, dod_presets: e.target.checked })} />
            <span>Add {full.dod_presets.length} definition-of-done presets</span>
            <span className="tpl-row-m">{full.dod_presets.map((p) => p.label).join(" · ")}</span>
          </label>
          {modeDiffers ? (
            canModeSwitch ? (
              <label className="tpl-check tpl-line">
                <input type="checkbox" id="tplMode" checked={sel.set_mode} onChange={(e) => setSel({ ...sel, set_mode: e.target.checked })} />
                <span>Switch this project to {MODE_LABEL[full.mode]} mode</span>
                <span className="tpl-row-m">{full.mode === "general" ? "Hides the Code and GitHub tabs; nothing is unbound or deleted." : "Shows the Code and GitHub tabs."}</span>
              </label>
            ) : (
              <p className="tpl-row-m tpl-line" id="tplModeDenied">Stays in {MODE_LABEL[pm.mode]} mode — {modeAuth.reason || "you can't change the project mode"}.</p>
            )
          ) : (
            <p className="tpl-row-m tpl-line">This project is already in {MODE_LABEL[pm.mode]} mode.</p>
          )}
        </section>

        {err && <p className="tpl-err" role="alert">{err}</p>}
        <div className="tpl-actions">
          {onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}
          <Button variant="primary" id="tplReview" disabled={busy || nothingPicked} onClick={review}>
            {busy ? "Checking…" : "Review"}
          </Button>
        </div>
      </div>
    );
  }

  /* -- review -- */
  if (stage === "review" && plan) {
    const nothing = !plan.counts.agents_to_create && !plan.counts.routines_to_create && !plan.counts.dod_presets_to_add
      && !plan.mode.change && !plan.objective;
    const applyBtn = (
      <Button variant="primary" id="tplApply" disabled={busy || !apply.can || nothing} aria-describedby={denied ? "tplDenied" : undefined} onClick={confirm}>
        {busy ? "Applying…" : nothing ? "Nothing new to create" : applyLabel(plan.counts)}
      </Button>
    );
    return (
      <div className="tpl-flow" data-stage="review">
        <h2 className="tpl-h" tabIndex={-1} ref={headRef}>Review: {plan.template.name}</h2>
        <p className="tpl-lede">This is exactly what will happen. Agents are created now, under your name, by your confirmation.</p>
        {notice && <p className="tpl-notice" role="status">{notice}</p>}
        <PlanView plan={plan} />
        {err && <p className="tpl-err" role="alert">{err}</p>}
        {denied && <p className="tpl-row-m" id="tplDenied" role="note">{denied}.</p>}
        <div className="tpl-actions">
          <Button variant="ghost" onClick={() => { setStage("configure"); setNotice(null); }}>Back</Button>
          <Tooltip label={denied || ""} disabled={!denied}>{applyBtn}</Tooltip>
        </div>
      </div>
    );
  }

  /* -- done -- */
  if (stage === "done" && result) {
    return (
      <div className="tpl-flow" data-stage="done">
        <h2 className="tpl-h" tabIndex={-1} ref={headRef}>{result.ok ? `${result.template.name} applied` : `${result.template.name} applied with problems`}</h2>
        <ResultView result={result} />
        <div className="tpl-actions">
          <Button variant="primary" id="tplDone" onClick={() => onDone?.(result)}>{doneLabel}</Button>
        </div>
      </div>
    );
  }
  return <EmptyState title="Nothing to show" />;
}

/* ---- plan + result lists ---------------------------------------------------- */

const ACTION_WORD: Record<PlanAction, string> = { create: "Create", reuse: "Keep", skip: "Skip" };
const ACTION_TONE: Record<PlanAction, "ok" | "neutral" | "warn"> = { create: "ok", reuse: "neutral", skip: "warn" };

function ActionChip({ a, reason }: { a: PlanAction; reason?: string | null }) {
  return <Chip size="sm" dot={ACTION_TONE[a]} title={reason || undefined}>{ACTION_WORD[a]}</Chip>;
}

export function PlanView({ plan }: { plan: TemplatePlan }) {
  const managers = Object.fromEntries(plan.reporting.map((l) => [l.alias, l.reports_to]));
  return (
    <div className="tpl-plan">
      {plan.agents.length > 0 && (
        <section className="tpl-sec" aria-label="Agents">
          <h3>Agents</h3>
          <ul className="tpl-rows">
            {plan.agents.map((a) => (
              <li key={a.alias} className="tpl-row" data-plan-agent={a.alias} data-action={a.action}>
                <ActionChip a={a.action} reason={a.reason} />
                <Avatar alias={a.alias} kind="ai" size={20} decorative />
                <span className="tpl-row-t">{a.alias}</span>
                <span className="tpl-row-s">{a.role}</span>
                <span className="tpl-row-m">{a.reason || (managers[a.alias] ? "reports to " + managers[a.alias] : "")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.routines.length > 0 && (
        <section className="tpl-sec" aria-label="Routines">
          <h3>Routines</h3>
          <ul className="tpl-rows">
            {plan.routines.map((r) => (
              <li key={r.key} className="tpl-row" data-plan-routine={r.key} data-action={r.action}>
                <ActionChip a={r.action} reason={r.reason} />
                <span className="tpl-row-t" title={r.title}>{prettyRoutineTitle(r.title)}</span>
                <span className="tpl-row-m">
                  {r.reason || <>{r.schedule_text} · {r.assignee_alias || "assigned normally"} · {r.enabled ? "starts now" : "paused"}</>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.dod_presets.length > 0 && (
        <section className="tpl-sec" aria-label="Definition-of-done presets">
          <h3>Definition-of-done presets</h3>
          <ul className="tpl-rows">
            {plan.dod_presets.map((p) => (
              <li key={p.key} className="tpl-row" data-action={p.action}>
                <ActionChip a={p.action} reason={p.reason} />
                <span className="tpl-row-t">{p.name}</span>
                <span className="tpl-row-m" title={p.body}>{p.reason || p.body}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="tpl-sec" aria-label="Project settings">
        <h3>Project</h3>
        <ul className="tpl-rows">
          <li className="tpl-row" data-plan-mode={plan.mode.to}>
            <ActionChip a={plan.mode.change ? "create" : "reuse"} />
            <span className="tpl-row-t">Mode</span>
            <span className="tpl-row-m">{plan.mode.change ? `${MODE_LABEL[plan.mode.from]} → ${MODE_LABEL[plan.mode.to]}` : `Stays ${MODE_LABEL[plan.mode.from]}`}</span>
          </li>
          {plan.objective && (
            <li className="tpl-row">
              <ActionChip a="create" />
              <span className="tpl-row-t">Objective</span>
              <span className="tpl-row-m">{plan.objective.to}</span>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

const STATUS_TONE: Record<ItemStatus, "ok" | "neutral" | "warn" | "danger"> = {
  created: "ok", set: "ok", reuse: "neutral", skip: "neutral", failed: "danger",
};
const STATUS_WORD: Record<ItemStatus, string> = { created: "Created", set: "Set", reuse: "Kept", skip: "Skipped", failed: "Failed" };

export function ResultView({ result }: { result: ApplyResult }) {
  const r = result.result;
  const rows: { k: string; kind: string; name: string; status: ItemStatus; reason?: string | null }[] = [
    ...r.agents.map((a) => ({ k: "a" + a.alias, kind: "Agent", name: a.alias, status: a.status, reason: a.reason })),
    ...r.routines.map((x) => ({ k: "r" + x.title, kind: "Routine", name: prettyRoutineTitle(x.title) + (x.status === "created" ? (x.enabled ? " (running)" : " (paused)") : ""), status: x.status, reason: x.reason })),
    ...r.dod_presets.map((p) => ({ k: "p" + p.name, kind: "Preset", name: p.name, status: p.status, reason: p.reason })),
    ...r.reporting.filter((l) => l.status === "failed").map((l) => ({ k: "l" + l.alias, kind: "Reporting line", name: `${l.alias} → ${l.reports_to}`, status: l.status, reason: l.reason })),
  ];
  return (
    <div className="tpl-plan">
      {!result.ok && <p className="tpl-err" role="alert">{r.failures.length} item{r.failures.length === 1 ? "" : "s"} failed — everything else was created. Details below.</p>}
      <ul className="tpl-rows" aria-label="What was created">
        {rows.map((x) => (
          <li key={x.k} className="tpl-row" data-status={x.status}>
            <Chip size="sm" dot={STATUS_TONE[x.status]}>{STATUS_WORD[x.status]}</Chip>
            <span className="tpl-row-s">{x.kind}</span>
            <span className="tpl-row-t">{x.name}</span>
            {x.reason ? <span className="tpl-row-m">{x.reason}</span> : null}
          </li>
        ))}
        {r.mode && (
          <li className="tpl-row" data-status="set">
            <Chip size="sm" dot="ok">Set</Chip>
            <span className="tpl-row-s">Mode</span>
            <span className="tpl-row-t">{MODE_LABEL[r.mode.from]} → {MODE_LABEL[r.mode.to]}</span>
          </li>
        )}
        {r.objective && (
          <li className="tpl-row" data-status="set">
            <Chip size="sm" dot="ok">Set</Chip>
            <span className="tpl-row-s">Objective</span>
            <span className="tpl-row-t">{r.objective}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

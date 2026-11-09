/**
 * What a person reads before deciding: each criterion with what backs it (the screens it was seen
 * on, the code it came from, the last check), the screens as a filmstrip beside them, the walk it
 * was drafted from, lint notes, and an agent's suggested changes as a diff to accept or dismiss.
 */
import { useState, type ReactElement } from "react";
import { ArrowRight, Check, CheckCheck, CircleAlert, Code2, ScanEye, Sparkles, TriangleAlert, X } from "../map/kit/icons";
import { Button, StatusGlyph, cn, fmtRelative, useToast } from "../map/kit";
import { useFrameLightbox } from "../Frames";
import { errText, useAgentAlias } from "../parts";
import {
  decideSuggestion,
  frameUrl,
  setScenarioStatus,
  type EvidenceStatus,
  type QaEvidence,
  type QaScenario,
  type QaSuggestion,
  type QaVerdict,
  type ScenarioStatus,
} from "../qaApi";
import { verdictWord } from "../qaWords";
import { HumanGate, useScenarios } from "./context";
import { PanelSection } from "./panel-ui";
import { WalkBlock } from "./walk-block";

/* ---- the decisions a person can take ---------------------------------------- */

export type StatusAction = { to: ScenarioStatus; label: string; icon: string; reason: boolean; primary?: boolean; danger?: boolean };

/** The decisions a person can take from a status (Pause and Retire need a reason). */
export function statusActions(st: ScenarioStatus): StatusAction[] {
  const validate: StatusAction = { to: "validated", label: "Validate", icon: "check", reason: false, primary: true };
  const pause: StatusAction = { to: "paused", label: "Pause", icon: "pause", reason: true };
  const retire: StatusAction = { to: "retired", label: "Retire", icon: "x", reason: true, danger: true };
  if (st === "draft") return [validate, retire];
  if (st === "validated") return [pause, retire];
  if (st === "paused") return [{ ...validate, label: "Resume", icon: "play" }, retire];
  return [{ to: "draft", label: "Restore as draft", icon: "refresh", reason: false }];
}

/* ---- evidence ---------------------------------------------------------------- */

export const EVIDENCE_LABEL: Record<EvidenceStatus, string> = {
  verified: "verified on screen",
  unconfirmed: "unconfirmed",
  code_only: "code only",
};

/** Evidence for one criterion, from the scenario's evidence rows. */
export function evidenceFor(evidence: readonly QaEvidence[], index: number): QaEvidence[] {
  return evidence.filter((e) => e.criterion_index === index);
}

/** "3 of 5 verified on screen" for the card's header; "code only" when no screen could check it. */
export function evidenceSummary(criteria: readonly string[], evidence: readonly QaEvidence[]): string | null {
  if (!evidence.length) return null;
  const seen = criteria.filter((_, i) => evidenceFor(evidence, i).some((e) => e.status === "verified")).length;
  if (!seen && evidence.every((e) => e.status === "code_only")) return "code only";
  return `${seen} of ${criteria.length} verified on screen`;
}

/** What a badge's tooltip says. */
export function evidenceTitle(r: Pick<QaEvidence, "status" | "note" | "code_ref">): string {
  const code = r.code_ref ? ` · from ${r.code_ref}` : "";
  if (r.status === "verified") return `Seen${r.note ? `: ${r.note}` : ""}${code}`;
  if (r.status === "unconfirmed") return `Not confirmed on any screen yet${code}`;
  return `No screen to check it against${code}`;
}

export interface FilmFrame {
  id: string;
  /** 0-based criteria the screen backs. */
  criteria: number[];
  verified: boolean;
}

/** The screens a draft is based on, one each: verified first, then by criterion. */
export function filmstrip(rows: readonly QaEvidence[], max = 8): FilmFrame[] {
  const byId = new Map<string, FilmFrame>();
  const ordered = [...rows].sort((a, b) => Number(b.status === "verified") - Number(a.status === "verified") || a.criterion_index - b.criterion_index);
  for (const r of ordered) {
    if (!r.frame_id) continue;
    const cur = byId.get(r.frame_id);
    if (cur) {
      if (!cur.criteria.includes(r.criterion_index)) cur.criteria.push(r.criterion_index);
      cur.verified ||= r.status === "verified";
      continue;
    }
    byId.set(r.frame_id, { id: r.frame_id, criteria: [r.criterion_index], verified: r.status === "verified" });
  }
  return [...byId.values()].slice(0, max);
}

const BADGE: Record<EvidenceStatus, string> = {
  verified: "border-success/35 bg-success/10 text-success",
  unconfirmed: "border-dashed border-border-strong text-muted",
  code_only: "border-border text-fg-2",
};

/** A criterion's evidence: "verified on screen ✓", "unconfirmed" or "code only". */
export function EvidenceBadge({ row }: { row: QaEvidence }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none", BADGE[row.status])} title={evidenceTitle(row)} data-evidence-badge={row.status}>
      {row.status === "code_only" ? <Code2 aria-hidden className="size-3" /> : null}
      {row.status === "unconfirmed" ? <ScanEye aria-hidden className="size-3" /> : null}
      {EVIDENCE_LABEL[row.status]}
      {row.status === "verified" ? <Check aria-hidden className="size-3" strokeWidth={2.5} /> : null}
    </span>
  );
}

/** A criterion with its `**bold**` labels drawn bold instead of as asterisks. */
export function CriterionText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-medium text-fg">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

const VERDICT_GLYPH: Record<QaVerdict["verdict"], "pass" | "fail" | "blocked" | "inconclusive"> = { pass: "pass", fail: "fail", blocked: "blocked", inconclusive: "inconclusive" };

/** The criteria of a draft with what backs each one. */
function EvidenceCriteria({
  criteria,
  evidence,
  verdicts,
  highlighted,
  onHighlight,
}: {
  criteria: readonly string[];
  evidence: readonly QaEvidence[];
  verdicts: readonly QaVerdict[];
  highlighted: number | null;
  onHighlight: (index: number | null) => void;
}) {
  return (
    <ol className="flex flex-col gap-2 text-sm text-fg" data-evidence-criteria>
      {criteria.map((c, i) => {
        const rows = evidenceFor(evidence, i);
        const last = verdicts.find((v) => v.criterion_index === i) ?? null;
        return (
          <li
            key={i}
            className={cn("-mx-1.5 flex flex-col gap-1 rounded-md px-1.5 py-1 transition-colors duration-150", highlighted === i && "bg-hover")}
            onMouseEnter={() => onHighlight(i)}
            onMouseLeave={() => onHighlight(null)}
            data-evidence-criterion={i}
          >
            <div className="flex items-start gap-2">
              <span className="w-4 shrink-0 pt-px text-right text-xs tabular text-muted">{i + 1}.</span>
              <span className="min-w-0 flex-1">
                <CriterionText text={c} />
              </span>
            </div>
            {rows.length || last ? (
              <div className="flex flex-wrap items-center gap-1.5 pl-6">
                {rows.map((row) => (
                  <span key={row.id} className="inline-flex min-w-0 items-center gap-1.5">
                    <EvidenceBadge row={row} />
                    {row.code_ref ? (
                      <span className="truncate font-mono text-[11px] text-muted" title={row.code_ref} data-evidence-code>
                        {row.code_ref}
                      </span>
                    ) : null}
                  </span>
                ))}
                {last ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted" title={last.note || undefined} data-last-check={last.verdict}>
                    <StatusGlyph status={VERDICT_GLYPH[last.verdict]} decorative className="size-3" />
                    Last check: {verdictWord(last.verdict)} · {fmtRelative(last.created_at)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The screens a draft is based on, beside its criteria; each opens full size. */
function DraftFilmstrip({ frames, criteria, highlighted, onHighlight }: { frames: readonly FilmFrame[]; criteria: readonly string[]; highlighted: number | null; onHighlight: (index: number | null) => void }) {
  const open = useFrameLightbox();
  if (frames.length === 0) return null;
  const caption = (f: FilmFrame) => `Criterion ${f.criteria.map((i) => i + 1).join(", ")}: ${criteria[f.criteria[0]] ?? ""}`;
  const items = frames.map((f) => ({ id: f.id, caption: caption(f) }));
  return (
    <div className="flex gap-2 overflow-x-auto @md:flex-col @md:overflow-visible" aria-label="Screens this draft is based on" data-draft-filmstrip>
      {frames.map((f, i) => {
        const lit = highlighted != null && f.criteria.includes(highlighted);
        return (
          <figure key={f.id} className="w-[132px] shrink-0">
            <button
              type="button"
              title="View full size"
              aria-label={`View ${items[i].caption} full size`}
              onClick={() => open?.(items, i)}
              onMouseEnter={() => onHighlight(f.criteria[0])}
              onMouseLeave={() => onHighlight(null)}
              onFocus={() => onHighlight(f.criteria[0])}
              onBlur={() => onHighlight(null)}
              className="group relative block cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              data-filmstrip-frame={f.id}
            >
              <span className={cn("relative block h-[92px] w-[132px] overflow-hidden rounded-md border border-border bg-panel transition-[border-color,box-shadow] duration-150 group-hover:border-border-strong", lit && "border-accent shadow-[0_0_0_1px_var(--color-accent)]")}>
                <img src={frameUrl(f.id)} alt={items[i].caption} loading="lazy" className="size-full object-cover object-top" />
              </span>
              <span className={cn("absolute left-1 top-1 z-10 inline-flex h-4 items-center gap-0.5 rounded px-1 text-[10px] font-medium tabular", f.verified ? "bg-success text-white" : "bg-panel/90 text-fg-2 ring-1 ring-border")}>
                {f.verified ? <Check aria-hidden className="size-2.5" strokeWidth={3} /> : null}
                {f.criteria.map((c) => c + 1).join(", ")}
              </span>
            </button>
          </figure>
        );
      })}
    </div>
  );
}

/** Criteria + filmstrip, side by side on a wide card, stacked on a narrow one. */
function DraftEvidenceBlock({ criteria, evidence, verdicts }: { criteria: readonly string[]; evidence: readonly QaEvidence[]; verdicts: readonly QaVerdict[] }) {
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const frames = filmstrip(evidence);
  return (
    <div className={cn("grid min-w-0 gap-3", frames.length > 0 && "@md:grid-cols-[minmax(0,1fr)_132px]")} data-draft-evidence>
      <EvidenceCriteria criteria={criteria} evidence={evidence} verdicts={verdicts} highlighted={highlighted} onHighlight={setHighlighted} />
      <DraftFilmstrip frames={frames} criteria={criteria} highlighted={highlighted} onHighlight={setHighlighted} />
    </div>
  );
}

/* ---- lint notes -------------------------------------------------------------- */

export interface LintNote {
  severity: "error" | "warning" | "info";
  message: string;
  /** 0-based; null for the whole scenario. */
  criterion: number | null;
}

/** The server's `lint` list, as far as it reads. */
export function lintNotes(raw: unknown): LintNote[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): LintNote[] => {
    const r = x as { severity?: unknown; message?: unknown; criterion?: unknown } | null;
    if (typeof r?.message !== "string" || !r.message) return [];
    const severity = r.severity === "error" || r.severity === "warning" ? r.severity : "info";
    return [{ severity, message: r.message, criterion: typeof r.criterion === "number" ? r.criterion : null }];
  });
}

function LintNotes({ notes }: { notes: readonly LintNote[] }) {
  if (notes.length === 0) return null;
  return (
    <PanelSection title="Lint notes" lead="How it reads as a test. Nothing here blocks a run." data-scenario-lint>
      <ul className="flex flex-col gap-1.5">
        {notes.map((n, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs text-fg-2" data-lint-note={n.severity}>
            {n.severity === "error" ? <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-danger" /> : <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />}
            <span className="min-w-0">
              {n.criterion != null ? <span className="text-muted">Criterion {n.criterion + 1}: </span> : null}
              {n.message}
            </span>
          </li>
        ))}
      </ul>
    </PanelSection>
  );
}

/* ---- suggestions ------------------------------------------------------------- */

export interface CriteriaDiff {
  text: string;
  mark: "kept" | "new" | "removed";
}

/** Proposed criteria in their new order, tagged new; removed ones listed after, struck through. */
export function diffCriteria(current: readonly string[], proposed: readonly string[]): CriteriaDiff[] {
  const cur = new Set(current.map((c) => c.trim()));
  const next = new Set(proposed.map((c) => c.trim()));
  return [
    ...proposed.map((c) => ({ text: c, mark: cur.has(c.trim()) ? ("kept" as const) : ("new" as const) })),
    ...current.filter((c) => !next.has(c.trim())).map((c) => ({ text: c, mark: "removed" as const })),
  ];
}

const FIELD_WORD: Record<string, string> = { name: "Name", description: "Description", persona: "Persona", category: "Category", tags: "Tags", needs: "Needs", depends_on: "Dependencies", checks: "Checks", data: "Data variables" };

/** A proposed value in words: lists joined, a check by its line, data as key = value. */
export function fieldText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? String((x as { line?: unknown }).line ?? "") : String(x))).filter(Boolean).join(", ") || "None";
  if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => `${k} = ${String(x)}`).join(", ") || "None";
  return v == null || v === "" ? "None" : String(v);
}

function SuggestionCard({ s, sug, onDone }: { s: QaScenario; sug: QaSuggestion; onDone: () => void }) {
  const { toast } = useToast();
  const { auth } = useScenarios();
  const [busy, setBusy] = useState<"accept" | "dismiss" | null>(null);
  const by = useAgentAlias(sug.agent_id, sug.agent_alias);
  const p = (sug.proposed ?? {}) as Record<string, unknown>;
  const now = s as unknown as Record<string, unknown>;
  const crit = Array.isArray(p.criteria) ? diffCriteria(s.criteria, p.criteria.map(String)) : null;
  const critChanged = !!crit && crit.some((c) => c.mark !== "kept");
  const fields = Object.keys(FIELD_WORD).filter((k) => k in p && fieldText(p[k]) !== fieldText(now[k]));
  const changed = [...fields.map((k) => FIELD_WORD[k]), ...(critChanged ? ["Criteria"] : [])];

  async function decide(d: "accept" | "dismiss") {
    if (!auth.can) return;
    setBusy(d);
    try {
      await decideSuggestion(sug.id, auth.human?.id ?? null, d);
      toast({ title: d === "accept" ? "Saved to the scenario" : "Suggestion dismissed", variant: "success" });
      onDone();
    } catch (e) {
      toast({ title: "Could not save that", description: errText(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-panel-2 px-3 py-2.5" aria-label="Suggested change" data-scenario-suggestion={sug.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-fg">
          <Sparkles aria-hidden className="size-3.5 shrink-0 text-accent" />
          Suggested change{changed.length ? ` · ${changed.join(", ")}` : ""}
        </span>
        <span className="text-xs text-muted">
          {by ? `by ${by}` : ""}
          {sug.created_at ? `${by ? " · " : ""}${fmtRelative(sug.created_at)}` : ""}
        </span>
      </div>
      {sug.reason ? <p className="whitespace-pre-wrap text-xs text-fg-2">{sug.reason}</p> : null}
      {fields.length ? (
        <dl className="flex flex-col gap-1 text-xs">
          {fields.map((k) => (
            <div key={k} className="flex min-w-0 items-start gap-2">
              <dt className="w-[92px] shrink-0 text-muted">{FIELD_WORD[k]}</dt>
              <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <span className="min-w-0 break-words text-muted line-through decoration-border-strong">{fieldText(now[k])}</span>
                <ArrowRight aria-hidden className="size-3 shrink-0 text-muted" />
                <span className="min-w-0 break-words text-fg">{fieldText(p[k])}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {critChanged ? (
        <ol className="flex flex-col gap-1" aria-label="Proposed criteria">
          {crit!.map((c, i) => (
            <li key={i} className={cn("-mx-1 flex items-start gap-1.5 rounded-md px-1 py-0.5 text-xs text-fg-2", c.mark === "new" && "bg-success/[0.08]", c.mark === "removed" && "bg-danger/[0.06]")} data-diff={c.mark}>
              {c.mark === "new" ? <span className="shrink-0 rounded-full bg-success/15 px-1.5 py-px text-[10px] font-medium text-success">New</span> : null}
              {c.mark === "removed" ? <span className="shrink-0 rounded-full bg-danger/12 px-1.5 py-px text-[10px] font-medium text-danger">Removed</span> : null}
              <span className={cn("min-w-0", c.mark === "removed" && "line-through decoration-danger/50")}>{c.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex items-center gap-1.5 pt-0.5">
        <HumanGate>
          <Button size="sm" variant="primary" disabled={!auth.can} loading={busy === "accept"} onClick={() => void decide("accept")} data-suggestion-accept>
            <Check /> Accept
          </Button>
        </HumanGate>
        <HumanGate>
          <Button size="sm" disabled={!auth.can} loading={busy === "dismiss"} onClick={() => void decide("dismiss")} data-suggestion-dismiss>
            <X /> Dismiss
          </Button>
        </HumanGate>
      </div>
    </section>
  );
}

/* ---- the card ------------------------------------------------------------------ */

/** The review card inside the scenario panel. `detail` is the scenario with its evidence. */
export function ReviewCard({ detail, onChanged }: { detail: QaScenario; onChanged: () => void }) {
  const { toast } = useToast();
  const { cid, auth } = useScenarios();
  const [busy, setBusy] = useState(false);
  const evidence = detail.evidence ?? [];
  const verdicts = detail.verdicts ?? [];
  const pending = (detail.suggestions ?? []).filter((x) => x.status === "proposal");
  const notes = lintNotes((detail as unknown as { lint?: unknown }).lint);
  const headline = evidenceSummary(detail.criteria, evidence);
  const accept = statusActions(detail.status).find((a) => a.primary) ?? null;
  const showCriteria = evidence.length > 0 || verdicts.length > 0;

  async function decide(a: StatusAction) {
    if (!auth.can) return;
    setBusy(true);
    try {
      await setScenarioStatus(cid, auth.human?.id ?? null, [detail.id], a.to);
      toast({ title: a.to === "validated" ? "Validated" : a.label, variant: "success" });
      onChanged();
    } catch (e) {
      toast({ title: "Could not change the status", description: errText(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const button: ReactElement | null = accept ? (
    <HumanGate placement="left">
      <Button size="sm" variant="primary" disabled={!auth.can} loading={busy} onClick={() => void decide(accept)} data-review-accept>
        <CheckCheck /> {accept.label}
      </Button>
    </HumanGate>
  ) : null;

  return (
    <>
      {showCriteria || accept ? (
        <PanelSection title="Review" lead={headline ?? undefined} action={button} className="@container" data-scenario-review>
          {showCriteria ? <DraftEvidenceBlock criteria={detail.criteria} evidence={evidence} verdicts={verdicts} /> : null}
          {!auth.can ? <p className="text-xs text-muted">{auth.reason || "Only a person can validate, pause or retire a scenario."}</p> : null}
        </PanelSection>
      ) : null}
      {pending.length ? (
        <PanelSection title="Suggested changes" data-scenario-suggestions>
          <div className="flex flex-col gap-2">
            {pending.map((p) => (
              <SuggestionCard key={p.id} s={detail} sug={p} onDone={onChanged} />
            ))}
          </div>
        </PanelSection>
      ) : null}
      <LintNotes notes={notes} />
      {detail.walk ? (
        <section className="border-t border-border px-4 py-3.5" data-scenario-walk>
          <WalkBlock walk={detail.walk} title={detail.platform === "web" ? "Walked in a browser" : "Walked on a device"} />
        </section>
      ) : null}
    </>
  );
}

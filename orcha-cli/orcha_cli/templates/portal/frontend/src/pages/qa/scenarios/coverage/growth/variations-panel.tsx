import { useState, type CSSProperties } from "react";
import { Check, Sparkles, X } from "../../../map/kit/icons";
import { Button } from "../../../map/kit";
import { cn } from "../../../map/kit";
import styles from "./growth.module.css";
import { TECHNIQUE_WORDS, type Flow, type Variations, type VariationRow } from "./types";

const TECH_TONE: Record<string, string> = {
  empty: "border-border-strong text-fg-2",
  invalid: "border-danger/40 text-danger",
  boundary: "border-primary/40 text-fg",
  locale: "border-border-strong text-fg",
  partition: "border-border text-fg-2",
};

/** A sealed Examples cell (`orcha.scenarios.examples`): never shown, not even its reference. */
const SECRET_REF = /^secret:sec_[0-9a-f]{8,64}$/;

function valuesLine(r: VariationRow): string {
  return Object.entries(r.values)
    .filter(([k]) => !/^(expect(ed)?|result|outcome|then|should)$/i.test(k))
    .map(([k, v]) => `${k}: ${v === "" ? "(empty)" : SECRET_REF.test(v) ? "••••" : v.length > 48 ? `${v.slice(0, 46)}…` : v}`)
    .join(" · ");
}

function Proposal({ group, busy, onApply, onDismiss }: {
  group: Variations["pending"][number];
  busy: boolean;
  onApply: (ids: string[]) => Promise<unknown> | void;
  onDismiss: (ids: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(group.rows.map((r) => r.id)));
  // The rows being added leave toward the table before the save starts, so approving reads as
  // the rows going in; the depth meter above then lights its new partitions.
  const [going, setGoing] = useState(false);
  const ids = group.rows.filter((r) => picked.has(r.id)).map((r) => r.id);
  async function add() {
    setGoing(true);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    await new Promise((r) => window.setTimeout(r, reduce ? 0 : 380));
    await onApply(ids);
    // Saved: this proposal leaves with the next report. Refused: the rows come back.
    setGoing(false);
  }
  return (
    <div className={cn("v-rise rounded-lg border border-[color:color-mix(in_oklab,var(--g-orcha)_35%,transparent)] bg-[color:color-mix(in_oklab,var(--g-orcha)_5%,transparent)] p-3")} data-growth-proposal={group.scenario_id}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-fg">
          {group.rows.length} rows for ‘{group.name}’ <span className="font-normal text-muted">waiting for your approval</span>
        </p>
        <p className="text-xs text-muted">Each row is its own run once added.</p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {group.rows.map((r, i) => (
          <li key={r.id} className={cn(styles.rowIn, going && picked.has(r.id) && styles.rowGoing)} style={{ "--i": i } as CSSProperties}>
            <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
              <input
                type="checkbox"
                className="mt-1 accent-[var(--color-primary)]"
                checked={picked.has(r.id)}
                onChange={(e) =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(r.id);
                    else n.delete(r.id);
                    return n;
                  })
                }
                data-growth-row={r.id}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className={cn("rounded border px-1.5 text-2xs font-medium uppercase tracking-[0.06em]", TECH_TONE[r.technique])}>{TECHNIQUE_WORDS[r.technique]}</span>
                  <span className="text-sm text-fg">{r.label}</span>
                </span>
                <span className="mt-0.5 block truncate font-mono text-xs text-muted">{valuesLine(r)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy || going || ids.length === 0} aria-busy={busy || going} onClick={() => void add()} data-growth-apply>
          <Check /> {busy || going ? `Adding ${ids.length} ${ids.length === 1 ? "row" : "rows"}…` : `Add ${ids.length} ${ids.length === 1 ? "row" : "rows"}`}
        </Button>
        <Button size="sm" disabled={busy || going} onClick={() => onDismiss(group.rows.map((r) => r.id))} data-growth-dismiss>
          <X /> Dismiss all
        </Button>
      </div>
    </div>
  );
}

/**
 * More data: the flows by how many input partitions they try, rows Orcha suggests for the
 * thinnest (empty, invalid, boundary, locale), and the ones waiting for the person's approval.
 * Nothing reaches a scenario until "Add rows" is clicked.
 */
export function VariationsPanel({ variations, flows, busy, grew = {}, onSuggest, onApply, onDismiss }: {
  variations: Variations;
  flows: Flow[];
  busy: string | null;
  /** Flows whose data depth just grew (rows were added): id -> partitions before. */
  grew?: Record<string, number>;
  onSuggest: (scenarioId: string) => void;
  onApply: (ids: string[]) => Promise<unknown> | void;
  onDismiss: (ids: string[]) => void;
}) {
  // The flows that count (fresh), deepest first; a flow whose rows were just added leads, even
  // one that does not count yet, so approving always shows where the rows went.
  const grown = flows.filter((f) => grew[f.id] !== undefined);
  const fresh = flows.filter((f) => f.evidence === "fresh" && grew[f.id] === undefined);
  const deep = [...grown, ...[...fresh].sort((a, b) => b.depth.partitions - a.depth.partitions || a.name.localeCompare(b.name)).slice(0, Math.max(0, 8 - grown.length))];
  const max = Math.max(5, ...deep.map((f) => f.depth.partitions));
  return (
    <section aria-labelledby="growth-data" className="rounded-xl border border-border bg-panel p-4" data-growth-variations>
      <h2 id="growth-data" className="text-sm font-semibold text-fg">
        Data depth
      </h2>
      <p className="mb-3 text-xs text-muted">
        Distinct input partitions each flow tries (ordinary values, empty fields, invalid input, boundaries, other locales, seeded records). {variations.applied > 0 ? `${variations.applied} rows Embodent suggested are in your tables.` : ""}
      </p>
      {grown.length > 0 ? (
        <p className={cn(styles.landed, "mb-3 inline-flex flex-wrap items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-medium", styles.pillUp)} aria-live="polite" data-growth-depth-grew>
          <Check className="size-3.5" aria-hidden />
          {grown
            .map((f) => `‘${f.name}’ now tries ${f.depth.partitions} partitions, up from ${grew[f.id]}${f.evidence === "fresh" ? "" : ". It counts once it passes a run"}`)
            .join("; ")}
          .
        </p>
      ) : null}
      {deep.length > 0 ? (
        <ul className="mb-4 flex flex-col gap-1.5" data-growth-depth>
          {deep.map((f, n) => {
            const was = grew[f.id];
            return (
              <li
                key={f.id}
                className={cn("v-rise grid grid-cols-[minmax(0,1fr)_7rem_2rem] items-center gap-2 rounded-md px-1 text-sm", was !== undefined && "bg-[color:color-mix(in_oklab,var(--g-orcha)_8%,transparent)]")}
                style={{ "--i": n } as CSSProperties}
                title={`${f.name}: ${f.depth.kinds.map((k) => TECHNIQUE_WORDS[k as keyof typeof TECHNIQUE_WORDS] ?? k).join(", ")}`}
                data-growth-depth-flow={f.id}
                data-grew={was !== undefined ? was : undefined}
              >
                <span className="truncate text-fg-2">
                  {f.name} {f.origin === "yours" ? <span className="text-xs text-muted">(your test)</span> : null}
                  {f.evidence !== "fresh" ? <span className="text-xs text-muted"> · not counted until it passes</span> : null}
                </span>
                <span className="flex h-2 gap-[2px]" aria-hidden>
                  {Array.from({ length: max }, (_, i) => (
                    <span
                      key={i}
                      className={cn("h-2 flex-1 rounded-[2px]", i < f.depth.partitions ? "bg-[var(--g-orcha)]" : "bg-[var(--g-track)]", was !== undefined && i >= was && i < f.depth.partitions && styles.cellLit)}
                      style={{ "--j": i - (was ?? 0) } as CSSProperties}
                    />
                  ))}
                </span>
                <span className="text-right tabular-nums text-fg">
                  {was !== undefined ? <span className="sr-only">{`${was} before, now `}</span> : null}
                  {f.depth.partitions}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-muted">No flow counts yet: a flow counts once its scenario is validated and has passed.</p>
      )}

      <div className="flex flex-col gap-3">
        {variations.pending.map((g) => (
          <Proposal key={g.scenario_id} group={g} busy={busy === g.scenario_id} onApply={onApply} onDismiss={onDismiss} />
        ))}
      </div>

      {variations.candidates.filter((c) => !c.waiting).length > 0 ? (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-[0.08em] text-muted">Worth more data</p>
          <ul className="flex flex-col divide-y divide-border/60">
            {variations.candidates
              .filter((c) => !c.waiting)
              .slice(0, 6)
              .map((c) => (
                <li key={c.scenario_id} className="flex flex-wrap items-center gap-2 py-1.5" data-growth-candidate={c.scenario_id}>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">
                    {c.name} {c.origin === "yours" ? <span className="text-xs text-muted">(your test)</span> : null}
                  </span>
                  <span className="text-xs text-muted">
                    tries {c.partitions}; missing {c.missing.map((m) => TECHNIQUE_WORDS[m as keyof typeof TECHNIQUE_WORDS]?.toLowerCase() ?? m).join(", ")}
                  </span>
                  <Button size="sm" disabled={busy === c.scenario_id} aria-busy={busy === c.scenario_id} onClick={() => onSuggest(c.scenario_id)} data-growth-suggest={c.scenario_id}>
                    <Sparkles className={busy === c.scenario_id ? "animate-pulse" : undefined} /> {busy === c.scenario_id ? "Writing rows…" : "Suggest rows"}
                  </Button>
                  {busy === c.scenario_id ? (
                    <p className="w-full text-xs text-fg-2" aria-live="polite">
                      <span className={cn(styles.typing, "mr-1.5 inline-block")} aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                      Writing one row per missing partition ({c.missing.map((m) => TECHNIQUE_WORDS[m as keyof typeof TECHNIQUE_WORDS]?.toLowerCase() ?? m).join(", ")}), from the table&apos;s first row.
                    </p>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ) : variations.pending.length === 0 ? (
        <p className="text-sm text-muted">Every scenario with data already tries the partitions Embodent knows, or none has an Examples table yet. Add one row to a scenario&apos;s Examples and Embodent suggests the rest.</p>
      ) : null}
    </section>
  );
}

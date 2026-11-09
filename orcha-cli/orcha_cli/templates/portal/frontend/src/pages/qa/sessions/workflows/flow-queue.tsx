import { ListOrdered, Target, TriangleAlert } from "../../map/kit/icons";
import { CountUp } from "../../map/kit";
import {
  countsLine,
  FLOW_STATUS_LABEL,
  flowOutcomeNote,
  flowPill,
  flowWalked,
  personaName,
  queueCounts,
  queueOrder,
  reasonChips,
  type DraftingFlow,
  type FlowWalk,
  type Persona,
} from "../workflows/workflows";
import { cn } from "../../map/kit";
import { ReasonChip, StatusPill } from "./bits";
import styles from "./workflows.module.css";

const CRIT_LABEL: Record<DraftingFlow["criticality"], string> = { critical: "Critical", high: "High", normal: "Normal", low: "Low" };

/** A ring of the queue's outcomes: passed, failed and unreachable arcs over the flows walked. */
function QueueRing({ flows }: { flows: readonly DraftingFlow[] }) {
  const c = queueCounts(flows);
  const r = 15;
  const len = 2 * Math.PI * r;
  const parts: { n: number; color: string }[] = [
    { n: c.passed, color: "var(--color-success)" },
    { n: c.failed, color: "var(--color-danger)" },
    { n: c.unreachable, color: "var(--color-warning)" },
    { n: c.walking, color: "var(--color-primary)" },
  ];
  let offset = 0;
  return (
    <svg viewBox="0 0 40 40" className="size-10 shrink-0 -rotate-90" aria-hidden>
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--color-border)" strokeWidth="5" />
      {c.total > 0
        ? parts.map((p, i) => {
            if (p.n === 0) return null;
            const seg = (p.n / c.total) * len;
            const el = (
              <circle
                key={i}
                cx="20"
                cy="20"
                r={r}
                fill="none"
                stroke={p.color}
                strokeWidth="5"
                strokeDasharray={`${Math.max(0, seg - 1.2)} ${len}`}
                strokeDashoffset={-offset}
                className="transition-[stroke-dasharray,stroke-dashoffset] duration-700 motion-reduce:transition-none"
              />
            );
            offset += seg;
            return el;
          })
        : null}
    </svg>
  );
}

/**
 * The ranked flow queue: every flow the drafter and the App model put in, in the order
 * the explorer walks them, each with why it is where it is (never walked, critical, changed),
 * who walks it and where it stands. A flow already walked links down to its outcome.
 */
export function FlowQueue({
  flows,
  walks,
  personas,
  live = true,
  className,
}: {
  flows: readonly DraftingFlow[];
  walks: readonly FlowWalk[];
  personas: readonly Persona[];
  /** The exploration still runs: only then is a flow "Walking". */
  live?: boolean;
  className?: string;
}) {
  const ordered = queueOrder(flows);
  const counts = queueCounts(flows);
  const walkOf = new Map(walks.map((w) => [w.id, w]));
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-panel p-4", className)} aria-labelledby="flow-queue-title" data-flow-queue>
      <header className="flex items-center gap-3">
        <QueueRing flows={flows} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 id="flow-queue-title" className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <ListOrdered aria-hidden className="size-3.5 text-muted" />
            The flow queue
          </h3>
          <p className="text-xs text-fg-2" data-queue-counts>
            <CountUp value={countsLine(counts)} />
          </p>
        </div>
      </header>
      <ol className="flex flex-col gap-1" aria-label="Flows in the order they are walked">
        {ordered.map((f, i) => {
          const reasons = reasonChips(f.rank_reasons, { walked: flowWalked(f.status) });
          const persona = personaName(f.persona, personas);
          const walk = f.walk_id ? walkOf.get(f.walk_id) : undefined;
          const finished = walk && (walk.status !== "walking" || !live);
          const pill = flowPill(f, walk, live);
          const walkingNow = pill === "walking";
          const note = flowOutcomeNote(f);
          const NoteIcon = note?.kind === "named" ? Target : TriangleAlert;
          const body = (
            <>
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold tabular",
                  walkingNow ? "border-primary bg-primary text-primary-fg" : "border-border text-fg-2",
                )}
                aria-label={`Rank ${f.rank || i + 1}`}
              >
                {f.rank || i + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 items-start gap-2">
                  <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-5 text-fg">{f.name}</span>
                  <StatusPill status={pill} />
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  {reasons.length ? reasons.map((r) => <ReasonChip key={r.label} {...r} />) : <ReasonChip label={CRIT_LABEL[f.criticality]} tone="plain" />}
                  <span className="ml-0.5 text-[11px] text-muted">
                    {[persona ? `as ${persona}` : null, f.steps.length ? `${f.steps.length} ${f.steps.length === 1 ? "step" : "steps"}` : null].filter(Boolean).join(" · ")}
                  </span>
                  {note ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning" title={note.hint} data-flow-outcome={note.kind}>
                      <NoteIcon aria-hidden className="size-3" strokeWidth={2.25} />
                      {note.label}
                      <span className="sr-only">: {note.hint}</span>
                    </span>
                  ) : null}
                </span>
              </span>
            </>
          );
          const rowCls = cn(
            "relative flex min-w-0 items-start gap-2.5 rounded-lg px-2 py-2",
            styles.queueRow,
            walkingNow && cn("bg-primary/[0.05]", styles.walkingRow),
          );
          return (
            <li key={f.id} style={{ ["--i" as string]: i }} data-queue-flow={f.flow_key} data-queue-status={pill}>
              {finished ? (
                <a href={`#walk-${walk.id}`} className={cn(rowCls, "outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring")} aria-label={`${f.name}: ${FLOW_STATUS_LABEL[pill]}${note ? ` (${note.label.toLowerCase()})` : ""}. Go to its outcome.`}>
                  {body}
                </a>
              ) : (
                <div className={rowCls}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

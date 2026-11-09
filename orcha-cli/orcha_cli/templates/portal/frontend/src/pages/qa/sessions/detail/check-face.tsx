import type { CSSProperties } from "react";
import { CountUp, cn } from "../../map/kit";
import { verdictWord } from "../../qaWords";
import type { QaMeasured, QaVerdict } from "../../qaApi";
import { featureNameFromKey, MEASURED_KIND_LENS, type Lens } from "../explorations";
import { LensChip } from "../lens-chip";
import type { LiveState } from "./model";
import styles from "./detail.module.css";

/** Each scenario the run checked, with its criteria's verdicts in the order given. */
export function checksBy(verdicts: readonly QaVerdict[]): { id: string; name: string; rows: QaVerdict[] }[] {
  const out = new Map<string, QaVerdict[]>();
  for (const v of verdicts) out.set(v.scenario_id, [...(out.get(v.scenario_id) ?? []), v]);
  return [...out.entries()].map(([id, rows]) => ({
    id,
    name: rows.find((v) => v.scenario_name)?.scenario_name || "Scenario",
    rows: [...rows].sort((a, b) => a.criterion_index - b.criterion_index),
  }));
}

/** The measured checks that run for the picked lenses, grouped by lens. */
export function checksFor(lenses: readonly Lens[]): { lens: Lens; kinds: string[] }[] {
  const out: { lens: Lens; kinds: string[] }[] = [];
  for (const lens of lenses) {
    const kinds = Object.entries(MEASURED_KIND_LENS)
      .filter(([, l]) => l === lens)
      .map(([k]) => k);
    if (kinds.length) out.push({ lens, kinds });
  }
  return out;
}

/**
 * Check: the approved scenarios run, one criterion at a time. The counters count up and a scan
 * passes over each verdict in turn; before the first verdict the page says what it is doing.
 */
export function CheckFace({ live, verdicts, measured = [] }: { live: LiveState; verdicts: readonly QaVerdict[]; measured?: readonly QaMeasured[] }) {
  const groups = checksBy(verdicts);
  // The audit's checks, only those that measured something on this run's screens.
  const seen = new Set(measured.map((m) => m.kind));
  const measuring = checksFor(live.exploration.lenses).map((g) => ({ ...g, kinds: g.kinds.filter((k) => seen.has(k)) })).filter((g) => g.kinds.length);
  const passed = verdicts.filter((v) => v.verdict === "pass").length;
  const stats = [
    { label: "Screens to check", value: String(live.frames.length) },
    { label: "Steps taken", value: String(live.steps) },
    { label: "Findings filed", value: String(live.findings.length) },
    { label: "Criteria passed", value: `${passed} / ${verdicts.length}` },
  ];
  return (
    <div className="flex flex-col gap-5" data-face="check">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((s, i) => (
          <div key={s.label} className="v-pop flex flex-col gap-0.5 rounded-lg border border-border bg-panel px-3 py-2.5" style={{ "--i": i } as CSSProperties}>
            <span className="text-xs text-muted">{s.label}</span>
            <span className="text-xl font-semibold tabular text-fg">
              <CountUp value={s.value} delay={i * 90} />
            </span>
          </div>
        ))}
      </div>
      {groups.length ? (
        <section className="flex flex-col gap-3" aria-label="Scenario checks">
          <h3 className="text-sm font-semibold text-fg">Checking every scenario</h3>
          {groups.map((g) => (
            <div key={g.id} className="flex flex-col gap-1.5" data-check-scenario={g.id}>
              <span className="text-sm font-medium text-fg">{g.name}</span>
              <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {g.rows.map((v, i) => (
                  <li key={v.id} className={cn("flex h-8 items-center rounded-md border border-border bg-panel px-2.5 text-sm text-fg-2", styles.scanRow)} style={{ "--i": i } as CSSProperties}>
                    Criterion {v.criterion_index + 1}: {verdictWord(v.verdict)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : measuring.length ? null : (
        <p className="rounded-lg border border-border bg-panel px-3 py-6 text-center text-sm text-muted">No verdicts yet. Checking the approved scenarios.</p>
      )}
      {measuring.length ? (
        <section className="flex flex-col gap-3" aria-label="Measured checks">
          <h3 className="text-sm font-semibold text-fg">Measuring every screen</h3>
          {measuring.map((g) => (
            <div key={g.lens} className="flex flex-col gap-1.5" data-check-lens={g.lens}>
              <span className="w-fit">
                <LensChip lens={g.lens} size="sm" />
              </span>
              <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {g.kinds.map((k, i) => (
                  <li key={k} className={cn("flex h-8 items-center rounded-md border border-border bg-panel px-2.5 text-sm text-fg-2", styles.scanRow)} style={{ "--i": i } as CSSProperties}>
                    {featureNameFromKey(k)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

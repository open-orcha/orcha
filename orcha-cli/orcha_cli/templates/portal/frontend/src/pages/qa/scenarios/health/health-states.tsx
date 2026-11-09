import type { CSSProperties } from "react";
import { CopyX, ScanSearch, ServerCrash } from "../../map/kit/icons";
import { Button } from "../../map/kit";
import { plural } from "../../map/kit";
import styles from "./health.module.css";

const LESSONS = [
  { icon: ScanSearch, text: "Agent tasks and work orders imported as scenarios" },
  { icon: CopyX, text: "Duplicates of another scenario on the same platform" },
  { icon: ServerCrash, text: "Failures that are the environment, not the app" },
];

/** The live view while the audit runs: placeholder rows a light sweeps down, and what it checks. */
export function HealthChecking({ count }: { count: number | null }) {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-8" role="status" aria-live="polite" data-health-checking>
      <p className="text-sm text-fg-2">{count ? `Checking ${plural(count, "scenario")}…` : "Checking your scenarios…"}</p>
      <div className={`${styles.scanBox} flex flex-col gap-2 rounded-lg border border-border bg-panel p-3`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <span className={`${styles.tick} size-3 rounded-full bg-border-strong`} style={{ "--i": i } as CSSProperties} />
            <span className="h-2.5 rounded bg-raised" style={{ width: `${70 - i * 9}%` }} />
          </div>
        ))}
      </div>
      <ul className="flex flex-col gap-1.5 text-sm text-muted">
        {LESSONS.map((l, i) => (
          <li key={l.text} className={`${styles.tick} flex items-center gap-2`} style={{ "--i": i + 2 } as CSSProperties}>
            <l.icon aria-hidden className="size-3.5" strokeWidth={1.75} />
            {l.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Nothing to fix: a ring that draws itself, and what was checked so the calm reads as earned. */
export function HealthHealthy({ total, onMap }: { total: number; onMap: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-14 text-center" data-health-healthy>
      <div className="relative size-20" aria-hidden>
        <span className={`${styles.breathe} absolute inset-0 rounded-full border border-success`} />
        <svg viewBox="0 0 64 64" className="relative size-20 text-success">
          <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="3" />
          <circle className={styles.ring} cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" transform="rotate(-90 32 32)" />
          <path className={styles.check} d="M21 33l7 7 15-16" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 className={`${styles.rise} text-[15px] font-semibold text-fg`}>All scenarios look healthy</h2>
      <p className={`${styles.rise} max-w-[440px] text-base text-fg-2`} style={{ "--i": 2 } as CSSProperties}>
        {total > 0 ? `${plural(total, "scenario")} checked. ` : ""}Every visit looks again for:
      </p>
      <ul className="flex flex-col items-start gap-1.5 text-sm text-muted">
        {LESSONS.map((l, i) => (
          <li key={l.text} className={`${styles.lesson} flex items-center gap-2`} style={{ "--i": i } as CSSProperties}>
            <l.icon aria-hidden className="size-3.5 text-success" strokeWidth={1.75} />
            {l.text}
          </li>
        ))}
      </ul>
      <Button size="sm" variant="ghost" onClick={onMap} className={`${styles.lesson} mt-1`} style={{ "--i": 3 } as CSSProperties}>
        Back to the map
      </Button>
    </div>
  );
}

/** No scenarios at all yet. */
export function HealthNoScenarios({ onMap }: { onMap: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-14 text-center" data-health-no-scenarios>
      <ScanSearch aria-hidden className={`${styles.rise} size-6 text-muted`} strokeWidth={1.75} />
      <h2 className={`${styles.rise} text-[15px] font-semibold text-fg`}>No scenarios to check yet</h2>
      <p className={`${styles.rise} max-w-[420px] text-base text-fg-2`} style={{ "--i": 1 } as CSSProperties}>
        Once the project has scenarios, this page flags agent tasks, duplicates and environment failures before they cost a run.
      </p>
      <Button size="sm" onClick={onMap} className={`${styles.rise} mt-1`} style={{ "--i": 2 } as CSSProperties}>
        Open the map
      </Button>
    </div>
  );
}

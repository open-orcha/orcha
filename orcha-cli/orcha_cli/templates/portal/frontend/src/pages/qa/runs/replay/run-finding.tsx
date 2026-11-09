import { useState, type ReactNode } from "react";
import { SeverityTag, cn } from "../../map/kit";
import { humanizeCheckText, REPRO_PREVIEW_STEPS } from "../lib/humanize-locator";
import { CopyFixPromptButton } from "../parts/copy-fix-prompt";
import { EvidenceThumb } from "../parts/evidence-thumb";
import type { Evidence, Finding, RunLog, TargetKind } from "../types";

export interface RunFindingRow {
  finding: Finding;
  /** Evidence rows referenced by `finding.evidence_seqs`. */
  evidence?: readonly Evidence[];
  /** Repro steps (one-line summaries) from the finding's step range. */
  repro: ReadonlyArray<{ seq: number; text: string }>;
  /** Error-level log lines whose `step_seq` falls in the finding's repro step range: the "why"
   * next to the "what". */
  logs?: readonly RunLog[];
  /** Jump the replay to a step (`steps.seq`). */
  onJumpToStep?: (seq: number) => void;
  className?: string;
  /** The run's target kind and capture size, so evidence thumbnails take its aspect ratio. */
  kind?: TargetKind | null;
  screenW?: number | null;
  screenH?: number | null;
  /** File as task / Dismiss, gated by the caller. */
  actions?: ReactNode;
}

/** Finding card (Linear): a calm panel with a small severity tag, title, expected/actual
 * property rows, repro, evidence and actions. No coloured stripe: colour stays in the tag. */
export function RunFinding({
  finding: f,
  kind,
  screenW,
  screenH,
  evidence = [],
  repro,
  logs = [],
  onJumpToStep,
  className,
  actions,
}: RunFindingRow) {
  const range =
    f.repro_from_step != null || f.repro_to_step != null
      ? f.repro_from_step === f.repro_to_step || f.repro_to_step == null
        ? `step ${f.repro_from_step ?? f.repro_to_step}`
        : `steps ${f.repro_from_step ?? 1}–${f.repro_to_step}`
      : null;
  const [allSteps, setAllSteps] = useState(false);
  const longRepro = repro.length > REPRO_PREVIEW_STEPS + 2;
  const shownRepro = longRepro && !allSteps ? repro.slice(0, REPRO_PREVIEW_STEPS) : repro;

  return (
    <article
      data-finding-card={f.seq}
      className={cn("rounded-lg border border-border bg-panel p-4", className)}
    >
      <header className="mb-1 flex items-start gap-2">
        <SeverityTag severity={f.severity} className="mt-px" />
        <h3 className="min-w-0 flex-1 select-text text-sm font-semibold leading-5 text-fg">
          <span className="font-mono text-xs font-medium text-muted">F{f.seq}</span>
          <span className="text-muted"> · </span>
          {f.title}
        </h3>
      </header>

      {f.note && f.note.trim() !== f.title.trim() ? (
        <p className="mb-3 select-text text-sm text-muted">{humanizeCheckText(f.note)}</p>
      ) : null}

      {f.expected || f.actual ? (
        <dl className="mb-3 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          {f.expected ? (
            <>
              <dt className="text-muted">Expected</dt>
              <dd className="select-text text-fg">{humanizeCheckText(f.expected)}</dd>
            </>
          ) : null}
          {f.actual ? (
            <>
              <dt className="text-muted">Actual</dt>
              <dd className="select-text text-fg">{humanizeCheckText(f.actual)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {logs.length > 0 ? (
        <div className="mb-3" data-finding-logs>
          <div className="mb-1 text-xs text-muted">Logs during this</div>
          <ul className="flex flex-col gap-0.5 rounded-md border border-border bg-panel-2 px-2.5 py-1.5 font-mono text-xs leading-5 text-fg">
            {logs.slice(0, 8).map((l) => (
              <li key={l.seq} className="min-w-0 truncate" title={l.text}>
                {l.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {repro.length > 0 ? (
        <div className="mb-3">
          <div className="mb-1 text-xs text-muted">
            Repro{range ? <span className="font-mono"> · {range}</span> : null}
          </div>
          <ol className="flex select-text flex-col gap-0.5 rounded-md border border-border bg-panel-2 px-2.5 py-1.5 font-mono text-xs leading-5">
            {shownRepro.map((r, i) => (
              <li key={r.seq} className="flex min-w-0 gap-2">
                <span className="w-4 shrink-0 text-right text-muted">{i + 1}.</span>
                {onJumpToStep ? (
                  <button
                    type="button"
                    onClick={() => onJumpToStep(r.seq)}
                    className="min-w-0 truncate text-left text-fg hover:underline"
                    title={`Jump to step ${r.seq}`}
                  >
                    {r.text}
                  </button>
                ) : (
                  <span className="min-w-0 truncate">{r.text}</span>
                )}
              </li>
            ))}
          </ol>
          {longRepro ? (
            <button
              type="button"
              onClick={() => setAllSteps((v) => !v)}
              className="mt-1 text-xs text-fg-2 underline-offset-2 hover:text-fg hover:underline"
              aria-expanded={allSteps}
              data-repro-toggle
            >
              {allSteps ? "Show fewer steps" : `Show all ${repro.length} steps`}
            </button>
          ) : null}
        </div>
      ) : range ? (
        <div className="mb-3 text-xs text-muted">
          Repro <span className="font-mono">· {range}</span>
        </div>
      ) : null}

      {evidence.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {evidence.map((e) => (
            <EvidenceThumb key={e.seq} evidence={e} kind={kind} screenW={screenW} screenH={screenH} />
          ))}
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {actions}
        <div className="flex-1" />
        <CopyFixPromptButton text={f.fix_prompt} logs={logs} variant="default" />
      </footer>
    </article>
  );
}

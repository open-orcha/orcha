import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, ImageOff, Maximize2 } from "../../map/kit/icons";
import { urlFor } from "../frames";
import { Button, Link } from "../../map/kit";
import { Dialog } from "../../map/kit";
import { ImageLightbox } from "../../map/kit";
import type { ResultFinding } from "../explorations";
import type { Finding, TargetKind } from "../explorations";
import { cn } from "../../map/kit";
import { FindingShot } from "./finding-shot";
import { lensLabel } from "./model";
import { FindingButtons, FindingEvents, type FindingActions } from "./finding-actions";
import { FindingSource } from "../../requests/RequestSource";
import { FindingDiagnosis } from "../../triage/TriageActions";
import { findingInputOf } from "./finding-input";
import { CopyFixPromptButton } from "../findings/copy-fix-prompt";
import { FindingScenarioButton } from "../findings/finding-scenario-button";
import { SeverityBadge, SeverityNote, useSeverityControl } from "../findings/finding-severity";
import { runHref } from "../links";

/** One agent finding with what the run knows about it (expected/actual, repro, fix prompt). */
export interface SheetFinding {
  f: ResultFinding;
  run: Finding | null;
  repro: string[];
}

export function findingStep(item: SheetFinding): number | null {
  return item.f.step_seq ?? item.run?.repro_to_step ?? item.run?.repro_from_step ?? null;
}

/**
 * A finding opened in full: a side sheet with the screenshot in its device on the left and
 * everything known about the finding on the right (expected against actual, the steps to
 * reproduce, the page events, the fix prompt, the run step it came from). ← / → (or the footer arrows) walk
 * through the lens's other findings without closing it.
 */
export function FindingSheet({
  items,
  index,
  onIndex,
  onClose,
  kind,
  actions,
}: {
  items: readonly SheetFinding[];
  index: number | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  kind: TargetKind | null;
  actions: FindingActions;
}) {
  const open = index != null && index >= 0 && index < items.length;
  const item = open ? items[index] : null;
  const total = items.length;

  useEffect(() => {
    if (!open || index == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      // The screenshot's lightbox (a centred dialog over the sheet) keeps the arrows to itself.
      if (el?.closest("dialog")?.getAttribute("data-dialog-placement") === "center") return;
      if ((e.key === "ArrowRight" || e.key === "j") && index! < total - 1) {
        e.preventDefault();
        onIndex(index! + 1);
      } else if ((e.key === "ArrowLeft" || e.key === "k") && index! > 0) {
        e.preventDefault();
        onIndex(index! - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, index, total, onIndex]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      placement="side"
      title={
        item ? (
          <span className="flex items-center gap-2 text-sm font-medium text-muted" data-sheet-position>
            Finding {index! + 1} of {total}
            <span aria-hidden>·</span>
            {lensLabel(item.f.lens)}
          </span>
        ) : null
      }
      footer={
        item ? (
          <div className="flex w-full items-center gap-2">
            <span className="hidden text-xs text-muted sm:inline">
              <kbd className="font-mono">←</kbd> <kbd className="font-mono">→</kbd> to move between findings
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="default" disabled={index === 0} onClick={() => onIndex(index! - 1)} data-sheet-prev>
                <ChevronLeft /> Previous
              </Button>
              <Button size="sm" variant="default" disabled={index === total - 1} onClick={() => onIndex(index! + 1)} data-sheet-next>
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        ) : null
      }
    >
      {item ? <SheetBody key={item.f.fingerprint} item={item} kind={kind} actions={actions} /> : null}
    </Dialog>
  );
}

function SheetBody({ item, kind, actions }: { item: SheetFinding; kind: TargetKind | null; actions: FindingActions }) {
  const { f, run, repro } = item;
  // The screenshot full size, in the app's lightbox (never a browser tab on a localhost URL).
  const [zoomed, setZoomed] = useState(false);
  const step = findingStep(item);
  const sev = useSeverityControl(run, f.severity, actions);
  const where = [f.feature, f.screen].filter(Boolean).join(" · ");
  return (
    <div
      className="grid gap-6 pb-2 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] md:gap-8"
      data-finding-sheet={f.fingerprint}
    >
      <div className="md:sticky md:top-0 md:self-start">
        {f.evidence ? (
          <figure className="flex flex-col items-center gap-2 animate-fade-in">
            <button
              type="button"
              onClick={() => setZoomed(true)}
              className="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={`View the evidence for ${f.title} full size`}
              data-finding-shot-open
            >
              <FindingShot path={f.evidence} alt={`Evidence: ${f.title}`} kind={kind} size="hero" />
            </button>
            <button
              type="button"
              onClick={() => setZoomed(true)}
              className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
              data-finding-full-image
            >
              <Maximize2 aria-hidden className="size-3" /> View full size
            </button>
            <ImageLightbox
              open={zoomed}
              onClose={() => setZoomed(false)}
              src={urlFor(f.evidence)}
              alt={`Evidence: ${f.title}`}
              title={f.title}
              description={step != null ? `Captured at step ${step}` : undefined}
            />
          </figure>
        ) : (
          <div className="flex aspect-[402/874] w-full max-w-[240px] flex-col items-center justify-center gap-2 rounded-[28px] border border-dashed border-border text-xs text-muted md:mx-auto">
            <ImageOff aria-hidden className="size-4" strokeWidth={1.5} />
            No screenshot for this finding
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge fields={sev.fields} onOpen={sev.open} />
            {where ? <span className="text-xs text-muted">{where}</span> : null}
          </div>
          <h3 className="select-text text-xl font-semibold leading-7 text-fg text-pretty">{f.title}</h3>
          {run?.note && (run.expected || run.actual) ? <p className="select-text whitespace-pre-wrap text-sm text-fg-2">{run.note}</p> : null}
          <SeverityNote fields={sev.fields} />
          {sev.dialog}
        </header>

        {run?.expected || run?.actual ? (
          <div className="grid gap-2 sm:grid-cols-2" data-sheet-compare>
            <Outcome label="Expected" text={run.expected} tone="expected" />
            <Outcome label="Actual" text={run.actual} tone="actual" />
          </div>
        ) : run?.note ? (
          <p className="select-text whitespace-pre-wrap text-sm text-fg-2">{run.note}</p>
        ) : null}

        {run ? <FindingEvents finding={run.qa} /> : null}

        {repro.length ? (
          <section className="flex flex-col gap-2" data-sheet-repro>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted">Steps to reproduce</h4>
            <ol className="relative flex flex-col gap-0">
              {repro.map((line, i) => (
                <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
                  {i < repro.length - 1 ? (
                    <span aria-hidden className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />
                  ) : null}
                  <span className="z-[1] flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-panel font-mono text-2xs tabular text-muted">
                    {i + 1}
                  </span>
                  <span className="select-text pt-0.5 text-sm leading-5 text-fg-2">{line}</span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {run?.fix_prompt ? (
          <section className="flex flex-col gap-2" data-sheet-fix>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted">Fix prompt</h4>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-panel-2 p-3 font-mono text-xs leading-5 text-fg-2">
              {run.fix_prompt}
            </pre>
          </section>
        ) : null}

        {run ? <FindingDiagnosis finding={run.qa} auth={actions.auth} /> : null}
        <FindingSource sessionId={actions.explorationId} requestId={run?.qa.request_id} />
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-4">
          <CopyFixPromptButton text={run?.fix_prompt ?? null} variant="primary" />
          <FindingScenarioButton input={findingInputOf(f, run, repro, actions.explorationId, actions.platform)} scenarios={actions.scenarios} />
          {run ? <FindingButtons finding={run.qa} actions={actions} /> : null}
          <Link href={runHref(actions.explorationId, step)} className="ml-auto inline-flex items-center gap-0.5 text-sm text-muted hover:text-fg">
            {step != null ? `Open step ${step} in the run` : "Open the run"}
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function Outcome({ label, text, tone }: { label: string; text: string | null; tone: "expected" | "actual" }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-panel p-3" data-sheet-outcome={tone}>
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <span aria-hidden className={cn("size-1.5 rounded-full", tone === "expected" ? "bg-success" : "bg-danger")} />
        {label}
      </span>
      <span className={cn("select-text text-sm leading-5", text ? "text-fg" : "text-muted")}>{text ?? "Not recorded"}</span>
    </div>
  );
}

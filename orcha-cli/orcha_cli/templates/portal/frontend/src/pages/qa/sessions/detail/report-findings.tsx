import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { ArrowUpRight, ChevronRight } from "../../map/kit/icons";
import { Link, SeverityTag } from "../../map/kit";
import type { ExplorationResult, Lens } from "../explorations";
import type { Finding, Severity, TargetKind } from "../explorations";
import { onTablistKeyDown } from "../../map/kit/tablist-keys";
import { cn } from "../../map/kit";
import { defaultLens, findingsByLens, lensForFingerprint, lensLabel, type LensFindings, type MeasuredGroup } from "./model";
import { findingStep, FindingSheet, type SheetFinding } from "./finding-sheet";
import { FindingButtons, FindingEvents, type FindingActions } from "./finding-actions";
import { FindingSource } from "../../requests/RequestSource";
import { FindingDiagnosis } from "../../triage/TriageActions";
import { findingInputOf } from "./finding-input";
import { CopyFixPromptButton } from "../findings/copy-fix-prompt";
import { FindingScenarioButton } from "../findings/finding-scenario-button";
import { SeverityBadge, SeverityNote, useSeverityControl } from "../findings/finding-severity";
import { runHref } from "../links";
import { FindingShot } from "./finding-shot";
import styles from "./detail.module.css";

function AgentFinding({
  item,
  index,
  kind,
  actions,
  onOpen,
}: {
  item: SheetFinding;
  index: number;
  kind: TargetKind | null;
  actions: FindingActions;
  /** Opens the finding in the detail sheet. */
  onOpen: () => void;
}) {
  const { f, run, repro } = item;
  const step = findingStep(item);
  const sev = useSeverityControl(run, f.severity as Severity, actions);
  return (
    <>
      {/* Beside the card, not in it: the card's click opens the sheet. */}
      {sev.dialog}
    <article
      className={cn(
        "group/finding flex cursor-pointer gap-3 rounded-lg border border-border bg-panel p-3 transition-colors hover:border-border-strong",
        kind === "web" && "flex-col sm:flex-row",
        styles.cascade,
      )}
      style={{ "--i": index } as CSSProperties}
      id={`finding-${f.fingerprint}`}
      data-report-finding={f.fingerprint}
      data-finding-source="agent"
      // The whole card opens the sheet; its own controls (buttons, links, the repro toggle) keep
      // their own clicks.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button,summary,details,input,textarea,label,dialog")) return;
        if (window.getSelection()?.toString()) return;
        onOpen();
      }}
    >
      {f.evidence ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open details: ${f.title}`}
          className="shrink-0 self-start rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-finding-thumb
        >
          <FindingShot path={f.evidence} alt={`Evidence: ${f.title}`} kind={kind} size="thumb" />
        </button>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex items-start gap-2">
          <SeverityBadge fields={sev.fields} onOpen={sev.open} className="mt-px" />
          <h4 className="min-w-0 flex-1 text-sm font-semibold leading-5 text-fg">
            <button
              type="button"
              onClick={onOpen}
              className="text-left hover:underline focus-visible:outline-none focus-visible:underline"
              data-finding-open
            >
              {f.title}
            </button>
          </h4>
          <ChevronRight
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-muted opacity-0 transition-opacity group-hover/finding:opacity-100 motion-reduce:transition-none"
          />
        </header>
        <SeverityNote fields={sev.fields} />
        {run?.expected || run?.actual ? (
          <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm max-sm:grid-cols-1 max-sm:[&_dd]:mb-1">
            {run.expected ? (
              <>
                <dt className="text-muted">Expected</dt>
                <dd className="select-text text-fg-2">{run.expected}</dd>
              </>
            ) : null}
            {run.actual ? (
              <>
                <dt className="text-muted">Actual</dt>
                <dd className="select-text text-fg-2">{run.actual}</dd>
              </>
            ) : null}
          </dl>
        ) : run?.note ? (
          <p className="select-text whitespace-pre-wrap text-sm text-muted">{run.note}</p>
        ) : null}
        {repro.length ? (
          <details className="group text-sm" data-finding-repro>
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted hover:text-fg">
              <ChevronRight aria-hidden className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
              Steps to reproduce
            </summary>
            <ol className="mt-1.5 list-decimal select-text pl-8 text-xs leading-5 text-fg-2">
              {repro.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          </details>
        ) : null}
        {run ? <FindingEvents finding={run.qa} /> : null}
        {run ? <FindingDiagnosis finding={run.qa} auth={actions.auth} /> : null}
        <FindingSource sessionId={actions.explorationId} requestId={run?.qa.request_id} />
        <div className="flex flex-wrap items-center gap-1.5">
          <CopyFixPromptButton text={run?.fix_prompt ?? null} variant="default" />
          <FindingScenarioButton input={findingInputOf(f, run, repro, actions.explorationId, actions.platform)} scenarios={actions.scenarios} variant="ghost" />
          {run ? <FindingButtons finding={run.qa} actions={actions} /> : null}
          <Link href={runHref(actions.explorationId, step)} className="ml-auto inline-flex items-center gap-0.5 text-xs text-muted hover:text-fg">
            {step != null ? `Step ${step}` : "Open run"}
            <ArrowUpRight aria-hidden className="size-3" />
          </Link>
        </div>
      </div>
    </article>
    </>
  );
}

/** One measured check collapsed into a row: the check, how often, on how many screens. */
function MeasuredRow({ g, index }: { g: MeasuredGroup; index: number }) {
  return (
    <li className={styles.cascade} style={{ "--i": index } as CSSProperties} data-measured-group={g.label}>
      <details className="group rounded-md">
        <summary className="flex h-9 cursor-pointer list-none items-center gap-2.5 rounded-md px-2.5 text-sm hover:bg-hover">
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          <SeverityTag severity={g.severity} />
          <span className="min-w-0 flex-1 truncate font-medium text-fg">{g.label}</span>
          <span className="shrink-0 text-xs tabular text-muted" data-measured-count>
            {g.count} on {g.screens.length} {g.screens.length === 1 ? "screen" : "screens"}
          </span>
        </summary>
        <ul className="flex flex-col pb-1.5 pl-[34px] pr-2.5">
          {g.screens.map((s) => (
            <li key={s.screen} id={`finding-${s.finding.fingerprint}`} className="flex h-7 items-center gap-2 text-xs" data-measured-screen={s.screen}>
              <span className="min-w-0 flex-1 truncate text-fg-2">{s.screen}</span>
              <span className="tabular text-muted">{s.count}</span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

function LensPanel({
  group,
  runFindings,
  repro,
  kind,
  actions,
}: {
  group: LensFindings;
  runFindings: Map<string, Finding>;
  repro: Record<string, string[]>;
  kind: TargetKind | null;
  actions: FindingActions;
}) {
  const items = useMemo<SheetFinding[]>(
    () =>
      group.agent.map((f) => {
        const run = f.ref_id ? (runFindings.get(f.ref_id) ?? null) : null;
        return { f, run, repro: run ? (repro[run.id] ?? []) : [] };
      }),
    [group.agent, runFindings, repro],
  );
  const [openAt, setOpenAt] = useState<number | null>(null);
  if (group.total === 0) {
    return (
      <p className="rounded-lg border border-border bg-panel px-3 py-6 text-center text-sm text-muted" data-lens-empty>
        Nothing found under {lensLabel(group.lens)}.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {group.agent.length ? (
        <div className="flex flex-col gap-2" data-lens-agent>
          {items.map((item, i) => (
            <AgentFinding
              key={item.f.fingerprint}
              item={item}
              index={i}
              kind={kind}
              actions={actions}
              onOpen={() => setOpenAt(i)}
            />
          ))}
          <FindingSheet
            items={items}
            index={openAt}
            onIndex={setOpenAt}
            onClose={() => setOpenAt(null)}
            kind={kind}
            actions={actions}
          />
        </div>
      ) : null}
      {group.measured.length ? (
        <section className="flex flex-col gap-1.5" data-lens-measured>
          <h4 className="flex items-baseline gap-2 text-xs font-medium text-muted">
            Measured checks
            <span className="tabular">{group.measured.length}</span>
          </h4>
          <ul className="flex flex-col rounded-lg border border-border bg-panel p-1">
            {group.measured.map((g, i) => (
              <MeasuredRow key={g.label} g={g} index={i + group.agent.length} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Findings by lens: a segmented control with one tab per picked lens and its count. Inside a
 * lens the agent's own findings come first, with evidence, repro and actions, then the
 * measured checks collapsed into one row per check (they used to be one huge list).
 */
export function FindingsByLens({
  result,
  lenses,
  runFindings,
  repro,
  kind = null,
  actions,
}: {
  result: ExplorationResult;
  lenses: Lens[];
  runFindings: readonly Finding[];
  repro: Record<string, string[]>;
  /** The exploration's platform: phone screenshots sit in a phone, web pages in a page. */
  kind?: TargetKind | null;
  actions: FindingActions;
}) {
  const groups = useMemo(() => findingsByLens(result, lenses), [result, lenses]);
  const byId = useMemo(() => new Map(runFindings.map((f) => [f.id, f])), [runFindings]);
  // A link to `#finding-<fingerprint>` opens the lens that holds the finding and scrolls
  // to it; a lens the reader picks wins over the link.
  const hashFp = useSyncExternalStore(subscribeHash, readHashFingerprint, () => null);
  const linked = hashFp ? lensForFingerprint(groups, hashFp) : null;
  const [chosen, setPicked] = useState<Lens | null>(null);
  const picked = chosen ?? linked ?? defaultLens(groups);
  useEffect(() => {
    if (!hashFp || !linked) return;
    requestAnimationFrame(() => document.getElementById(`finding-${hashFp}`)?.scrollIntoView({ block: "center" }));
  }, [hashFp, linked]);
  const current = groups.find((g) => g.lens === picked) ?? groups[0];
  if (!current) return null;
  return (
    <div className="flex flex-col gap-3" data-findings-by-lens>
      <div
        role="tablist"
        aria-label="Lens"
        onKeyDown={onTablistKeyDown}
        className="flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-md bg-panel-2 p-0.5 [scrollbar-width:none]"
      >
        {groups.map((g) => {
          const on = g.lens === current.lens;
          return (
            <button
              key={g.lens}
              type="button"
              role="tab"
              id={`lens-tab-${g.lens}`}
              aria-selected={on}
              aria-controls={`lens-panel-${g.lens}`}
              tabIndex={on ? 0 : -1}
              onClick={() => setPicked(g.lens)}
              data-lens-tab={g.lens}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[5px] px-2.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                on ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg",
              )}
            >
              {lensLabel(g.lens)}
              <span className="font-mono text-xs tabular text-muted">{g.total}</span>
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`lens-panel-${current.lens}`}
        aria-labelledby={`lens-tab-${current.lens}`}
        key={current.lens}
        className="v-panel"
        data-lens-panel={current.lens}
      >
        <LensPanel group={current} runFindings={byId} repro={repro} kind={kind} actions={actions} />
      </div>
    </div>
  );
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function readHashFingerprint(): string | null {
  const m = window.location.hash.match(/^#finding-(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

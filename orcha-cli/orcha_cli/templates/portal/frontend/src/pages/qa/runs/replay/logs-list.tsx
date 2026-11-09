import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, Bug, CircleX, Globe, Info, Search, Smartphone, SquareTerminal, TriangleAlert, Zap } from "../../map/kit/icons";
import { isAtBottom } from "../lib/use-now";
import { tailJump, tailOnScroll, tailStart, tailUnseen } from "../theater/theater-model";
import motion from "../theater/theater.module.css";
import { Input } from "../../map/kit";
import { Select } from "../../map/kit";
import { fmtMs } from "../../map/kit";
import type { RunLog, RunLogLevel, RunLogSource } from "../types";
import { RUN_LOG_LEVELS, RUN_LOG_SOURCES } from "../types";
import { cn } from "../../map/kit";
import { MiniChip } from "../parts/mini-chip";
import { detailSuffix, errorCount, filterLogs, initialLogFilters, logTimeMs, orderLogs, type LogFilters } from "./logs-model";

const LEVEL_ICONS: Record<RunLogLevel, ReactNode> = {
  error: <CircleX className="text-danger" />,
  warn: <TriangleAlert className="text-warning" />,
  info: <Info />,
  debug: <Bug />,
};

const SOURCE_ICONS: Record<RunLogSource, ReactNode> = {
  console: <SquareTerminal />,
  network: <Globe />,
  device: <Smartphone />,
  crash: <Zap />,
};

const LEVEL_DOT: Record<RunLogLevel, string> = {
  error: "bg-sev-blocker",
  warn: "bg-sev-major",
  info: "bg-sev-info",
  debug: "bg-muted",
};

/** Errors and warnings read in full colour text; colour itself stays in the level dot. */
const LEVEL_TEXT: Record<RunLogLevel, string> = {
  error: "text-fg",
  warn: "text-fg",
  info: "text-fg-2",
  debug: "text-muted",
};

const INITIAL_VISIBLE = 200;
const VISIBLE_STEP = 400;

export interface LogsListProps {
  logs: readonly RunLog[];
  /** `seq` of the highlighted step (drives which log rows show as "in the selected step"). */
  currentSeq: number | null;
  onSelectLog: (log: RunLog) => void;
  /** Step seq -> its `at_ms`: the time shown for an older row written without one (#171). */
  stepAtMs?: ReadonlyMap<number, number>;
  /** The run is still going: the list becomes a live tail (oldest first, new lines arriving at
   * the foot and scrolled into view until the reader scrolls up). */
  live?: boolean;
  className?: string;
}

/**
 * Devtools-style log console: level dot, monospace message, relative timestamp, source chip.
 * Errors-only by default when any exist, plus source and text filters. Capped rendering with
 * a "show older" affordance — a long run can produce thousands of rows.
 *
 * While the run is live it tails instead (#188): every level, oldest first, new lines fading in
 * at the foot and followed. Scrolling up pauses the follow and counts what arrives since;
 * scrolling back down or "Jump to latest" resumes it.
 */
export function LogsList({ logs, currentSeq, onSelectLog, stepAtMs, live = false, className }: LogsListProps) {
  const [filters, setFilters] = useState<LogFilters>(() => initialLogFilters(logs, live));
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const rows = useRef(new Map<number, HTMLButtonElement>());
  const scroller = useRef<HTMLDivElement>(null);
  // Lines that were there when the list opened do not animate; only the ones that land after.
  const [arrivedAfter] = useState(() => logs.reduce((m, l) => Math.max(m, l.seq), 0));

  const ordered = useMemo(() => orderLogs(logs, live), [logs, live]);
  const filtered = useMemo(() => filterLogs(ordered, filters), [ordered, filters]);
  // A tail keeps the newest rows (at the foot); a console the newest at the top.
  const shown = live ? filtered.slice(Math.max(0, filtered.length - visible)) : filtered.slice(0, visible);
  const errN = useMemo(() => errorCount(logs), [logs]);
  const [tail, setTail] = useState(() => tailStart(filtered.length));
  const unseen = live ? tailUnseen(tail, filtered.length) : 0;

  useEffect(() => {
    if (currentSeq == null) return;
    rows.current.get(currentSeq)?.scrollIntoView({ block: "nearest" });
  }, [currentSeq]);

  // Following: keep the foot in view as lines land. Instant, so the scroll handler never sees a
  // half-way position and mistakes it for the reader scrolling up; the lines themselves fade in.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!live || !tail.following || !el) return;
    el.scrollTop = el.scrollHeight;
  }, [live, tail.following, filtered.length]);

  function onScroll() {
    const el = scroller.current;
    if (!live || !el) return;
    setTail((t) => tailOnScroll(t, isAtBottom(el), filtered.length));
  }

  function jumpToLatest() {
    setTail(tailJump(filtered.length));
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  if (logs.length === 0) return <LogsTeachingEmpty live={live} />;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2.5", className)} data-logs-list>
      <div className="flex flex-wrap items-center gap-2" data-logs-filters>
        <Select
          data-logs-filter="level"
          value={filters.level}
          onChange={(e) => setFilters((f) => ({ ...f, level: e.target.value as RunLogLevel | "" }))}
          wrapperClassName="max-w-[130px]"
          dimension="sm"
          aria-label="Log level"
          menuClassName="min-w-[160px]"
          options={[
            { value: "", label: "All levels" },
            ...RUN_LOG_LEVELS.map((l) => ({
              value: l,
              label: l,
              icon: LEVEL_ICONS[l],
              hint: l === "error" && errN > 0 ? String(errN) : undefined,
            })),
          ]}
        />
        <Select
          data-logs-filter="source"
          value={filters.source}
          onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value as RunLogSource | "" }))}
          wrapperClassName="max-w-[130px]"
          dimension="sm"
          aria-label="Log source"
          options={[
            { value: "", label: "All sources" },
            ...RUN_LOG_SOURCES.map((s) => ({ value: s, label: s, icon: SOURCE_ICONS[s] })),
          ]}
        />
        <span className="relative min-w-[160px] flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted"
          />
          <Input
            data-logs-search
            type="search"
            placeholder="Search log text…"
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            className="h-6 pl-7 text-xs"
          />
        </span>
        {filtered.length !== logs.length ? (
          <span className="text-xs text-muted" data-logs-filtered-count>
            {filtered.length} of {logs.length}
          </span>
        ) : null}
        {live ? (
          <span
            className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted"
            data-logs-tail={tail.following ? "following" : "paused"}
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", tail.following ? "v-live" : "bg-muted")} />
            {tail.following ? "Live tail" : "Paused"}
          </span>
        ) : null}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          role="list"
          data-logs-rows
          onScroll={onScroll}
          aria-live={live ? "polite" : undefined}
          aria-relevant={live ? "additions" : undefined}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {live && filtered.length > shown.length ? (
            <ShowOlder count={filtered.length - shown.length} onClick={() => setVisible((v) => v + VISIBLE_STEP)} />
          ) : null}
          {shown.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No logs match these filters.</p>
          ) : (
            shown.map((l) => {
              const current = l.step_seq != null && l.step_seq === currentSeq;
              return (
                <button
                  key={l.seq}
                  type="button"
                  role="listitem"
                  ref={(el) => {
                    if (el && l.step_seq != null) rows.current.set(l.step_seq, el);
                  }}
                  onClick={() => onSelectLog(l)}
                  data-log-row
                  data-seq={l.seq}
                  data-level={l.level}
                  title={l.text}
                  className={cn(
                    "grid w-full grid-cols-[8px_44px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover",
                    current && "bg-selected hover:bg-selected",
                    l.seq > arrivedAfter && motion.lineIn,
                  )}
                >
                  <i
                    aria-hidden
                    className={cn("mt-[7px] inline-block size-1.5 shrink-0 rounded-full", LEVEL_DOT[l.level])}
                  />
                  <span className="font-mono text-xs leading-5 tabular text-muted" data-log-at>
                    {(() => {
                      const ms = logTimeMs(l, stepAtMs);
                      return ms == null ? "–" : fmtMs(ms);
                    })()}
                  </span>
                  <span className={cn("min-w-0 select-text truncate font-mono text-xs leading-5", LEVEL_TEXT[l.level])}>
                    {l.text}
                    {detailSuffix(l)}
                  </span>
                  <span className="justify-self-end">
                    <MiniChip data-chip>{l.source}</MiniChip>
                  </span>
                </button>
              );
            })
          )}
          {!live && filtered.length > shown.length ? (
            <ShowOlder count={filtered.length - shown.length} onClick={() => setVisible((v) => v + VISIBLE_STEP)} />
          ) : null}
        </div>
        {live && !tail.following ? (
          <button
            type="button"
            onClick={jumpToLatest}
            data-logs-jump
            className={cn(
              "absolute bottom-2 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-panel px-3 text-xs font-medium text-fg shadow-sm transition-colors hover:bg-hover",
              motion.fadeIn,
            )}
          >
            <ArrowDown aria-hidden className="size-3.5" />
            {unseen > 0 ? `Jump to latest · ${unseen} new` : "Jump to latest"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ShowOlder({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      data-logs-show-older
      onClick={onClick}
      className="mx-2 my-2 h-7 shrink-0 rounded-md border border-border text-xs text-muted transition-colors hover:bg-hover hover:text-fg"
    >
      Show older ({count} more)
    </button>
  );
}

/** What the teaching empty state shows arriving: one line per kind of log, each tied to a step. */
const SAMPLE_LINES: { source: RunLogSource; level: RunLogLevel; text: string; step: number }[] = [
  { source: "console", level: "info", text: "App launched", step: 1 },
  { source: "network", level: "warn", text: "GET /api/cart 504", step: 4 },
  { source: "crash", level: "error", text: "TypeError: total is undefined", step: 7 },
];

/**
 * The Logs tab with nothing in it: it teaches what lands here. Three sample lines rise in (a
 * console line, a failed request, a crash), each with the step it belongs to, then the sentence
 * that says so. Under reduced motion the illustration is simply there.
 */
function LogsTeachingEmpty({ live }: { live: boolean }) {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-5 px-6 py-10 text-center" data-logs-empty={live ? "live" : "none"}>
      <div aria-hidden className="flex w-full max-w-[360px] flex-col gap-1.5">
        {SAMPLE_LINES.map((l, i) => (
          <div
            key={l.source}
            className="v-pop flex items-center gap-2 rounded-md border border-border bg-panel px-2.5 py-1.5 text-left text-xs shadow-[var(--shadow-md)] [&_svg]:size-3 [&_svg]:shrink-0"
            style={{ "--d": `${i * 180}ms`, opacity: live ? 0.55 : undefined } as CSSProperties}
          >
            <span className="text-muted">{LEVEL_ICONS[l.level]}</span>
            <span className="text-muted">{SOURCE_ICONS[l.source]}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-fg-2">{l.text}</span>
            <span className="v-fade shrink-0 rounded border border-border px-1 text-[10px] text-muted tabular" style={{ "--d": `${i * 180 + 220}ms` } as CSSProperties}>
              step {l.step}
            </span>
          </div>
        ))}
      </div>
      <div className="flex max-w-[420px] flex-col gap-1.5">
        <h2 className="v-rise flex items-center justify-center gap-2 text-[14px] font-semibold text-fg" style={{ "--d": "560ms" } as CSSProperties}>
          {live ? <span aria-hidden className="v-live size-1.5" /> : null}
          {live ? "Waiting for the first log line" : "No runtime logs captured for this run"}
        </h2>
        <p className="v-rise text-base text-fg-2" style={{ "--d": "620ms" } as CSSProperties}>
          Console messages, failed requests, device logs and crashes land here, each tied to the step it happened at. Click one to jump the
          replay there.
        </p>
      </div>
    </div>
  );
}

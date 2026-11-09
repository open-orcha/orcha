import { useMemo, useState, type CSSProperties } from "react";
import { Archive, Columns2, History, Search, X } from "../../map/kit/icons";
import { Button, buttonVariants, Link, pillClass } from "../../map/kit";
import {
  filterExplorations,
  noDevice,
  hasActiveFilters,
  isLive,
  seriesPlaces,
  SCOPE_TIERS,
  LENS_META,
  type Exploration,
  type ExplorationScope,
  type HistoryFilters,
  type Lens,
  type StatusFilter,
} from "../explorations";
import { cn } from "../../map/kit";
import { LENS_ICON } from "../lens-chip";
import { RECIPE_ICON, recipeLabel } from "../recipe-meta";
import { ExplorationCard } from "./exploration-card";
import { compareHref } from "../links";
import { dayGroups, type ExplorationRoute } from "./home-model";
import styles from "./explore.module.css";

const NO_NAMES: Readonly<Record<string, string>> = {};

const STATUS_PILLS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Stopped or failed" },
];

const EMPTY_FILTERS: HistoryFilters = { q: "", recipe: "", lens: "", status: "all", archived: "hide" };

const NODE: Record<Exploration["status"], string> = {
  done: "border-success/45 text-success",
  cancelled: "border-border-strong text-muted",
  failed: "border-danger/45 text-danger",
  queued: "border-progress/60 text-progress",
  studying: "border-progress/60 text-progress",
  exploring: "border-progress/60 text-progress",
  checking: "border-progress/60 text-progress",
};

function statusOf(e: Exploration): StatusFilter {
  if (isLive(e.status)) return "running";
  if (e.status === "done") return "done";
  return "failed";
}

/**
 * The Explore tab's history as a timeline of expeditions, grouped by day: compact pill filters
 * (status, and kind or lens when there is more than one), a search and the cards on a rail.
 */
export function ExplorationHistory({
  explorations,
  routes = {},
  kind,
  onKind,
  actor,
  canAct,
}: {
  explorations: Exploration[];
  /** Each exploration's route, by id (its screenshots in order). */
  routes?: Readonly<Record<string, ExplorationRoute>>;
  /** The kind picked (`?kind=`). */
  kind: ExplorationScope | null;
  onKind: (kind: ExplorationScope | null) => void;
  /** The person acting, when one is. */
  actor: string | null;
  canAct: boolean;
}) {
  const [own, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const filters = useMemo<HistoryFilters>(() => ({ ...own, recipe: kind ?? "" }), [own, kind]);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const places = useMemo(() => seriesPlaces(explorations), [explorations]);

  const shown = useMemo(() => filterExplorations(explorations, filters), [explorations, filters]);
  const groups = useMemo(() => {
    const pinned = shown.filter((e) => e.pinned_at);
    const days = dayGroups(shown.filter((e) => !e.pinned_at), now);
    return pinned.length ? [{ key: "pinned", label: "Pinned", rows: pinned }, ...days] : days;
  }, [shown, now]);
  const current = useMemo(() => explorations.filter((e) => !e.archived_at), [explorations]);
  const running = current.filter((e) => isLive(e.status)).length;
  const archivedCount = explorations.length - current.length;
  const pickedRows = picked.map((id) => explorations.find((e) => e.id === id)).filter((e): e is Exploration => Boolean(e));
  const set = (patch: Partial<HistoryFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const statusCount = (v: StatusFilter) => (v === "all" ? current.filter((e) => !noDevice(e)).length : current.filter((e) => !noDevice(e) && statusOf(e) === v).length);
  const recipes = useMemo(() => {
    const n = new Map<ExplorationScope | "custom", number>();
    for (const e of current) n.set(e.recipe ?? "custom", (n.get(e.recipe ?? "custom") ?? 0) + 1);
    const order: (ExplorationScope | "custom")[] = [...SCOPE_TIERS.map((t) => t.key), "custom"];
    return order.filter((k) => n.has(k)).map((k) => ({ key: k, count: n.get(k) as number }));
  }, [current]);
  const lenses = useMemo(() => {
    const n = new Map<Lens, number>();
    for (const e of current) for (const l of e.lenses) n.set(l, (n.get(l) ?? 0) + 1);
    return LENS_META.filter((m) => n.has(m.key)).map((m) => ({ key: m.key, label: m.label, count: n.get(m.key) as number }));
  }, [current]);

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? p : [...p, id]));
  }

  const position = new Map(shown.map((e, i) => [e.id, i]));

  return (
    <section className="flex flex-col gap-3" aria-labelledby="history-title" data-exploration-history>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="history-title" className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            <History aria-hidden className="size-4 text-muted" strokeWidth={1.75} />
            History
            <span className="text-xs font-normal tabular text-muted">{current.length}</span>
            {running > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-normal text-progress" role="status">
                <span className="v-live size-1.5" aria-hidden />
                {running} running
              </span>
            ) : null}
          </h2>
          <p className="text-sm text-fg-2">Every expedition, newest first. Unfold one to see the route it took; pick two to compare.</p>
        </div>
        <div className="relative w-[240px] max-sm:w-full">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <label htmlFor="history-search" className="sr-only">
            Search explorations
          </label>
          <input
            id="history-search"
            type="search"
            placeholder="Search names, goals, notes"
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            className="h-7 w-full rounded-full border border-border bg-control pl-8 pr-3 text-sm text-fg outline-none transition-colors placeholder:text-muted hover:border-border-strong focus:border-primary focus-visible:ring-2 focus-visible:ring-ring/30"
            data-history-search
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" role="search" aria-label="Filter explorations" data-history-filters>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Status" data-history-status>
          {STATUS_PILLS.filter((p) => p.value === "all" || statusCount(p.value) > 0 || filters.status === p.value).map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={(filters.status ?? "all") === p.value}
              onClick={() => set({ status: p.value })}
              className={pillClass((filters.status ?? "all") === p.value, "h-6 px-2.5 text-sm")}
            >
              {p.value === "running" ? <span aria-hidden className="v-live size-1.5 text-progress" /> : null}
              {p.label} <span className="tabular text-muted">{statusCount(p.value)}</span>
            </button>
          ))}
        </div>
        {recipes.length > 1 ? (
          <>
            <span aria-hidden className="h-4 w-px bg-border" />
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Recipe" data-history-recipe>
              {recipes.map((r) => {
                const Icon = RECIPE_ICON[r.key];
                const on = filters.recipe === r.key;
                return (
                  <button key={r.key} type="button" aria-pressed={on} onClick={() => onKind(on ? null : (r.key as ExplorationScope))} className={pillClass(on, "h-6 px-2.5 text-sm")}>
                    <Icon aria-hidden strokeWidth={2} />
                    {r.key === "custom" ? "Custom" : recipeLabel(r.key)} <span className="tabular text-muted">{r.count}</span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
        {lenses.length > 1 ? (
          <>
            <span aria-hidden className="h-4 w-px bg-border" />
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Lens" data-history-lens>
              {lenses.map((l) => {
                const Icon = LENS_ICON[l.key];
                const on = filters.lens === l.key;
                return (
                  <button key={l.key} type="button" aria-pressed={on} onClick={() => set({ lens: on ? "" : l.key })} className={pillClass(on, "h-6 px-2.5 text-sm")}>
                    <Icon aria-hidden strokeWidth={2} />
                    {l.label} <span className="tabular text-muted">{l.count}</span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
        {archivedCount > 0 || filters.archived !== "hide" ? (
          <button
            type="button"
            className={pillClass(filters.archived === "only", "h-6 px-2.5 text-sm")}
            aria-pressed={filters.archived === "only"}
            onClick={() => set({ archived: filters.archived === "only" ? "hide" : "only" })}
            data-history-archived
          >
            <Archive aria-hidden strokeWidth={2} />
            Archived {archivedCount > 0 ? <span className="tabular text-muted">{archivedCount}</span> : null}
          </button>
        ) : null}
        {hasActiveFilters(filters) ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              onKind(null);
            }}
          >
            <X /> Clear
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted" data-history-none>
          {filters.archived === "only" ? "Nothing archived." : "No exploration matches these filters."}
        </p>
      ) : (
        <ol className="flex flex-col gap-5" aria-label="Explorations">
          {groups.map((g) => (
            <li key={g.key} className="flex flex-col gap-2" data-history-day={g.key}>
              <h3 className="flex items-baseline gap-2 pl-9 text-xs font-medium text-fg-2" suppressHydrationWarning>
                {g.label}
                <span className="tabular text-muted">{g.rows.length}</span>
              </h3>
              <ul className="relative flex flex-col gap-2.5 pl-9">
                <span aria-hidden className={cn("absolute bottom-4 left-[13px] top-4 w-px bg-gradient-to-b from-border-strong via-border to-transparent", styles.rail)} />
                {g.rows.map((e) => {
                  const i = position.get(e.id) ?? 0;
                  const Icon = RECIPE_ICON[e.recipe ?? "custom"];
                  return (
                    <li key={e.id} className="v-rise relative min-w-0" style={{ "--i": Math.min(i, 10) } as CSSProperties} id={`exploration-${e.id}`}>
                      <span
                        aria-hidden
                        className={cn(
                          "absolute -left-9 top-3.5 flex size-[27px] items-center justify-center rounded-full border-2 bg-panel shadow-[0_0_0_4px_var(--color-bg)]",
                          NODE[e.status],
                          styles.node,
                        )}
                        style={{ "--i": Math.min(i, 10) } as CSSProperties}
                      >
                        <Icon className="size-3.5" strokeWidth={2} />
                        {isLive(e.status) ? <span className="v-live absolute -right-0.5 -top-0.5 size-2 text-progress" /> : null}
                      </span>
                      <ExplorationCard
                        exploration={e}
                        place={places.get(e.id)}
                        names={NO_NAMES}
                        route={routes[e.id]}
                        selected={picked.includes(e.id)}
                        selectDisabled={picked.length >= 2}
                        picking={picked.length > 0}
                        onToggleSelect={() => toggle(e.id)}
                        onError={setError}
                        actor={actor}
                        canAct={canAct}
                      />
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {picked.length > 0 ? (
        <div
          className="v-pop sticky bottom-3 z-20 mx-auto flex w-full max-w-[640px] items-center gap-3 rounded-xl border border-border-strong bg-raised/95 px-3 py-2 shadow-[var(--shadow-md)] backdrop-blur"
          role="region"
          aria-label="Compare"
          data-compare-bar
        >
          <Columns2 aria-hidden className="size-4 shrink-0 text-muted" />
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            {pickedRows.map((row, i) => {
              const Icon = RECIPE_ICON[row.recipe ?? "custom"];
              return (
                <span key={row.id} className="contents">
                  {i > 0 ? <span className="shrink-0 text-xs font-medium text-muted">vs</span> : null}
                  <span className="v-pop inline-flex min-w-0 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/[0.07] px-2 py-0.5 text-fg">
                    <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-fg">{i === 0 ? "A" : "B"}</span>
                    <Icon aria-hidden className="size-3 shrink-0 text-muted" strokeWidth={2} />
                    <span className="min-w-0 truncate">{row.name}</span>
                  </span>
                </span>
              );
            })}
            {pickedRows.length === 1 ? <span className="min-w-0 truncate text-muted">Pick one more to compare.</span> : null}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setPicked([])}>
            Clear
          </Button>
          {pickedRows.length === 2 ? (
            <Link href={compareHref(pickedRows[0].id, pickedRows[1].id)} className={cn(buttonVariants({ variant: "primary", size: "sm" }))} data-compare-go>
              Compare
            </Link>
          ) : (
            <span className={cn(buttonVariants({ variant: "primary", size: "sm" }), "pointer-events-none opacity-50")} aria-disabled>
              Compare
            </span>
          )}
        </div>
      ) : null}
    </section>
  );
}

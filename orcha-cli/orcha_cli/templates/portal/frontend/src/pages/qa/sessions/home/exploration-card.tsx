import { Link } from "../../map/kit";
import { useRouter } from "../../map/kit";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, Bug, Check, ChevronDown, Columns2, Copy, ExternalLink, Layers, Pencil, Pin, PinOff, RotateCw, Target, Timer } from "../../map/kit/icons";
import { severityDot } from "../../map/kit";
import { PlatformIcon } from "../../map/kit";
import { StatusGlyph } from "../../map/kit";
import { featureNameFromKey } from "../explorations";
import { isLive, NAME_MAX, NO_DEVICE_LABEL, noDevice, statusWord, type SeriesPlace } from "../explorations";
import { displayVerdict, type Exploration, type ResultSeverity } from "../explorations";
import { PLATFORM_LABELS as PLATFORM_NAMES } from "../../map/kit";
import type { TargetKind } from "../explorations";
import { cn } from "../../map/kit";
import { errText } from "../../parts";
import { duplicateSession, keepSession, runSessionAgain } from "../api";
import { compareHref, explorationHref, runHref } from "../links";
import { LensChips } from "../lens-chip";
import { RecipeMeta } from "../recipe-meta";
import { ScoreRing } from "../score-ring";
import { PhaseBar, Sparkline } from "./bits";
import { CardMenu, type MenuItem } from "./card-menu";
import { clock, formatSeconds, measuredWords, ranSeconds, routeSize, SEVERITY_ORDER, timeOfDay, type ExplorationRoute } from "./home-model";
import { LiveScreen, useElapsed, useLatestFrame } from "./live-expedition";
import { RouteStrip, ScreenFan } from "./route-strip";
import styles from "./explore.module.css";

/** "Stopped by you" for the user's own stop, else the stop's own words. */
function stopLine(error: string | null): string {
  if (!error || /stopped by the user/i.test(error)) return "Stopped by you";
  return `Stopped: ${error.split("\n")[0]}`;
}

/** A failure's first line: the rest is usually a log. */
function firstLine(error: string | null): string | null {
  const line = error?.split("\n").find((l) => l.trim())?.trim();
  return line ? line.slice(0, 200) : null;
}

function severityCounts(e: Exploration): [ResultSeverity, number][] {
  const n = new Map<ResultSeverity, number>();
  for (const f of e.result?.findings ?? []) if (f.source === "agent") n.set(f.severity, (n.get(f.severity) ?? 0) + 1);
  return SEVERITY_ORDER.filter((s) => n.get(s)).map((s): [ResultSeverity, number] => [s, n.get(s) as number]);
}

/**
 * One exploration in the history, as an expedition: its recipe, lenses, platform, time and how
 * long it ran; what it came back with (issues, screens reached, missions, the score and its
 * change since the previous one of its series) or how it ended (stopped by you reads as a stop,
 * not a failure); a fan of the screens it reached that unfolds into its whole route; live
 * progress while it runs. The pick circle chooses it for Compare; the menu opens, renames, runs
 * again, duplicates, compares with the previous one or archives.
 */
export function ExplorationCard({
  exploration: e,
  place,
  names,
  route,
  selected,
  selectDisabled,
  picking = false,
  onToggleSelect,
  onError,
  actor,
  canAct,
}: {
  exploration: Exploration;
  place: SeriesPlace | undefined;
  names: Readonly<Record<string, string>>;
  /** Its screens in order, when its run took screenshots. */
  route?: ExplorationRoute;
  selected: boolean;
  selectDisabled: boolean;
  /** Something is picked for Compare: every card shows its pick circle. */
  picking?: boolean;
  onToggleSelect: () => void;
  onError: (message: string) => void;
  /** The person acting, when one is: renaming, repeating and archiving are theirs. */
  actor: string | null;
  canAct: boolean;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  // The name typed in a rename, shown at once while the save goes through; the row's own name
  // otherwise (a live refresh brings the explorer's suggestion).
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? e.name;
  const [draft, setDraft] = useState(e.name);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const routeId = useId();
  const live = isLive(e.status);
  // A run going on opens on its live page, with the device.
  const openHref = live ? runHref(e.id) : explorationHref(e.id);
  const archived = e.archived_at != null;
  const pinned = e.pinned_at != null;
  const comparable = place?.previousScored && e.result ? place.previousScored : null;
  const latest = useLatestFrame(e, route);
  const elapsed = useElapsed(e.started_at ?? e.created_at, live);
  const hasRoute = Boolean(route && route.frames.length >= 2);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  async function saveName(ev?: FormEvent) {
    ev?.preventDefault();
    const next = draft.trim().replace(/\s+/g, " ");
    setRenaming(false);
    if (!next || next === name) return;
    setTyped(next);
    try {
      await keepSession(e.id, actor, { name: next });
    } catch (err) {
      setTyped(null);
      onError(errText(err) || "Could not rename it.");
      return;
    }
    router.refresh();
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  const items: MenuItem[] = [
    { key: "open", label: "Open", icon: <ExternalLink />, onSelect: () => router.push(openHref) },
    {
      key: "rename",
      label: "Rename",
      icon: <Pencil />,
      disabled: !canAct,
      onSelect: () => {
        setDraft(name);
        setRenaming(true);
      },
    },
    {
      key: "again",
      label: "Run again",
      icon: <RotateCw />,
      disabled: busy || !canAct,
      onSelect: () =>
        act(async () => {
          try {
            const next = await runSessionAgain(e.id, actor);
            router.push(explorationHref(next.id));
          } catch (err) {
            onError(errText(err) || "Could not run it again.");
          }
        }),
    },
    {
      key: "duplicate",
      label: "Duplicate",
      icon: <Copy />,
      disabled: busy || !canAct,
      onSelect: () =>
        act(async () => {
          try {
            const next = await duplicateSession(e.id, actor);
            router.push(explorationHref(next.id));
          } catch (err) {
            onError(errText(err) || "Could not duplicate it.");
          }
        }),
    },
    {
      key: "compare-previous",
      label: "Compare with previous",
      icon: <Columns2 />,
      disabled: !comparable,
      onSelect: () => comparable && router.push(compareHref(comparable.id, e.id)),
    },
    {
      key: "pin",
      label: pinned ? "Unpin" : "Pin",
      icon: pinned ? <PinOff /> : <Pin />,
      disabled: busy || !canAct,
      onSelect: () =>
        act(async () => {
          try {
            await keepSession(e.id, actor, { pinned: !pinned });
            router.refresh();
          } catch (err) {
            onError(errText(err) || "Could not change it.");
          }
        }),
    },
    {
      key: "archive",
      label: archived ? "Unarchive" : "Archive",
      icon: archived ? <ArchiveRestore /> : <Archive />,
      disabled: busy || live || !canAct,
      onSelect: () =>
        act(async () => {
          try {
            await keepSession(e.id, actor, { archived: !archived });
            router.refresh();
          } catch (err) {
            onError(errText(err) || "Could not change it.");
          }
        }),
    },
  ];

  const targetNames = e.targets.map((k) => names[k] ?? featureNameFromKey(k));
  const platform = e.platform && e.platform in PLATFORM_NAMES ? (e.platform as TargetKind) : null;
  const delta = place?.delta ?? null;
  const checkboxId = `pick-${e.id}`;
  const ran = live ? null : ranSeconds(e);
  const sev = severityCounts(e);
  const measured = (e.result?.findings ?? []).filter((f) => f.source !== "agent").length;
  const screens = e.result?.screens ?? route?.screens ?? null;

  return (
    <article
      className={cn(
        "group/card relative flex flex-col rounded-xl border bg-panel p-3.5 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-border-strong motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        selected ? "border-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_18%,transparent)]" : "border-border",
        live && !selected && "border-progress/45 bg-[linear-gradient(100deg,color-mix(in_srgb,var(--color-fg)_6%,var(--color-panel)),var(--color-panel)_55%)]",
        archived && "opacity-70",
        "cursor-pointer",
        styles.card,
      )}
      // The whole row opens the run. The title stays the link for the keyboard; its own controls keep their clicks.
      onClick={(ev) => {
        const inControl = (ev.target as HTMLElement).closest("a, button, input, label, form, [role='menu']");
        if (!inControl && !window.getSelection()?.toString()) router.push(openHref);
      }}
      aria-labelledby={`name-${e.id}`}
      data-exploration-card={e.id}
      data-status={e.status}
    >
      <div className="flex items-start gap-3">
        <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center">
          <input
            id={checkboxId}
            type="checkbox"
            checked={selected}
            disabled={selectDisabled && !selected}
            onChange={onToggleSelect}
            className={cn(
              "peer size-4 cursor-pointer appearance-none rounded-full border border-border-strong bg-control transition-[opacity,background-color,border-color] checked:border-primary checked:bg-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30 max-sm:opacity-100",
              picking || selected ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
            )}
            aria-label={`Pick ${name} to compare`}
            title="Pick to compare"
            data-compare-pick
          />
          <Check aria-hidden className="pointer-events-none absolute size-2.5 text-primary-fg opacity-0 peer-checked:opacity-100" strokeWidth={3} />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {renaming ? (
            <form onSubmit={saveName} className="flex items-center gap-1.5">
              <label htmlFor={`rename-${e.id}`} className="sr-only">
                Exploration name
              </label>
              <input
                ref={input}
                id={`rename-${e.id}`}
                value={draft}
                maxLength={NAME_MAX}
                onChange={(ev) => setDraft(ev.target.value)}
                onBlur={() => saveName()}
                onKeyDown={(ev) => {
                  if (ev.key === "Escape") {
                    ev.preventDefault();
                    setRenaming(false);
                  }
                }}
                className="h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-control px-2 text-base font-medium text-fg outline-none focus:border-primary"
                data-rename-input
              />
            </form>
          ) : (
            <div className="group flex min-w-0 items-center gap-1">
              <Link
                id={`name-${e.id}`}
                href={openHref}
                className="min-w-0 truncate text-[14px] font-semibold text-fg hover:underline hover:underline-offset-2"
                data-exploration-name
              >
                {name}
              </Link>
              {pinned ? <Pin aria-label="Pinned" className="size-3 shrink-0 text-muted" strokeWidth={2} data-pinned /> : null}
              <button
                type="button"
                onClick={() => {
                  setDraft(name);
                  setRenaming(true);
                }}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                aria-label={`Rename ${name}`}
                disabled={!canAct}
                data-rename
              >
                <Pencil className="size-3" />
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
            <RecipeMeta recipe={e.recipe} minutes={e.minutes} size="sm" />
            {targetNames.length > 0 ? (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <Target aria-hidden className="size-3 shrink-0" strokeWidth={2} />
                {targetNames.slice(0, 3).join(", ")}
              </span>
            ) : null}
            {platform ? (
              <span className="inline-flex items-center gap-1">
                <PlatformIcon kind={platform} className="size-3" />
                {PLATFORM_NAMES[platform]}
              </span>
            ) : null}
            <time dateTime={e.created_at} className="tabular">
              {timeOfDay(e.created_at)}
            </time>
            {ran != null ? (
              <span className="inline-flex items-center gap-1 tabular" title="How long it ran">
                <Timer aria-hidden className="size-3" strokeWidth={2} />
                {formatSeconds(ran)}
              </span>
            ) : null}
            {archived ? <span>Archived</span> : null}
            <LensChips lenses={e.lenses} max={4} />
          </div>

          {e.goal ? (
            <p className="line-clamp-1 text-sm text-fg-2" title={e.goal}>
              &ldquo;{e.goal}&rdquo;
            </p>
          ) : null}

          {live ? (
            <div className="flex max-w-[560px] flex-col gap-1.5 pt-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-progress" role="status" data-live-pill>
                  <span className="v-live size-1.5" aria-hidden />
                  {statusWord(e)}
                  {e.status === "queued" ? <span className="font-normal text-muted">· waiting for an agent</span> : null}
                </span>
                {elapsed != null ? (
                  <time className="font-mono text-xs tabular text-fg-2" suppressHydrationWarning>
                    {clock(elapsed)}
                  </time>
                ) : null}
                {latest ? <span className="text-xs text-muted">· step {latest.seq}</span> : null}
              </div>
              <PhaseBar status={e.status} />
            </div>
          ) : e.status === "done" ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-px font-medium text-success">
                  <StatusGlyph status="pass" decorative className="size-3" /> Done
                </span>
                <span className="min-w-0 max-w-full truncate pr-1 text-sm text-fg-2" data-verdict>
                  {(e.result ? displayVerdict(e.result) : null) ?? (e.report_id ? "Report from before scores. Open it to read it." : "Finished.")}
                </span>
                {sev.length > 0 ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-px text-fg-2">
                    <Bug aria-hidden className="size-3 text-muted" strokeWidth={2} />
                    {sev.map(([s, n]) => (
                      <span key={s} className="inline-flex items-center gap-1">
                        <span aria-hidden className={cn("size-1.5 rounded-full", severityDot[s])} />
                        {n} {s}
                      </span>
                    ))}
                  </span>
                ) : e.result ? (
                  <span className="rounded-full border border-border px-2 py-px text-fg-2">No issues</span>
                ) : null}
                {measured > 0 ? (
                  <span className="rounded-full border border-border px-2 py-px text-muted" title="Automatic checks such as contrast and tap size, not bugs an agent reported" data-measured-count={measured}>
                    {measuredWords(measured)}
                  </span>
                ) : null}
                {screens ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-px text-fg-2">
                    <Layers aria-hidden className="size-3 text-muted" strokeWidth={2} />
                    {screens} {screens === 1 ? "screen" : "screens"}
                  </span>
                ) : null}
                {delta != null && delta !== 0 ? (
                  <span className={cn("tabular", delta > 0 ? "text-success" : "text-danger")} data-delta>
                    {delta > 0 ? "+" : ""}
                    {delta} vs previous
                  </span>
                ) : null}
                {place && place.trend.length >= 3 ? <Sparkline values={place.trend} /> : null}
              </div>
            </div>
          ) : e.status === "cancelled" ? (
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-fg-2" data-ended="cancelled">
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-panel-2 px-2 py-px text-xs font-medium text-fg-2">
                <StatusGlyph status="cancelled" decorative className="size-3" />
                {stopLine(e.error)}
              </span>
              {ran != null ? <span className="text-xs text-muted">after {formatSeconds(ran)}</span> : null}
              {route && route.captured > 0 ? (
                <span className="text-xs text-muted">· {route.screens != null ? `reached ${routeSize(route)}` : `took ${routeSize(route)}`} first</span>
              ) : (
                <span className="text-xs text-muted">· before it reached a screen</span>
              )}
            </p>
          ) : noDevice(e) ? (
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-2" data-ended="no-device">
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-panel-2 px-2 py-px text-xs font-medium text-fg-2">
                <StatusGlyph status="cancelled" decorative className="size-3" />
                {NO_DEVICE_LABEL}
              </span>
              <span className="min-w-0 truncate text-xs text-muted" title={e.error ?? undefined}>
                Nothing ran. Run it again when one is free.
              </span>
            </p>
          ) : (
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-2" data-ended="failed">
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger/10 px-2 py-px text-xs font-medium text-danger">
                <StatusGlyph status="failed" decorative className="size-3" />
                {statusWord(e)}
              </span>
              {firstLine(e.error) ? (
                <span className="min-w-0 truncate text-xs text-muted" title={e.error ?? undefined}>
                  {firstLine(e.error)}
                </span>
              ) : null}
            </p>
          )}

          {hasRoute && route ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={routeId}
              className="inline-flex items-center gap-1 self-start rounded-md text-xs font-medium text-fg-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-route-toggle
            >
              <ChevronDown aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
              {open ? "Fold the route" : `Show the route · ${routeSize(route)}`}
            </button>
          ) : null}
        </div>

        {live ? (
          <LiveScreen frame={latest} kind={e.platform} size="sm" className="max-sm:hidden" sessionId={e.status === "queued" ? null : e.id} />
        ) : hasRoute && route ? (
          <span className={e.platform === "ios" || e.platform === "android" ? "max-md:hidden" : "max-xl:hidden"}>
            <ScreenFan route={route} kind={e.platform} onClick={() => setOpen((v) => !v)} />
          </span>
        ) : null}
        {e.status === "done" && e.recipe !== "check" ? <ScoreRing score={e.result?.score ?? null} size={46} stroke={4} delta={delta} label={`${name} score`} /> : null}
        <CardMenu label={`Actions for ${name}`} items={items} />
      </div>

      {open && route ? <RouteStrip id={routeId} exploration={e} route={route} /> : null}
    </article>
  );
}

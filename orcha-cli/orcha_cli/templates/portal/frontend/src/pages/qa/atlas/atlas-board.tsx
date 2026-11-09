import { Download, FileText, Link2, Map as MapIcon, Play, RefreshCw, Share2 } from "../map/kit/icons";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { flushSync } from "react-dom";
import { Button, buttonVariants, cn, fmtDate, fmtRelative, Link, Select, useRouter, useToast } from "../map/kit";
import { errText, qaHref } from "../parts";
import type { QaNav } from "../QaPage";
import { createQaTask, qaTaskBody } from "../runQa";
import styles from "./atlas.module.css";
import { AtlasHero } from "./atlas-hero";
import { AtlasPlay } from "./atlas-play";
import { AtlasEmpty, RefreshButton } from "./atlas-scenes";
import board from "./board.module.css";
import { exportHtml, exportPdf, fileName, saveFile } from "./export";
import { FillDialog, type PassStart } from "./fill-dialog";
import { FilterBar } from "./filter-bar";
import { fillPlan, fillWords, filterAtlas, filtersQuery, NO_FILTERS, passProgress, PLATFORM_WORD, shapesOf, shownPlatforms, viewAtlas, type AtlasFilters } from "./model";
import { shotsOf } from "./play";
import { frameSigs, landingOf, RefreshLanded, RefreshStory, type Landing } from "./refresh-story";
import { ScreenDetail } from "./screen-detail";
import { Storyboard } from "./storyboard";
import { isEmptyAtlas, isFilling, type Atlas, type AtlasScreen, type Platform } from "./types";
import { useAtlas } from "./use-atlas";
import { enter, zoomClose, zoomOpen, zoomSwitch } from "./zoom";

/** A platform chip offers "Fill in" from this many screens not seen there (fewer: the cards and the details still do). */
const FILL_OFFER = 3;
/** The URL parameters the board keeps. */
const URL_KEYS = ["area", "platforms", "filter", "q", "arrows", "device", "appearance", "screen", "since"];

/** A platform as the `?platform=` the QA page reads (iOS is its default). */
const platformParam = (p: Platform) => (p === "ios" ? null : p);

/** Export and share: a PDF, one page to send, or a link to this very view. */
function ShareMenu({ atlas, filters }: { atlas: Atlas; filters: AtlasFilters }) {
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState<"pdf" | "html" | null>(null);
  const { toast } = useToast();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const make = async (format: "pdf" | "html") => {
    setOpen(false);
    setMaking(format);
    try {
      if (format === "pdf") saveFile(await exportPdf(atlas, filters), fileName(atlas, "pdf"));
      else saveFile(await exportHtml(atlas, filters), fileName(atlas, "html"));
    } catch (e) {
      toast({ title: "The atlas could not be exported", description: errText(e), variant: "error" });
    } finally {
      setMaking(null);
    }
  };
  const what = filters.area ? "this area" : "the atlas";
  return (
    <div className="relative" ref={box}>
      <Button size="md" variant="ghost" onClick={() => setOpen((o) => !o)} loading={making !== null} aria-expanded={open} aria-haspopup="menu" data-atlas-share>
        {making ? null : <Share2 />} Export
      </Button>
      {open ? (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-[260px] rounded-lg border border-border bg-raised p-1 shadow-lg" data-atlas-share-menu>
          <button role="menuitem" type="button" className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-hover" onClick={() => void make("pdf")} data-atlas-export="pdf">
            <FileText className="mt-0.5 size-3.5 text-muted" aria-hidden />
            <span>
              <span className="block font-medium text-fg">Download a PDF</span>
              <span className="block text-xs text-muted">Of {what}, as filtered, for a design review</span>
            </span>
          </button>
          <button role="menuitem" type="button" className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-hover" onClick={() => void make("html")} data-atlas-export="html">
            <Download className="mt-0.5 size-3.5 text-muted" aria-hidden />
            <span>
              <span className="block font-medium text-fg">Download a page to share</span>
              <span className="block text-xs text-muted">One file with its screenshots inside, opens anywhere</span>
            </span>
          </button>
          <button
            role="menuitem"
            type="button"
            className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-hover"
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.href).then(
                () => toast({ title: "Link copied", description: "It opens the atlas with these filters." }),
                () => toast({ title: "Could not copy the link", variant: "error" }),
              );
              setOpen(false);
            }}
          >
            <Link2 className="mt-0.5 size-3.5 text-muted" aria-hidden />
            <span>
              <span className="block font-medium text-fg">Copy a link to this view</span>
              <span className="block text-xs text-muted">For someone who uses Embodent</span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Scrolls a card into the middle of the window (its row sideways too) and lights it for a beat. */
function showCard(id: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-atlas-card="${CSS.escape(id)}"]`);
  if (!el) return false;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
  el.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "center", inline: "center" });
  return true;
}

/**
 * The Screen atlas: every screen of the app at a glance. The header says what the atlas holds (one
 * bar of every screen, how it counts them beside the App map), picks "changed since" a date, plays
 * it as a tour ("Play the app"), shares it and starts a map pass (Run check); a pass is told as a story
 * while it runs and landed when it ends. The sticky filter bar narrows it by area, platform and what
 * differs, changed or was never seen; the storyboard shows each area as a row of screens with their
 * platforms side by side; a screen opens its details. Filters and the open screen live in the URL,
 * so a link opens the same view.
 */
export function AtlasBoard({
  cid,
  nav,
  atlas: served,
  error: loadError,
  filters: initialFilters,
  screen: initialScreen,
  since: initialSince,
}: {
  cid: string;
  nav: QaNav;
  atlas: Atlas | null;
  error: string | null;
  filters: AtlasFilters;
  screen: string | null;
  since: string | null;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<AtlasFilters>(initialFilters);
  const [open, setOpen] = useState<string | null>(initialScreen);
  const [since, setSince] = useState<string | null>(initialSince);
  const [drawKey, setDrawKey] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [glow, setGlow] = useState<ReadonlyMap<string, number> | null>(null);
  const [, startNav] = useTransition();
  const { atlas, fresh, loading, error } = useAtlas(cid, served, since, nav.nonce);

  // A refresh the page watches: each screen's screenshots when it started, so its end can say
  // which screens got a new one. Kept from the atlas as it changes (no effect needed).
  const [pass, setPass] = useState<Map<string, string> | null>(() => (served && isFilling(served) ? frameSigs(served) : null));
  const [landing, setLanding] = useState<Landing | null>(null);
  const [watched, setWatched] = useState(atlas);
  if (atlas !== watched) {
    setWatched(atlas);
    if (atlas && isFilling(atlas)) {
      if (!pass) setPass(frameSigs(atlas));
    } else if (atlas && pass) {
      const ended = landingOf(atlas, pass);
      if (ended) {
        setLanding(ended);
        setPass(null);
      }
    }
  }

  // The view in the URL, beside the QA page's own parameters.
  const navNow = useRef(nav);
  useEffect(() => {
    navNow.current = nav;
  });
  useEffect(() => {
    const q = filtersQuery(filters);
    if (open) q.set("screen", open);
    if (since) q.set("since", since);
    const patch: Record<string, string | null> = {};
    for (const k of URL_KEYS) if (q.get(k) !== navNow.current.get(k)) patch[k] = q.get(k);
    if (Object.keys(patch).length) navNow.current.set(patch);
  }, [filters, open, since]);

  // The filter bar lifts off the storyboard once the header has scrolled away under it: a line
  // just above the bar, watched from the moment it is in the page.
  const watcher = useRef<IntersectionObserver | null>(null);
  const sentinel = useCallback((el: HTMLDivElement | null) => {
    watcher.current?.disconnect();
    watcher.current = null;
    if (!el || typeof IntersectionObserver === "undefined") return;
    watcher.current = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { root: el.closest("[data-atlas-scroll]"), threshold: 0 });
    watcher.current.observe(el);
  }, []);

  // Cards lit after "Show them" or a jump go back to rest.
  useEffect(() => {
    if (!glow) return;
    const t = window.setTimeout(() => setGlow(null), 3200);
    return () => window.clearTimeout(t);
  }, [glow]);

  // A card opens its screen with a zoom (its frames grow into the panel's) and the panel closes
  // back into it; moving between screens inside the panel just swaps them. Stable, so the
  // storyboard's rows do not re-render when a screen opens.
  const openNow = useRef(open);
  useEffect(() => {
    openNow.current = open;
  }, [open]);
  // The card a panel was opened from: it flies back there (or to the shown screen's card) on close.
  const opener = useRef<string | null>(initialScreen);
  const openCard = useCallback((id: string) => {
    if (openNow.current) return zoomSwitch(openNow.current, () => flushSync(() => setOpen(id)));
    opener.current = id;
    zoomOpen(id, () => flushSync(() => setOpen(id)));
  }, []);
  const closeDetail = useCallback(() => zoomClose(openNow.current, () => flushSync(() => setOpen(null)), opener.current), []);
  // Another screen in the open panel (its moves, previous and next): a crossfade, the panel still.
  const switchTo = useCallback((id: string) => zoomSwitch(openNow.current, () => flushSync(() => setOpen(id))), []);
  // Opened from a link: the panel still slides in (nothing to fly from).
  useEffect(() => {
    if (openNow.current) enter(openNow.current);
  }, []);

  const set = useCallback((patch: Partial<AtlasFilters>) => setFilters((f) => ({ ...f, ...patch })), []);
  const clear = useCallback(() => setFilters((f) => ({ ...NO_FILTERS, arrows: f.arrows })), []);
  // The atlas as the device and appearance filters show it (each frame the look that fits them);
  // the same object when neither is on.
  const { devices, appearances } = filters;
  const shown = useMemo(() => (atlas ? viewAtlas(atlas, { devices, appearances }) : null), [atlas, devices, appearances]);
  const rows = useMemo(() => (shown ? filterAtlas(shown, filters) : []), [shown, filters]);
  const plats = useMemo(() => (shown ? shownPlatforms(shown, filters) : []), [shown, filters]);
  const shapes = useMemo(() => (shown ? shapesOf(shown) : {}), [shown]);
  const kept = rows.reduce((n, r) => n + r.screens.length, 0);
  const order = useMemo(() => rows.flatMap((r) => r.screens.map((s) => s.id)), [rows]);
  const playable = useMemo(() => rows.reduce((n, r) => n + r.screens.filter((s) => shotsOf(s, plats).length).length, 0), [rows, plats]);
  const screen = useMemo(() => (shown && open ? (shown.screens.find((s) => s.id === open || s.nodes.includes(open)) ?? null) : null), [shown, open]);
  const names = useMemo(() => new Map((atlas?.screens ?? []).map((s) => [s.id, s.name])), [atlas]);

  const jump = useCallback((ids: string[]) => {
    if (!ids.length) return;
    showCard(ids[0]);
    setGlow(new Map(ids.map((id, i) => [id, i])));
  }, []);

  // Refresh atlas maps on the platform the page shows; its dialog says which device first, as
  // Fill's does. Agents do the work: either dialog creates a task on the map skill.
  const { toast } = useToast();
  const [starting, setStarting] = useState(false);
  const [askRefresh, setAskRefresh] = useState(false);
  const refreshOn = atlas?.refresh.platform ?? nav.platform;
  const [fillFor, setFillFor] = useState<Platform | null>(null);
  const start = useCallback(
    async (p: Platform, pass: "overview" | "deeper", go: PassStart) => {
      if (!atlas) return;
      setStarting(true);
      setLanding(null);
      const word = PLATFORM_WORD[p];
      const plan = fillPlan(atlas, p);
      const body = qaTaskBody({
        kind: "map", platform: p, pass, device: go.device, agentAlias: go.agentAlias, humanId: nav.auth.human?.id ?? null,
        minutes: pass === "deeper" ? atlas.refresh.fill_minutes : atlas.refresh.minutes,
        passTitle: pass === "deeper" ? `Fill in ${word}: ${plan.visits} ${plan.visits === 1 ? "screen" : "screens"} not seen` : `Refresh the screen atlas on ${word}`,
      });
      try {
        await createQaTask(cid, body);
        toast(pass === "deeper"
          ? { title: `Filling in ${word}`, description: `${fillWords(plan, atlas.refresh).detail} Screens develop in as they are seen.` }
          : { title: "Refreshing the atlas", description: `About ${atlas.refresh.minutes} minutes. Screens fill in as they are seen.` });
        setFillFor(null);
        setAskRefresh(false);
        nav.refresh();
      } catch (e) {
        toast({ title: pass === "deeper" ? `Could not fill in ${word}` : "The atlas could not refresh", description: errText(e), variant: "error" });
      } finally {
        setStarting(false);
      }
    },
    [atlas, cid, nav, toast],
  );
  const onRefresh = () => setAskRefresh(true);
  // A card's or a detail's "Fill in iOS" opens the same dialog: which device, then go.
  const onFill = useCallback((p: Platform) => setFillFor(p), []);
  const can = nav.auth.can;
  // The platforms a fill-in can start on now: a pass is not running and some screen there is unseen.
  const fillOn = useMemo<ReadonlySet<Platform>>(() => {
    if (!atlas || isFilling(atlas) || starting || !can) return new Set();
    return new Set(atlas.platforms.filter((p) => fillPlan(atlas, p).visits > 0));
  }, [atlas, starting, can]);
  const mapHref = qaHref({ view: "map", platform: platformParam(nav.platform) });
  const screenHref = useCallback((s: AtlasScreen) => {
    const p = s.variants[nav.platform] ? nav.platform : (s.platforms[0] ?? nav.platform);
    return qaHref({ view: "map", platform: platformParam(p), screen: s.variants[p]?.node || s.id });
  }, [nav.platform]);

  if (!atlas || !shown) {
    return (
      <div className="flex flex-1 items-start justify-center px-4 py-10">
        <div className="w-full max-w-lg rounded-xl border border-border bg-panel p-6" data-atlas-load-error>
          <p className="text-base text-fg">The atlas could not be loaded.</p>
          <p className="mt-1 text-sm text-muted">{loadError ?? error}</p>
          <Button className="mt-3" onClick={() => startNav(() => router.refresh())}>
            <RefreshCw /> Try again
          </Button>
        </div>
      </div>
    );
  }

  const filling = isFilling(atlas);
  const refreshDialog = askRefresh ? (
    <FillDialog
      key={`refresh:${refreshOn}`}
      pass="refresh"
      label={isEmptyAtlas(atlas) ? "Map the main screens" : "Refresh atlas"}
      cid={cid}
      atlas={atlas}
      platform={refreshOn}
      open={!filling || starting}
      busy={starting}
      onClose={() => setAskRefresh(false)}
      onStart={(go) => void start(refreshOn, "overview", go)}
    />
  ) : null;
  if (isEmptyAtlas(atlas)) {
    return (
      <div className={cn(styles.palette, "flex min-h-0 flex-1 flex-col")} data-atlas-board="empty">
        {filling ? <RefreshStory atlas={atlas} refresh={atlas.refresh} seen={0} total={0} /> : null}
        <AtlasEmpty refresh={atlas.refresh} onRefresh={onRefresh} asks busy={starting || filling} can={can} reason={nav.auth.reason} mapHref={mapHref} />
        {refreshDialog}
      </div>
    );
  }

  const c = atlas.counts;
  // Said after "N changed" in the header's figure: "in the last 7 days".
  const sinceOptions = [
    { value: "", label: "in the last 7 days" },
    ...atlas.builds.map((b) => ({ value: b.id, label: `since build ${b.label}`, description: b.at ? fmtDate(b.at, { time: false }) : undefined })),
    // From when the atlas was read, so the option is the same on every render.
    ...(atlas.generated_at ? [{ value: new Date(new Date(atlas.generated_at).getTime() - 30 * 86400000).toISOString().slice(0, 10), label: "in the last 30 days" }] : []),
  ];
  const sinceValue = since ?? "";
  if (since && !sinceOptions.some((o) => o.value === since)) sinceOptions.push({ value: since, label: `since ${atlas.since.label}` });

  const actions = (
    <>
      <Button
        size="md"
        variant="primary"
        onClick={() => setPlaying(true)}
        disabled={!playable}
        title={playable ? `A tour of the ${playable === 1 ? "screen" : `${playable} screens`} seen live, area by area` : "No screen here has been seen live yet"}
        data-atlas-play
      >
        <Play className="fill-current" /> Play the app
      </Button>
      <ShareMenu atlas={shown} filters={filters} />
      <RefreshButton refresh={atlas.refresh} onClick={onRefresh} asks busy={starting} can={can} reason={nav.auth.reason} />
      <Link href={mapHref} className={buttonVariants({ variant: "ghost", size: "md" })} data-atlas-map>
        <MapIcon /> App map
      </Link>
    </>
  );
  const sinceControl = (
    <Select aria-label="Changed since" dimension="sm" wrapperClassName="mt-0.5 w-[168px]" value={sinceValue} onChange={(e) => setSince(e.target.value || null)} options={sinceOptions} data-atlas-since />
  );

  return (
    <div className={cn(styles.palette, "flex min-h-0 flex-1 flex-col")} data-atlas-board aria-busy={loading || undefined}>
      {filling ? (
        <RefreshStory atlas={atlas} refresh={atlas.refresh} seen={c.seen} total={c.screens} progress={passProgress(atlas)} onJump={(id) => jump([id])} />
      ) : landing ? (
        <RefreshLanded landing={landing} names={names} onShow={() => jump(landing.gained)} onClose={() => setLanding(null)} />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto" data-atlas-scroll>
        <AtlasHero
          atlas={atlas}
          actions={actions}
          since={sinceControl}
          platformAction={(p) => {
            const plan = fillPlan(atlas, p);
            // Many screens not seen there: worth a pass of its own.
            if (plan.unseen - plan.blocked < FILL_OFFER) return null;
            const words = fillWords(plan, atlas.refresh);
            return (
              <Button size="sm" variant="ghost" className="ml-1" onClick={() => onFill(p)} disabled={!fillOn.has(p)} title={words.detail} data-atlas-fill={p}>
                {words.label}
              </Button>
            );
          }}
        />
        <div ref={sentinel} aria-hidden className="h-px" />
        <FilterBar atlas={atlas} filters={filters} set={set} clear={clear} kept={kept} onArrows={() => setDrawKey((k) => k + 1)} stuck={stuck} />
        {loading ? <div className={board.veilBar} aria-hidden data-atlas-reading /> : null}
        <div className={board.veil} aria-busy={loading || undefined}>
          {rows.length ? (
            <Storyboard atlas={shown} rows={rows} platforms={plats} arrows={filters.arrows} drawKey={drawKey} fresh={fresh} glow={glow} onOpen={openCard} onArea={(key) => set({ area: key })} fillOn={fillOn} onFill={onFill} />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center" data-atlas-none>
              <p className="text-base text-fg">No screen matches these filters.</p>
              <Button variant="ghost" onClick={clear}>
                Show every screen
              </Button>
            </div>
          )}
        </div>
        <p className="px-4 py-5 text-xs text-muted md:px-6">
          Screenshots from mapping runs, explorations and checks, newest first
          {atlas.generated_at ? `, read ${fmtRelative(atlas.generated_at)}` : ""}. A dashed frame is a screen known from the code that no run has reached yet.
        </p>
      </div>
      <ScreenDetail atlas={shown} screen={screen} mapHref={screenHref} onClose={closeDetail} onOpen={switchTo} order={order} fillOn={fillOn} onFill={onFill} />
      {fillFor ? (
        <FillDialog
          key={fillFor}
          cid={cid}
          atlas={atlas}
          platform={fillFor}
          open={fillOn.has(fillFor) || starting}
          busy={starting}
          onClose={() => setFillFor(null)}
          onStart={(go) => void start(fillFor, "deeper", go)}
        />
      ) : null}
      {refreshDialog}
      {playing ? (
        <AtlasPlay
          atlas={shown}
          rows={rows}
          platforms={plats}
          shapes={shapes}
          onClose={() => setPlaying(false)}
          onOpenScreen={(id) => {
            setPlaying(false);
            setOpen(id);
          }}
        />
      ) : null}
    </div>
  );
}

import type { CSSProperties, ReactNode } from "react";
import {
  AppWindow,
  BookOpen,
  Brain,
  Bug,
  FileCode2,
  FileText,
  FlaskConical,
  Globe,
  History,
  ListChecks,
  Map as MapIcon,
  Paperclip,
  Pin,
  Smartphone,
  Target,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "../../map/kit/icons";
import { FrameView } from "../frames";
import { CountUp } from "../../map/kit";
import { LensChip } from "../lens-chip";
import type { CharterItem, Exploration, ExplorationBriefing } from "../explorations";
import { studySource, type StudyManifest, type StudyScreen, type StudySourceKind } from "../explorations";
import type { Placement } from "../frames";
import { usePrefersReducedMotion } from "../../map/kit";
import { cn } from "../../map/kit";
import { sourceTiles, type PassFrame } from "./model";
import {
  SCENE_KINDS,
  SCENE_TITLE,
  chooseScene,
  codeFiles,
  countLabel,
  featureChips,
  featuresWaitingLine,
  missingRepoLine,
  pageOutline,
  pinnedFiles,
  readState,
  sourceRows,
  timelineEntries,
  type FeatureOrigin,
  type ReadState,
  type SourceRow,
  type StudyScene,
} from "./study-model";
import { WorkEmpty } from "../work/work-live";
import styles from "./detail.module.css";

const KIND_ICON: Readonly<Record<StudySourceKind, LucideIcon>> = {
  code: FileCode2,
  tests: FlaskConical,
  docs: BookOpen,
  scenarios: ListChecks,
  features: Target,
  app_map: MapIcon,
  context: Paperclip,
  memory: Brain,
  findings: Bug,
  history: History,
};

const TILE_ICON = { files: FileCode2, tests: FlaskConical, scenarios: ListChecks, docs: BookOpen, context: Paperclip } as const;

/** `--i` for a staggered entrance. */
function at(i: number, extra?: Record<string, string | number>): CSSProperties {
  return { "--i": i, ...extra } as CSSProperties;
}

// ---------- the code scene ----------

/** A repository: its real paths stream in under a scan line; the files the explorer opens light
 * up and are pinned beside the list. */
function CodeScene({ manifest, read, reduced }: { manifest: StudyManifest; read: ReadState; reduced: boolean }) {
  const files = codeFiles(manifest, read);
  const pinned = pinnedFiles(manifest, read);
  const counts = (["code", "tests", "docs"] as const)
    .map((k) => studySource(manifest, k))
    .filter((s): s is NonNullable<typeof s> => s != null)
    .map((s) => countLabel(s));
  return (
    <div className="@container" data-study-code>
    <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-[minmax(0,1fr)_260px]">
      <div className="relative min-w-0 overflow-hidden rounded-lg border border-border bg-panel">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted">
          <FileCode2 aria-hidden className="size-3.5" strokeWidth={1.75} />
          <span className="text-fg-2">The repository</span>
          {counts.length ? <span className="ml-auto truncate font-mono text-2xs tabular">{counts.join(" · ")}</span> : null}
        </div>
        {files.length ? (
          <>
            {reduced ? null : <span aria-hidden className={styles.scanLine} style={{ "--scan-to": `${files.length * 22 + 16}px` } as CSSProperties} data-study-scan />}
            <ul className="flex flex-col py-1" aria-label="Files in the study">
              {files.map((f, i) => {
                const Icon = KIND_ICON[f.kind];
                return (
                  <li
                    key={f.path}
                    className={cn("flex min-w-0 items-center gap-2 px-3 py-[3px]", reduced ? null : styles.stream, f.lit && styles.fileLit)}
                    style={at(i)}
                    data-study-file={f.path}
                    data-lit={f.lit || undefined}
                  >
                    <Icon aria-hidden className="size-3 shrink-0 text-muted" strokeWidth={1.75} />
                    <span className="truncate font-mono text-2xs text-fg-2">{f.path}</span>
                    {f.label && f.label !== f.path ? <span className="hidden min-w-0 truncate text-2xs text-muted sm:inline">{f.label}</span> : null}
                    {f.lit ? <Pin aria-label="Opened" className="ml-auto size-3 shrink-0 text-primary" strokeWidth={2} /> : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="px-3 py-4 text-xs text-muted">The repository has no source files, tests or docs Embodent could find.</p>
        )}
      </div>
      <aside className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-panel p-3" aria-label="Opened by Embodent" data-study-pinned>
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted">
          <Pin aria-hidden className="size-3.5" strokeWidth={1.75} /> Opened by Embodent
          {pinned.length ? <span className="tabular text-fg-2">{pinned.length}</span> : null}
        </h4>
        {pinned.length ? (
          <ul className="flex flex-col gap-1" aria-live="polite">
            {pinned.map((p) => (
              <li
                key={p}
                className={cn("truncate rounded-md bg-panel-2 px-2 py-1 font-mono text-2xs text-fg", reduced ? null : styles.pinIn)}
                style={{ direction: "rtl", textAlign: "left" }}
                title={p}
                data-study-pinned-file={p}
              >
                <bdi>{p}</bdi>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted">Nothing opened yet. Each file it reads is pinned here.</p>
        )}
      </aside>
    </div>
    </div>
  );
}

// ---------- the site and device scenes ----------

function OutlineGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
    </div>
  );
}

/**
 * No repository: Orcha studies what is running. The session's first frames fade in inside
 * the browser (or the device), and what the page says is outlined as it is found: its title,
 * its navigation, its other links, its texts. A new page outlines itself again.
 */
function LiveScene({
  phone,
  desktop,
  screens,
  frames,
  placement,
  device,
  reduced,
}: {
  phone: boolean;
  desktop: boolean;
  screens: readonly StudyScreen[];
  frames: readonly PassFrame[];
  placement: Placement | null;
  device?: unknown;
  reduced: boolean;
}) {
  const latest = screens[screens.length - 1] ?? null;
  const outline = latest ? pageOutline(latest) : null;
  const framePath = frames[frames.length - 1]?.frame_path ?? latest?.frame_path ?? null;
  const where = phone ? "screen" : desktop ? "window" : "page";
  let n = 0;
  return (
    <div
      className={cn("grid grid-cols-1 gap-4", phone ? "md:grid-cols-[minmax(220px,0.7fr)_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]")}
      data-study-live={phone ? "device" : "site"}
    >
      {/* The scan sits on the frame itself: the box is exactly as wide as the browser or the phone. */}
      <div className={cn("relative min-w-0 self-start overflow-hidden", phone ? "mx-auto w-full max-w-[220px] rounded-[28px]" : "w-full rounded-lg")} data-study-frame>
        {placement ? (
          <FrameView placement={placement} path={framePath} device={device} />
        ) : (
          <div className={cn("flex items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted", phone ? "aspect-[9/19.5]" : "aspect-[16/10]")}>
            Waiting for the first {where}
          </div>
        )}
        {framePath && !reduced ? <span aria-hidden className={styles.frameScan} data-study-scan /> : null}
      </div>
      <div key={outline?.seq ?? "none"} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-panel p-3" data-study-outline>
        {outline ? (
          <>
            {outline.address ? (
              <p className="flex min-w-0 items-center gap-1.5 font-mono text-2xs text-muted">
                <Globe aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{outline.address}</span>
              </p>
            ) : null}
            {outline.title ? (
              <OutlineGroup label={phone ? "Screen" : "Title"}>
                <span className={cn("self-start text-sm font-medium text-fg", styles.outlined)} style={at(n++)} data-study-outlined="title">
                  {outline.title}
                </span>
              </OutlineGroup>
            ) : null}
            {outline.nav.length ? (
              <OutlineGroup label={phone ? "Sections" : "Navigation"}>
                <div className="flex flex-wrap gap-1.5">
                  {outline.nav.map((a) => (
                    <span key={a} className={cn("rounded-md px-1.5 py-0.5 text-xs text-fg", styles.outlined)} style={at(n++)} data-study-outlined="nav">
                      {a}
                    </span>
                  ))}
                </div>
              </OutlineGroup>
            ) : null}
            {outline.links.length ? (
              <OutlineGroup label={phone ? "Controls" : "Links"}>
                <div className="flex flex-wrap gap-1.5">
                  {outline.links.map((a) => (
                    <span key={a} className={cn("rounded-md px-1.5 py-0.5 text-2xs text-fg-2", styles.outlined)} style={at(n++)} data-study-outlined="link">
                      {a}
                    </span>
                  ))}
                </div>
              </OutlineGroup>
            ) : null}
            {outline.texts.length ? (
              <OutlineGroup label={`On the ${where}`}>
                <ul className="flex flex-col gap-1">
                  {outline.texts.map((t) => (
                    <li key={t} className={cn("text-xs text-fg-2", styles.outlined)} style={at(n++)} data-study-outlined="text">
                      {t}
                    </li>
                  ))}
                </ul>
              </OutlineGroup>
            ) : null}
            {screens.length > 1 ? (
              <p className="text-2xs tabular text-muted" data-study-pages>
                {screens.length} {phone ? "screens" : "pages"} studied so far
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted" data-study-outline-waiting>
            Waiting for the first {where}: the session opens it while the explorer reads, and what it shows is outlined here.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- the timeline scene ----------

const TIMELINE_ICON = { history: History, findings: Bug, memory: Brain } as const;

/** Only earlier runs to go on: what they learned, one entry at a time. */
function TimelineScene({ manifest, reduced }: { manifest: StudyManifest; reduced: boolean }) {
  const entries = timelineEntries(manifest);
  return (
    <ol className="relative flex flex-col gap-3 rounded-lg border border-border bg-panel p-3 pl-8" data-study-timeline aria-label="What earlier runs learned">
      <span aria-hidden className={cn("absolute bottom-4 left-[18px] top-4 w-px bg-border", reduced ? null : styles.timelineLine)} />
      {entries.map((t, i) => {
        const Icon = TIMELINE_ICON[t.kind];
        return (
          <li key={`${t.kind}-${i}`} className={cn("relative flex flex-col gap-0.5", reduced ? null : styles.cascade)} style={at(i, { "--d": "120ms" })} data-study-entry={t.kind}>
            <span aria-hidden className="absolute -left-[22px] top-0.5 flex size-4 items-center justify-center rounded-full border border-border bg-panel-2">
              <Icon className="size-2.5 text-muted" strokeWidth={2} />
            </span>
            <span className="text-sm text-fg">{t.title}</span>
            {t.detail || t.at ? (
              <span className="text-xs text-muted">{[t.at ? t.at.slice(0, 10) : null, t.detail].filter(Boolean).join(" · ")}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- the source rows ----------

/** One row per source with something in it, its real names as chips; the opened ones lit. */
function SourceRows({ rows, reduced }: { rows: readonly SourceRow[]; reduced: boolean }) {
  let n = 0;
  return (
    <div className="flex flex-col gap-2" data-study-rows>
      {rows.map((r) => {
        const Icon = KIND_ICON[r.kind];
        return (
          <div key={r.kind} className="grid grid-cols-1 items-start gap-1.5 sm:grid-cols-[136px_minmax(0,1fr)] sm:gap-2" data-study-row={r.kind}>
            <span className="flex items-start gap-1.5 text-xs text-fg-2">
              <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" strokeWidth={1.75} />
              <span className="flex min-w-0 flex-row gap-1.5 sm:flex-col sm:gap-0">
                <span>{r.label}</span>
                <span className="truncate text-2xs tabular text-muted">{r.count}</span>
              </span>
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {r.chips.map((c, ci) => (
                <span
                  key={`${c.name}-${c.reported ? "r" : "m"}-${ci}`}
                  className={cn(
                    "inline-flex h-[22px] max-w-full items-center truncate rounded-md border border-border bg-panel-2 px-2 text-2xs text-fg-2",
                    r.kind === "code" || r.kind === "docs" ? "font-mono" : null,
                    reduced ? null : styles.chipIn,
                    c.lit && styles.chipLit,
                  )}
                  style={at(n++)}
                  title={c.detail ?? undefined}
                  data-study-chip={c.name}
                  data-lit={c.lit || undefined}
                  data-reported={c.reported || undefined}
                >
                  <span className="truncate">{c.name}</span>
                </span>
              ))}
              {r.more ? <span className="text-2xs tabular text-muted">+{r.more} more</span> : null}
              {r.from ? <span className="text-2xs text-muted">left open by {r.from}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The counts the explorer reported in its briefing, the ones with something in them. */
function ReadTiles({ briefing }: { briefing: ExplorationBriefing }) {
  const tiles = sourceTiles(briefing.sources_read).filter((t) => t.value > 0);
  if (!tiles.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-study-sources>
      {tiles.map((t, i) => {
        const Icon = TILE_ICON[t.key as keyof typeof TILE_ICON];
        return (
          <div key={t.key} className="v-pop flex flex-col gap-0.5 rounded-lg border border-border bg-panel px-3 py-2" style={at(i)} data-study-source={t.key}>
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
              {t.label}
            </span>
            <span className="text-lg font-semibold tabular text-fg">
              {t.key === "context" ? "Read" : <CountUp value={String(t.value)} delay={i * 80} />}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------- features ----------

const ORIGIN_NOTE: Readonly<Record<FeatureOrigin, string | null>> = {
  targets: null,
  briefing: null,
  feature_map: "from the feature map",
  site: "from what the screens show",
  none: null,
};

function FeatureCards({ exploration, screens, scene, reduced }: { exploration: Exploration; screens: readonly StudyScreen[]; scene: StudyScene; reduced: boolean }) {
  const { chips, origin } = featureChips(exploration, screens);
  const lit = Boolean(exploration.briefing);
  const note = ORIGIN_NOTE[origin];
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-sm font-semibold text-fg">
        Features {note ? <span className="text-xs font-normal text-muted">{note}</span> : null}
      </h3>
      {chips.length ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-study-features data-study-features-origin={origin}>
          {chips.map((f, i) => (
            <div
              key={f.key}
              className={cn(
                "flex h-14 min-w-0 flex-col justify-center gap-1 rounded-lg border px-3",
                lit ? styles.cardLit : "border-border bg-panel",
                !lit && !reduced ? styles.chipIn : null,
              )}
              style={at(i)}
              data-study-feature={f.key}
            >
              <span className="truncate text-sm font-medium text-fg">{f.name}</span>
              <span className="text-2xs text-muted">{lit ? "Understood" : origin === "site" ? (scene === "device" ? "Seen on screen" : "Seen on the site") : "Reading"}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted" data-study-features-waiting>
          {featuresWaitingLine(scene)}
        </p>
      )}
    </section>
  );
}

/** The App brief: what the app is, who uses it, its key journeys and the risky areas. */
export function AppBrief({ briefing, animate = true }: { briefing: ExplorationBriefing; animate?: boolean }) {
  const rise = animate ? "v-rise" : "";
  return (
    <section className="flex flex-col gap-3" data-app-brief aria-label="App brief">
      <p className={cn("max-w-prose select-text text-sm leading-6 text-fg", rise)}>{briefing.app_summary}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {briefing.personas.length ? (
          <div className={cn("flex flex-col gap-1.5", rise)} style={{ "--i": 1 } as CSSProperties}>
            <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <Users aria-hidden className="size-3.5" strokeWidth={1.75} /> Who uses it
            </h4>
            <ul className="flex flex-col gap-1">
              {briefing.personas.map((p) => (
                <li key={p.name} className="select-text text-sm">
                  <span className="font-medium text-fg">{p.name}</span>
                  {p.goal ? <span className="text-muted">: {p.goal}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {briefing.journeys.length ? (
          <div className={cn("flex flex-col gap-1.5", rise)} style={{ "--i": 2 } as CSSProperties}>
            <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <Target aria-hidden className="size-3.5" strokeWidth={1.75} /> Key journeys
            </h4>
            <ul className="flex flex-col gap-1">
              {briefing.journeys.map((j) => (
                <li key={j.id} className="select-text text-sm text-fg">
                  {j.name}
                  {j.persona ? <span className="text-muted"> · {j.persona}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {briefing.risks.length ? (
          <div className={cn("flex flex-col gap-1.5", rise)} style={{ "--i": 3 } as CSSProperties}>
            <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <TriangleAlert aria-hidden className="size-3.5" strokeWidth={1.75} /> Risky areas
            </h4>
            <ul className="flex flex-col gap-1">
              {briefing.risks.map((r) => (
                <li key={r.area} className="select-text text-sm">
                  <span className="font-medium text-fg">{r.area}</span>
                  {r.why ? <span className="text-muted">: {r.why}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The charter, dealt in one mission at a time. */
function CharterDeal({ items }: { items: readonly CharterItem[] }) {
  return (
    <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-study-charter>
      {items.map((m, i) => (
        <li
          key={m.id}
          className={cn("flex flex-col gap-1 rounded-lg border border-border bg-panel p-3", styles.deal)}
          style={{ "--i": i, "--d": "200ms" } as CSSProperties}
          data-charter-card={m.id}
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-2xs text-muted">{m.id.toUpperCase()}</span>
            <LensChip lens={m.lens} size="sm" />
          </div>
          <span className="text-sm font-medium text-fg">{m.title}</span>
          <span className="flex items-start gap-1 text-xs text-muted">
            <FileText aria-hidden className="mt-0.5 size-3 shrink-0" strokeWidth={1.75} />
            {m.why}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Study: before it touches the app, the explorer reads, and this face shows what it actually
 * reads. A repository gets a code-reading scene; a site with none a browser where the live
 * pages are outlined as they are found; a phone app the same in a device; only earlier runs a
 * timeline of what they learned. Under the scene, one row per source that has something in it
 * (memory, scenarios, past runs...), with its real names; whatever the explorer opens lights up.
 * The Features row fills from the targets, the feature map or the sections the screens show,
 * then the App brief and the charter arrive.
 */
export function StudyFace({
  exploration,
  screens = [],
  frames = [],
  placement = null,
  device,
  progress = null,
  part,
}: {
  exploration: Exploration;
  screens?: readonly StudyScreen[];
  frames?: readonly PassFrame[];
  placement?: Placement | null;
  device?: unknown;
  progress?: { read_files?: readonly string[] | null } | null;
  /** One column of the live view: what Orcha reads ("sees": the scene and its
   * sources) or what it writes from it ("produces": the features, the App brief, the charter).
   * Both when omitted. */
  part?: "sees" | "produces";
}) {
  const reduced = usePrefersReducedMotion();
  const briefing = exploration.briefing;
  const manifest = exploration.study ?? null;
  const platform = placement?.kind ?? exploration.platform;
  const hasScreen = frames.length > 0 || screens.length > 0;
  const scene = chooseScene({ manifest, platform, hasScreen });
  const read = readState(manifest, briefing?.sources, progress?.read_files ?? undefined);
  const rows = sourceRows(manifest, read, SCENE_KINDS[scene]);
  const missing = missingRepoLine(manifest, scene, platform);
  const gathering = !manifest && !hasScreen;
  const SceneIcon = scene === "code" ? FileCode2 : scene === "device" ? Smartphone : scene === "timeline" ? History : platform === "desktop" ? AppWindow : Globe;
  const sees = (
      <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          {gathering ? null : <SceneIcon aria-hidden className="size-4 text-muted" strokeWidth={1.75} />}
          {briefing ? "What it read" : gathering ? "Gathering what describes the app" : SCENE_TITLE[scene]}
          {!briefing ? <span className={cn("inline-block h-3.5 w-1.5 bg-fg-2", styles.cursor)} aria-hidden /> : null}
        </h3>
        {missing ? (
          <p className="text-xs text-muted" data-study-missing>
            {missing}
          </p>
        ) : null}
        {gathering ? (
          <p className="text-xs text-muted" data-study-gathering>
            Its repository, feature map, scenarios and memory, whichever it has. The session starts in a moment.
          </p>
        ) : null}
      </div>

      {gathering ? null : scene === "code" && manifest ? (
        <CodeScene manifest={manifest} read={read} reduced={reduced} />
      ) : scene === "timeline" && manifest ? (
        <TimelineScene manifest={manifest} reduced={reduced} />
      ) : (
        <LiveScene
          phone={scene === "device"}
          desktop={platform === "desktop"}
          screens={screens}
          frames={frames}
          placement={placement}
          device={device}
          reduced={reduced}
        />
      )}

      {rows.length ? <SourceRows rows={rows} reduced={reduced} /> : null}
      {manifest && manifest.sources.length === 0 ? (
        <p className="text-xs text-muted" data-study-nothing-else>
          Nothing else describes this app yet: no feature map, scenarios, docs or memory. What it learns comes from the{" "}
          {scene === "device" ? "app" : platform === "desktop" ? "running app" : "site"} itself.
        </p>
      ) : null}
      {briefing ? <ReadTiles briefing={briefing} /> : null}
    </section>
  );
  const produces = (
    <>
      <FeatureCards exploration={exploration} screens={screens} scene={scene} reduced={reduced} />

      {briefing ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg">App brief</h3>
          <AppBrief briefing={briefing} />
        </section>
      ) : (
        <div data-study-waiting>
          <WorkEmpty live skeletons={2}>
            The App brief and the charter appear here as soon as Embodent writes them.
          </WorkEmpty>
        </div>
      )}

      {exploration.charter.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-baseline gap-2 text-sm font-semibold text-fg">
            The charter <span className="font-normal tabular text-muted">{exploration.charter.length} missions</span>
          </h3>
          <CharterDeal items={exploration.charter} />
        </section>
      ) : null}
    </>
  );
  const attrs = { "data-study-scene": gathering ? "gathering" : scene, "data-motion": reduced ? "reduced" : "full" };
  if (part === "sees") return <div className="flex flex-col gap-5" data-study-part="sees" {...attrs}>{sees}</div>;
  if (part === "produces") return <div className="flex flex-col gap-5" data-study-part="produces">{produces}</div>;
  return (
    <div className="flex flex-col gap-5" data-face="study" {...attrs}>
      {sees}
      {produces}
    </div>
  );
}

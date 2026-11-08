import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import { ArrowLeft, ArrowLeftRight, ArrowRight, ChevronsDownUp, ChevronsUpDown, CircleDashed, Database, Eye, FileCode2, FlaskConical, Layers, Lock, Radio, Server, Smartphone } from "./kit/icons";
import { useEffect, useState, type CSSProperties } from "react";
import { cn } from "./kit";
import { COVERAGE_LABEL, STATE_DOT } from "./coverage-words";
import { SpeedMark, type HeatMark } from "./map-speed";
import styles from "./app-map.module.css";
import { coverOf } from "./coverage-model";
import { OTHER_REGION, PORT, REGION_HEAD, type BandKey, type DataGroup, type Port, type Region } from "./layout";
import { endpointTitle, farTitle, frameSrc, knownFrom, lodFor, nearTitleSize, nodeSources, plural, quoteLabel, statusBarCrop, truncate, zoomStep, type Lod } from "./model";
import { budgetLeft, clock, type CrawlTarget, type QueueMark } from "./live-reveal";
import { CoverMark } from "./map-coverage";
import { blockedText, SIDE_LABEL, STORE_LABEL, type AppMapNode, type EvidenceSource } from "./types";

/** The level of detail for the canvas's zoom. Re-renders only when the level changes. */
export function useLod(): Lod {
  return useStore((s) => lodFor(s.transform[2]));
}

/** The canvas's zoom in quarter steps (`zoomStep`), for text that keeps its size on screen. */
function useZoomStep(): number {
  return useStore((s) => zoomStep(s.transform[2]));
}

/** Edges are drawn from the layout's routes, so the handles only have to exist. */
function Handles() {
  const hidden = "!pointer-events-none !h-px !w-px !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0";
  return (
    <>
      <Handle type="target" position={Position.Left} className={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Right} className={hidden} isConnectable={false} />
    </>
  );
}

export interface RegionNodeData extends Record<string, unknown> {
  region: Region;
  lit: boolean;
  selected: boolean;
  /** With the speed overlay on: how many of its timed screens are slow, getting slow and
   * fast enough, so a region shows its speed from afar, where the cards are not drawn. */
  heat?: RegionHeat | null;
}

export interface RegionHeat {
  slow: number;
  warm: number;
  ok: number;
}

/** "2 slow · 1 getting slow", "3 fast enough": a region's timed screens, worst first. */
function regionHeatWords(h: RegionHeat): { heat: "slow" | "warm" | "ok"; words: string } {
  const parts = [h.slow ? `${h.slow} slow` : null, h.warm ? `${h.warm} getting slow` : null].filter(Boolean) as string[];
  if (parts.length) return { heat: h.slow ? "slow" : "warm", words: parts.join(" · ") };
  return { heat: "ok", words: `${h.ok} fast enough` };
}

function RegionHeatMark({ heat, far }: { heat: RegionHeat | null | undefined; far?: boolean }) {
  if (!heat || heat.slow + heat.warm + heat.ok === 0) return null;
  const { heat: worst, words } = regionHeatWords(heat);
  return (
    <span className={far ? styles.regionHeatFar : styles.regionHeat} data-heat={worst} data-map-region-heat={worst}>
      <span aria-hidden className={styles.regionHeatDot} />
      <span className="sr-only">Speed: </span>
      {words}
    </span>
  );
}

/** "38 screens not tied to a feature", "14 small features · 22 screens", "4 of 6 screens seen". */
function regionLine(r: Region): string {
  if (r.collapsed && r.kind === "other") return `${plural(r.screens, "screen")} not tied to a feature`;
  if (r.collapsed) return `${plural(r.members.length, "small feature")} · ${plural(r.screens, "screen")}`;
  return r.screens ? `${r.seen} of ${plural(r.screens, "screen")} seen` : "No screens known yet";
}

/** Closer in, the line under a region's name: how much is seen and what is left. */
function regionSubline(r: Region): string {
  const parts = [regionLine(r)];
  if (!r.collapsed && r.declared) parts.push(`${r.declared} not reached yet`);
  if (!r.collapsed && r.blocked) parts.push(`${r.blocked} blocked`);
  return parts.join(" · ");
}

/** One feature: zoomed out, its name and how much of it runs have seen, sized to read on screen
 * whatever the zoom; closer in, a labelled territory the screen cards stand in, its name, coverage
 * and cover bar on one line over how much is seen. "Other areas" and a long "Other screens" start
 * as summary cards that open in place: their Show and Fold buttons are handled by the canvas's
 * node click (`data-map-region-open`, `data-map-region-fold`). */
export function RegionNode({ data }: NodeProps) {
  const { region: r, lit, selected, heat } = data as RegionNodeData;
  const lod = useLod();
  const zoom = useZoomStep();
  const share = r.screens ? r.seen / r.screens : 0;
  const line = regionLine(r);
  const bar = (className?: string) =>
    r.screens ? (
      <div className={cn(styles.regionBar, className)} aria-hidden data-map-region-bar>
        <span style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
    ) : null;
  const fog = r.screens ? 1 - share : 0;
  if (lod === "far") {
    const title = farTitle(r.label, r.w, r.h, zoom);
    return (
      <div className={cn(styles.region, !lit && styles.dim)} data-coverage={r.coverage} data-kind={r.kind} data-lod={lod} data-selected={selected ? "true" : "false"} data-map-region={r.key}>
        <Handles />
        <div className={styles.regionFar} style={{ fontSize: title.size }}>
          <p className={styles.regionFarLabel} title={r.label}>
            {r.label}
          </p>
          <p className={styles.regionFarMeta}>{line}</p>
          <RegionHeatMark heat={heat} far />
          {bar()}
        </div>
      </div>
    );
  }
  const titlePx = nearTitleSize(zoom);
  return (
    <div
      className={cn(styles.region, !lit && styles.dim)}
      style={{ "--fog": fog.toFixed(2) } as CSSProperties}
      data-coverage={r.coverage}
      data-kind={r.kind}
      data-lod={lod}
      data-selected={selected ? "true" : "false"}
      data-map-region={r.key}
    >
      <Handles />
      <div className={styles.regionHead}>
        <div className="flex min-w-0 items-center gap-2.5">
          <p className="min-w-0 truncate font-semibold tracking-[-0.01em] text-fg" style={{ fontSize: titlePx, lineHeight: 1.2 }} title={r.label}>
            {r.label}
          </p>
          {r.kind !== "other" && !r.collapsed ? (
            <span className={styles.coveragePill} data-map-region-coverage={r.coverage}>
              <span className={cn("size-2 rounded-full", STATE_DOT[r.coverage])} aria-hidden />
              {COVERAGE_LABEL[r.coverage]}
            </span>
          ) : null}
          <RegionHeatMark heat={heat} />
          <span className="min-w-4 flex-1" />
          {r.fold ? (
            <button type="button" className={styles.regionToggle} title={r.fold === OTHER_REGION ? "Fold back into a summary card" : "Fold back into Other areas"} data-map-region-fold={r.fold}>
              <ChevronsDownUp className="size-3.5" aria-hidden />
              Fold
            </button>
          ) : r.collapsed ? null : (
            bar(styles.headBar)
          )}
        </div>
        <p className="mt-1 truncate text-[13px] tabular-nums text-fg-2">{r.collapsed ? line : regionSubline(r)}</p>
      </div>
      {r.collapsed ? (
        <div className="absolute inset-x-6 bottom-6 flex flex-col gap-3" style={{ top: REGION_HEAD + 8 }}>
          {r.summary ? <p className="line-clamp-3 text-[14px] leading-5 text-fg-2">{r.summary}</p> : null}
          <div className="mt-auto flex flex-col gap-3">
            {bar()}
            <button type="button" className={cn(styles.regionToggle, "self-start")} data-map-region-open={r.key}>
              <ChevronsUpDown className="size-3.5" aria-hidden />
              {r.kind === "areas" ? `Show ${plural(r.members.length, "feature")}` : `Show ${plural(r.screens, "screen")}`}
            </button>
          </div>
        </div>
      ) : r.screens === 0 ? (
        <p className="absolute inset-x-0 bottom-1/3 text-center text-[13px] text-muted">No run or file has shown a screen here yet.</p>
      ) : null}
    </div>
  );
}

const SOURCE_ICON: Record<EvidenceSource, typeof FileCode2> = { code: FileCode2, tests: FlaskConical, live: Radio };
const SOURCE_NAME: Record<EvidenceSource, string> = { code: "code", tests: "existing tests", live: "a run" };

/** Which of the three sources back a node: each one's mark in full ink when it knows the screen,
 * faint when it says nothing. */
function SourceMarks({ node, className }: { node: AppMapNode; className?: string }) {
  const has = nodeSources(node);
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} aria-label={`Known from ${has.map((s) => SOURCE_NAME[s]).join(", ") || "no source"}`} data-map-sources={has.join(" ")}>
      {(Object.keys(SOURCE_ICON) as EvidenceSource[]).map((s) => {
        const Icon = SOURCE_ICON[s];
        const on = has.includes(s);
        return <Icon key={s} className={cn("size-3.5", on ? styles.sourceOn : styles.sourceOff)} strokeWidth={on ? 2 : 1.75} aria-hidden data-on={on ? "true" : "false"} />;
      })}
    </span>
  );
}

/** A frame without the device's status bar (`statusBarCrop`): the screen starts at its content.
 * The crop is known from the platform, or from the frame's shape once it has loaded. */
function Frame({ src, alt, platform, thumb = false }: { src: string; alt: string; platform: string | null | undefined; thumb?: boolean }) {
  const [crop, setCrop] = useState<number | null>(() => (platform === "web" || platform === "desktop" ? 0 : null));
  return (
    <img
      src={src}
      alt={alt}
      aria-hidden={thumb || undefined}
      loading="lazy"
      decoding="async"
      {...(thumb ? { fetchpriority: "low" } : {})}
      draggable={false}
      className={styles.frameImg}
      style={crop ? { transform: `translateY(-${(crop * 100).toFixed(2)}%)` } : undefined}
      data-map-thumb={thumb || undefined}
      data-crop={crop ?? undefined}
      onLoad={(e) => {
        if (crop !== null) return;
        const img = e.currentTarget;
        setCrop(statusBarCrop(img.naturalWidth, img.naturalHeight, platform));
      }}
    />
  );
}

export interface ScreenCardData extends Record<string, unknown> {
  node: AppMapNode;
  lit: boolean;
  selected: boolean;
  /** 1-based place in the picked flow (Tests layer), or null. */
  flowStep: number | null;
  /** Entrance stagger, ms. */
  delay: number;
  /** Just reached by a Map the app crawl: it lifts out of the fog with a short pulse. */
  revealed?: boolean;
  /** Its place in a planned crawl's queue: the target the crawl is on, or one of the next. */
  crawl?: QueueMark | null;
  /** The speed overlay's mark: its heat and newest time, when the overlay is on. */
  heat?: HeatMark | null;
}

/** How far the budget ring sits outside the card. */
const RING_PAD = 5;

/** A clock that ticks every `ms` while the component is mounted. */
function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** The current target's budget: a thin indigo ring around the card that runs down as its time
 * does (the warning colour in its last 10 s), and "Now · 0:18" over its top edge. Only this card
 * ticks, once a second. */
function CrawlRing({ target, width, height }: { target: CrawlTarget; width?: number; height?: number }) {
  const now = useTick(1000);
  const left = budgetLeft(target, now);
  const warn = left !== null && left.left_s <= 10;
  const w = width ? width + 2 * RING_PAD : 0;
  const h = height ? height + 2 * RING_PAD : 0;
  return (
    <>
      {w && h ? (
        <svg className={styles.crawlRing} width={w} height={h} style={{ left: -RING_PAD, top: -RING_PAD }} data-warning={warn || undefined} aria-hidden>
          <rect className={styles.crawlRingTrack} x={1} y={1} width={w - 2} height={h - 2} rx={16} />
          {left ? (
            <rect
              className={styles.crawlRingLeft}
              x={1}
              y={1}
              width={w - 2}
              height={h - 2}
              rx={16}
              pathLength={100}
              strokeDasharray="100 100"
              strokeDashoffset={(100 * (1 - left.fraction)).toFixed(2)}
              data-crawl-budget={left.left_s}
            />
          ) : null}
        </svg>
      ) : null}
      <span className={styles.crawlNow} data-warning={warn || undefined} data-crawl-now>
        {left ? `Now · ${clock(left.left_s)}` : "Now"}
      </span>
    </>
  );
}

/** One screen. A seen screen is a frame card: its frame (from under the status bar), its name,
 * a footer with its coverage and sources, and its actions. One no run has reached is a compact
 * ghost: its name, "Not reached yet" (or why it is blocked) and where it is known from. In the
 * middle distance both say the same in large type. */
export function ScreenCardNode({ data, width, height, positionAbsoluteX }: NodeProps) {
  const { node: n, lit, selected, flowStep, delay, revealed, crawl, heat } = data as ScreenCardData;
  const lod = useLod();
  const src = frameSrc(n.frame_url);
  const runs = n.evidence.live?.runs ?? 0;
  const ghost = n.state !== "seen";
  const stateLine = n.state === "seen" ? (runs ? `Seen in ${plural(runs, "run")}` : "Seen") : n.state === "blocked" ? (blockedText(n) ?? "Blocked") : "Not reached yet";
  const StateIcon = n.state === "seen" ? Eye : n.state === "blocked" ? Lock : CircleDashed;
  const from = knownFrom(n);
  const covered = coverOf(n).length;
  return (
    <div
      className={cn(styles.card, !lit && styles.dim, revealed && styles.revealed, crawl?.role === "current" && styles.crawlCurrent)}
      style={{ "--d": `${delay}ms` } as CSSProperties}
      data-state={n.state}
      data-crawl-role={crawl?.role}
      data-crawl-order={crawl?.role === "next" ? crawl.order : undefined}
      data-ghost={ghost ? "true" : undefined}
      data-revealed={revealed ? "true" : undefined}
      data-selected={selected ? "true" : "false"}
      data-flow-step={flowStep ?? undefined}
      data-map-screen={n.key}
      data-heat={heat?.heat}
    >
      <Handles />
      {heat ? <SpeedMark mark={heat} x={positionAbsoluteX} /> : null}
      {crawl?.role === "current" ? <CrawlRing target={crawl.target} width={width} height={height} /> : null}
      {flowStep ? (
        <span className={styles.flowBadge} style={{ "--d": `${(flowStep - 1) * 700}ms` } as CSSProperties}>
          {flowStep}
        </span>
      ) : null}
      <div className={styles.cardBox}>
        {ghost ? (
          lod === "near" ? (
            <div className="flex h-full flex-col justify-between px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <StateIcon className={cn("size-3.5 shrink-0", n.state === "blocked" ? "text-warning" : "text-muted")} aria-hidden />
                <span className="truncate text-[13px] font-medium leading-5 text-fg" title={n.label}>
                  {n.label}
                </span>
              </div>
              <p className="truncate text-[11px] leading-4 text-fg-2" title={stateLine}>
                {stateLine}
              </p>
              <div className="flex min-w-0 items-center justify-between gap-2 text-[10px] leading-4 text-muted">
                {from ? (
                  <span className="inline-flex min-w-0 items-center gap-1 truncate" data-map-known-from>
                    <FileCode2 className="size-3 shrink-0" aria-hidden />
                    {from}
                  </span>
                ) : (
                  <span />
                )}
                {covered ? <CoverMark node={n} className="shrink-0 text-[10px]" /> : null}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-w-0 items-start gap-2 px-3.5 py-3">
              <StateIcon className={cn("mt-[3px] size-4 shrink-0", n.state === "blocked" ? "text-warning" : "text-muted")} aria-hidden />
              <div className="min-w-0">
                <p className="line-clamp-2 text-[17px] font-semibold leading-[22px] text-fg">{n.label}</p>
                <p className="mt-0.5 truncate text-[13px] leading-4 text-fg-2">{stateLine}</p>
              </div>
            </div>
          )
        ) : lod === "near" ? (
          <>
            <div className={cn(styles.frame, "h-[96px]")}>
              {src ? <Frame src={src} alt={n.label} platform={n.detail.platform} /> : <Eye className="m-auto size-5 text-muted" aria-hidden />}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-2.5 pb-2 pt-2">
              <span className="truncate text-[13px] font-medium leading-[18px] text-fg" title={n.label}>
                {n.label}
              </span>
              <div className="flex items-center justify-between gap-2">
                <CoverMark node={n} className={styles.coverChip} />
                <SourceMarks node={n} className="shrink-0" />
              </div>
              <div className="flex min-w-0 gap-1 overflow-hidden">
                {n.detail.actions.length ? (
                  n.detail.actions.slice(0, 3).map((a) => (
                    <span key={a} className="max-w-full shrink-0 truncate rounded-xs bg-panel-2 px-1.5 text-[10px] leading-4 text-fg-2 last:shrink">
                      {quoteLabel(a)}
                    </span>
                  ))
                ) : (
                  <span className={cn("truncate text-[10px] leading-4 text-muted", n.detail.route && "font-mono")}>{n.detail.route ?? stateLine}</span>
                )}
              </div>
            </div>
          </>
        ) : src ? (
          // In the middle distance a seen screen shows its frame already, small: the browser fetches
          // it only once the card is near the viewport.
          <>
            <div className={cn(styles.frame, "h-[72px]")}>
              <Frame src={src} alt="" platform={n.detail.platform} thumb />
            </div>
            <div className="flex min-h-0 flex-1 flex-col justify-end px-3.5 pb-3 pt-2">
              <p className="line-clamp-2 text-[20px] font-semibold leading-6 text-fg">{n.label}</p>
              <p className="mt-1 truncate text-[15px] text-fg-2">{stateLine}</p>
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col justify-between p-4">
            <StateIcon className="size-7 text-[var(--cov-strong)]" aria-hidden />
            <div className="min-w-0">
              <p className="line-clamp-2 text-[22px] font-semibold leading-7 text-fg">{n.label}</p>
              <p className="mt-1 truncate text-[15px] text-fg-2">{stateLine}</p>
              <CoverMark node={n} className="mt-1 text-[13px] [&_svg]:size-3.5" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export interface PortNodeData extends Record<string, unknown> {
  port: Port;
  /** Hovered, or holding a line of the screen in focus. */
  active: boolean;
  lit: boolean;
}

/** Where a region's navigation to another region leaves and arrives, on its bottom border: the
 * way users go, the other region's name and how many lines it stands for. Hovering it draws them;
 * a click flies to that region. */
export function PortNode({ data }: NodeProps) {
  const { port: p, active, lit } = data as PortNodeData;
  const Icon = p.out && p.in ? ArrowLeftRight : p.out ? ArrowRight : ArrowLeft;
  const way = p.out && p.in ? "To and from" : p.out ? "To" : "From";
  const lines = plural(p.count, "line");
  return (
    <div
      className={cn(styles.port, !lit && styles.dim)}
      data-active={active ? "true" : undefined}
      data-map-port={p.to ?? "~more"}
      title={p.to ? `${way} ${p.label}: ${lines}. Hover to see them, click to go there.` : `${lines} to and from ${p.label.replace(/^\+/, "")} other features. Hover to see them.`}
    >
      <Handles />
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{p.to ? truncate(p.label, PORT.maxChars) : p.label}</span>
      {p.to ? <span className="shrink-0 tabular-nums text-muted">· {p.count}</span> : null}
    </div>
  );
}

export interface PillData extends Record<string, unknown> {
  node: AppMapNode;
  lit: boolean;
  selected: boolean;
  delay: number;
}

/** A screen, endpoint or entity in the data-flow layer. */
export function PillNode({ data }: NodeProps) {
  const { node: n, lit, selected, delay } = data as PillData;
  return (
    <div
      className={cn(styles.pill, !lit && styles.dim)}
      style={{ "--d": `${delay}ms` } as CSSProperties}
      data-state={n.state}
      data-selected={selected ? "true" : "false"}
      data-map-pill={n.kind}
      title={n.kind === "endpoint" ? endpointTitle(n) : n.label}
    >
      <Handles />
      {n.kind === "endpoint" ? (
        <>
          <span className={styles.method} data-method={n.detail.method ?? ""}>
            {n.detail.method ?? "API"}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{n.detail.pattern ?? n.label}</span>
          {n.detail.side ? <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] leading-4 text-fg-2">{SIDE_LABEL[n.detail.side]}</span> : null}
        </>
      ) : n.kind === "entity" ? (
        <>
          <Database className="size-4 shrink-0 text-fg-2" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{n.label}</span>
          {n.detail.store ? <span className="shrink-0 rounded-full bg-panel-2 px-1.5 text-[10px] leading-4 text-fg-2">{STORE_LABEL[n.detail.store]}</span> : null}
        </>
      ) : (
        <>
          <Smartphone className="size-4 shrink-0 text-fg-2" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{n.label}</span>
          <span className={cn("size-2 shrink-0 rounded-full", n.state === "seen" ? "bg-[var(--cov-strong)]" : n.state === "blocked" ? "bg-warning" : "border border-dashed border-[var(--cov-untested)]")} aria-hidden />
        </>
      )}
    </div>
  );
}

export interface PrefixData extends Record<string, unknown> {
  label: string;
  count: number;
  /** An open group of a folded band: its id, for the Fold button (`data-map-group-fold`). */
  fold?: string | null;
  band?: "screens" | "endpoints";
}

/** The endpoints under one path prefix (or, opened from a folded band, one feature's screens): a
 * frame its members stand in. */
export function PrefixNode({ data }: NodeProps) {
  const { label, count, fold, band } = data as PrefixData;
  return (
    <div className={styles.prefix} data-map-group-open={fold ?? undefined}>
      <Handles />
      <div className="flex items-center justify-between gap-2 px-3.5 pt-1.5">
        <p className={cn("min-w-0 truncate text-[11px] text-fg-2", band !== "screens" && "font-mono")}>
          {label} <span className="text-muted">· {count}</span>
        </p>
        {fold ? (
          <button type="button" className={cn(styles.regionToggle, "!h-5 !px-1.5 !text-[11px]")} title="Fold back into one box" data-map-group-fold={fold}>
            <ChevronsDownUp className="size-3" aria-hidden />
            Fold
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface DataGroupData extends Record<string, unknown> {
  group: DataGroup;
  lit: boolean;
  /** Hovered or picked, or holding what is. */
  active: boolean;
  delay: number;
}

/** A folded group of the data-flow layer: one feature's screens, or the endpoints under one path
 * prefix with their method mix and where they are called and served. A click opens it in place. */
export function DataGroupNode({ data }: NodeProps) {
  const { group: g, lit, active, delay } = data as DataGroupData;
  const endpoints = g.band === "endpoints";
  return (
    <div
      className={cn(styles.pill, styles.groupBox, !lit && styles.dim)}
      style={{ "--d": `${delay}ms` } as CSSProperties}
      data-active={active ? "true" : undefined}
      data-map-data-group={g.id}
      title={endpoints ? `${g.label}: ${plural(g.count, "endpoint")}. Click to show them.` : `${g.label}: ${plural(g.count, "screen")}. Click to show them.`}
    >
      <Handles />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {endpoints ? <Server className="size-3.5 shrink-0 text-fg-2" aria-hidden /> : <Layers className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
          <span className={cn("min-w-0 flex-1 truncate text-fg", endpoints ? "font-mono text-[12px]" : "text-[13px] font-medium")}>{g.label}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted" aria-hidden />
        </div>
        <p className="truncate text-[11px] tabular-nums text-fg-2">
          {endpoints ? plural(g.count, "endpoint") : `${plural(g.count, "screen")} · ${g.seen} seen`}
          {endpoints && g.sides.length ? <span className="text-muted"> · {g.sides.map(([side, n]) => `${SIDE_LABEL[side]} ${n}`).join(", ")}</span> : null}
        </p>
        {endpoints ? (
          <div className="flex min-w-0 gap-1 overflow-hidden">
            {g.methods.slice(0, 4).map(([m, n]) => (
              <span key={m} className={styles.method} data-method={m}>
                {m} {n}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const BAND_LABEL: Record<BandKey, string> = { screens: "Screens", endpoints: "Endpoints", entities: "Data" };

export interface BandData extends Record<string, unknown> {
  band: BandKey;
  /** A slim band whose note (`NoteNode`) says it all: no label. */
  quiet?: boolean;
}

/** One band of the data-flow layer, labelled at its left edge. */
export function BandNode({ data }: NodeProps) {
  const { band, quiet } = data as BandData;
  return (
    <div className={styles.band} data-quiet={quiet ? "true" : undefined}>
      <Handles />
      {quiet ? null : <p className="px-4 pt-2.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted">{BAND_LABEL[band]}</p>}
    </div>
  );
}

export interface NoteData extends Record<string, unknown> {
  text: string;
}

/** A one-line note on the canvas, over the edges that pass under it. */
export function NoteNode({ data }: NodeProps) {
  const { text } = data as NoteData;
  return (
    <div className={styles.note} data-map-note>
      {text}
    </div>
  );
}

export interface FogData extends Record<string, unknown> {
  src: string | null;
}

/** The fog over what no run has reached, painted once into a bitmap (coverage `fog-paint.ts`). It
 * lies under the see-through regions, the edges and the cards. */
export function FogNode({ data }: NodeProps) {
  const { src } = data as FogData;
  if (!src) return null;
  return <img src={src} alt="" aria-hidden draggable={false} className="pointer-events-none h-full w-full select-none opacity-90" data-map-fog />;
}

export const mapNodeTypes = { region: RegionNode, screen: ScreenCardNode, port: PortNode, pill: PillNode, prefix: PrefixNode, dataGroup: DataGroupNode, band: BandNode, note: NoteNode, fog: FogNode };

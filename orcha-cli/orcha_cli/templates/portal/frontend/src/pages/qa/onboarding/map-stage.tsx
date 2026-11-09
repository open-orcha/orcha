import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type PointerEvent } from "react";
import { ImageLightbox } from "./ui";
import { usePrefersReducedMotion } from "./ui";
import { cn } from "./ui";
import { advancePlan, animating, emptyPlan, type Plan } from "./choreo";
import { frameworkName, type MapScreen, type OnboardingMap } from "./contract";
import { outcomeOf, resultWords } from "./first-run-result";
import { drawMap, readPalette, type Camera, type Palette, type StageMode } from "./draw";
import { computeLayout, MAX_SCALE, neighbour, nodeAt, stageHeight, type MapLayout, type NodeBox } from "./layout";
import styles from "./onboarding-map.module.css";

const GLIDE_MS = 520;
const CAMERA_MS = 620;

/** Frame timings the Playwright proof reads (`window.__ONB_PERF__ = {}` turns it on). */
interface PerfSink {
  frames?: number[];
  draws?: number[];
}
declare global {
  interface Window {
    __ONB_PERF__?: PerfSink;
  }
}

/** What a screen's label says about the first run that landed on it (#486). */
const RUN_WORDS = {
  passed: ", first test passed",
  failed: ", first test did not pass",
  unchecked: ", first test could not be checked",
  setup_failed: ", the starting state could not be set up here",
  error: ", first run could not finish",
} as const;

/** What a screen is, in one sentence (the keyboard announcement and the tooltip's status). */
export function describeScreen(s: MapScreen): string {
  const seen = s.source === "code" ? "found in the code" : "seen on the device";
  const cov =
    s.coverage === "your_tests"
      ? `covered by ${s.tests.length} of your ${s.tests.length === 1 ? "tests" : "tests"}`
      : s.coverage === "qa"
        ? "covered by Embodent"
        : s.coverage === "both"
          ? "covered by your tests and Embodent"
          : "not covered";
  const run = s.first_run ? (s.first_run.verdict === "running" || s.first_run.verdict === "queued" ? ", first test running" : RUN_WORDS[outcomeOf(s.first_run)]) : "";
  return `${s.name}, ${seen}, ${cov}${run}.`;
}

/**
 * The map on a canvas: the file tree, the screens in their areas, the endpoints, and the
 * cinematic between them. Keyboard: the stage is one tab stop; arrows move between screens,
 * Home and End jump, Enter selects, Escape clears; each move is announced. The pointer shows a
 * screen's tests and their evidence on hover. With no selection to drive (the Map step), a click or
 * Enter opens a seen screen's screenshot full size.
 */
export function MapStage({
  map,
  planRef,
  mode,
  label,
  highlight = null,
  focusId = null,
  onFocusChange,
  onSelect,
  zoomTo = null,
  pulseId = null,
  height,
}: {
  map: OnboardingMap;
  /** The cinematic's plan, kept by the flow so a remount (Coverage, Back) does not replay it. */
  planRef: MutableRefObject<Plan | null>;
  mode: StageMode;
  label: string;
  highlight?: ReadonlySet<string> | null;
  focusId?: string | null;
  onFocusChange?: (id: string | null) => void;
  onSelect?: (id: string) => void;
  /** Glide the camera onto this screen (a gap clicked in the list); null shows everything. */
  zoomTo?: string | null;
  pulseId?: string | null;
  height?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [localFocus, setLocalFocus] = useState<string | null>(null);
  const focus = focusId ?? localFocus;
  const [said, setSaid] = useState("");
  // The focused screen's card shows only while the stage has the keyboard focus (a screen
  // focused from outside, a gap or the first run, is shown on the map without covering it).
  const [inside, setInside] = useState(false);
  // Without a selection to drive (the Map step), opening a screen shows its screenshot full size.
  const [viewing, setViewing] = useState<string | null>(null);
  const descId = useId();
  const h = height ?? stageHeight(map.screens.length);

  const screens = useMemo(() => new Map(map.screens.map((s) => [s.id, s])), [map.screens]);
  // The layout follows the map's shape (which screens, files and links), not every update of
  // a screen's data: a thumbnail or a coverage change repaints, it never re-packs.
  const shapeKey = `${map.screens.map((s) => s.id).join("|")}#${map.files.length}#${map.edges.length}`;
  // As the map grows its screens only ever get smaller (never zoom back in when a new batch
  // packs better): the cap is the last scale drawn at this size.
  const [cap, setCap] = useState({ key: "", value: MAX_SCALE });
  const capKey = `${width}x${h}`;
  const maxScale = cap.key === capKey ? cap.value : MAX_SCALE;
  const layout = useMemo<MapLayout | null>(() => {
    if (width <= 0) return null;
    return computeLayout({ screens: map.screens, files: map.files, edges: map.edges, found: map.found }, width, h, maxScale);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-pack on the map's shape only (shapeKey)
  }, [shapeKey, width, h, maxScale]);
  // Adjusted while rendering (React's "storing information from previous renders"): it settles in
  // one extra pass, since a layout at the new cap packs the same.
  if (layout && (cap.key !== capKey || layout.scale < cap.value - 1e-3)) setCap({ key: capKey, value: layout.scale });

  // Everything the frame loop reads lives in one ref, refreshed after each render.
  const live = useRef({
    layout: null as MapLayout | null,
    screens,
    mode,
    hover: null as string | null,
    focus: null as string | null,
    highlight,
    pulseId,
    palette: null as Palette | null,
    images: new Map<string, HTMLImageElement | HTMLCanvasElement>(),
    glideFrom: new Map<string, NodeBox>(),
    glideAt: 0,
    camera: { s: 1, x: 0, y: 0 } as Camera,
    camFrom: { s: 1, x: 0, y: 0 } as Camera,
    camTo: { s: 1, x: 0, y: 0 } as Camera,
    camAt: 0,
    raf: 0,
    kick: () => {},
  });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The palette follows the theme and the accent (both are attributes on <html>).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => {
      live.current.palette = readPalette(el);
      live.current.kick();
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-accent", "data-design"] });
    return () => mo.disconnect();
  }, []);

  // New data: extend the plan (a first mount past the Map step shows the map settled).
  useEffect(() => {
    const now = performance.now();
    const fresh = planRef.current === null || planRef.current.reduced !== reduced;
    const base = fresh ? emptyPlan(reduced) : planRef.current!;
    planRef.current = advancePlan(base, map, now, fresh && mode !== "build");
    for (const s of map.screens) {
      if (s.thumbnail && !live.current.images.has(s.thumbnail)) {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => {
          live.current.images.set(`${s.thumbnail}#grey`, greyCopy(img));
          live.current.kick();
        };
        img.src = s.thumbnail;
        live.current.images.set(s.thumbnail, img);
      }
    }
    live.current.kick();
  }, [map, mode, reduced, planRef]);

  // A new layout: every screen glides from where it was to where it now belongs.
  useEffect(() => {
    const L = live.current;
    const prev = L.layout;
    if (prev && layout && !reduced) {
      const from = new Map<string, NodeBox>();
      const now = performance.now();
      for (const [id, b] of prev.nodes) from.set(id, currentBox(L, id, now) ?? b);
      L.glideFrom = from;
      L.glideAt = now;
    }
    L.layout = layout;
    L.kick();
  }, [layout, reduced]);

  // The camera: onto a screen, or back out to everything.
  const camera = useMemo<Camera>(() => {
    const b = zoomTo && layout ? layout.nodes.get(zoomTo) : null;
    if (!b || !layout) return { s: 1, x: 0, y: 0 };
    const s = Math.max(1, Math.min(2.2, 96 / b.w));
    const cx = layout.graph.x + layout.graph.w / 2;
    const cy = layout.graph.y + layout.graph.h / 2;
    return { s, x: cx - (b.x + b.w / 2) * s, y: cy - (b.y + b.h / 2) * s };
  }, [zoomTo, layout]);
  useEffect(() => {
    const L = live.current;
    L.camFrom = { ...L.camera };
    L.camTo = camera;
    L.camAt = reduced ? -Infinity : performance.now();
    L.kick();
  }, [camera, reduced]);

  useEffect(() => {
    const L = live.current;
    L.screens = screens;
    L.mode = mode;
    L.hover = hover;
    L.focus = focus;
    L.highlight = highlight;
    L.pulseId = pulseId;
    L.kick();
  });

  // The frame loop: runs while something moves, then stops; anything new kicks it again.
  useEffect(() => {
    const L = live.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let last = 0;
    const frame = (now: number) => {
      L.raf = 0;
      const lay = L.layout;
      const plan = planRef.current;
      if (!lay || !plan || !L.palette) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(lay.width * dpr);
      const H = Math.round(lay.height * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const camT = Math.min(1, (now - L.camAt) / CAMERA_MS);
      const ce = 1 - Math.pow(1 - camT, 3);
      L.camera = {
        s: L.camFrom.s + (L.camTo.s - L.camFrom.s) * ce,
        x: L.camFrom.x + (L.camTo.x - L.camFrom.x) * ce,
        y: L.camFrom.y + (L.camTo.y - L.camFrom.y) * ce,
      };
      const gliding = now - L.glideAt < GLIDE_MS;
      const boxes = gliding ? glidedBoxes(L, now) : lay.nodes;
      const perf = window.__ONB_PERF__;
      const t0 = perf ? performance.now() : 0;
      drawMap(ctx, {
        layout: lay,
        boxes,
        plan,
        now,
        palette: L.palette,
        mode: L.mode,
        screens: L.screens,
        images: L.images,
        hover: L.hover,
        focus: L.focus,
        highlight: L.highlight,
        pulseId: L.pulseId,
        camera: L.camera,
        dpr,
      });
      if (perf) {
        (perf.draws ??= []).push(performance.now() - t0);
        if (last) (perf.frames ??= []).push(now - last);
      }
      last = now;
      const running = [...L.screens.values()].some((s) => s.first_run && (s.first_run.verdict === "running" || s.first_run.verdict === "queued"));
      if (animating(plan, now) || gliding || camT < 1 || (running && !plan.reduced)) L.raf = requestAnimationFrame(frame);
      else last = 0;
    };
    L.kick = () => {
      if (!L.raf) L.raf = requestAnimationFrame(frame);
    };
    L.kick();
    return () => {
      cancelAnimationFrame(L.raf);
      L.raf = 0;
      L.kick = () => {};
    };
  }, [planRef]);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cam = live.current.camera;
    return [(clientX - rect.left - cam.x) / cam.s, (clientY - rect.top - cam.y) / cam.s] as const;
  };

  function onPointerMove(e: PointerEvent<HTMLCanvasElement>) {
    if (!layout) return;
    const [x, y] = toWorld(e.clientX, e.clientY);
    const id = nodeAt(layout, x, y);
    const shown = id && planRef.current?.nodeIn.has(id) ? id : null;
    if (shown !== hover) setHover(shown);
  }

  /** A screen opened (click, Enter): the step's selection when it has one, else its screenshot. */
  function open(id: string) {
    if (onSelect) onSelect(id);
    else if (screens.get(id)?.thumbnail) setViewing(id);
  }
  const opens = (id: string | null) => !!id && (!!onSelect || !!screens.get(id)?.thumbnail);

  function moveFocus(id: string | null) {
    if (onFocusChange) onFocusChange(id);
    else setLocalFocus(id);
    const s = id ? screens.get(id) : null;
    setSaid(s ? describeScreen(s) : "");
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!layout) return;
    const dir = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Home: "home", End: "end" } as const)[e.key as "ArrowLeft"];
    if (dir) {
      e.preventDefault();
      moveFocus(neighbour(layout, focus, dir));
    } else if ((e.key === "Enter" || e.key === " ") && focus) {
      e.preventDefault();
      open(focus);
    } else if (e.key === "Escape" && focus) {
      e.preventDefault();
      moveFocus(null);
    }
  }

  const tipId = hover ?? (inside ? focus : null);
  const viewingScreen = viewing ? screens.get(viewing) : null;
  const tipScreen = tipId ? screens.get(tipId) : null;
  const tipBox = tipId && layout ? layout.nodes.get(tipId) : null;
  const areas = useMemo(() => {
    const by = new Map<string, number>();
    for (const s of map.screens) {
      const k = s.route?.split("/").filter(Boolean)[0] ?? "other";
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    return by.size;
  }, [map.screens]);

  return (
    <div
      ref={wrapRef}
      className={styles.stage}
      style={{ height: h }}
      tabIndex={0}
      role="application"
      aria-roledescription="map"
      aria-label={label}
      aria-describedby={descId}
      onKeyDown={onKeyDown}
      onFocus={() => setInside(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setHover(null);
          setInside(false);
        }
      }}
      data-onboarding-map-stage={mode}
      data-screens={map.screens.length}
    >
      <p id={descId} className="sr-only">
        {map.screens.length} screens in {areas} {areas === 1 ? "area" : "areas"}. Use the arrow keys to move between screens, Enter to open one, Escape to leave.
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {said}
      </p>
      {layout?.tree ? (
        <span className={styles.colHead} style={{ left: 12 }}>
          {map.found.repo.name || "Repository"}
        </span>
      ) : null}
      {layout ? (
        <span className={styles.colHead} style={{ left: layout.graph.x }}>
          Screens
        </span>
      ) : null}
      {layout?.rail ? (
        <span className={styles.colHead} style={{ left: layout.rail.x }}>
          Endpoints
        </span>
      ) : null}
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        style={{ height: h, cursor: opens(hover) ? (onSelect ? "pointer" : "zoom-in") : "default" }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onClick={() => {
          if (hover) {
            moveFocus(hover);
            open(hover);
          }
        }}
        aria-hidden
      />
      {tipScreen && tipBox && layout && !viewing ? <ScreenTip screen={tipScreen} box={tipBox} layout={layout} camera={camera} /> : null}
      {viewingScreen?.thumbnail ? (
        <ImageLightbox
          open
          onClose={() => setViewing(null)}
          src={viewingScreen.thumbnail}
          alt={`${viewingScreen.name}, as the device saw it`}
          title={viewingScreen.name}
          description={[viewingScreen.route ?? viewingScreen.files[0], platformName(viewingScreen.platform)].filter(Boolean).join(" · ")}
          dataAttrs={{ "data-onboarding-map-screenshot": viewingScreen.id }}
        />
      ) : null}
    </div>
  );
}

function platformName(platform?: string): string {
  return platform === "ios" ? "iOS" : platform === "android" ? "Android" : platform ? "Web" : "";
}

/** A small grey copy of a screenshot, made once when it loads (never per frame). */
function greyCopy(img: HTMLImageElement): HTMLCanvasElement | HTMLImageElement {
  const c = document.createElement("canvas");
  c.width = Math.min(140, img.naturalWidth || 140);
  c.height = Math.round((c.width * (img.naturalHeight || 200)) / (img.naturalWidth || 140));
  const g = c.getContext("2d");
  if (!g) return img;
  g.filter = "grayscale(1) contrast(0.9)";
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function currentBox(L: { glideFrom: Map<string, NodeBox>; glideAt: number; layout: MapLayout | null }, id: string, now: number): NodeBox | null {
  const to = L.layout?.nodes.get(id);
  if (!to) return null;
  const from = L.glideFrom.get(id);
  const t = Math.min(1, (now - L.glideAt) / GLIDE_MS);
  if (!from || t >= 1) return to;
  const e = 1 - Math.pow(1 - t, 3);
  return { ...to, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, w: from.w + (to.w - from.w) * e, h: from.h + (to.h - from.h) * e };
}

function glidedBoxes(L: { glideFrom: Map<string, NodeBox>; glideAt: number; layout: MapLayout | null }, now: number): Map<string, NodeBox> {
  const out = new Map<string, NodeBox>();
  for (const id of L.layout?.nodes.keys() ?? []) {
    const b = currentBox(L, id, now);
    if (b) out.set(id, b);
  }
  return out;
}

/** The card beside a screen: what it is, which tests reach it and why, and what it calls. */
function ScreenTip({ screen: s, box, layout, camera }: { screen: MapScreen; box: NodeBox; layout: MapLayout; camera: Camera }) {
  const x = box.x * camera.s + camera.x;
  const y = box.y * camera.s + camera.y;
  const w = box.w * camera.s;
  const right = x + w + 12 + 300 < layout.width;
  const left = right ? x + w + 12 : Math.max(12, x - 312);
  const top = Math.max(12, Math.min(y - 8, layout.height - 220));
  const tests = s.tests.slice(0, 3);
  const drafts = s.scenarios.filter((x) => x.status === "draft");
  return (
    <div className={styles.tip} style={{ left, top }} data-onboarding-map-tip={s.id}>
      <p className="truncate text-sm font-semibold text-fg">{s.name}</p>
      <p className="truncate font-mono text-2xs text-muted">
        {s.route ?? s.files[0]}
        {s.platform ? ` · ${platformName(s.platform)}` : ""}
      </p>
      <p className="mt-1.5 text-xs text-fg-2">{describeScreen(s)}</p>
      {tests.length ? (
        <ul className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
          {tests.map((t) => (
            <li key={`${t.path}#${t.name}`} className="min-w-0">
              <p className="flex min-w-0 items-center gap-1.5 text-xs">
                <span className="shrink-0 rounded-sm border border-border px-1 text-2xs font-medium text-fg-2">{frameworkName(t.framework)}</span>
                <span className="truncate font-medium text-fg">{t.name}</span>
              </p>
              <p className="truncate font-mono text-2xs text-muted">
                {t.path}
                {t.line ? `:${t.line}` : ""}
              </p>
              <p className={cn(styles.evidence, "mt-0.5 rounded-sm bg-panel-2 px-1.5 py-1 font-mono text-2xs text-fg-2")}>{t.evidence}</p>
            </li>
          ))}
          {s.tests.length > tests.length ? <li className="text-2xs text-muted">and {s.tests.length - tests.length} more</li> : null}
        </ul>
      ) : null}
      {drafts.length ? (
        <p className="mt-2 border-t border-border pt-2 text-xs text-fg-2">
          {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}: {drafts.map((d) => d.name).join(", ")}
        </p>
      ) : null}
      {s.endpoints.length ? <p className="mt-2 truncate font-mono text-2xs text-muted">{s.endpoints.join("  ·  ")}</p> : null}
      {s.first_run && (s.first_run.verdict === "fail" || s.first_run.verdict === "error") ? (
        <p className={cn("mt-2 border-t border-border pt-2 text-xs", resultWords(s.first_run, s.name).tone === "warn" ? "text-warning" : "text-danger")}>
          {resultWords(s.first_run, s.name).body}
        </p>
      ) : null}
    </div>
  );
}

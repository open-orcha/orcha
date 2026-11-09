/**
 * Draws one frame of the map onto a 2D canvas. Everything it needs is precomputed (the layout,
 * the plan's start times); a frame only samples and paints, so 250 screens stay well under a
 * frame's budget. Colours come from CSS custom properties (`readPalette`), so light, dark and
 * every accent palette are the stylesheet's business.
 */
import { APPEAR_MS, LIVE_MS, activeFlights, deviceAt, easeOut, fileGlow, progress, pulse, type Plan } from "./choreo";
import type { MapScreen } from "./contract";
import type { Column, MapLayout, NodeBox } from "./layout";

export interface Palette {
  label: string;
  labelDim: string;
  area: string;
  areaLine: string;
  tile: string;
  skeleton: string;
  line: string;
  lineActive: string;
  yours: string;
  qa: string;
  none: string;
  flight: string;
  pass: string;
  fail: string;
  /** A first run the app did not fail: its starting state or the test itself (#486). */
  warn: string;
  ring: string;
}

const VARS: Record<keyof Palette, string> = {
  label: "--onb-label",
  labelDim: "--onb-label-dim",
  area: "--onb-area",
  areaLine: "--onb-area-line",
  tile: "--onb-tile",
  skeleton: "--onb-skeleton",
  line: "--onb-line",
  lineActive: "--onb-line-active",
  yours: "--onb-yours",
  qa: "--onb-qa",
  none: "--onb-none",
  flight: "--onb-flight",
  pass: "--onb-pass",
  fail: "--onb-fail",
  warn: "--onb-warn",
  ring: "--onb-ring",
};

/**
 * The palette as plain `rgba()` strings: each custom property is resolved through a probe
 * element (so `color-mix()` and `var()` chains work) and a 1x1 canvas (so any colour space
 * the browser serialises comes back as bytes the canvas can mix cheaply every frame).
 */
export function readPalette(el: Element): Palette {
  const probe = document.createElement("span");
  probe.style.display = "none";
  el.appendChild(probe);
  const px = document.createElement("canvas");
  px.width = 1;
  px.height = 1;
  const pctx = px.getContext("2d", { willReadFrequently: true });
  const out = {} as Palette;
  for (const [k, v] of Object.entries(VARS) as [keyof Palette, string][]) {
    probe.style.color = `var(${v}, #888)`;
    const css = getComputedStyle(probe).color;
    let value = css;
    if (pctx) {
      pctx.clearRect(0, 0, 1, 1);
      pctx.fillStyle = "#888";
      pctx.fillStyle = css;
      pctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = pctx.getImageData(0, 0, 1, 1).data;
      value = `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    }
    out[k] = value;
  }
  probe.remove();
  return out;
}

export type StageMode = "build" | "coverage" | "bring_in" | "first_run";

export interface Camera {
  s: number;
  x: number;
  y: number;
}

export interface DrawArgs {
  layout: MapLayout;
  boxes: Map<string, NodeBox>;
  plan: Plan;
  now: number;
  palette: Palette;
  mode: StageMode;
  screens: Map<string, MapScreen>;
  /** Screenshots by URL, and a grey copy of each under `${url}#grey`. */
  images: Map<string, HTMLImageElement | HTMLCanvasElement>;
  hover: string | null;
  focus: string | null;
  /** Screens to bring forward (a framework badge or a test under the pointer); the rest dim. */
  highlight: ReadonlySet<string> | null;
  /** The node the first run is on: it pulses while the run is live. */
  pulseId: string | null;
  camera: Camera;
  dpr: number;
}

const MONO = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = (px: number, weight = 500) => `${weight} ${px}px "Inter Variable", system-ui, -apple-system, sans-serif`;

// `rgba(r, g, b, a)` strings, parsed once and re-emitted at another alpha (cached: the canvas
// parses colour strings on every assignment, and a frame assigns thousands).
const parsed = new Map<string, [string, number]>();
const mixCache = new Map<string, string>();
function mix(color: string, a: number): string {
  const q = Math.round(Math.max(0, Math.min(1, a)) * 40) / 40;
  const key = `${color}|${q}`;
  let v = mixCache.get(key);
  if (v) return v;
  let base = parsed.get(color);
  if (!base) {
    const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?/.exec(color);
    base = m ? [`${m[1]}, ${m[2]}, ${m[3]}`, m[4] === undefined ? 1 : Number(m[4])] : ["136, 136, 136", 1];
    parsed.set(color, base);
  }
  v = `rgba(${base[0]}, ${(base[1] * q).toFixed(3)})`;
  if (mixCache.size > 4000) mixCache.clear();
  mixCache.set(key, v);
  return v;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** A screenshot filling its card without stretching: cropped to the card's shape, kept from the
 * top (a screen's header says the most about it), never squeezed to fit. */
export function coverRect(iw: number, ih: number, w: number, h: number): { sx: number; sy: number; sw: number; sh: number } {
  if (iw <= 0 || ih <= 0 || w <= 0 || h <= 0) return { sx: 0, sy: 0, sw: Math.max(iw, 0), sh: Math.max(ih, 0) };
  const want = w / h;
  if (iw / ih > want) {
    const sw = ih * want;
    return { sx: (iw - sw) / 2, sy: 0, sw, sh: ih };
  }
  return { sx: 0, sy: 0, sw: iw, sh: iw / want };
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement | HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  const iw = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const ih = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  const r = coverRect(iw, ih, w, h);
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, x, y, w, h);
}

function project(cam: Camera, x: number, y: number): [number, number] {
  return [x * cam.s + cam.x, y * cam.s + cam.y];
}

function drawColumn(ctx: CanvasRenderingContext2D, col: Column, p: Palette, glowOf: (paths: string[]) => number, mono: boolean, method: boolean) {
  ctx.textBaseline = "middle";
  for (const r of col.rows) {
    const g = glowOf(r.paths);
    const y = r.y + col.rowH / 2;
    if (g > 0.45) {
      ctx.fillStyle = mix(p.flight, (g - 0.4) * 0.3);
      ctx.beginPath();
      ctx.roundRect(col.x - 6, r.y + 1, col.w + 6, col.rowH - 2, 4);
      ctx.fill();
    }
    const x = col.x + r.depth * 12;
    ctx.font = r.kind === "dir" ? SANS(11, 600) : mono ? MONO : SANS(11);
    const base = r.kind === "file" ? p.label : p.labelDim;
    ctx.fillStyle = g > 0 ? mix(g > 0.6 ? p.flight : base, 0.55 + g * 0.45) : mix(base, r.kind === "more" ? 0.6 : 0.5);
    if (method && r.kind === "file") {
      const [verb, ...rest] = r.label.split(" ");
      ctx.font = SANS(9.5, 650);
      const vw = ctx.measureText(verb).width;
      ctx.fillStyle = mix(verb === "GET" ? p.labelDim : verb === "DELETE" ? p.fail : p.qa, 0.55 + g * 0.45);
      ctx.fillText(verb, x, y);
      ctx.font = MONO;
      ctx.fillStyle = mix(p.label, 0.5 + g * 0.5);
      ctx.fillText(truncate(ctx, rest.join(" "), col.w - vw - 8), x + vw + 5, y);
    } else {
      ctx.fillText(truncate(ctx, r.label, col.w - r.depth * 12), x, y);
    }
  }
}

/** A point on a cubic curve. */
function cubic(t: number, a: number, b: number, c: number, d: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

function quadPoint(t: number, a: number, c: number, b: number): number {
  const u = 1 - t;
  return u * u * a + 2 * u * t * c + t * t * b;
}

/** One frame. */
export function drawMap(ctx: CanvasRenderingContext2D, a: DrawArgs): void {
  const { layout, plan, now, palette: p, camera: cam, boxes, screens } = a;
  ctx.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
  ctx.clearRect(0, 0, layout.width, layout.height);
  const building = a.mode === "build";
  const lit = (id: string) => (a.highlight ? a.highlight.has(id) : true);
  const active = a.hover ?? a.focus;

  // The file tree and the endpoints, in screen space.
  if (layout.tree) {
    drawColumn(ctx, layout.tree, p, (paths) => {
      let g = 0;
      for (const path of paths) g = Math.max(g, fileGlow(plan, path, now));
      if (active) {
        const s = screens.get(active);
        if (s && paths.some((x) => s.files.includes(x))) g = Math.max(g, 1);
      }
      return g;
    }, true, false);
  }
  if (layout.rail) {
    drawColumn(ctx, layout.rail, p, (eps) => {
      if (active) {
        const s = screens.get(active);
        if (s && eps.some((e) => s.endpoints.includes(e))) return 1;
      }
      return 0;
    }, true, true);
  }

  // Endpoint links: faint once both ends exist, bright for the screen in focus.
  if (layout.rail) {
    const rail = layout.rail;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let quiet = false;
    for (const s of screens.values()) {
      const b = boxes.get(s.id);
      if (!b || s.endpoints.length === 0) continue;
      const shown = progress(plan, plan.nodeIn.get(s.id), now, APPEAR_MS);
      if (shown <= 0) continue;
      const [x1, y1] = project(cam, b.x + b.w, b.y + b.h / 2);
      for (const e of s.endpoints) {
        const ri = rail.rowOf.get(e);
        if (ri === undefined) continue;
        const ry = rail.rows[ri].y + rail.rowH / 2;
        const x2 = rail.x - 10;
        if (s.id === active) continue;
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(x1 + (x2 - x1) * 0.5, y1, x1 + (x2 - x1) * 0.6, ry, x2, ry);
        quiet = true;
      }
    }
    if (quiet) {
      ctx.strokeStyle = mix(p.line, a.highlight || active ? 0.08 : 0.16);
      ctx.stroke();
    }
    if (active) {
      const s = screens.get(active);
      const b = s && boxes.get(s.id);
      if (s && b) {
        ctx.beginPath();
        const [x1, y1] = project(cam, b.x + b.w, b.y + b.h / 2);
        for (const e of s.endpoints) {
          const ri = rail.rowOf.get(e);
          if (ri === undefined) continue;
          const ry = rail.rows[ri].y + rail.rowH / 2;
          const x2 = rail.x - 10;
          ctx.moveTo(x1, y1);
          ctx.bezierCurveTo(x1 + (x2 - x1) * 0.5, y1, x1 + (x2 - x1) * 0.6, ry, x2, ry);
        }
        ctx.strokeStyle = mix(p.lineActive, 0.8);
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
    }
  }

  // The graph, through the camera, kept between the tree and the endpoints when zoomed in.
  ctx.save();
  const clipL = layout.tree ? layout.tree.x + layout.tree.w + 6 : 0;
  const clipR = layout.rail ? layout.rail.x - 6 : layout.width;
  ctx.beginPath();
  ctx.rect(clipL, 0, clipR - clipL, layout.height);
  ctx.clip();
  ctx.setTransform(a.dpr * cam.s, 0, 0, a.dpr * cam.s, a.dpr * cam.x, a.dpr * cam.y);

  for (const area of layout.areas) {
    let shown = 0;
    for (const [id, b] of boxes) if (b.area === area.key) shown = Math.max(shown, progress(plan, plan.nodeIn.get(id), now, APPEAR_MS));
    if (shown <= 0) continue;
    const r = Math.min(14, area.w * 0.08);
    ctx.globalAlpha = easeOut(shown);
    ctx.fillStyle = p.area;
    ctx.strokeStyle = p.areaLine;
    ctx.lineWidth = 1 / cam.s;
    ctx.beginPath();
    ctx.roundRect(area.x, area.y, area.w, area.h, r);
    ctx.fill();
    ctx.stroke();
    // The name sits in the band above the screens, sized to it, so it never runs into them.
    const fs = Math.max(8, Math.min(13, area.head * 0.5));
    const ly = area.y + area.head * 0.52;
    ctx.font = SANS(fs, 600);
    ctx.textBaseline = "middle";
    ctx.fillStyle = p.labelDim;
    const label = truncate(ctx, area.label, area.w - 30);
    const lx = area.x + Math.min(12, area.head * 0.45);
    ctx.fillText(label, lx, ly);
    // Measured in the name's own font: measured after the switch to the count's smaller one,
    // the name came up short and the count landed on its last letters.
    const lw = ctx.measureText(label).width;
    ctx.font = SANS(fs - 1, 500);
    ctx.fillStyle = mix(p.labelDim, 0.7);
    const count = String(area.count);
    const gapX = fs * 0.45;
    if (lx + lw + gapX + ctx.measureText(count).width + 8 < area.x + area.w) ctx.fillText(count, lx + lw + gapX, ly);
    ctx.globalAlpha = 1;
  }

  // Navigation between screens: drawn in as both ends exist, the screen in focus's links bright.
  ctx.lineWidth = 1 / cam.s;
  const settled = new Path2D();
  let settledAny = false;
  for (const e of layout.edges) {
    const ia = plan.nodeIn.get(e.from);
    const ib = plan.nodeIn.get(e.to);
    if (ia === undefined || ib === undefined) continue;
    const start = Math.max(ia, ib);
    const v = progress(plan, start, now, 600);
    if (v <= 0) continue;
    const fa = boxes.get(e.from);
    const fb = boxes.get(e.to);
    if (!fa || !fb) continue;
    const x1 = fa.x + fa.w / 2;
    const y1 = fa.y + fa.h / 2;
    const x2 = fb.x + fb.w / 2;
    const y2 = fb.y + fb.h / 2;
    const cx = e.cx + (x1 - e.x1 + x2 - e.x2) / 2;
    const cy = e.cy + (y1 - e.y1 + y2 - e.y2) / 2;
    const focusEdge = active !== null && (e.from === active || e.to === active);
    if (v >= 1 && !focusEdge) {
      settled.moveTo(x1, y1);
      settled.quadraticCurveTo(cx, cy, x2, y2);
      settledAny = true;
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    const steps = 10;
    const ev = easeOut(v);
    for (let k = 1; k <= steps; k++) {
      const t = (k / steps) * ev;
      ctx.lineTo(quadPoint(t, x1, cx, x2), quadPoint(t, y1, cy, y2));
    }
    ctx.strokeStyle = focusEdge ? p.lineActive : mix(p.line, 0.9);
    ctx.lineWidth = (focusEdge ? 1.6 : 1) / cam.s;
    ctx.stroke();
  }
  if (settledAny) {
    ctx.strokeStyle = mix(p.line, a.highlight || active ? 0.35 : 0.7);
    ctx.lineWidth = 1 / cam.s;
    ctx.stroke(settled);
  }

  // Screens.
  const lod = layout.lod;
  for (const [id, b] of boxes) {
    const s = screens.get(id);
    if (!s) continue;
    const appear = progress(plan, plan.nodeIn.get(id), now, APPEAR_MS);
    if (appear <= 0) continue;
    const ea = easeOut(appear);
    const live = progress(plan, plan.liveIn.get(id), now, LIVE_MS);
    const tested = progress(plan, plan.testIn.get(id), now, 500);
    const dim = !lit(id) ? 0.28 : 1;
    const grow = 0.86 + 0.14 * ea;
    const w = b.w * grow;
    const h = b.h * grow;
    const x = b.x + (b.w - w) / 2;
    const y = b.y + (b.h - h) / 2;
    const r = lod === "card" ? 7 : lod === "chip" ? 3.5 : 2;
    ctx.globalAlpha = ea * dim;

    // Coverage tint (the Coverage step and after), else the tile.
    const cov = s.coverage;
    const bucket = a.mode === "build" ? (tested > 0 ? "your_tests" : null) : cov;
    const tint = bucket === "your_tests" ? p.yours : bucket === "qa" ? p.qa : bucket === "both" ? p.yours : bucket === "none" ? p.none : null;

    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = p.tile;
    ctx.fill();

    // The screenshot: in colour while mapping; past the Map step a grey copy under the coverage
    // colour, so the app's own colours never read as coverage.
    const img = s.thumbnail ? (building ? a.images.get(s.thumbnail) : (a.images.get(`${s.thumbnail}#grey`) ?? a.images.get(s.thumbnail))) : undefined;
    const ready = img && (img instanceof HTMLCanvasElement || (img.complete && img.naturalWidth > 0));
    if (live > 0 && img && ready && lod !== "dot") {
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = ea * dim * live * (building ? 1 : 0.55);
      drawCover(ctx, img, x, y, w, h);
      ctx.restore();
      ctx.globalAlpha = ea * dim;
    } else if (lod === "card") {
      // A wireframe: the screen as the code describes it, before anyone has seen it.
      ctx.fillStyle = p.skeleton;
      ctx.fillRect(x + 7, y + 8, w * 0.55, 5);
      for (let k = 0; k < 4; k++) ctx.fillRect(x + 7, y + 22 + k * 13, (w - 14) * (k % 2 ? 0.62 : 0.86), 6);
      ctx.fillRect(x + 7, y + h - 15, w - 14, 7);
    } else if (lod === "chip") {
      ctx.fillStyle = p.skeleton;
      ctx.fillRect(x + w * 0.18, y + h * 0.14, w * 0.5, Math.max(1.5, h * 0.06));
    }

    if (tint && !building) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fillStyle = mix(tint, bucket === "none" ? 0.24 : 0.36);
      ctx.fill();
      if (bucket === "both") {
        ctx.save();
        ctx.clip();
        ctx.fillStyle = mix(p.qa, 0.35);
        ctx.beginPath();
        ctx.moveTo(x + w, y);
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x, y + h);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // The outline: dashed while only the code knows the screen, solid once the device saw it.
    const border = tint ?? p.line;
    const bw = (lod === "card" ? (tint ? 1.6 : 1.2) : 1) / Math.max(1, cam.s * 0.9);
    ctx.lineWidth = bw;
    if (live < 1) {
      ctx.setLineDash(lod === "card" ? [4, 3] : [2.5, 2]);
      ctx.strokeStyle = mix(border, (tint ? 0.9 : 0.75) * (1 - live));
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (live > 0) {
      ctx.strokeStyle = mix(border, live * (tint ? 1 : 0.85));
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.stroke();
    }

    // The moment a test lights the screen: a soft ring that grows and fades.
    const glow = pulse(plan, plan.testIn.get(id), now);
    if (glow > 0) {
      // Sized to the screen: a soft halo on a card, a thin one on a chip in a big map.
      const k = lod === "card" ? 1 : 0.45;
      const o = (2 + glow * 3) * k;
      ctx.strokeStyle = mix(p.yours, glow * 0.6);
      ctx.lineWidth = (1.2 + glow * 2.4) * k;
      ctx.beginPath();
      ctx.roundRect(x - o, y - o, w + o * 2, h + o * 2, r + o);
      ctx.stroke();
    }
    if (building && tested > 0 && lod !== "dot") {
      ctx.fillStyle = p.yours;
      ctx.beginPath();
      ctx.arc(x + w - (lod === "card" ? 7 : 3), y + (lod === "card" ? 7 : 3), lod === "card" ? 3.5 : 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Drafts attached to the screen (Bring it in): a small count in Embodent's colour.
    const drafts = s.scenarios.filter((x) => x.status === "draft").length;
    const dv = progress(plan, plan.draftIn.get(id), now, 400);
    if (drafts > 0 && dv > 0 && a.mode !== "build") {
      const rr = lod === "card" ? Math.min(7.5, w * 0.13) : Math.max(3, w * 0.18);
      ctx.globalAlpha = ea * dim * dv;
      ctx.fillStyle = p.qa;
      ctx.beginPath();
      ctx.arc(x + w, y, rr, 0, Math.PI * 2);
      ctx.fill();
      if (lod === "card" && rr >= 6) {
        ctx.fillStyle = "#fff";
        ctx.font = SANS(9.5, 650);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(drafts), x + w, y + 0.5);
        ctx.textAlign = "left";
      }
      ctx.globalAlpha = ea * dim;
    }

    // The first run: a calm pulse while it runs, then the verdict.
    const run = s.first_run;
    if (run && (run.verdict === "running" || run.verdict === "queued" || id === a.pulseId) && !plan.resultIn.has(id)) {
      const ph = plan.reduced ? 0.5 : (Math.sin(now / 320) + 1) / 2;
      ctx.strokeStyle = mix(p.qa, 0.35 + ph * 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x - 4 - ph * 3, y - 4 - ph * 3, w + 8 + ph * 6, h + 8 + ph * 6, r + 4);
      ctx.stroke();
    }
    const rv = progress(plan, plan.resultIn.get(id), now, 500);
    if (run && rv > 0) {
      const ok = run.verdict === "pass";
      const warn = run.outcome === "setup_failed" || run.outcome === "unchecked";
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rr = Math.max(6, Math.min(16, w * 0.28)) * (0.6 + 0.4 * easeOut(rv));
      ctx.globalAlpha = ea * rv;
      ctx.fillStyle = ok ? p.pass : warn ? p.warn : p.fail;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(1.5, rr * 0.18);
      ctx.lineCap = "round";
      ctx.beginPath();
      if (ok) {
        ctx.moveTo(cx - rr * 0.42, cy + rr * 0.02);
        ctx.lineTo(cx - rr * 0.1, cy + rr * 0.34);
        ctx.lineTo(cx + rr * 0.45, cy - rr * 0.3);
      } else if (warn) {
        // "!": not the app's verdict, something Embodent could not do.
        ctx.moveTo(cx, cy - rr * 0.42);
        ctx.lineTo(cx, cy + rr * 0.08);
        ctx.moveTo(cx, cy + rr * 0.36);
        ctx.lineTo(cx, cy + rr * 0.37);
      } else {
        ctx.moveTo(cx - rr * 0.32, cy - rr * 0.32);
        ctx.lineTo(cx + rr * 0.32, cy + rr * 0.32);
        ctx.moveTo(cx + rr * 0.32, cy - rr * 0.32);
        ctx.lineTo(cx - rr * 0.32, cy + rr * 0.32);
      }
      ctx.stroke();
      ctx.lineCap = "butt";
      ctx.globalAlpha = ea * dim;
    }

    if (lod === "card") {
      ctx.font = SANS(10.5, id === active ? 600 : 500);
      ctx.textBaseline = "top";
      ctx.fillStyle = id === active ? p.label : p.labelDim;
      ctx.fillText(truncate(ctx, s.name, b.w + 14), b.x - 2, b.y + b.h + 5);
    }
    ctx.globalAlpha = 1;

    if (id === a.focus || id === a.hover) {
      ctx.strokeStyle = id === a.focus ? p.ring : mix(p.lineActive, 0.9);
      ctx.lineWidth = 2 / cam.s;
      ctx.beginPath();
      ctx.roundRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8, r + 3);
      ctx.stroke();
    }
  }

  // The device during the live pass: a small phone gliding from screen to screen.
  const dev = building ? deviceAt(plan, now) : null;
  if (dev) {
    const fa = boxes.get(dev.from);
    const fb = boxes.get(dev.to);
    if (fa && fb) {
      const x = fa.x + fa.w / 2 + (fb.x + fb.w / 2 - (fa.x + fa.w / 2)) * dev.t;
      const y = fa.y - 6 + (fb.y - fa.y) * dev.t;
      const pw = lod === "card" ? 12 : 8;
      const ph = pw * 1.7;
      ctx.fillStyle = p.qa;
      ctx.beginPath();
      ctx.roundRect(x - pw / 2, y - ph, pw, ph, pw * 0.25);
      ctx.fill();
      ctx.fillStyle = p.tile;
      ctx.fillRect(x - pw / 2 + 1.6, y - ph + 2.4, pw - 3.2, ph - 4.8);
    }
  }
  ctx.restore();

  // Flights: a file's curve onto its screen, a short bright comet with a fading tail.
  if (building && layout.tree) {
    const tree = layout.tree;
    for (const { flight, t } of activeFlights(plan, now)) {
      const ri = tree.rowOf.get(flight.path);
      const b = boxes.get(flight.id);
      if (ri === undefined || !b) continue;
      const x0 = tree.x + tree.w + 2;
      const y0 = tree.rows[ri].y + tree.rowH / 2;
      const [x3, y3] = project(cam, b.x, b.y + b.h / 2);
      const dx = x3 - x0;
      const c1x = x0 + dx * 0.45;
      const c2x = x3 - dx * 0.35;
      const tail = 0.22;
      const segs = 8;
      for (let k = 0; k < segs; k++) {
        const ta = Math.max(0, t - tail + (tail * k) / segs);
        const tb = Math.max(0, t - tail + (tail * (k + 1)) / segs);
        ctx.beginPath();
        ctx.moveTo(cubic(ta, x0, c1x, c2x, x3), cubic(ta, y0, y0, y3, y3));
        ctx.lineTo(cubic(tb, x0, c1x, c2x, x3), cubic(tb, y0, y0, y3, y3));
        ctx.strokeStyle = mix(p.flight, ((k + 1) / segs) * 0.85);
        ctx.lineWidth = 0.8 + (1.4 * (k + 1)) / segs;
        ctx.stroke();
      }
      ctx.fillStyle = p.flight;
      ctx.beginPath();
      ctx.arc(cubic(t, x0, c1x, c2x, x3), cubic(t, y0, y0, y3, y3), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

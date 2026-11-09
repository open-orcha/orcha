import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BookOpen, Bug, ClipboardCheck, Cloud, Compass, FileText, ScanSearch } from "../../map/kit/icons";
import { cn } from "../../map/kit";
import styles from "./explore.module.css";

const W = 640;
const H = 210;
const AW = 84;
const AH = 50;

/** An example app's areas: the explorer walks the first six in order; Settings stays in the fog. */
const AREAS = [
  { name: "Sign in", x: 8, y: 118 },
  { name: "Home", x: 112, y: 36 },
  { name: "Search", x: 216, y: 118 },
  { name: "Listing", x: 320, y: 36 },
  { name: "Cart", x: 320, y: 140 },
  { name: "Profile", x: 424, y: 88 },
  { name: "Settings", x: 216, y: 14 },
] as const;
const WALKED = 6;
const ISSUE_AT = 4;

// The job page's phases: Read, Explore (with the checks your lenses ask for), Review.
const PHASES = [
  { title: "Read", line: "Reads the code, tests and docs.", icon: BookOpen },
  { title: "Explore", line: "Walks every area it can reach.", icon: Compass },
  { title: "Check", line: "Measures what your lenses ask for.", icon: ScanSearch },
  { title: "Review", line: "Hands back a report you can keep.", icon: ClipboardCheck },
] as const;

/** The last step of a take; then the scene fades, resets and starts again. */
const LAST = WALKED + 3;
const FINAL = WALKED + 2;
const STEP_MS = 1000;

/** Where the explorer stands at an area: the middle of its lower edge, like a pin on a map. */
const center = (i: number) => ({ x: AREAS[i].x + AW / 2, y: AREAS[i].y + AH - 1 });
const pct = (v: number, of: number) => `${(v / of) * 100}%`;

function phaseAt(step: number): number {
  if (step <= 0) return 0;
  if (step <= WALKED) return 1;
  if (step === WALKED + 1) return 2;
  return 3;
}

function leg(i: number): string {
  const a = center(i);
  const b = center(i + 1);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - 18;
  return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
}

/**
 * The Explore tab's teaching empty state: an exploration charting an example app. It studies
 * first, then a marker walks from area to area; each one it reaches comes out of the fog with a
 * screen inside, an issue is pinned where it found one, an area it never reached stays fogged,
 * and a report lands at the end. One take is about ten seconds and loops only while on screen.
 * Under reduced motion it is the finished frame. It is an example, so it is hidden from screen
 * readers, which get the same story as one sentence.
 */
export function ExplorationEmptyScene({ className }: { className?: string }) {
  const [step, setStep] = useState(FINAL);
  const [resetting, setResetting] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof window === "undefined") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    let at = 0;
    let visible = false;
    const tick = () => {
      if (!visible) return;
      if (at > LAST) {
        setResetting(true);
        timer = window.setTimeout(() => {
          at = 0;
          setStep(0);
          timer = window.setTimeout(() => {
            setResetting(false);
            at = 1;
            timer = window.setTimeout(tick, STEP_MS);
          }, 60);
        }, 420);
        return;
      }
      setStep(at);
      at += 1;
      timer = window.setTimeout(tick, STEP_MS);
    };
    const start = () => {
      window.clearTimeout(timer);
      setResetting(true);
      timer = window.setTimeout(() => {
        at = 0;
        setStep(0);
        setResetting(false);
        at = 1;
        timer = window.setTimeout(tick, STEP_MS * 1.2);
      }, 200);
    };
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      const was = visible;
      visible = entry.isIntersecting;
      if (visible && !was) start();
      if (!visible) window.clearTimeout(timer);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  const reached = Math.min(step, WALKED);
  const at = center(Math.max(0, reached - 1));
  const phase = phaseAt(step);

  return (
    <div ref={root} className={cn("flex flex-col gap-3", className)} data-exploration-empty-scene>
      <p className="sr-only">
        An example of an exploration: Embodent studies the code, walks the app area by area, pins an issue where it finds one, and writes a report. Areas it did not reach stay in the fog.
      </p>
      <div aria-hidden className={cn("relative mx-auto w-full max-w-[760px]", styles.sceneBody, resetting && styles.sceneResetting)} style={{ aspectRatio: `${W} / ${H}` }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full overflow-visible">
          {AREAS.slice(0, WALKED - 1).map((_, i) => (
            <path
              key={i}
              d={leg(i)}
              pathLength={1}
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeDasharray="1"
              className={cn(styles.leg2, reached > i + 1 && styles.legDrawn)}
              opacity={0.75}
            />
          ))}
        </svg>

        {AREAS.map((a, i) => {
          const shown = i < reached;
          return (
            <div
              key={a.name}
              className={cn(
                "absolute flex flex-col justify-between overflow-hidden rounded-md border border-dashed border-border-strong bg-panel-2 px-2 py-1.5",
                styles.area,
                shown && cn(styles.areaShown, "border-solid"),
              )}
              style={{ left: pct(a.x, W), top: pct(a.y, H), width: pct(AW, W), height: pct(AH, H) }}
            >
              <span className={cn("absolute inset-0 bg-[repeating-linear-gradient(135deg,transparent_0_6px,color-mix(in_srgb,var(--color-muted)_14%,transparent)_6px_7px)]", styles.areaFog)} />
              <span className={cn("relative flex items-center gap-1 truncate text-[10.5px] font-medium", shown ? "text-fg" : "text-muted")}>
                {shown ? null : <Cloud className="size-2.5 shrink-0" strokeWidth={2} />}
                {a.name}
              </span>
              <span className={cn("relative flex flex-col gap-[3px]", styles.areaScreen)}>
                <span className="h-[3px] w-4/5 rounded-full bg-border-strong" />
                <span className="h-[3px] w-1/2 rounded-full bg-border" />
              </span>
              {i === ISSUE_AT ? (
                <span
                  className={cn(
                    "absolute right-1 top-1 inline-flex items-center gap-0.5 rounded-full bg-sev-major/15 px-1 text-[9px] font-semibold leading-[14px] text-sev-major",
                    styles.scenePin,
                    reached > ISSUE_AT && styles.scenePinShown,
                  )}
                >
                  <Bug className="size-2.5" strokeWidth={2.25} />1
                </span>
              ) : null}
            </div>
          );
        })}

        {/* The explorer, above the areas it walks into. */}
        <svg viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 size-full overflow-visible">
          <g className={styles.traveler} style={{ transform: `translate(${at.x}px, ${at.y}px)`, opacity: step === 0 ? 0 : 1 } as CSSProperties}>
            <circle r={12} fill="var(--color-primary)" opacity={0.18} />
            <circle r={5.5} fill="var(--color-primary)" stroke="var(--color-panel)" strokeWidth={2} />
          </g>
        </svg>

        <div
          className={cn("absolute flex flex-col gap-1.5 rounded-lg border border-border bg-raised p-2.5 shadow-[var(--shadow-md)]", styles.sceneReport, step >= FINAL && styles.sceneReportShown)}
          style={{ left: pct(524, W), top: pct(36, H), width: pct(112, W) }}
        >
          <span className="flex items-center gap-1 text-[11px] font-semibold text-fg">
            <FileText className="size-3 text-muted" strokeWidth={2} />
            Report
          </span>
          <span className="text-[10px] leading-[14px] text-fg-2">6 areas charted</span>
          <span className="flex items-center gap-1 text-[10px] leading-[14px] text-sev-major">
            <Bug className="size-2.5" strokeWidth={2.25} />1 issue in Cart
          </span>
          <span className="flex items-center gap-1 text-[10px] leading-[14px] text-muted">
            <Cloud className="size-2.5" strokeWidth={2} />1 still in the fog
          </span>
        </div>
      </div>

      <ol aria-hidden className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PHASES.map((p, i) => {
          const Icon = p.icon;
          const now = i === phase;
          return (
            <li
              key={p.title}
              className={cn(
                "flex flex-col gap-1 rounded-lg border bg-panel px-3 py-2 transition-[border-color,background-color] duration-300 motion-reduce:transition-none",
                now ? "border-primary/60 bg-primary/[0.06]" : "border-border",
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                <Icon className={cn("size-3.5", now ? "text-primary" : "text-muted")} strokeWidth={2} />
                {p.title}
              </span>
              <span className="text-xs leading-4 text-muted">{p.line}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

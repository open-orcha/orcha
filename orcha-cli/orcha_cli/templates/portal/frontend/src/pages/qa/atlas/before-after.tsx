import { ChevronsLeftRight, ScanSearch } from "../map/kit/icons";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import styles from "./atlas.module.css";
import detail from "./detail.module.css";
import { measureDiff, type DiffResult } from "./diff";

/** How much of the way to its target the cut moves each frame when it glides (keys, clicks). */
const GLIDE = 0.22;

const noop = () => () => undefined;
/** A canvas can read the pictures' pixels here (a browser; not a test DOM, which has no canvas). */
const canvasReads = () => typeof HTMLCanvasElement !== "undefined" && !/jsdom/i.test(navigator.userAgent);

/**
 * Two looks of one screen, one over the other, with a handle to slide between them: the first on
 * the left of the handle, the second on its right. A range input over the picture drives it, so
 * arrow keys move it too and a screen reader hears where it is. `kind` says what the two are: a
 * screen before and after a change (the default), the same screen on two platforms (a wipe), or
 * the same screen on one device in light and in dark (`appearance`).
 *
 * The whole picture takes the drag (the handle, the line or anywhere on it), and the cut follows
 * the pointer exactly; a key press glides the cut there (one frame
 * loop writing a CSS variable, no re-render per frame). The first time it comes into view it
 * peeks toward the second and settles back, so a person sees there is something to slide. Each
 * label fades as the cut covers it. "Highlight what changed" measures the two pictures' pixels
 * (`diff.ts`) and rings each region that differs; it is offered only where a canvas can read them.
 * Reduced motion: no glide, no peek, the rings appear without blooming.
 */
export function BeforeAfter({
  before,
  after,
  beforeLabel,
  afterLabel,
  name,
  kind = "change",
}: {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  name: string;
  kind?: "change" | "platforms" | "appearance";
}) {
  const [cut, setCut] = useState(50);
  const [diff, setDiff] = useState<DiffResult | null | "measuring">(null);
  const [showDiff, setShowDiff] = useState(false);
  const canMeasure = useSyncExternalStore(noop, canvasReads, () => false);
  const box = useRef<HTMLDivElement>(null);
  const shown = useRef(50);
  const dragging = useRef(false);
  const touched = useRef(false);

  // The cut on screen eases toward `cut`; while dragging, or under reduced motion, it is `cut`.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const paint = (v: number) => {
      shown.current = v;
      el.style.setProperty("--cut", `${v}%`);
      el.style.setProperty("--before-fade", String(Math.min(1, Math.max(0, (v - 8) / 14))));
      el.style.setProperty("--after-fade", String(Math.min(1, Math.max(0, (92 - v) / 14))));
    };
    if (still || dragging.current || typeof requestAnimationFrame !== "function") {
      paint(cut);
      return;
    }
    let raf = 0;
    const step = () => {
      const d = cut - shown.current;
      if (Math.abs(d) < 0.05) return paint(cut);
      paint(shown.current + d * GLIDE);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [cut]);

  // A peek the first time it is seen: toward the second, and back.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timers: number[] = [];
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      timers.push(window.setTimeout(() => !touched.current && setCut(70), 350));
      timers.push(window.setTimeout(() => !touched.current && setCut(50), 1150));
    });
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  // The cut under the pointer. The range input takes no pointer: its thumb would shift the cut
  // off the pointer, and the handle drawn over it swallowed a press on the grip.
  const follow = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    setCut(Math.max(0, Math.min(100, Math.round(((clientX - rect.left) / rect.width) * 200) / 2)));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    touched.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    follow(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current) follow(e.clientX);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const toggleDiff = () => {
    const next = !showDiff;
    setShowDiff(next);
    if (next && diff === null) {
      setDiff("measuring");
      void measureDiff(before, after).then((r) => setDiff(r));
    }
  };

  const change = kind === "change";
  const what = change ? "changed" : "differs";
  const boxes = showDiff && diff && diff !== "measuring" ? diff.boxes : [];
  const result = diff && diff !== "measuring" ? diff : null;

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={box}
        className={styles.compare}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        {...(change ? { "data-atlas-compare": "" } : kind === "appearance" ? { "data-atlas-shade-wipe": "" } : { "data-atlas-wipe": "" })}
      >
        <img src={before} alt={`${name}, ${beforeLabel}`} draggable={false} />
        <div className={styles.compareAfter}>
          <img src={after} alt={`${name}, ${afterLabel}`} draggable={false} className="h-full w-full object-cover object-top" />
        </div>
        {boxes.map((b, i) => (
          <span
            key={i}
            className={detail.diffBox}
            style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, "--i": i } as CSSProperties}
            aria-hidden
            data-atlas-diff-box
          />
        ))}
        <span className={styles.compareTag} style={{ left: 8, opacity: "var(--before-fade, 1)" }}>
          {beforeLabel}
        </span>
        <span className={styles.compareTag} style={{ right: 8, opacity: "var(--after-fade, 1)" }}>
          {afterLabel}
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={cut}
          onKeyDown={() => {
            touched.current = true;
          }}
          onChange={(e) => setCut(Number(e.target.value))}
          className={styles.compareRange}
          aria-label={`Slide between ${beforeLabel} and ${afterLabel}`}
          aria-valuetext={`${Math.round(100 - cut)}% ${afterLabel}, ${Math.round(cut)}% ${beforeLabel}`}
          {...(change ? { "data-atlas-compare-range": "" } : kind === "appearance" ? { "data-atlas-shade-range": "" } : { "data-atlas-wipe-range": "" })}
        />
        <span className={styles.compareHandle} aria-hidden>
          <span className={styles.compareGrip}>
            <ChevronsLeftRight className="size-3.5" />
          </span>
        </span>
      </div>
      {canMeasure ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" className={detail.diffToggle} aria-pressed={showDiff} onClick={toggleDiff} data-atlas-diff>
            <ScanSearch className="size-3.5" aria-hidden />
            Highlight what {what}
          </button>
          {showDiff ? (
            <span className="text-xs text-muted" aria-live="polite" data-atlas-diff-words>
              {diff === "measuring"
                ? "Comparing the two screenshots"
                : result
                  ? result.boxes.length
                    ? `About ${Math.max(1, Math.round(result.changed * 100))}% of the screen ${change ? "changed" : "differs"}, in ${result.boxes.length} ${result.boxes.length === 1 ? "place" : "places"}`
                    : `The two screenshots look alike pixel for pixel`
                  : "These screenshots could not be compared"}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

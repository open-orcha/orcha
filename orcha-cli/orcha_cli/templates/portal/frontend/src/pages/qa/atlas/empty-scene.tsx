import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../map/kit";
import styles from "./atlas.module.css";

/**
 * The atlas's teaching scene: what the atlas is, shown working. One loop, four beats, each with
 * its caption lit beside it:
 *
 * 1. The app's areas appear on the left, each holding its screens, and the platform columns
 *    (iOS, Android, Web) slide down over the storyboard.
 * 2. Each screen flies out of its area into its row, its three platforms side by side, and its
 *    screenshots develop in.
 * 3. A badge lands under each: same, minor differences, and "not matched yet" where Orcha does
 *    not know (that Android slot stays a dashed question).
 * 4. The flow arrows draw between the screens.
 *
 * Every element is drawn finished; one timeline (`SCENE_MS`, the Web Animations API, transform
 * and opacity only) says where each comes from, so all share one loop and rewind together. It
 * pauses off screen. Under reduced motion nothing plays: the finished storyboard stands still and
 * every caption reads at once.
 */

export const SCENE_MS = 10500;
/** Where the loop rewinds (everything fades back to its start together). */
const REWIND = 0.94;

const AREAS = [
  { label: "Browse", y: 82 },
  { label: "Products", y: 176 },
  { label: "Checkout", y: 270 },
];
/** The storyboard: a row per area, two screens each. */
const ROW_Y = [56, 150, 244];
const CARD_X = [168, 384];
const CARD_W = 200;
const CARD_H = 84;
/** Each card's frames: iOS and Android phones, a web browser window. */
const FRAMES = [
  { p: "iOS", dx: 10, w: 30, h: 54 },
  { p: "Android", dx: 52, w: 30, h: 54 },
  { p: "Web", dx: 94, w: 96, h: 54 },
];
const BADGES = ["same", "minor", "same", "same", "minor", "unmatched"] as const;
const BADGE_WORDS: Record<(typeof BADGES)[number], string> = { same: "Same", minor: "Minor differences", unmatched: "Not matched yet" };
/** The card (row 2, second screen) whose Android slot Orcha has not matched yet. */
const UNKNOWN = { card: 5, frame: 1 };

export const BEATS = [
  { title: "Your app's screens, area by area", text: "From its code, its tests and every run, replay and exploration.", at: 0, until: 2400 },
  { title: "iOS, Android and web side by side", text: "Each screen lands in its area's row with its newest screenshots.", at: 2400, until: 5000 },
  { title: "A badge says how alike they are, and why", text: "Same, minor differences, or not matched yet when Embodent cannot tell.", at: 5000, until: 7300 },
  { title: "How people move between them", text: "Flow arrows follow the way people walk the app.", at: 7300, until: 9870 },
] as const;

const flightAt = (k: number) => 2400 + k * 330;
const FLIGHT_MS = 820;
const badgeAt = (k: number) => 5000 + k * 200;
const arrowAt = (r: number) => 7300 + r * 380;

type Frame = Keyframe & { offset?: never };

/** One element's part of the loop: hidden as `from` until `start`, eased to `to` by `start + dur`,
 * held, and back to `from` as the loop rewinds. */
function beat(el: Element, from: Frame, to: Frame, start: number, dur: number, easing = "cubic-bezier(0.2, 0.7, 0.2, 1)"): Animation {
  const a = Math.max(0, start / SCENE_MS);
  const b = Math.min((start + dur) / SCENE_MS, REWIND - 0.005);
  return el.animate(
    [
      { ...from, offset: 0 },
      { ...from, offset: a, easing },
      { ...to, offset: b },
      { ...to, offset: REWIND, easing: "ease-in" },
      { ...from, offset: 1 },
    ],
    { duration: SCENE_MS, iterations: Infinity },
  );
}

/** A caption lit only during its beat. */
function lit(el: Element, at: number, until: number): Animation {
  const on = { opacity: "1", transform: "none" };
  const off = { opacity: "0.62", transform: "translateX(-2px)" };
  const fade = 260 / SCENE_MS;
  const a = at / SCENE_MS;
  const b = Math.min(until / SCENE_MS, REWIND);
  const frames: Keyframe[] = [{ ...off, offset: 0 }];
  if (a > 0) frames.push({ ...off, offset: a });
  frames.push({ ...on, offset: Math.min(a + fade, b) }, { ...on, offset: Math.max(b - fade, a + fade) }, { ...off, offset: b }, { ...off, offset: 1 });
  return el.animate(frames, { duration: SCENE_MS, iterations: Infinity });
}

function playScene(root: HTMLElement): Animation[] {
  const all: Animation[] = [];
  const q = <T extends Element>(sel: string) => [...root.querySelectorAll<T>(sel)];
  // 1. The platform columns slide down, the areas appear with their screens inside.
  q("[data-scene=band]").forEach((el, i) => all.push(beat(el, { transform: "scaleY(0)", opacity: "0" }, { transform: "scaleY(1)", opacity: "1" }, 150 + (i % 3) * 90, 700)));
  q("[data-scene=column]").forEach((el, i) => all.push(beat(el, { transform: "translateY(-10px)", opacity: "0" }, { transform: "none", opacity: "1" }, 250 + (i % 3) * 90, 500)));
  q("[data-scene=area]").forEach((el, i) => all.push(beat(el, { transform: "translateX(-14px)", opacity: "0" }, { transform: "none", opacity: "1" }, 500 + i * 160, 520)));
  q("[data-scene=row]").forEach((el, i) => all.push(beat(el, { opacity: "0" }, { opacity: "1" }, 700 + i * 160, 600)));
  // A screen waiting in its area leaves it as its card flies.
  q("[data-scene=seed]").forEach((el) => {
    const k = Number((el as HTMLElement).dataset.k);
    all.push(beat(el, { opacity: "0", transform: "scale(0.4)" }, { opacity: "1", transform: "none" }, 900 + k * 120, 360));
    all.push(beat(el, { opacity: "1" }, { opacity: "0" }, flightAt(k), 160));
  });
  // 2. Each card flies from its area (x and y eased apart, so it arcs), its shots develop.
  q("[data-scene=fly-x]").forEach((el) => {
    const k = Number((el as HTMLElement).dataset.k);
    const dx = Number((el as HTMLElement).dataset.dx);
    all.push(beat(el, { transform: `translateX(${dx}px)` }, { transform: "translateX(0px)" }, flightAt(k), FLIGHT_MS, "cubic-bezier(0.3, 0, 0.2, 1)"));
  });
  q("[data-scene=fly-y]").forEach((el) => {
    const k = Number((el as HTMLElement).dataset.k);
    const dy = Number((el as HTMLElement).dataset.dy);
    all.push(beat(el, { transform: `translateY(${dy}px) scale(0.28)`, opacity: "0" }, { transform: "none", opacity: "1" }, flightAt(k), FLIGHT_MS, "cubic-bezier(0.1, 0.6, 0.3, 1)"));
  });
  q("[data-scene=shot]").forEach((el) => {
    const k = Number((el as HTMLElement).dataset.k);
    all.push(beat(el, { opacity: "0", transform: "translateY(3px)" }, { opacity: "1", transform: "none" }, flightAt(k) + FLIGHT_MS - 120, 420));
  });
  // 3. The badges land.
  q("[data-scene=badge]").forEach((el) => {
    const k = Number((el as HTMLElement).dataset.k);
    all.push(beat(el, { opacity: "0", transform: "translateY(4px) scale(0.85)" }, { opacity: "1", transform: "none" }, badgeAt(k), 320));
  });
  // 4. The flow arrows draw, then their heads land.
  q("[data-scene=arrow]").forEach((el) => {
    const r = Number((el as HTMLElement).dataset.r);
    all.push(beat(el, { strokeDashoffset: "1" }, { strokeDashoffset: "0" }, arrowAt(r), 620, "cubic-bezier(0.3, 0.6, 0.2, 1)"));
  });
  q("[data-scene=head]").forEach((el) => {
    const r = Number((el as HTMLElement).dataset.r);
    all.push(beat(el, { opacity: "0" }, { opacity: "1" }, arrowAt(r) + 520, 180));
  });
  q("[data-scene=caption]").forEach((el, i) => all.push(lit(el, BEATS[i].at, BEATS[i].until)));
  return all;
}

export function AtlasEmptyScene({ intro, actions, className }: { intro?: ReactNode; actions?: ReactNode; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof el.animate !== "function") {
      el?.removeAttribute("data-wait");
      return;
    }
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    let anims: Animation[] = [];
    let seen = true;
    const start = () => {
      anims.forEach((a) => a.cancel());
      anims = still.matches ? [] : playScene(el);
      if (!seen) anims.forEach((a) => a.pause());
      el.removeAttribute("data-wait");
      el.toggleAttribute("data-still", still.matches);
    };
    start();
    still.addEventListener("change", start);
    // Off screen, the loop rests where it is.
    const io = new IntersectionObserver(([entry]) => {
      seen = entry.isIntersecting;
      anims.forEach((a) => (seen ? a.play() : a.pause()));
    });
    io.observe(el);
    return () => {
      still.removeEventListener("change", start);
      io.disconnect();
      anims.forEach((a) => a.cancel());
    };
  }, []);

  return (
    <div ref={root} className={cn(styles.scene, className)} data-wait data-atlas-scene>
      <div className={styles.sceneText}>
        {intro}
        <ol className={styles.sceneSteps} aria-label="How the atlas works">
        {BEATS.map((b, i) => (
          <li key={b.title} className={styles.sceneStep} data-scene="caption">
            <span className={styles.sceneNum} aria-hidden>
              {i + 1}
            </span>
            <span>
              <span className="block text-sm font-medium text-fg">{b.title}</span>
              <span className="block text-[13px] leading-snug text-muted">{b.text}</span>
            </span>
          </li>
        ))}
        </ol>
        {actions}
      </div>
      <svg viewBox="0 0 600 340" className={styles.sceneSvg} role="img" aria-label="Screens flying from the app's areas into a storyboard, iOS, Android and web side by side, each with a badge, and arrows between them">
        {/* The platform columns, over both screens of every row. */}
        {CARD_X.flatMap((cx, c) =>
          FRAMES.map((f) => (
            <g key={`${c}${f.p}`}>
              <rect data-scene="band" x={cx + f.dx - 3} y={40} width={f.w + 6} height={292} rx={6} className={styles.sceneBand} style={{ transformOrigin: `${cx + f.dx}px 40px` }} />
              <text data-scene="column" x={cx + f.dx + f.w / 2} y={32} textAnchor="middle" className={styles.sceneColumn}>
                {f.p}
              </text>
            </g>
          )),
        )}
        {/* The app's areas, each holding its two screens until they fly. */}
        <text x={16} y={32} className={styles.sceneColumn}>
          Your app
        </text>
        {AREAS.map((a, r) => (
          <g key={a.label}>
            <rect data-scene="row" x={156} y={ROW_Y[r] - 6} width={440} height={CARD_H + 12} rx={12} className={styles.sceneRow} />
            <g data-scene="area">
              <rect x={10} y={a.y - 30} width={124} height={60} rx={12} className={styles.sceneArea} />
              <text x={22} y={a.y - 11} className={styles.sceneAreaLabel}>
                {a.label}
              </text>
            </g>
            {[0, 1].map((c) => (
              <rect key={`ghost${c}`} x={22 + c * 24} y={a.y - 2} width={18} height={24} rx={4} className={styles.sceneGhost} />
            ))}
            {[0, 1].map((c) => (
              <rect key={c} data-scene="seed" data-k={r * 2 + c} x={22 + c * 24} y={a.y - 2} width={18} height={24} rx={4} className={styles.sceneSeed} style={{ transformOrigin: `${31 + c * 24}px ${a.y + 10}px` }} />
            ))}
          </g>
        ))}
        {/* The arrows between the two screens of each row. */}
        {ROW_Y.map((y, r) => {
          const x1 = CARD_X[0] + CARD_W + 2;
          const x2 = CARD_X[1] - 3;
          const my = y + CARD_H / 2 - 4;
          return (
            <g key={r}>
              <path data-scene="arrow" data-r={r} d={`M${x1},${my} L${x2 - 5},${my}`} pathLength={1} className={styles.sceneArrow} />
              <path data-scene="head" data-r={r} d={`M${x2},${my} L${x2 - 6},${my - 3.5} L${x2 - 6},${my + 3.5} Z`} className={styles.sceneHead} />
            </g>
          );
        })}
        {/* The screens: each flies from its area into its row. */}
        {ROW_Y.flatMap((y, r) =>
          CARD_X.map((cx, c) => {
            const card = r * CARD_X.length + c;
            const from = AREAS[r];
            const badge = BADGES[card];
            const word = BADGE_WORDS[badge];
            return (
              <g key={card} data-scene="fly-x" data-k={card} data-dx={22 + c * 24 - cx}>
                <g data-scene="fly-y" data-k={card} data-dy={from.y - y} style={{ transformOrigin: `${cx}px ${y}px` }}>
                  <rect x={cx} y={y} width={CARD_W} height={CARD_H} rx={10} className={styles.sceneCard} />
                  {FRAMES.map((f, fi) => {
                    const unknown = card === UNKNOWN.card && fi === UNKNOWN.frame;
                    const fx = cx + f.dx;
                    const fy = y + 8;
                    return (
                      <g key={f.p}>
                        <rect
                          x={fx}
                          y={fy}
                          width={f.w}
                          height={f.h}
                          rx={f.p === "Web" ? 4 : 6}
                          className={unknown ? styles.sceneUnknown : f.p === "Web" ? styles.sceneBrowser : styles.scenePhone}
                        />
                        {unknown ? (
                          <text x={fx + f.w / 2} y={fy + f.h / 2 + 4} textAnchor="middle" className={styles.sceneQuestion}>
                            ?
                          </text>
                        ) : (
                          <g data-scene="shot" data-k={card}>
                            <rect x={fx + 4} y={fy + (f.p === "Web" ? 8 : 9)} width={f.p === "Web" ? 40 : f.w - 8} height={4} rx={2} className={styles.sceneInk} />
                            <rect x={fx + 4} y={fy + (f.p === "Web" ? 16 : 17)} width={f.w - 8} height={f.p === "Web" ? 22 : 16} rx={3} className={styles.sceneTint} />
                            <rect x={fx + 4} y={fy + (f.p === "Web" ? 42 : 38)} width={(f.w - 8) * 0.7} height={4} rx={2} className={styles.sceneMuted} />
                          </g>
                        )}
                      </g>
                    );
                  })}
                  <g data-scene="badge" data-k={card} style={{ transformOrigin: `${cx + 10}px ${y + 72}px` }}>
                    <rect x={cx + 10} y={y + 66} width={word.length * 4.7 + 14} height={14} rx={7} className={cn(styles.sceneBadge, styles[badge])} />
                    <text x={cx + 17} y={y + 76} className={cn(styles.sceneBadgeText, styles[badge])}>
                      {word}
                    </text>
                  </g>
                </g>
              </g>
            );
          }),
        )}
      </svg>
    </div>
  );
}

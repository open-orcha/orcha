import { Link } from "../map/kit";
import { flushSync } from "react-dom";
import { ArrowRight, ChevronLeft, ChevronRight, ExternalLink, Film, FlaskConical, History, Layers, Maximize2, Minimize2, Monitor, MonitorSmartphone, Moon, Route, Smartphone, Sun, SunMoon, Tablet } from "../map/kit/icons";
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, cn, Dialog, fmtDate, fmtRelative, ImageLightbox, PlatformIcon } from "../map/kit";
import styles from "./atlas.module.css";
import { BeforeAfter } from "./before-after";
import detail from "./detail.module.css";
import {
  APPEARANCE_WORD,
  BADGE_WORD,
  blankWords,
  chipWords,
  deviceSeen,
  FORM_WORD,
  FRAME,
  fillable,
  frameKind,
  lookKind,
  missingWords,
  moveWords,
  PLATFORM_WORD,
  presenceWords,
  seenCell,
  seenRows,
  shadePairs,
  shapesOf,
  slotFit,
  usualForms,
  wipeWords,
  wireWords,
  type FrameKind,
  type Shapes,
} from "./model";
import { BadgeTip, BLANK_ICON, DeviceChip, DeviceFrame, SimilarityBadge } from "./screen-card";
import { useTip } from "./tip";
import { presenceOf, type Atlas, type AtlasPair, type AtlasScreen, type BlankWhy, type DeviceForm, type Platform } from "./types";

const FORM_ICON: Record<DeviceForm, typeof Smartphone> = { phone: Smartphone, tablet: Tablet, desktop: Monitor };

/** A kind of device as the frame its screenshots are drawn in. */
const formKind = (form: DeviceForm | null | undefined, platform: Platform): FrameKind =>
  platform === "web" && form !== "phone" && form !== "tablet" ? "browser" : form === "tablet" ? "tablet" : form === "desktop" ? "desktop" : "phone";
import { zoomResize } from "./zoom";

type Shot = { src: string; title: string; description: string };

/** The room the stage gives its frames, side by side, and the gap between two. */
const STAGE_W = 640;
const STAGE_GAP = 28;
/** Full window: the room before the stage is measured, the tallest a frame may be and the most it grows. */
const FULL = { w: 1080, h: 600, max: 2.6 };
/** The full stage's own padding, left and right. */
const FULL_PAD = 56;
/** The person's choice of side panel or full window, for this session. */
export const EXPANDED_KEY = "orcha:atlas:detail-expanded";

export function readExpanded(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeExpanded(storage: Pick<Storage, "setItem"> | null | undefined, on: boolean): void {
  try {
    storage?.setItem(EXPANDED_KEY, on ? "1" : "0");
  } catch {
    // private mode or blocked storage: the choice lasts until the page reloads
  }
}

const session = () => (typeof window === "undefined" ? null : (() => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
})());

/** Whether a key press belongs to a field (typing an "f" is not the shortcut). */
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/** How wide a before and after reads well: a phone narrow, an iPad or a window wider. */
function compareWidth(kind: FrameKind): string {
  return kind === "phone" ? "max-w-[300px]" : kind === "tablet" ? "max-w-[420px]" : "max-w-[620px]";
}

/** "3 combinations seen": how many of a screen's "Seen on" cells hold a screenshot. */
function seenAside(screen: AtlasScreen): string {
  const n = screen.seen_on.filter((l) => l.frame_url || l.blank).length;
  return `${n} ${n === 1 ? "combination" : "combinations"} seen`;
}

function seenWords(at: string | null, build: string | null): string {
  if (!at) return "Not seen yet";
  return `Seen ${fmtRelative(at)}${build ? ` on build ${build}` : ""}`;
}

/** The scale the stage draws its frames at: as big as fits side by side, never past 1.7 in the
 * side panel; in the full window as big as `FULL` allows. */
export function stageScale(platforms: readonly Platform[], shapes: Shapes, full = false, measured = 0): number {
  // A frame's border and its caption take a little more than the frame: keep a tenth spare.
  const room = full ? Math.max(STAGE_W, ((measured || FULL.w + FULL_PAD) - FULL_PAD) * 0.9) : STAGE_W;
  const w = platforms.reduce((n, p) => n + FRAME[frameKind(p, shapes)].w, 0) + STAGE_GAP * Math.max(0, platforms.length - 1);
  const h = Math.max(...platforms.map((p) => FRAME[frameKind(p, shapes)].h), FRAME.phone.h);
  return Math.max(1, Math.min(full ? FULL.max : 1.7, (room - STAGE_GAP * Math.max(0, platforms.length - 1)) / Math.max(1, w - STAGE_GAP * Math.max(0, platforms.length - 1)), (full ? FULL.h : 380) / h));
}

/** A reason with what it quotes marked, so the words that differ stand out ("Android says “Add to bag”"). */
function Marked({ text }: { text: string }) {
  const parts = text.split(/(“[^”]*”)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("“") && p.endsWith("”") ? (
          <mark key={i} className={detail.quote}>
            {p.slice(1, -1)}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** How alike two platforms are, as a ring that fills to their score (decorative; the words say it). */
function PairRing({ score, tone }: { score: number; tone: string }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 40 40" className={cn(detail.ring, tone)} aria-hidden>
      <circle cx="20" cy="20" r={r} className={detail.ringTrack} />
      <circle cx="20" cy="20" r={r} className={detail.ringFill} style={{ strokeDasharray: `${c}`, "--ring-off": `${c * (1 - score)}`, "--ring-from": `${c}` } as CSSProperties} />
    </svg>
  );
}

function Section({ title, icon: Icon, children, id, i, aside }: { title: string; icon: typeof History; children: ReactNode; id: string; i: number; aside?: ReactNode }) {
  return (
    <section className={detail.section} style={{ "--i": i } as CSSProperties} aria-labelledby={id}>
      <h3 id={id} className={detail.sectionTitle}>
        <Icon className="size-3.5 text-muted" aria-hidden />
        {title}
        {aside ? <span className="ml-auto text-xs font-normal text-muted">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** One pair of platforms: how alike they read and look (a ring), which looks it compares ("iPhone
 * 17 Pro vs Pixel 9a, both light"), and when both are the same kind of device with a screenshot
 * each, a wipe from one to the other. A pair never seen like with like has no ring: it says why. */
function Pair({ pair, screen, shapes }: { pair: AtlasPair; screen: AtlasScreen; shapes: Shapes }) {
  const a = screen.variants[pair.a];
  const b = screen.variants[pair.b];
  const la = pair.looks?.a ?? null;
  const lb = pair.looks?.b ?? null;
  // A side whose capture was blank has no picture to wipe across (never another look's instead).
  const before = la?.blank ? null : (la?.frame_url ?? a?.frame_url ?? null);
  const after = lb?.blank ? null : (lb?.frame_url ?? b?.frame_url ?? null);
  const blank = la?.blank ? { why: la.blank, p: pair.a } : lb?.blank ? { why: lb.blank, p: pair.b } : null;
  const kind = la ? formKind(la.form, pair.a) : frameKind(pair.a, shapes);
  const sameKind = la && lb ? kind === formKind(lb.form, pair.b) : frameKind(pair.a, shapes) === frameKind(pair.b, shapes);
  const wipe = pair.fair && sameKind && before && after && !a?.signin_only && !b?.signin_only;
  const why = !pair.fair && pair.reasons[0] ? pair.reasons[0] : null;
  return (
    <div className={detail.pair} data-atlas-pair={`${pair.a}-${pair.b}`} data-atlas-pair-fair={pair.fair ? "true" : "false"}>
      <div className={detail.pairHead}>
        <span className={detail.pairSide}>
          <PlatformIcon kind={pair.a} className="size-3.5" />
          {PLATFORM_WORD[pair.a]}
        </span>
        {pair.score !== null ? (
          <span className={detail.pairScore}>
            <PairRing score={pair.score} tone={styles[pair.badge]} />
            <span className="tabular-nums">{Math.round(pair.score * 100)}% alike</span>
          </span>
        ) : (
          <span className={detail.pairDash} aria-hidden />
        )}
        <span className={detail.pairSide}>
          <PlatformIcon kind={pair.b} className="size-3.5" />
          {PLATFORM_WORD[pair.b]}
        </span>
        <span className={cn(detail.pairBadge, styles[pair.badge])}>{BADGE_WORD[pair.badge]}</span>
      </div>
      {pair.words && !why ? (
        <p className={detail.pairWords} data-atlas-pair-words>
          {pair.words}
        </p>
      ) : null}
      {why ? (
        <p className={detail.pairWhy} data-atlas-pair-unfair>
          {why}
        </p>
      ) : null}
      {wipe ? (
        <div className={cn(compareWidth(kind), "mt-3")}>
          <BeforeAfter kind="platforms" before={before!} after={after!} beforeLabel={PLATFORM_WORD[pair.a]} afterLabel={PLATFORM_WORD[pair.b]} name={screen.name} />
        </div>
      ) : pair.fair && sameKind && blank ? (
        <BlankNote why={blank.why} words={wipeWords(blank.why, blank.p)} kind="pair" />
      ) : null}
    </div>
  );
}

/** A filmstrip cell whose state has no picture: its capture was blank, said in a word. Secure mode
 * is only ever found on Android (the session's FLAG_SECURE check, D110). */
function StateBlank({ why, platforms }: { why: BlankWhy; platforms: Platform[] }) {
  const bw = blankWords(why, why === "flag_secure" ? "android" : (platforms[0] ?? "android"));
  const Icon = BLANK_ICON[why];
  return (
    <span className={detail.cellBlank} title={`${bw.title}. ${bw.line}`} data-atlas-state-blank={why}>
      <Icon className="size-4" aria-hidden />
      {bw.short}
    </span>
  );
}

/** Where a wipe or a before and after would be when a side's capture was blank: why there is
 * nothing to slide across, and what Orcha compares instead. */
function BlankNote({ why, words, kind }: { why: BlankWhy; words: string; kind: "pair" | "change" }) {
  const Icon = BLANK_ICON[why];
  return (
    <p className={cn(detail.pairWhy, detail.blankNote)} data-atlas-blank-note={kind} data-why={why}>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
      <span>{words}</span>
    </p>
  );
}

/**
 * Where a screen has been seen: its platforms across, each kind of device in light and in dark
 * down. A cell holds the newest screenshot of that combination (it opens full size) with the
 * device's name; an empty one says calmly what is missing ("Not seen on an Android tablet yet"); a
 * kind of device the platform is not usually seen on (an Android desktop) stays blank.
 */
function SeenOn({ atlas, screen, platforms, onShot }: { atlas: Atlas; screen: AtlasScreen; platforms: Platform[]; onShot: (shot: Shot) => void }) {
  const rows = seenRows(atlas, screen);
  return (
    <div className={detail.seenWrap}>
      <table className={detail.seen} data-atlas-seen-on>
        <caption className="sr-only">Where {screen.name} has been seen: each platform across, each kind of device{rows.some((r) => r.appearance) ? " in light and dark" : ""} down.</caption>
        <colgroup>
          <col className={detail.seenHeadCol} />
          {platforms.map((p) => (
            <col key={p} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <td className={detail.seenCorner} />
            {platforms.map((p) => (
              <th key={p} scope="col">
                <span className="inline-flex items-center gap-1">
                  <PlatformIcon kind={p} className="size-3" />
                  {PLATFORM_WORD[p]}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const Icon = FORM_ICON[r.form];
            const Shade = r.appearance === "dark" ? Moon : r.appearance === "light" ? Sun : null;
            return (
              <tr key={`${r.form}-${r.appearance}`} data-atlas-seen-row={`${r.form}-${r.appearance}`} style={{ "--i": i } as CSSProperties}>
                <th scope="row">
                  <span className={detail.seenRowHead}>
                    <Icon className="size-3.5" aria-hidden />
                    {FORM_WORD[r.form]}
                    {Shade ? <Shade className="size-3" aria-hidden /> : null}
                    {r.appearance ? <span className="font-normal text-muted">{APPEARANCE_WORD[r.appearance]}</span> : null}
                  </span>
                </th>
                {platforms.map((p) => {
                  const l = seenCell(screen, p, r);
                  if (!l && !usualForms(atlas, p).includes(r.form)) {
                    // Not a kind of device this platform is seen on (an Android desktop): blank.
                    return (
                      <td key={p} data-atlas-seen-cell={`${p}-${r.form}-${r.appearance}`} data-blank="">
                        <span className="sr-only">
                          {PLATFORM_WORD[p]} is not usually seen on a {FORM_WORD[r.form].toLowerCase()}
                        </span>
                      </td>
                    );
                  }
                  if (!l) {
                    return (
                      <td key={p} data-atlas-seen-cell={`${p}-${r.form}-${r.appearance}`} data-empty="">
                        <span className={detail.seenEmpty}>{missingWords(screen, p, r)}</span>
                      </td>
                    );
                  }
                  const words = chipWords(l, p) ?? PLATFORM_WORD[p];
                  if (!l.frame_url && l.blank) {
                    // Seen there, but its capture was blank: where the picture would be, why.
                    const bw = blankWords(l.blank, p);
                    const Icon = BLANK_ICON[l.blank];
                    return (
                      <td key={p} data-atlas-seen-cell={`${p}-${r.form}-${r.appearance}`} data-atlas-seen-blank={l.blank}>
                        <span className={detail.seenBlank} role="img" aria-label={`${screen.name} on ${PLATFORM_WORD[p]}, ${words}: ${bw.title}. ${bw.line}`} title={bw.line}>
                          <Icon className="size-4" aria-hidden />
                          <span>{bw.title}</span>
                        </span>
                        <span className={detail.seenDevice} title={words}>
                          {l.device ?? FORM_WORD[r.form]}
                        </span>
                        {l.at ? <span className={detail.seenWhen}>{fmtRelative(l.at)}</span> : null}
                      </td>
                    );
                  }
                  return (
                    <td key={p} data-atlas-seen-cell={`${p}-${r.form}-${r.appearance}`}>
                      <button
                        type="button"
                        className={detail.seenShot}
                        onClick={() => onShot({ src: l.frame_url!, title: `${screen.name} on ${PLATFORM_WORD[p]}, ${words}`, description: l.at ? `Seen ${fmtRelative(l.at)}${l.build ? ` on build ${l.build}` : ""}` : "" })}
                        aria-label={`Open ${screen.name} on ${PLATFORM_WORD[p]}, ${words}, full size`}
                      >
                        <img src={l.frame_url!} alt="" loading="lazy" decoding="async" style={l.w && l.h ? { aspectRatio: `${l.w} / ${l.h}` } : undefined} />
                      </button>
                      <span className={detail.seenDevice} title={words}>
                        {l.device ?? FORM_WORD[r.form]}
                      </span>
                      {l.at ? <span className={detail.seenWhen}>{fmtRelative(l.at)}</span> : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Everything about one screen, for people who design and plan it. It opens like a scene: the
 * frames fly in from the card (zoom.ts), then each part rises in turn. A lit stage shows each
 * platform's newest screenshot side by side (a click opens it full size); how the platforms
 * compare says how alike each pair is (a ring), why (the words that differ marked), and wipes from
 * one to the other where both are the same kind of device; what changed since the chosen build or
 * date has a before and after slider that can ring what changed; the states it has been seen in
 * run as a filmstrip; and how people get here and where it leads are a small flow. The technical
 * App map is one secondary link away.
 *
 * Expand (top right, or F) turns the panel into the full window: the frames much larger side by
 * side, the rest beside them on a wide window and below on a narrow one; Collapse (F again, or
 * Esc, which collapses before it closes) puts it back. The frames grow and shrink in place
 * (`zoomResize`), the zoom from a card works in both, and the choice lasts for the session.
 *
 * The previous and next screens of the storyboard (`order`, as filtered) are one click away, top
 * right; the content crossfades into theirs while the panel holds still (`zoomSwitch`, the board's
 * `onOpen`), and their sections do not rise in again.
 */
export function ScreenDetail({
  atlas,
  screen,
  mapHref,
  onClose,
  onOpen,
  order = [],
  fillOn,
  onFill,
}: {
  atlas: Atlas;
  screen: AtlasScreen | null;
  /** This screen in the App map. */
  mapHref: (screen: AtlasScreen) => string;
  onClose: () => void;
  onOpen: (id: string) => void;
  /** The storyboard's screens in order, as filtered: the panel's previous and next. */
  order?: readonly string[];
  /** Platforms a "Fill in" can start on now; with `onFill`, a not-seen platform offers it. */
  fillOn?: ReadonlySet<Platform>;
  onFill?: (platform: Platform) => void;
}) {
  const [shot, setShot] = useState<Shot | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the session's choice once mounted
    setExpanded(readExpanded(session()));
  }, []);
  const screenId = screen?.id ?? null;
  // Another screen while open: its content crossfades in (zoomSwitch), its sections do not rise again.
  const [seenId, setSeenId] = useState(screenId);
  const [switched, setSwitched] = useState(false);
  if (screenId !== seenId) {
    setSeenId(screenId);
    setSwitched(seenId !== null && screenId !== null);
  }
  const at = screenId ? order.indexOf(screenId) : -1;
  const prevId = at > 0 ? order[at - 1] : null;
  const nextId = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
  // The full stage's width as laid out (beside the sections on a wide window), so the frames
  // fit side by side in it.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageW, setStageW] = useState(0);
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  const toggle = useCallback(
    (on?: boolean) => {
      const next = on ?? !expandedRef.current;
      if (next === expandedRef.current) return;
      writeExpanded(session(), next);
      zoomResize(screenId, () => {
        expandedRef.current = next;
        flushSync(() => setExpanded(next));
        // The full stage's width now, so its frames have their final size before they fly (the
        // ResizeObserver would otherwise re-scale them a moment after the motion).
        const el = stageRef.current;
        if (next && el) {
          const cs = getComputedStyle(el);
          const w = Math.round(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + FULL_PAD);
          if (w > 0) flushSync(() => setStageW(w));
        }
      });
    },
    [screenId],
  );
  // F toggles the full window while the details are open, and the left and right arrows show the
  // previous and next screen, as the buttons do (not while typing, on a slider, or with a
  // picture open).
  useEffect(() => {
    if (!screenId || shot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if ((e.key === "f" || e.key === "F") && !e.repeat) {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const to = e.key === "ArrowLeft" ? prevId : nextId;
        if (!to) return;
        e.preventDefault();
        onOpen(to);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screenId, shot, toggle, prevId, nextId, onOpen]);
  const names = new Map(atlas.screens.map((s) => [s.id, s.name]));
  const sim = screen?.similarity ?? null;
  const shown: Platform[] = screen ? (atlas.platforms.length ? atlas.platforms : screen.platforms) : [];
  const shapes = shapesOf(atlas);
  useEffect(() => {
    const el = stageRef.current;
    if (!expanded || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setStageW(Math.round(e.contentRect.width + FULL_PAD)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, screenId]);
  const scale = stageScale(shown, shapes, expanded, stageW);
  const tip = useTip();
  const pairs = sim?.pairs ?? [];
  // A pair not compared says why in its own box; the list below says the rest once.
  const said = (sim?.reasons ?? []).filter((r) => !pairs.some((x) => !x.fair && x.reasons[0] === r));
  const shades = screen ? shadePairs(screen, shown, shapes) : [];
  let k = 0;
  return (
    <>
      <Dialog
        open={Boolean(screen)}
        onClose={onClose}
        onEscape={() => {
          if (!expandedRef.current) return false;
          toggle(false);
          return true;
        }}
        placement="side"
        // zoom.ts moves the panel (from its card, out to it, to the full window and back).
        className={cn("animate-none", expanded ? "w-screen max-w-none sm:rounded-none" : "w-[min(100vw,760px)]")}
        actions={
          screen ? (
            <>
            {order.length > 1 ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon
                  disabled={!prevId}
                  onClick={() => prevId && onOpen(prevId)}
                  aria-label={prevId ? `Previous screen: ${names.get(prevId) ?? prevId}` : "No previous screen"}
                  aria-keyshortcuts="ArrowLeft"
                  title={prevId ? `Previous: ${names.get(prevId) ?? prevId} (←)` : undefined}
                  data-atlas-detail-prev
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon
                  disabled={!nextId}
                  onClick={() => nextId && onOpen(nextId)}
                  aria-label={nextId ? `Next screen: ${names.get(nextId) ?? nextId}` : "No next screen"}
                  aria-keyshortcuts="ArrowRight"
                  title={nextId ? `Next: ${names.get(nextId) ?? nextId} (→)` : undefined}
                  data-atlas-detail-next
                >
                  <ChevronRight />
                </Button>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon
              onClick={() => toggle()}
              aria-label={expanded ? "Collapse to the side panel" : "Expand to the full window"}
              aria-keyshortcuts="F"
              title={expanded ? "Collapse (F or Esc)" : "Expand (F)"}
              data-atlas-detail-expand={expanded ? "expanded" : "panel"}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
            </>
          ) : null
        }
        title={
          screen ? (
            <span className="flex flex-wrap items-center gap-2">
              {screen.name}
              {sim ? <SimilarityBadge badge={sim.badge} label={sim.label} tip={tip} focusable /> : null}
            </span>
          ) : null
        }
        description={screen ? [screen.route, screen.last_seen_at ? seenWords(screen.last_seen_at, screen.last_build) : "Known from the code, not seen live yet"].filter(Boolean).join(" · ") : null}
      >
        {screen ? (
          <div key={screen.id} className={cn("flex flex-col gap-6 pb-6", expanded && detail.full, switched && detail.switched)} data-atlas-detail={screen.id} data-atlas-detail-mode={expanded ? "full" : "panel"}>
            {sim ? <BadgeTip tip={tip} badge={sim.badge} /> : null}
            <div ref={stageRef} className={cn(detail.stage, expanded && detail.stageFull)} data-atlas-stage>
              <div className={detail.stageFrames}>
                {shown.map((p, i) => {
                  const v = screen.variants[p];
                  const src = v?.signin_only ? null : (v?.frame_url ?? null);
                  // The frame of the device that took the screenshot (an iPad's in an iPad), in its column's room.
                  const slot = frameKind(p, shapes);
                  const own = (src ? lookKind(p, v?.device) : null) ?? slot;
                  return (
                    <figure key={p} className={detail.figure} style={{ "--i": i } as CSSProperties}>
                      <button
                        type="button"
                        className={detail.frameButton}
                        disabled={!src}
                        onClick={() => src && setShot({ src, title: `${screen.name} on ${PLATFORM_WORD[p]}`, description: seenWords(v?.last_seen_at ?? null, v?.build ?? null) })}
                        aria-label={src ? `Open ${screen.name} on ${PLATFORM_WORD[p]} full size` : `${screen.name} on ${PLATFORM_WORD[p]}`}
                        data-atlas-detail-frame={p}
                      >
                        <span className={detail.slot} style={own === slot ? undefined : { width: Math.round(FRAME[slot].w * scale), height: Math.round(FRAME[slot].h * scale) }}>
                          <DeviceFrame
                            platform={p}
                            kind={own}
                            shot={v?.device}
                            src={v?.frame_url ?? null}
                            name={screen.name}
                            route={v?.route ?? screen.route}
                            words={wireWords(screen)}
                            presence={presenceOf(screen, p)}
                            gated={Boolean(v?.signin_only)}
                            blank={v?.blank ?? null}
                            note={v?.unfit ?? null}
                            scale={scale * slotFit(slot, own)}
                            eager
                            caption={false}
                          />
                        </span>
                      </button>
                      <figcaption className={detail.caption}>
                        <span className="flex items-center gap-1 font-medium text-fg">
                          <PlatformIcon kind={p} className="size-3" />
                          {PLATFORM_WORD[p]}
                        </span>
                        {/* A blank capture's device is known, what it showed is not: no light or dark. */}
                        {(src || v?.blank) && v?.device ? <DeviceChip look={src ? deviceSeen(v.device) : { ...deviceSeen(v.device)!, appearance: null }} platform={p} full /> : null}
                        <span>{v?.unfit ?? (v?.seen ? seenWords(v.last_seen_at, v.build) : presenceWords(presenceOf(screen, p), p))}</span>
                        {onFill && fillOn?.has(p) && fillable(screen, p) ? (
                          <Button size="sm" className="mt-1" onClick={() => onFill(p)} data-atlas-detail-fill={p}>
                            Fill in {PLATFORM_WORD[p]}
                          </Button>
                        ) : null}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </div>

            <div className={cn("flex flex-col gap-6", expanded && detail.fullSide)}>
            {sim ? (
              <Section title="How the platforms compare" icon={Layers} id="atlas-why" i={k++}>
                {pairs.length ? (
                  <div className="mb-3 flex flex-col gap-2.5">
                    {pairs.map((p) => (
                      <Pair key={`${p.a}-${p.b}`} pair={p} screen={screen} shapes={shapes} />
                    ))}
                  </div>
                ) : null}
                {said.length ? (
                <ul className={detail.reasons} data-atlas-reasons>
                  {said.map((r) => {
                    // "Not seen on Android yet, so Orcha cannot compare it there": the way to fix it.
                    const unseen = onFill && /^Not seen on /.test(r) ? shown.filter((p) => fillOn?.has(p) && fillable(screen, p)) : [];
                    return (
                      <li key={r}>
                        <span aria-hidden>
                          <Marked text={r} />
                        </span>
                        <span className="sr-only">{r}</span>
                        {unseen.map((p) => (
                          <Button key={p} size="sm" variant="ghost" className="ml-2 align-middle" onClick={() => onFill?.(p)} data-atlas-reason-fill={p}>
                            Fill in {PLATFORM_WORD[p]}
                          </Button>
                        ))}
                      </li>
                    );
                  })}
                </ul>
                ) : null}
                <p className="mt-2.5 text-xs text-muted">
                  Embodent compares the platforms it has seen live, like with like: the same kind of device in the same appearance. It calls them the same when they show exactly the same screen, and leaves the rest not compared yet. A platform it has not matched yet is never counted as a difference.
                </p>
              </Section>
            ) : null}

            {screen.seen_on.length ? (
              <Section title="Seen on" icon={MonitorSmartphone} id="atlas-seen-on" i={k++} aside={seenAside(screen)}>
                <SeenOn atlas={atlas} screen={screen} platforms={shown} onShot={setShot} />
              </Section>
            ) : null}

            {shades.length ? (
              <Section title="Light and dark" icon={SunMoon} id="atlas-shades" i={k++}>
                <div className="flex flex-col gap-5">
                  {shades.map((x) => (
                    <div key={x.platform} data-atlas-shade={x.platform}>
                      <p className="mb-2 flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                        <PlatformIcon kind={x.platform} className="size-3" />
                        {PLATFORM_WORD[x.platform]}
                        <span className="font-normal text-muted">on {x.device}, the same screen in light and in dark</span>
                      </p>
                      <div className={compareWidth(formKind(x.form, x.platform))}>
                        <BeforeAfter kind="appearance" before={x.light.frame_url!} after={x.dark.frame_url!} beforeLabel="Light" afterLabel="Dark" name={`${screen.name} on ${x.device}`} />
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {screen.change ? (
              <Section title={`Changed since ${atlas.since.label}`} icon={History} id="atlas-change" i={k++}>
                <div className="flex flex-col gap-5">
                  {screen.change.platforms.map((c) => (
                    <div key={c.platform} data-atlas-change={c.platform}>
                      <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-fg">
                        <PlatformIcon kind={c.platform} className="size-3" />
                        {PLATFORM_WORD[c.platform]}
                        <span className={cn(detail.changeTag, styles.changedTone)}>{c.kind === "new" ? "New since then" : "Looks different"}</span>
                      </p>
                      {/* A change with a before and after, one side blank: why there is no slider (a new screen has none anyway). */}
                      {c.kind === "changed" && c.before && c.after && (c.before.blank || c.after.blank) && !(c.before.frame_url && c.after.frame_url) ? (
                        <BlankNote
                          why={(c.after?.blank ?? c.before?.blank)!}
                          words={`${blankWords((c.after?.blank ?? c.before?.blank)!, c.platform).title}, so there is no before and after to slide across. What changed is read from its words.`}
                          kind="change"
                        />
                      ) : null}
                      {c.before?.frame_url && c.after?.frame_url ? (
                        <div className={compareWidth(frameKind(c.platform, shapes))}>
                          <BeforeAfter
                            before={c.before.frame_url}
                            after={c.after.frame_url}
                            beforeLabel={c.before.build ? `Build ${c.before.build}` : `Before, ${fmtDate(c.before.at, { time: false })}`}
                            afterLabel={c.after.build ? `Build ${c.after.build}` : "Now"}
                            name={screen.name}
                          />
                        </div>
                      ) : null}
                      <ul className={detail.whatList}>
                        {c.what.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {screen.states.length ? (
              <Section title="States seen" icon={Film} id="atlas-states" i={k++} aside={`${screen.states.length} ${screen.states.length === 1 ? "state" : "states"}`}>
                <div className={detail.film}>
                  <div className={detail.filmStrip}>
                    {screen.states.map((s, i) => (
                      <button
                        key={s.state}
                        type="button"
                        disabled={!s.frame_url}
                        onClick={() => s.frame_url && setShot({ src: s.frame_url, title: `${screen.name}: ${s.label}`, description: s.at ? `Last seen ${fmtRelative(s.at)}` : "" })}
                        className={detail.cell}
                        style={{ "--i": i } as CSSProperties}
                        data-atlas-state={s.state}
                      >
                        <span className={detail.cellPic} style={{ aspectRatio: s.w && s.h ? `${s.w} / ${s.h}` : undefined }} title={s.device_name ?? undefined}>
                          {s.frame_url ? (
                            <img src={s.frame_url} alt={`${screen.name}, ${s.label}`} loading="lazy" />
                          ) : s.blank ? (
                            <StateBlank why={s.blank} platforms={s.platforms} />
                          ) : (
                            <span className={detail.cellEmpty}>No screenshot</span>
                          )}
                        </span>
                        <span className={detail.cellLabel}>{s.label}</span>
                        <span className={detail.cellSub}>{s.platforms.map((p) => PLATFORM_WORD[p]).join(", ")}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </Section>
            ) : null}

            {screen.from.length || screen.to.length ? (
              <Section title="How people get here" icon={Route} id="atlas-flow" i={k++}>
                <div className={detail.flow}>
                  <ul className={detail.flowSide} aria-label="From">
                    <li className={detail.flowWord}>From</li>
                    {screen.from.length ? (
                      screen.from.map((m) => (
                        <li key={m.id}>
                          <button type="button" className={detail.move} onClick={() => onOpen(m.id)}>
                            <span className="truncate font-medium text-fg">{names.get(m.id) ?? m.id}</span>
                            <span className="truncate text-xs text-muted">{moveWords(m.label)}</span>
                          </button>
                        </li>
                      ))
                    ) : (
                      <li className="px-2 text-xs text-muted">Nothing seen leading here</li>
                    )}
                  </ul>
                  <div className={detail.flowHere} aria-hidden>
                    <span className={detail.flowLine} />
                    <span className={detail.flowNode}>{screen.name}</span>
                    <span className={detail.flowLine} />
                  </div>
                  <ul className={detail.flowSide} aria-label="Leads to">
                    <li className={detail.flowWord}>Leads to</li>
                    {screen.to.length ? (
                      screen.to.map((m) => (
                        <li key={m.id}>
                          <button type="button" className={detail.move} onClick={() => onOpen(m.id)}>
                            <span className="flex min-w-0 items-center gap-1 truncate font-medium text-fg">
                              <ArrowRight className="size-3 shrink-0 text-muted" aria-hidden />
                              {names.get(m.id) ?? m.id}
                            </span>
                            <span className="truncate text-xs text-muted">{moveWords(m.label)}</span>
                          </button>
                        </li>
                      ))
                    ) : (
                      <li className="px-2 text-xs text-muted">Nowhere seen yet</li>
                    )}
                  </ul>
                </div>
              </Section>
            ) : null}

            {screen.flows.length ? (
              <Section title="Tests that walk through it" icon={FlaskConical} id="atlas-tests" i={k++}>
                <ul className="flex flex-col gap-0.5 text-sm text-fg-2">
                  {screen.flows.map((f) => (
                    <li key={f} className="truncate">
                      {f}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            <div className={cn(detail.section, "flex flex-wrap items-center gap-3 text-xs text-muted")} style={{ "--i": k } as CSSProperties}>
              <Link href={mapHref(screen)} className="inline-flex items-center gap-1 hover:text-fg hover:underline" data-atlas-map-link>
                <ExternalLink className="size-3" aria-hidden /> Open in the App map
              </Link>
              {screen.blocked_reason ? <span>Why it has not been reached: {screen.blocked_reason}</span> : null}
            </div>
            </div>
          </div>
        ) : null}
      </Dialog>
      {shot ? <ImageLightbox open onClose={() => setShot(null)} src={shot.src} alt={shot.title} title={shot.title} description={shot.description} dataAttrs={{ "data-atlas-lightbox": "" }} /> : null}
    </>
  );
}

import { memo, useCallback, useState, type CSSProperties, type MouseEventHandler } from "react";
import { CheckCircle2, CircleDashed, CircleDotDashed, CircleHelp, CircleSlash2, EyeOff, ImageOff, LockKeyhole, Monitor, Moon, Smartphone, Sun, Tablet, TriangleAlert } from "../map/kit/icons";
import { cn } from "../map/kit";
import styles from "./atlas.module.css";
import { BADGE_MEANS, BADGE_SHORT, BADGE_WORD, blankWords, CARD_HEAD, CARD_PAD, chipWords, deviceSeen, FRAME, FRAME_GAP, frameFit, frameKind, lookKind, NARROW_CARD, PLATFORM_WORD, presenceWords, shortDevice, slotFit, wireWords, type FrameKind, type Shapes } from "./model";
import { keyboardFocus, TipBubble, useTip, type Tip } from "./tip";
import { presenceOf, type AtlasScreen, type AtlasSeen, type Badge, type BlankWhy, type DeviceForm, type Platform, type Presence } from "./types";

const FORM_ICON: Record<DeviceForm, typeof Smartphone> = { phone: Smartphone, tablet: Tablet, desktop: Monitor };
/** A blank capture's sign: an eye shut for an app that hides itself, a picture missing for one colour. */
export const BLANK_ICON: Record<BlankWhy, typeof EyeOff> = { flag_secure: EyeOff, uniform: ImageOff };

/**
 * Where a blank capture's picture would be (`BlankWhy`): a quiet slot in the sign-in slot's style
 * that says why there is no picture, and on a big frame (`full`) what Orcha did instead.
 */
export function BlankSlot({ why, platform, name, full = false }: { why: BlankWhy; platform: Platform; name: string; full?: boolean }) {
  const words = blankWords(why, platform);
  const Icon = BLANK_ICON[why];
  return (
    <div className={cn(styles.gated, styles.blank, full && styles.blankFull)} role="img" aria-label={`${name} on ${PLATFORM_WORD[platform]}: ${words.title}. ${words.line}`} data-atlas-blank={why}>
      <Icon className={full ? "size-5" : "size-3.5"} aria-hidden />
      <span className={styles.blankTitle}>{words.title}</span>
      {full ? <span className={styles.blankLine}>{words.line}</span> : null}
    </div>
  );
}

/**
 * What took a look, as a chip: the device's name and a sun or a moon for light or dark ("iPhone
 * 17 Pro · Dark · Portrait" in full, for its title and a screen reader). `full` spells the kind,
 * appearance and orientation out (under a big frame); small, on a frame, it keeps to the name and
 * the sun or moon.
 */
export function DeviceChip({ look, platform, full = false, className }: { look: Pick<AtlasSeen, "device" | "form" | "appearance" | "orientation"> | null | undefined; platform: Platform; full?: boolean; className?: string }) {
  const words = chipWords(look, platform);
  if (!look || !words) return null;
  const Icon = FORM_ICON[look.form ?? (platform === "web" ? "desktop" : "phone")];
  const Shade = look.appearance === "dark" ? Moon : look.appearance === "light" ? Sun : null;
  return (
    <span className={cn(styles.chip, full && styles.chipFull, className)} title={words} data-atlas-chip={look.appearance ?? ""}>
      {/* On a frame, the frame's own shape already says phone or tablet. */}
      {full ? <Icon className="size-[1.1em] shrink-0" aria-hidden /> : null}
      <span className={styles.chipName}>{full ? words : look.device ? shortDevice(look.device) : words}</span>
      {!full && Shade ? <Shade className="size-[1.05em] shrink-0" aria-hidden /> : null}
      {full ? null : <span className="sr-only">{words}</span>}
    </span>
  );
}


const BADGE_ICON: Record<Badge, typeof CheckCircle2> = {
  same: CheckCircle2,
  minor: TriangleAlert,
  different: TriangleAlert,
  missing: CircleSlash2,
  unchecked: CircleHelp,
  unmatched: CircleDotDashed,
};

/**
 * A similarity badge: its shape and its words, in its tone, never colour alone. With a `tip` it
 * explains itself on hover; `focusable`, it is a toggletip (a button: focus or press it to read
 * what it means), for where nothing around it takes focus (the screen's detail).
 */
export function SimilarityBadge({
  badge,
  label,
  className,
  tip,
  focusable = false,
}: {
  badge: Badge;
  label?: string;
  className?: string;
  tip?: Tip;
  focusable?: boolean;
}) {
  const Icon = BADGE_ICON[badge];
  const body = (
    <>
      <Icon className="size-3" aria-hidden />
      {label ?? BADGE_WORD[badge]}
    </>
  );
  const hover: { onMouseEnter?: MouseEventHandler; onMouseLeave?: MouseEventHandler } = tip
    ? { onMouseEnter: (e) => tip.show(e.currentTarget), onMouseLeave: () => tip.hide() }
    : {};
  if (focusable && tip) {
    return (
      <button
        type="button"
        className={cn(styles.badge, styles[badge], styles.badgeTip, className)}
        data-atlas-badge={badge}
        aria-describedby={tip.describedBy}
        aria-expanded={tip.open}
        // Not the first focus of the dialog it heads (Dialog skips it when it opens).
        data-dialog-skip-focus=""
        onClick={(e) => tip.show(e.currentTarget, true)}
        onFocus={(e) => keyboardFocus(e.currentTarget) && tip.show(e.currentTarget, true)}
        onBlur={() => tip.hide(true)}
        {...hover}
      >
        {body}
      </button>
    );
  }
  return (
    <span className={cn(styles.badge, styles[badge], tip && styles.badgeTip, className)} data-atlas-badge={badge} {...hover}>
      {body}
    </span>
  );
}

/** The words a screen reader hears for a badge: its word and what it means. */
export const badgeWords = (badge: Badge) => `${BADGE_WORD[badge]}: ${BADGE_MEANS[badge]}`;

/** What a badge means, in its tip: its shape and word, then the meaning in a sentence. Render it
 * outside any button. */
export function BadgeTip({ tip, badge }: { tip: Tip; badge: Badge }) {
  const Icon = BADGE_ICON[badge];
  return (
    <TipBubble tip={tip} words={badgeWords(badge)}>
      <span className={cn("flex items-center gap-1.5 font-semibold", styles[badge])}>
        <Icon className="size-3.5" aria-hidden />
        {BADGE_WORD[badge]}
      </span>
      <span className="mt-1 block text-fg-2" data-atlas-tip-means>
        {BADGE_MEANS[badge]}
      </span>
    </TipBubble>
  );
}

/** How many of a wireframe's words fit its frame: each line is about 16 px with its gap, and its
 * padding, bars, name, route and foot take the rest. */
function wireLines(innerH: number, scale: number, route: boolean): number {
  return Math.max(0, Math.min(scale > 1 ? 7 : 4, Math.floor((innerH - 78 - (route ? 16 : 0)) / 16)));
}

/** A frame's chrome: its border and the bar across its top. */
const CHROME: Record<FrameKind, { border: number; bar: number }> = {
  phone: { border: 3, bar: 0 },
  tablet: { border: 4, bar: 0 },
  tabletWide: { border: 4, bar: 0 },
  desktop: { border: 1, bar: 14 },
  browser: { border: 1, bar: 12 },
};
const FRAME_CLASS: Record<FrameKind, string> = {
  phone: styles.phone,
  tablet: styles.tablet,
  tabletWide: styles.tablet,
  desktop: styles.desktop,
  browser: styles.browser,
};

/**
 * One platform's frame, the shape of the device its screenshots were taken on: a phone, an iPad
 * (upright or on its side), a desktop window or a browser window. A screenshot of the frame's
 * shape is cropped from the top; one of another shape is shown whole, letterboxed, so the
 * important part is never cut off. Without a screenshot it says honestly what is known: a screen
 * in this platform's code that no run has reached is a wireframe with its name, route and first
 * words ("Not seen yet"); one the platform's mapped code has nothing like is a dashed "Not in the
 * Android code" slot; one Orcha has not matched on this platform is a quiet "No Android match
 * found" (the code may hold it inside another screen). One a
 * run saw only behind a sign-in form (`gated`) says so, and a screenshot that no longer loads
 * (its run was cleaned up) falls back to the wireframe instead of a broken image.
 */
export function DeviceFrame({
  platform,
  kind: kindIn,
  src,
  shot,
  name,
  route,
  words,
  presence = "unseen",
  fresh,
  capturing = false,
  scale = 1,
  eager = false,
  caption = true,
  gated = false,
  blank = null,
  note = null,
  chip = null,
}: {
  platform: Platform;
  /** The column's frame; by default a phone, or a browser for the web. */
  kind?: FrameKind;
  src: string | null;
  /** The screenshot's size in pixels, when the atlas knows it: its fit is set before it loads. */
  shot?: { w: number | null; h: number | null } | null;
  name: string;
  route?: string | null;
  words?: string[];
  presence?: Presence;
  fresh?: boolean;
  /** The high-level pass is about to capture this frame: it shimmers until the screenshot lands. */
  capturing?: boolean;
  /** Bigger frames in the detail panel. */
  scale?: number;
  eager?: boolean;
  /** "Not seen yet" at a wireframe's foot; off where the words under the frame already say it. */
  caption?: boolean;
  /** Seen only behind a sign-in form: the frame says so, never shows the sign-in. */
  gated?: boolean;
  /** Seen, but its capture was blank (an app in secure mode, a screen not drawn yet): the frame
   * says why instead of a black or empty picture. */
  blank?: BlankWhy | null;
  /** Seen, but never the way the filters ask: what it says instead ("Not seen on an iPad in dark yet"). */
  note?: string | null;
  /** What took the screenshot, as a small chip on it. */
  chip?: Pick<AtlasSeen, "device" | "form" | "appearance" | "orientation"> | null;
}) {
  const kind = kindIn ?? frameKind(platform);
  const size = FRAME[kind];
  const base = CHROME[kind];
  // Bigger frames (the details, the tour) get a bigger bar, room for the route in the address.
  const chrome = { border: base.border, bar: Math.round(base.bar * Math.min(scale, 1.6)) };
  const w = Math.round(size.w * scale);
  const h = Math.round(size.h * scale);
  const innerW = w - 2 * chrome.border;
  const innerH = h - chrome.bar - 2 * chrome.border;
  const sized = Boolean(shot?.w && shot?.h);
  const known = sized ? frameFit(shot!.w!, shot!.h!, innerW, innerH) : null;
  const [loaded, setLoaded] = useState<ReturnType<typeof frameFit> | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  // Seen only behind a sign-in: its screenshot is the sign-in, never shown as this screen.
  const shown = src && broken !== src && !gated ? src : null;
  const fit = known ?? loaded;
  // Measured once it has loaded. A screenshot the browser loaded before the page hydrated fires
  // no load event React hears, so the ref measures one that is already complete (else a phone's
  // shot in an iPad's frame stayed cropped).
  const measure = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img || sized || !img.complete || !img.naturalWidth) return;
      const next = frameFit(img.naturalWidth, img.naturalHeight, innerW, innerH);
      setLoaded((cur) => (cur && cur.fit === next.fit && cur.position === next.position ? cur : next));
    },
    [sized, innerW, innerH],
  );
  const style: CSSProperties = { width: w, height: h };
  return (
    <div
      className={FRAME_CLASS[kind]}
      style={style}
      data-platform={platform}
      data-device={kind}
      data-atlas-frame={shown ? "shot" : gated ? "gated" : note ? "unfit" : blank ? "blank" : presence === "absent" ? "absent" : presence === "unknown" ? "unknown" : "wire"}
      data-fit={shown ? (fit?.fit ?? "cover") : undefined}
      data-capturing={capturing || undefined}
    >
      {chrome.bar ? (
        <div className={styles.browserBar} style={{ height: chrome.bar }} aria-hidden>
          <i />
          <i />
          <i />
          {kind === "browser" ? <span className={styles.address}>{scale >= 1.3 && route ? route : null}</span> : null}
        </div>
      ) : null}
      {kind === "phone" || kind === "tablet" || kind === "tabletWide" ? <span className={styles.buttons} aria-hidden /> : null}
      <div className={styles.ground} style={{ height: innerH }}>
        {shown ? (
          <img
            src={shown}
            alt={`${name} on ${PLATFORM_WORD[platform]}`}
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            draggable={false}
            className={cn(styles.shot, fit?.fit === "contain" && styles.contain, fresh && styles.fresh)}
            style={fit ? { objectPosition: fit.position } : undefined}
            ref={measure}
            onLoad={(e) => measure(e.currentTarget)}
            onError={() => setBroken(src)}
          />
        ) : gated ? (
          <div className={styles.gated} role="img" aria-label={`${name} on ${PLATFORM_WORD[platform]}: seen only behind its sign-in`}>
            <LockKeyhole className="size-3.5" aria-hidden />
            <span>Seen only behind sign-in</span>
          </div>
        ) : note ? (
          <div className={styles.unknown} data-atlas-unfit>
            {note}
          </div>
        ) : blank ? (
          <BlankSlot why={blank} platform={platform} name={name} full={scale >= 1.3} />
        ) : presence === "absent" || presence === "unknown" ? (
          <div className={presence === "absent" ? styles.absent : styles.unknown}>{presenceWords(presence, platform)}</div>
        ) : (
          <div className={styles.wire} aria-label={`${name}: not seen on ${PLATFORM_WORD[platform]} yet`} role="img">
            <div className={styles.wireBar} style={{ width: "62%" }} />
            <div className={styles.wireText}>{name}</div>
            {route ? <div className={cn(styles.wireText, "font-mono")}>{route}</div> : null}
            {(words ?? []).slice(0, wireLines(innerH, scale, Boolean(route))).map((t, i) => (
              <div key={i} className={styles.wireText}>
                {t}
              </div>
            ))}
            <div className={styles.wireBar} style={{ width: "86%", marginTop: "auto" }} />
            {caption ? <div className={cn(styles.wireText, styles.wireFoot, "text-center")}>{capturing ? "" : `Not seen on ${PLATFORM_WORD[platform]} yet`}</div> : null}
          </div>
        )}
        {shown && chip ? <DeviceChip look={chip} platform={platform} className={styles.chipOn} /> : null}
        {capturing && !shown ? (
          <div className={styles.capture} aria-label={`${name} on ${PLATFORM_WORD[platform]}: being captured`} role="img">
            <span className={styles.captureTag}>Capturing</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A screen on the storyboard: its name, its platforms' frames side by side, its similarity badge
 * and when it changed. The whole card is one button that opens the screen's details.
 */
export const ScreenCard = memo(function ScreenCard({
  screen,
  platforms,
  shapes,
  x,
  y = 0,
  width,
  height,
  lit,
  dim,
  fresh,
  order = 0,
  glowAt = null,
  capturing = null,
  onOpen,
  onHover,
  fillOn,
  onFill,
}: {
  screen: AtlasScreen;
  platforms: Platform[];
  shapes: Shapes;
  x: number;
  /** The top of its line when the row wraps (0 on the first). */
  y?: number;
  width: number;
  height: number;
  lit: boolean;
  dim: boolean;
  fresh: boolean;
  /** Its place in its row, for the cards dealt in one after another. */
  order?: number;
  /** Lit in turn (a refresh's new screenshots, a jump to it): its place in that order. */
  glowAt?: number | null;
  /** The platform whose frame the high-level pass is about to capture, if any. */
  capturing?: Platform | null;
  /** Platforms a "Fill in" can start on now; with `onFill`, a not-seen frame offers it. */
  fillOn?: ReadonlySet<Platform>;
  onFill?: (platform: Platform) => void;
  onOpen: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const sim = screen.similarity;
  const tip = useTip();
  const changed = Boolean(screen.change);
  // A one-phone card: its name keeps the whole width and the New/Changed pill sits on the frame.
  const narrow = width < NARROW_CARD;
  const words = wireWords(screen);
  // The first platform this screen is not seen on yet that a fill-in can start on now.
  const fill = fillOn && !screen.blocked_reason ? (platforms.find((p) => fillOn.has(p) && presenceOf(screen, p) === "unseen") ?? null) : null;
  const summary = [
    screen.name,
    sim ? `${sim.label}${sim.reasons[0] ? `: ${sim.reasons[0]}` : ""}` : null,
    // The card is one button: its frames' words reach a screen reader only through it.
    ...platforms.map((p) => {
      const why = screen.variants[p]?.frame_url ? null : screen.variants[p]?.blank;
      return why ? blankWords(why, p).title : null;
    }),
    changed ? "Changed recently" : null,
    screen.never_seen ? "Not seen live yet" : null,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <>
    <button
      type="button"
      className={styles.card}
      style={{ left: x, top: y, width, height, padding: CARD_PAD, "--k": Math.min(order, 8), "--card-head": `${CARD_PAD + CARD_HEAD}px`, ...(glowAt !== null ? { "--glow-i": glowAt } : null) } as CSSProperties}
      onClick={() => onOpen(screen.id)}
      onMouseEnter={() => onHover(screen.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={(e) => {
        onHover(screen.id);
        // A card reached by the keyboard explains its badge, as a hover on the badge does.
        if (sim && keyboardFocus(e.currentTarget)) tip.show(e.currentTarget.querySelector("[data-atlas-badge]"), true);
      }}
      onBlur={() => {
        onHover(null);
        tip.hide(true);
      }}
      aria-describedby={sim ? tip.describedBy : undefined}
      data-lit={lit || undefined}
      data-dim={dim || undefined}
      data-changed={changed || undefined}
      data-fresh={fresh || undefined}
      data-glow={glowAt !== null || undefined}
      data-atlas-card={screen.id}
      aria-label={summary}
    >
      <div className={cn("flex flex-col justify-start", changed && !narrow ? "pr-[68px]" : "pr-2")} style={{ height: CARD_HEAD - 6 }} title={screen.route ? `${screen.name} · ${screen.route}` : screen.name}>
        <span className={cn(styles.cardTitle, "text-sm font-medium text-fg")}>{screen.name}</span>
        {screen.route ? <span className="truncate font-mono text-[11px] leading-4 text-muted">{screen.route}</span> : null}
      </div>
      {screen.change ? (
        <span className={styles.changePill} data-kind={screen.change.kind} data-narrow={narrow || undefined} aria-hidden>
          {screen.change.kind === "new" ? "New" : "Changed"}
        </span>
      ) : null}
      <div className="flex items-start" style={{ gap: FRAME_GAP }}>
        {platforms.map((p) => {
          const v = screen.variants[p];
          // The column's room, and the frame of the device that took the screenshot: an iPad's shot
          // in an iPad (shrunk into a phone column), never in a phone.
          const slot = frameKind(p, shapes);
          const own = (v?.frame_url && !v.signin_only ? lookKind(p, v.device) : null) ?? slot;
          const frame = (
            <DeviceFrame
              key={p}
              platform={p}
              kind={own}
              scale={slotFit(slot, own)}
              src={v?.frame_url ?? null}
              shot={v?.device}
              name={screen.name}
              route={v?.route ?? screen.route}
              words={words}
              presence={presenceOf(screen, p)}
              gated={Boolean(v?.signin_only)}
              blank={v?.blank ?? null}
              note={v?.unfit ?? null}
              chip={deviceSeen(v?.device)}
              fresh={fresh}
              capturing={capturing === p}
              // One platform: the card's foot says "Not seen yet" for the whole screen.
              caption={platforms.length > 1}
            />
          );
          return own === slot ? (
            frame
          ) : (
            <span key={p} className={styles.slot} style={{ width: FRAME[slot].w, height: FRAME[slot].h }} data-atlas-slot={slot}>
              {frame}
            </span>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-1.5 overflow-hidden">
        {sim ? (
          <SimilarityBadge tip={tip} badge={sim.badge} label={width < NARROW_CARD ? BADGE_SHORT[sim.badge] : sim.badge === "missing" ? (sim.reasons[0] ?? sim.label) : sim.label} />
        ) : null}
        {screen.never_seen && !sim ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] text-muted">
            <CircleDashed className="size-3" aria-hidden />
            Not seen yet
          </span>
        ) : null}
      </div>
    </button>
    {fill && onFill ? (
      // Beside the card, never inside it (a button in a button): it shows while the card is
      // hovered or focused, and is the next stop for the keyboard.
      <button
        type="button"
        className={styles.cardFill}
        style={{ left: x + width - 10, top: y + height - 10 } as CSSProperties}
        onClick={() => onFill(fill)}
        aria-label={`Fill in ${PLATFORM_WORD[fill]}: a pass at the screens not seen on ${PLATFORM_WORD[fill]} yet, ${screen.name} among them`}
        data-atlas-card-fill={fill}
      >
        Fill in {PLATFORM_WORD[fill]}
      </button>
    ) : null}
    {sim ? <BadgeTip tip={tip} badge={sim.badge} /> : null}
    </>
  );
});

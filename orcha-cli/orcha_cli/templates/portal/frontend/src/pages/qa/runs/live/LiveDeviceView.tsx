import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "../../../../components/primitives";
import { Button, StatusGlyph, cn, useToast } from "../../map/kit";
import { Hand } from "../../map/kit/icons";
import type { QaAuthority } from "../../authority";
import { useRunWords } from "../../run/ActivityPanel";
import { stopSession } from "../../sessions/api";
import { DESKTOP_FALLBACK, duoFallbackSizeFor, frameScreenSize, isTabletStyle, tabletChromeGeometry, type DeviceFrameStyle } from "../lib/device-frame";
import { BrowserFrame } from "../replay/browser-frame";
import { BufferedImage } from "../replay/buffered-image";
import { DeviceBezel, useFrameStyle } from "../replay/device-bezel";
import { urlFor } from "../replay/use-signed-url";
import { markSessionFailed } from "./liveApi";
import type { TargetKind } from "./recording";
import { RecordingCommands } from "./recording-commands";
import { RecordingControls } from "./recording-controls";
import { livePhase, sessionEnded, staleBannerTone, staleMinutesOf, takeoverBlock, type LiveFrame, type LiveMeta, type LivePhase } from "./recording-live";
import { RecordingScreen } from "./recording-screen";
import { useLiveDrive } from "./use-live-drive";
import { liveFrameSrc, useLiveFrame } from "./use-live-frame";

// Vertical chrome around the frame in this card: the status/label row above it and the actions
// line below, plus gaps: kept small since the card itself sits inline in a page rather than
// filling a fixed-height column.
const PEEK_RESERVE_PX = 70;

const PLATFORM_NAMES: Record<string, string> = { ios: "iOS", android: "Android", web: "Web" };

/** The frame's width so that its full height fits the size container it sits in. */
export function fitWidth(phone: boolean, aspect: string, style?: DeviceFrameStyle): string {
  // The browser frame: a 30px title bar over the page, at the capture's own aspect.
  const m = /^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(aspect);
  const w = m ? Number(m[1]) : 0;
  const h = m ? Number(m[2]) : 0;
  if (!phone) return `min(100%, calc((100cqh - 32px) * ${w > 0 && h > 0 ? (w / h).toFixed(4) : "1.6"}))`;
  if (style && isTabletStyle(style) && w > 0 && h > 0) {
    // A tablet's bezel is a fixed share of its short side on every edge: fit the whole body.
    const [bw, bh] = tabletChromeGeometry(style, w, h).bodyAspect.split("/").map((n) => Number(n.trim()));
    return `min(100%, calc(100cqh * ${(bw / bh).toFixed(4)}))`;
  }
  const ratio = w > 0 && h > 0 ? h / w : 19.5 / 9;
  // The bezel adds a few percent of its width around the screen: 0.08 of the width on top of
  // the screen's own height keeps every phone style inside the box.
  return `min(100%, calc(100cqh / ${(ratio + 0.08).toFixed(4)}))`;
}

/**
 * One screen in the frame of the session's platform: a phone or tablet for iOS / Android, a
 * browser window for the web. `children` replaces the image while a person drives.
 */
function FrameView({
  platform,
  deviceName,
  src,
  keep = false,
  address,
  fit = false,
  loadedSize,
  onSize,
  children,
}: {
  platform: TargetKind;
  deviceName?: string | null;
  src: string | null;
  /** With no `src`: a frame has been painted and stays on screen. */
  keep?: boolean;
  address?: string | null;
  /** Fill the space the parent leaves (a flex column of definite height): the whole frame is
   * scaled to fit it, by width or by height, whichever is tighter. */
  fit?: boolean;
  loadedSize: { w: number; h: number } | null;
  onSize: (size: { w: number; h: number }) => void;
  children?: ReactNode;
}) {
  const phone = platform !== "web";
  const frameStyle = useFrameStyle(platform, deviceName, { screenW: loadedSize?.w, screenH: loadedSize?.h });
  const isDuoStyle = frameStyle === "iphone-duo";
  const tablet = isTabletStyle(frameStyle);
  // Before a frame has loaded the frame can only go by the device name; once the image itself
  // loads, `onFrame` replaces this with the image's own proportions.
  const duoClosed = duoFallbackSizeFor("closed", "portrait");
  const tabletFallback = tablet ? frameScreenSize({ style: frameStyle }) : null;
  const fallbackAspect = isDuoStyle
    ? `${duoClosed.w} / ${duoClosed.h}`
    : !phone
      ? "16 / 10"
      : (platform as string) === "desktop"
        ? `${DESKTOP_FALLBACK.w} / ${DESKTOP_FALLBACK.h}`
        : tabletFallback
          ? `${tabletFallback.w} / ${tabletFallback.h}`
          : "9 / 19.5";
  const aspect = loadedSize ? `${loadedSize.w} / ${loadedSize.h}` : fallbackAspect;
  // Double-buffered: each frame is decoded first and faded in over the previous one, which stays
  // on screen until then.
  const screen =
    children ??
    (src || keep ? (
      <BufferedImage
        src={src}
        alt=""
        fadeMs={0}
        onFrame={({ width, height }) => {
          if (width && height) onSize({ w: width, h: height });
        }}
        // Duo / tablet: never crop (the box re-flows a paint after the image's own size is known).
        className={isDuoStyle || tablet || !phone ? "object-contain" : "object-cover"}
        frontProps={{ "data-live-frame": "" }}
      />
    ) : (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center text-xs text-muted" data-live-frame-empty role="status">
        <span className="animate-shimmer h-2.5 w-1/2 rounded-sm" />
        Waiting for the first screen…
      </div>
    ));
  const reserve = fit ? 0 : PEEK_RESERVE_PX;
  const frame = phone ? (
    <DeviceBezel style={frameStyle} aspect={aspect} reserve={reserve} className={fit ? "max-w-none" : tablet ? "mx-auto max-w-[360px]" : "mx-auto max-w-[220px]"}>
      {screen}
    </DeviceBezel>
  ) : (
    <BrowserFrame aspect={aspect} reserve={reserve} address={address}>
      {screen}
    </BrowserFrame>
  );
  if (!fit) return frame;
  return (
    // A size container: `cqh` is the height left for the frame, so the frame's width (the bezel
    // draws itself from its width) can be derived from it.
    <div className="flex min-h-0 w-full flex-1 items-center justify-center [container-type:size]" data-frame-fit>
      <div className="mx-auto transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{ width: fitWidth(phone, aspect, frameStyle) }}>
        {frame}
      </div>
    </div>
  );
}

function LiveBadge({ phase }: { phase: LivePhase }) {
  const live = phase === "live";
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-medium", live ? "text-fg" : "text-muted")}
      data-live-badge={phase}
    >
      <span className={cn("size-1.5 rounded-full", live ? "bg-danger motion-safe:animate-pulse" : "bg-muted")} aria-hidden />
      {live ? "LIVE" : phase === "waiting" ? "Connecting" : phase === "abandoned" ? "Abandoned" : "Finished"}
    </span>
  );
}

function Placement({ platform, deviceName }: { platform: TargetKind; deviceName?: string | null }) {
  const name = PLATFORM_NAMES[platform] ?? platform;
  return (
    <span className="min-w-0 truncate text-muted" data-live-placement>
      {deviceName ? `${name} · ${deviceName.replace(/_/g, " ")}` : name}
    </span>
  );
}

export interface LiveDeviceViewProps {
  sessionId: string;
  platform: TargetKind;
  /** The session's `device_name` (a simulator's name; on the web, the viewport). */
  deviceName?: string | null;
  /** The session's status as the page has it. The view also follows it on its own. */
  status?: string | null;
  /** The newest stored frame's id: shown until the first live frame, and after the session ends. */
  fallbackFrameId?: string | null;
  /** What the browser frame's address bar says. */
  address?: string | null;
  /** Fill the column's height, the status sitting under the frame. */
  fit?: boolean;
  /** `fit` only: a line shown right under the frame. */
  caption?: ReactNode;
  /** Who may take the device over. Without it the view only watches. */
  auth?: QaAuthority;
  /** The session stopped running. */
  onEnded?: () => void;
  className?: string;
}

/**
 * The device of a running session, live, in the frame of its own platform: the newest frame the
 * tool server pushed, with a LIVE badge and where it runs. A stalled session says how long nothing
 * has moved, one nothing runs any more says so and can be marked failed, and an ended one stays on
 * its last screen. A person can take the device over and drive it from here: the agent is held
 * after its current step until they hand it back.
 */
export function LiveDeviceView({ sessionId, platform, deviceName, status, fallbackFrameId = null, address, fit = false, caption, auth, onEnded, className }: LiveDeviceViewProps) {
  const { toast } = useToast();
  const [ended, setEnded] = useState(false);
  const running = !ended && (status == null || status === "running");
  const { frame, meta, wake } = useLiveFrame(sessionId, running, null);
  const actor = auth?.human?.id ?? null;
  const drive = useLiveDrive(sessionId, meta, actor, wake);
  // The newest frame stays once the session ends, or the view would blink to its stored one.
  const lastFrame = useRef<LiveFrame | null>(null);
  if (frame) lastFrame.current = frame;
  const painted = lastFrame.current !== null;
  const src = frame ? liveFrameSrc(frame) : !painted && fallbackFrameId ? urlFor(fallbackFrameId) : null;
  const phase = livePhase(meta, ended ? "done" : status, Boolean(src) || painted);
  const [loadedSize, setLoadedSize] = useState<{ w: number; h: number } | null>(null);
  const [stopping, setStopping] = useState(false);
  const words = useRunWords();

  useEffect(() => {
    if (sessionEnded(meta)) setEnded(true);
  }, [meta]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) onEnded?.();
    wasRunning.current = running;
  }, [running, onEnded]);

  const onSize = (size: { w: number; h: number }) => setLoadedSize((prev) => (prev && prev.w === size.w && prev.h === size.h ? prev : size));

  const block = takeoverBlock(phase, meta, auth);
  const driving = drive.driving && phase === "live";
  const other = meta?.takeover && !drive.driving ? meta.takeover.by : null;
  const stale = staleMinutesOf(meta);
  const tone = phase === "live" && !meta?.takeover ? staleBannerTone(stale) : null;

  async function stop(call: () => Promise<unknown>) {
    setStopping(true);
    try {
      await call();
      wake();
    } catch (err) {
      toast({ title: "Could not stop the session", description: err instanceof Error ? err.message : String(err), variant: "error" });
    } finally {
      setStopping(false);
    }
  }

  const view = !src && !painted && !driving ? (
    <div className="qa-noframe" data-live-frame-empty role="status">
      <p className="qa-noframe-t">{words ?? "Waiting for the first screen…"}</p>
      <p className="qa-noframe-b">The device shows here as soon as the app opens on it.</p>
    </div>
  ) : (
    <FrameView platform={platform} deviceName={deviceName} src={src} keep={painted} address={address} fit={fit} loadedSize={loadedSize} onSize={onSize}>
      {driving ? (
        <RecordingScreen
          framePath={fallbackFrameId}
          frameSeq={null}
          live={frame}
          wakeLive={wake}
          kind={platform}
          run={{ id: sessionId, screen_w: meta?.screen_w ?? null, screen_h: meta?.screen_h ?? null }}
          interactive
          longPress={drive.longPress}
          slideFor={drive.slideFor}
          onInput={drive.onInput}
          deviceName={deviceName}
          framed
          onSize={({ width, height }) => onSize({ w: width, h: height })}
        />
      ) : undefined}
    </FrameView>
  );

  const takeButton = auth && phase !== "ended" && !driving ? (
    block ? (
      <Tooltip label={block}>
        <Button size="sm" disabled data-live-take-over>
          <Hand /> Take over
        </Button>
      </Tooltip>
    ) : (
      <Button size="sm" loading={drive.busy} onClick={() => void drive.take(true)} data-live-take-over>
        <Hand /> Take over
      </Button>
    )
  ) : null;

  const status_lines = (
    <>
      {tone ? (
        <p className="flex items-center gap-1.5 text-xs text-fg" data-replay-stale-banner data-tone={tone} role="status">
          <StatusGlyph status={tone === "danger" ? "fail" : "warning"} decorative className="size-3" />
          No activity for {stale} min
        </p>
      ) : null}
      {phase === "abandoned" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg" role="status" data-run-abandoned>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <StatusGlyph status="fail" decorative className="size-3" />
            Abandoned: this session never finished; its tool server stopped answering. Nothing is running it now.
          </span>
          {auth?.can ? (
            <Button size="sm" loading={stopping} onClick={() => void stop(() => markSessionFailed(sessionId, actor))} data-run-mark-failed>
              Mark as failed
            </Button>
          ) : null}
        </div>
      ) : null}
      {other ? (
        <p className="text-xs text-muted" role="status" data-live-driven-by>
          {other} is driving this device. The agent is waiting.
        </p>
      ) : null}
      {meta?.notice ? (
        <p className="text-xs text-muted" role="status" data-live-notice>
          {meta.notice}
        </p>
      ) : null}
    </>
  );

  const controls = driving ? (
    <div className="flex min-w-0 flex-col gap-3" data-live-driving>
      <p className="text-center text-xs text-muted">
        Click to {drive.longPress ? "long press" : "tap"}, hold to long press, drag or scroll to {platform === "web" ? "scroll" : "swipe"}; with the
        screen focused, type straight into the page. The agent waits until you hand it back.
      </p>
      <RecordingControls
        kind={platform}
        disabled={drive.busy}
        canCancel
        longPress={drive.longPress}
        onLongPressChange={drive.setLongPress}
        onSend={drive.send}
        onFinish={() => void drive.take(false)}
        finishing={drive.busy}
        onCancel={() => void stop(() => stopSession(sessionId, actor))}
        cancelling={stopping}
      />
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-fg">Inputs</h2>
        <RecordingCommands rows={drive.rows} />
      </section>
    </div>
  ) : null;

  if (fit) {
    return (
      <aside className={cn("flex min-h-0 flex-1 flex-col gap-2.5", className)} data-live-peek={sessionId} data-live-peek-kind={platform}>
        {view}
        {caption}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <LiveBadge phase={phase} />
          <Placement platform={platform} deviceName={deviceName} />
          <span className="ml-auto shrink-0">{takeButton}</span>
        </div>
        {status_lines}
        {controls}
      </aside>
    );
  }

  return (
    <aside className={cn("flex w-full flex-col gap-2", className)} data-live-peek={sessionId} data-live-peek-kind={platform}>
      <div className="flex items-center gap-2 text-xs">
        <LiveBadge phase={phase} />
        <Placement platform={platform} deviceName={deviceName} />
        <span className="ml-auto shrink-0">{takeButton}</span>
      </div>
      {view}
      {status_lines}
      {controls}
    </aside>
  );
}

export type { LiveMeta };

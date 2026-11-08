/**
 * A screenshot in the frame of the platform it came from. The frames themselves live with the run
 * page (`runs/replay`); this keeps the names the session screens import. `urlFor` turns a stored
 * frame id into its image URL.
 */
import { useCallback, useState, type ReactNode } from "react";
import { frameUrl } from "../qaApi";
import { BrowserFrame as RunBrowserFrame } from "../runs/replay/browser-frame";
import { DeviceBezel as RunDeviceBezel, useFrameStyle } from "../runs/replay/device-bezel";
import { DESKTOP_FALLBACK, frameScreenSize, isTabletStyle, type DeviceFrameStyle } from "../runs/lib/device-frame";

export const urlFor = (frameId: string) => frameUrl(frameId);

export interface Placement {
  kind: "ios" | "android" | "web" | "desktop";
}

export function runPlacement(input: { kind: Placement["kind"] }): Placement {
  return { kind: input.kind };
}

const WEB_ASPECT = "16 / 10";

/** The real device bezel. A caller with no resolved style gets the phone's. */
export function DeviceBezel({ style, ...rest }: { aspect: string; reserve?: number; className?: string; style?: DeviceFrameStyle; title?: string | null; children: ReactNode }) {
  return <RunDeviceBezel style={style ?? "iphone"} {...rest} />;
}

export const BrowserFrame = RunBrowserFrame;

/**
 * The newest frame in the frame of its platform, sized from the capture once it has loaded. `fit`
 * caps it to the height left in the column, as the replay's frame slot does.
 */
export function FrameView({ placement, path, device, fit = false }: { placement: Placement; path: string | null; device?: unknown; fit?: boolean }) {
  const [broken, setBroken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ w: number; h: number } | null>(null);
  const onLoad = useCallback((e: { currentTarget: HTMLImageElement }) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (w && h) setLoaded({ w, h });
  }, []);
  const style = useFrameStyle(placement.kind, typeof device === "string" ? device : null, { device, screenW: loaded?.w ?? null, screenH: loaded?.h ?? null });
  const shown = path && broken !== path ? path : null;
  const size = placement.kind === "web" ? null : frameScreenSize({ style, loaded, screenW: null, screenH: null });
  const contain = placement.kind === "desktop" || isTabletStyle(style);
  const img = shown ? (
    <img key={shown} src={urlFor(shown)} alt="Latest screen" onLoad={onLoad} onError={() => setBroken(shown)} className={contain ? "absolute inset-0 size-full object-contain" : "absolute inset-0 size-full object-cover object-top"} data-frame-image />
  ) : (
    <span className="absolute inset-0 v-skeleton" aria-hidden />
  );
  const reserve = fit ? 320 : 220;
  if (placement.kind === "web") {
    return <BrowserFrame aspect={loaded ? `${loaded.w} / ${loaded.h}` : WEB_ASPECT} reserve={reserve}>{img}</BrowserFrame>;
  }
  const aspect = size ? `${size.w} / ${size.h}` : `${DESKTOP_FALLBACK.w} / ${DESKTOP_FALLBACK.h}`;
  return <DeviceBezel style={style} aspect={aspect} reserve={reserve} className={fit ? undefined : "max-w-[260px]"}>{img}</DeviceBezel>;
}

import type { ReactNode } from "react";
import { Lock } from "../../map/kit/icons";
import { cn } from "../../map/kit";
import { heightCapStyle } from "./device-bezel";

/** The browser chrome bar's height (px): added to the reserve before capping the capture. */
export const BROWSER_BAR_PX = 30;

/**
 * A web run's frame: a macOS browser window (traffic lights, a slim address bar with the page's
 * address, a soft shadow) around the capture at its own aspect ratio. The step player, the live
 * view and the recording all draw it, so a web run always reads as a page in a browser.
 */
export function BrowserFrame({
  aspect,
  reserve = 220,
  address,
  className,
  children,
}: {
  aspect: string;
  reserve?: number;
  /** What the address bar says (`addressLabel`): the page's host and path. */
  address?: string | null;
  className?: string;
  children: ReactNode;
}) {
  const capStyle = heightCapStyle(aspect, reserve + BROWSER_BAR_PX);
  return (
    <div
      data-device="browser"
      data-device-frame="browser"
      className={cn(
        "mx-auto w-full overflow-hidden rounded-[10px] border border-border-strong bg-panel shadow-[0_18px_44px_rgba(0,0,0,0.18),0_0_0_0.5px_rgba(0,0,0,0.15)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.6),0_0_0_0.5px_rgba(0,0,0,0.6)]",
        className,
      )}
      style={capStyle}
    >
      <div className="relative flex items-center gap-3 border-b border-border bg-panel-2 px-3" style={{ height: BROWSER_BAR_PX }}>
        <span aria-hidden className="flex shrink-0 items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]" />
          <span className="size-2.5 rounded-full bg-[#febc2e] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]" />
          <span className="size-2.5 rounded-full bg-[#28c840] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]" />
        </span>
        <span
          className="mx-auto flex h-[18px] min-w-0 max-w-[70%] flex-1 items-center justify-center gap-1 rounded-[5px] bg-hover px-2 text-[11px] text-muted"
          data-browser-address
          title={address ?? undefined}
        >
          {address ? (
            <>
              <Lock aria-hidden className="size-2.5 shrink-0" />
              <span className="truncate">{address}</span>
            </>
          ) : null}
        </span>
        {/* Balances the traffic lights so the address bar sits in the middle. */}
        <span aria-hidden className="w-[46px] shrink-0" />
      </div>
      <div className="relative w-full bg-black" style={{ aspectRatio: aspect }}>
        {children}
      </div>
    </div>
  );
}

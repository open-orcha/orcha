import { useState } from "react";
import { BrowserFrame, DeviceBezel, urlFor } from "../frames";
import type { TargetKind } from "../explorations";
import { cn } from "../../map/kit";

const PHONE_ASPECT = "402 / 874";
const WEB_ASPECT = "16 / 10";

/** Whether a finding's screenshot belongs in a phone (or tablet) rather than a window. */
export function isDeviceKind(kind: TargetKind | null | undefined): kind is "ios" | "android" {
  return kind === "ios" || kind === "android";
}

/**
 * A finding's evidence screenshot in the frame of the platform it was captured on: the phone
 * for an iOS or Android exploration (the whole screen, never a cropped strip of its top), a
 * browser window for web, a Mac window for desktop. The frame takes the screenshot's own
 * shape once it loads, so an iPad capture becomes a tablet and a wide page a wide window.
 * `size="thumb"` is the list's small version; `size="hero"` fills the detail sheet's column.
 */
export function FindingShot({
  path,
  alt,
  kind,
  size,
  className,
}: {
  path: string;
  alt: string;
  kind: TargetKind | null;
  size: "thumb" | "hero";
  className?: string;
}) {
  const [aspect, setAspect] = useState<string | null>(null);
  const img = (
    <img
      src={urlFor(path)}
      alt={alt}
      loading={size === "thumb" ? "lazy" : undefined}
      draggable={false}
      onLoad={(e) => {
        const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
        if (w && h) setAspect(`${w} / ${h}`);
      }}
      className="absolute inset-0 size-full object-cover object-top"
      data-finding-evidence
    />
  );
  const reserve = size === "hero" ? 150 : 0;
  if (isDeviceKind(kind) || kind === "desktop") {
    return (
      <DeviceBezel
        aspect={aspect ?? (kind === "desktop" ? WEB_ASPECT : PHONE_ASPECT)}
        reserve={reserve}
        className={cn(size === "thumb" ? "mx-0 w-[92px] max-w-[92px]" : "mx-auto max-w-[340px]", className)}
      >
        {img}
      </DeviceBezel>
    );
  }
  if (size === "thumb") {
    // A browser's title bar would take a fifth of a thumbnail: a plain page-shaped card instead.
    return (
      <span
        className={cn("relative block w-44 overflow-hidden rounded-md border border-border bg-panel-2", className)}
        style={{ aspectRatio: WEB_ASPECT }}
      >
        {img}
      </span>
    );
  }
  return (
    <BrowserFrame
      aspect={aspect ?? WEB_ASPECT}
      reserve={reserve}
      className={cn("mx-auto w-full", className)}
    >
      {img}
    </BrowserFrame>
  );
}

import { useState, type SyntheticEvent } from "react";
import { ImageOff, Maximize2 } from "../../map/kit/icons";
import { Dialog } from "../../map/kit";
import { urlFor } from "../frames";
import { normalizeRect } from "./exploration";
import { cn } from "../../map/kit";

/**
 * The whole screen a finding was measured on, with the measured element outlined.
 *
 * Shown in the detail panel rather than as a thumbnail on every row: the crop
 * answered "where on this control", this answers "where on the screen", and it is
 * only worth the pixels for the one finding being read. `rect` is in image pixels,
 * so the outline is placed as a percentage of the natural size once it is known.
 */
export function FindingScreenshot({
  framePath,
  rect,
  alt,
  label,
  className,
}: {
  framePath: string | null;
  rect: readonly number[] | null;
  alt: string;
  label?: string | null;
  className?: string;
}) {
  const [error, setError] = useState(false);
  const url = framePath ? urlFor(framePath) : null;
  const onError = () => setError(true);
  const [natural, setNatural] = useState<{ src: string; w: number; h: number } | null>(null);
  const [open, setOpen] = useState(false);
  const box = normalizeRect(rect);
  // A size measured for the previous screenshot must not place this one's outline.
  const size = natural && natural.src === url ? natural : null;

  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && url) setNatural({ src: url, w: img.naturalWidth, h: img.naturalHeight });
  };

  if (!framePath) {
    return (
      <div className={cn("flex h-28 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted", className)}>
        no screenshot
      </div>
    );
  }

  const outline = (ring: string) =>
    box && size ? (
      <span
        aria-hidden
        data-screenshot-outline
        className={cn("pointer-events-none absolute rounded-[2px] ring-2 ring-accent", ring)}
        style={{
          left: `${(box.x / size.w) * 100}%`,
          top: `${(box.y / size.h) * 100}%`,
          width: `${(box.w / size.w) * 100}%`,
          height: `${(box.h / size.h) * 100}%`,
        }}
      />
    ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!url}
        title="Open full size"
        data-finding-screenshot
        className={cn(
          "group relative flex min-h-28 w-full items-center justify-center overflow-hidden rounded-md border border-border bg-panel-2 p-2 transition-colors hover:border-border-strong disabled:cursor-default",
          className,
        )}
      >
        {url ? (
          <span className="relative block w-fit">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed URL from a private bucket */}
            <img
              key={url}
              src={url}
              alt={alt}
              onLoad={onLoad}
              onError={onError}
              draggable={false}
              className="block max-h-[340px] w-auto max-w-full rounded-sm"
            />
            {outline("shadow-[0_0_0_9999px_rgba(0,0,0,0.32)]")}
          </span>
        ) : error ? (
          <ImageOff className="size-4 text-muted" strokeWidth={1.5} aria-hidden />
        ) : (
          <span className="h-40 w-24 animate-pulse rounded-sm bg-hover" />
        )}
        <span className="pointer-events-none absolute right-2 top-2 flex size-5 items-center justify-center rounded-sm bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100">
          <Maximize2 className="size-3" strokeWidth={2} aria-hidden />
        </span>
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={label ?? "Evidence"}
        description={alt}
        className="max-w-[min(96vw,1100px)]"
      >
        {url ? (
          <div className="relative mx-auto w-fit">
            {/* eslint-disable-next-line @next/next/no-img-element -- signed URL from a private bucket */}
            <img
              src={url}
              alt={alt}
              className="block max-h-[calc(100dvh-220px)] w-auto max-w-full rounded-md border border-border"
            />
            {outline("")}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

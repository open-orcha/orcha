import { useState } from "react";
import { ImageOff } from "../../map/kit/icons";
import { SeverityTag } from "../../map/kit";
import { ImageLightbox } from "../../map/kit";
import { useSignedUrl } from "../replay/use-signed-url";
import { evidenceThumbSize } from "../lib/device-frame";
import type { Evidence, TargetKind } from "../types";
import { cn } from "../../map/kit";
import { humanizeCheckText } from "../lib/humanize-locator";

/** Evidence screenshot thumbnail (signed URL); click opens it full size. The box takes the
 * run's capture ratio (`kind` + `screenW`/`screenH`, see `evidenceThumbSize`); a `className`
 * with its own `h-*`/`w-*` still wins for callers that size it themselves. */
export function EvidenceThumb({
  evidence,
  className,
  kind,
  screenW,
  screenH,
}: {
  evidence: Evidence;
  className?: string;
  kind?: TargetKind | null;
  screenW?: number | null;
  screenH?: number | null;
}) {
  // Without the run's platform or screen size, the box takes the screenshot's own shape once it
  // loads: a web capture in a phone-shaped box shrank to a sliver with grey below it.
  const [natural, setNatural] = useState<number | null>(null);
  const known = Boolean(kind || (screenW && screenH));
  const sized = evidenceThumbSize(kind, screenW, screenH);
  const box = !known && natural ? { w: Math.round(Math.min(Math.max(sized.h * natural, 48), 260)), h: sized.h } : sized;
  const { url, error, onError } = useSignedUrl(evidence.png_path);
  const [open, setOpen] = useState(false);
  const label = evidence.label ?? `evidence ${evidence.seq}`;

  // The accessibility tree opens in the in-app sheet, over the lightbox (never a browser tab).

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!url}
        title={`E${evidence.seq} · ${label}`}
        data-evidence-thumb={evidence.seq}
        data-evidence-aspect={`${box.w}x${box.h}`}
        style={{ width: box.w, height: box.h }}
        className={cn(
          // The box follows the run's own capture ratio (phone 64×139, web 222×139, tablet in
          // between) — see `evidenceThumbSize`; `object-contain` keeps whatever lands inside honest.
          "group relative shrink-0 overflow-hidden rounded-md border border-border bg-panel-2 transition-colors hover:border-muted focus-visible:border-muted disabled:cursor-default",
          className,
        )}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed URL from a private bucket
          <img
            src={url}
            alt={label}
            onError={onError}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth && img.naturalHeight) setNatural(img.naturalWidth / img.naturalHeight);
            }}
            className="size-full object-contain object-top"
            draggable={false}
          />
        ) : (
          <span className="flex size-full items-center justify-center text-muted">
            {error ? (
              <ImageOff className="size-3.5" strokeWidth={1.5} aria-hidden />
            ) : (
              <span className="size-full animate-pulse bg-hover" />
            )}
          </span>
        )}
        <span className="absolute bottom-1 left-1 rounded-sm bg-black/70 px-1 font-mono text-2xs leading-4 text-white">
          E{evidence.seq}
        </span>
      </button>

      {url ? (
        <ImageLightbox
          open={open}
          onClose={() => setOpen(false)}
          src={url}
          alt={label}
          title={
            <span className="flex items-center gap-2">
              <SeverityTag severity={evidence.severity} />
              <span className="truncate">{label}</span>
            </span>
          }
          description={evidence.note && evidence.note !== label ? evidence.note : undefined}
          details={
            evidence.expected || evidence.actual ? (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-muted">
                {evidence.expected ? (
                  <>
                    <dt>Expected</dt>
                    <dd className="select-text text-fg">{humanizeCheckText(evidence.expected)}</dd>
                  </>
                ) : null}
                {evidence.actual ? (
                  <>
                    <dt>Actual</dt>
                    <dd className="select-text text-fg">{humanizeCheckText(evidence.actual)}</dd>
                  </>
                ) : null}
              </dl>
            ) : null
          }
        />
      ) : null}
    </>
  );
}

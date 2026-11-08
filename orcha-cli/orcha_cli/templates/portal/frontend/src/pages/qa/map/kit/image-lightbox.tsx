
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Download, ZoomIn, ZoomOut } from "./icons";
import { Button, buttonVariants } from "./button";
import { Dialog } from "./dialog";
import { cn } from "./cn";


/** The file name a saved frame gets: the URL's last segment (`0062.jpg`), else `screenshot`. */
export function imageFileName(src: string): string {
  try {
    const last = new URL(src, "http://local").pathname.split("/").filter(Boolean).pop();
    return last && /\.[a-z0-9]+$/i.test(last) ? decodeURIComponent(last) : "screenshot.png";
  } catch {
    return "screenshot.png";
  }
}

/**
 * The one full-size screenshot viewer (Decisions, failure captures, finding evidence). The frame
 * fills the window's height instead of its own pixel size, so a small capture is still big
 * enough to read; clicking it (or Zoom) doubles it and pans to the spot that was clicked.
 *
 * Everything stays in the app: in a browser the footer offers "Open in a new tab"; in the Mac app,
 * where a new window would be the system browser on a localhost URL, it offers "Save image" (a
 * download, which the app saves where the person picks) instead.
 */
export function ImageLightbox({
  open,
  onClose,
  src,
  alt,
  title,
  description,
  footer,
  details,
  dataAttrs,
}: {
  open: boolean;
  onClose: () => void;
  src: string;
  alt: string;
  title: ReactNode;
  /** The dialog's second line ("Captured at step 7"). */
  description?: ReactNode;
  /** Extra footer actions, before Zoom and "Open in a new tab" (or "Save image" in the Mac app). */
  footer?: ReactNode;
  /** Shown under the frame (Expected / Actual). The frame leaves room for it. */
  details?: ReactNode;
  dataAttrs?: Record<string, string | undefined>;
}) {
  const [zoom, setZoom] = useState(false);
  // False on the server and the first paint, so hydration matches.
  const macApp = false as boolean;
  const stage = useRef<HTMLDivElement>(null);
  // Where the click landed, as a fraction of the frame, so the zoomed frame opens on that spot.
  const focus = useRef({ x: 0.5, y: 0.5 });

  useEffect(() => {
    const el = stage.current;
    if (!zoom || !el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, el.scrollWidth * focus.current.x - el.clientWidth / 2);
      el.scrollTop = Math.max(0, el.scrollHeight * focus.current.y - el.clientHeight / 2);
    });
    return () => cancelAnimationFrame(raf);
  }, [zoom]);

  function toggle(e?: MouseEvent<HTMLImageElement>) {
    if (e && !zoom) {
      const r = e.currentTarget.getBoundingClientRect();
      focus.current = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    } else if (!e) {
      focus.current = { x: 0.5, y: 0.5 };
    }
    setZoom((z) => !z);
  }

  function close() {
    setZoom(false);
    onClose();
  }

  // The frame's height: the window minus the dialog's header and footer, and the details row.
  const fit = details ? "h-[calc(100dvh-320px)]" : "h-[calc(100dvh-240px)]";

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      className="max-w-[min(96vw,1280px)]"
      footer={
        <>
          {footer}
          <Button variant="ghost" onClick={() => toggle()} data-lightbox-zoom={zoom ? "in" : "out"}>
            {zoom ? <ZoomOut /> : <ZoomIn />} {zoom ? "Fit" : "Zoom"}
          </Button>
          {macApp ? (
            <a href={src} download={imageFileName(src)} className={buttonVariants({ variant: "ghost" })} data-lightbox-save>
              <Download /> Save image
            </a>
          ) : (
            <Button variant="ghost" onClick={() => window.open(src, "_blank", "noopener")} data-lightbox-new-tab>
              Open in a new tab
            </Button>
          )}
        </>
      }
    >
      <div
        ref={stage}
        className={cn("min-h-[240px]", fit, zoom ? "overflow-auto" : "flex justify-center")}
        data-lightbox-stage={zoom ? "zoomed" : "fit"}
        {...dataAttrs}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- signed URL from a private bucket */}
        <img
          src={src}
          alt={alt}
          onClick={toggle}
          draggable={false}
          className={cn(
            "rounded-md border border-border object-contain",
            zoom ? "mx-auto block h-[200%] w-auto max-w-none cursor-zoom-out" : "h-full w-auto max-w-full cursor-zoom-in",
          )}
        />
      </div>
      {details}
    </Dialog>
  );
}

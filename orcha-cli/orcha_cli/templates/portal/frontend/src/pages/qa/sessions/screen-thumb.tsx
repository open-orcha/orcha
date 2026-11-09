import { useState, type CSSProperties, type ReactNode } from "react";
import { ImageLightbox } from "./../map/kit";
import { cn } from "./../map/kit";

/**
 * A screenshot thumbnail that opens full size in a dialog on click (the failure-capture zoom of
 * #76, shared): small where it is listed, the whole frame in the lightbox with "Open in a new
 * tab" and any extra footer actions (e.g. "Go to step 7"). The viewer is `ImageLightbox`.
 */
export function ScreenThumb({
  src,
  label,
  description,
  footer,
  className,
  imgClassName,
  imgStyle,
  children,
  onHover,
  onSize,
  dataAttrs,
}: {
  src: string;
  label: string;
  /** The dialog's second line ("Captured at step 7"). */
  description?: ReactNode;
  /** Extra buttons in the dialog footer, before "Open in a new tab". */
  footer?: (close: () => void) => ReactNode;
  className?: string;
  imgClassName?: string;
  /** Inline size for the frame box (wins over `imgClassName`'s size): a caller that knows the shape. */
  imgStyle?: CSSProperties;
  /** Drawn over the thumbnail (a badge). */
  children?: ReactNode;
  onHover?: (hovered: boolean) => void;
  /** The screenshot's natural size once it has loaded (a strip can then size a tablet's slot). */
  onSize?: (size: { w: number; h: number }) => void;
  dataAttrs?: Record<string, string | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        onMouseEnter={onHover ? () => onHover(true) : undefined}
        onMouseLeave={onHover ? () => onHover(false) : undefined}
        onFocus={onHover ? () => onHover(true) : undefined}
        onBlur={onHover ? () => onHover(false) : undefined}
        title="View full size"
        aria-label={`View ${label} full size`}
        className={cn(
          "group relative block cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          className,
        )}
        {...dataAttrs}
      >
        <span
          className={cn(
            "relative block overflow-hidden rounded-md border border-border bg-panel transition-[border-color] group-hover:border-border-strong",
            imgClassName,
          )}
          style={imgStyle}
        >
          <img
            src={src}
            alt={label}
            loading="lazy"
            className="absolute inset-0 size-full object-cover object-top"
            onLoad={onSize ? (e) => onSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }) : undefined}
          />
        </span>
        {children}
      </button>
      <ImageLightbox
        open={open}
        onClose={close}
        src={src}
        alt={label}
        title={label}
        description={description}
        footer={footer?.(close)}
      />
    </>
  );
}

/**
 * Device screenshots ("frames", GET /api/qa/frames/{fid}): a phone-shaped thumbnail,
 * (wide for a desktop browser), a filmstrip of them, and one lightbox that pages through the strip it was opened
 * from (← / → / Escape). A frame that fails to load says so instead of a broken image.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../../components/primitives";
import { trapTab, useFocusReturn } from "../../components/primitives/focus";
import { frameUrl } from "./qaApi";

export interface FrameItem {
  id: string;
  /** what the frame shows ("Step 2 · Tap Sign in") — alt text and the lightbox caption */
  caption: string;
  /** Where the image is, when it is not a frame of this project (an imported report's). */
  src?: string;
}

/** Thumbnail shape: phone-shaped (iOS, Android, a mobile web viewport) or wide (a desktop browser). */
export type FrameShape = "phone" | "wide";
const ShapeCtx = createContext<FrameShape>("phone");
export function FrameShapeProvider({ shape, children }: { shape: FrameShape; children: ReactNode }) {
  return <ShapeCtx.Provider value={shape}>{children}</ShapeCtx.Provider>;
}

type Open = (items: FrameItem[], index: number) => void;
const LightboxCtx = createContext<Open | null>(null);

/** Opens the page's lightbox on `items` at `index`, for thumbnails drawn elsewhere; null outside a provider. */
export function useFrameLightbox(): Open | null {
  return useContext(LightboxCtx);
}

/** Mount once per page; every <FrameThumb> below opens the shared lightbox. */
export function FrameLightboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ items: FrameItem[]; index: number } | null>(null);
  const open = useCallback<Open>((items, index) => setState({ items, index }), []);
  return (
    <LightboxCtx.Provider value={open}>
      {children}
      {state ? <FrameLightbox items={state.items} index={state.index} onIndex={(i) => setState((s) => (s ? { ...s, index: i } : s))} onClose={() => setState(null)} /> : null}
    </LightboxCtx.Provider>
  );
}

export function FrameThumb({ frame, strip, index = 0, size = "md", label }: {
  frame: FrameItem;
  /** the strip the lightbox pages through (defaults to this frame alone) */
  strip?: FrameItem[];
  index?: number;
  size?: "sm" | "md" | "lg";
  /** a short word under the thumbnail ("Step 2") */
  label?: ReactNode;
}) {
  const open = useContext(LightboxCtx);
  const shape = useContext(ShapeCtx);
  const [broken, setBroken] = useState(false);
  const img = broken ? (
    <span className="qa-frame-missing">Screenshot unavailable</span>
  ) : (
    <img src={frame.src ?? frameUrl(frame.id)} alt={frame.caption} loading="lazy" onError={() => setBroken(true)} />
  );
  return (
    <figure className={"qa-frame qa-frame-" + size + (shape === "wide" ? " is-wide" : "")}>
      {open && !broken ? (
        <button type="button" className="qa-frame-btn" aria-label={"Enlarge screenshot: " + frame.caption} onClick={() => open(strip ?? [frame], strip ? index : 0)}>
          {img}
        </button>
      ) : (
        <span className="qa-frame-btn is-static">{img}</span>
      )}
      {label != null ? <figcaption className="qa-frame-cap">{label}</figcaption> : null}
    </figure>
  );
}

/** A horizontal strip of frames; the lightbox pages through all of them. */
export function Filmstrip({ frames, label, size = "sm" }: { frames: (FrameItem & { label?: ReactNode })[]; label: string; size?: "sm" | "md" }) {
  if (!frames.length) return null;
  return (
    <ol className="qa-strip" aria-label={label}>
      {frames.map((f, i) => (
        <li key={f.id + ":" + i}>
          <FrameThumb frame={f} strip={frames} index={i} size={size} label={f.label} />
        </li>
      ))}
    </ol>
  );
}

function FrameLightbox({ items, index, onIndex, onClose }: { items: FrameItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusReturn(ref);
  const cur = items[Math.max(0, Math.min(index, items.length - 1))];
  const many = items.length > 1;
  useEffect(() => {
    // the image is the only content: the dialog itself holds focus for the arrow keys
    ref.current?.focus();
  }, []);
  if (!cur) return null;
  return createPortal(
    <div className="qa-lightbox" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={"Screenshot: " + cur.caption} tabIndex={-1} className="qa-lightbox-dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
          if (e.key === "ArrowRight" && index < items.length - 1) { e.preventDefault(); onIndex(index + 1); return; }
          if (e.key === "ArrowLeft" && index > 0) { e.preventDefault(); onIndex(index - 1); return; }
          trapTab(e, ref.current);
        }}>
        <div className="qa-lightbox-bar">
          <span className="qa-lightbox-cap">{cur.caption}</span>
          {many ? <span className="qa-lightbox-pos">{index + 1} / {items.length}</span> : null}
          {many ? <IconButton icon="chev-left" label="Previous screenshot" size="sm" disabled={index <= 0} onClick={() => onIndex(index - 1)} /> : null}
          {many ? <IconButton icon="chev-right" label="Next screenshot" size="sm" disabled={index >= items.length - 1} onClick={() => onIndex(index + 1)} /> : null}
          <IconButton icon="x" label="Close screenshot" size="sm" onClick={onClose} />
        </div>
        <img className="qa-lightbox-img" src={cur.src ?? frameUrl(cur.id)} alt={cur.caption} />
      </div>
    </div>,
    document.body,
  );
}

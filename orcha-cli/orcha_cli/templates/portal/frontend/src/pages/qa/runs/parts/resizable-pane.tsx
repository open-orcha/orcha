import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "../../map/kit";

export interface ResizablePaneProps {
  /** Storage key: the chosen width persists per pane in localStorage. */
  id: string;
  /** Which edge of its container the pane sits on; the drag handle is on the opposite edge. */
  side: "left" | "right";
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  /** Never wider than this share of the window, whatever was saved (default 45%). */
  maxViewportFraction?: number;
  className?: string;
  children: ReactNode;
}

const storageKey = (id: string) => `qa-pane:${id}`;

/**
 * A fixed-width side pane with a drag handle on its inner edge. Drag to resize, double-click
 * the handle to reset, arrow keys nudge it when focused. The width is remembered per `id` in
 * the viewer's browser, so a wide monitor can give the device preview real estate while a
 * laptop keeps the default.
 */
export function ResizablePane({
  id,
  side,
  defaultWidth,
  minWidth = 200,
  maxWidth = 1400,
  maxViewportFraction = 0.45,
  className,
  children,
}: ResizablePaneProps) {
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(defaultWidth);
  // A width saved on a wide monitor must not swallow a laptop screen: cap the pane at a
  // fraction of the viewport and follow window resizes.
  const [viewport, setViewport] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setViewport(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const cap = viewport
    ? Math.max(minWidth, Math.floor(viewport * maxViewportFraction))
    : null;
  const effectiveWidth = cap ? Math.min(width, cap) : width;
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback(
    (w: number) => Math.min(maxWidth, Math.max(minWidth, Math.round(w))),
    [minWidth, maxWidth],
  );

  // Read the remembered width after mount so the server and client markup match; a stored
  // value only ever widens/narrows from the default, never breaks hydration.
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey(id)));
      if (Number.isFinite(stored) && stored > 0) {
        const w = clamp(stored);
        widthRef.current = w;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe localStorage read
        setWidth(w);
      }
    } catch {
      // localStorage unavailable: keep the default
    }
  }, [id, clamp]);

  const apply = useCallback(
    (w: number) => {
      const next = clamp(w);
      widthRef.current = next;
      setWidth(next);
    },
    [clamp],
  );

  const persist = useCallback(() => {
    try {
      localStorage.setItem(storageKey(id), String(widthRef.current));
    } catch {
      // ignore
    }
  }, [id]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { startX: e.clientX, startW: widthRef.current };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    apply(drag.current.startW + (side === "left" ? dx : -dx));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    persist();
  };
  const reset = () => {
    apply(defaultWidth);
    try {
      localStorage.removeItem(storageKey(id));
    } catch {
      // ignore
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) apply(widthRef.current + step);
    else if (e.key === shrink) apply(widthRef.current - step);
    else if (e.key === "Home") apply(defaultWidth);
    else return;
    e.preventDefault();
    persist();
  };

  return (
    <div
      data-resizable-pane={id}
      className={cn(
        "relative flex shrink-0",
        dragging && "select-none",
        className,
      )}
      style={{ width: effectiveWidth }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize pane"
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
        data-resize-handle
        className={cn(
          "group absolute inset-y-0 z-10 w-2 cursor-col-resize outline-none",
          side === "left" ? "-right-1" : "-left-1",
        )}
      >
        <div
          className={cn(
            "mx-auto h-full w-px transition-colors group-hover:bg-accent group-focus-visible:bg-accent",
            dragging ? "bg-accent" : "bg-transparent",
          )}
        />
      </div>
    </div>
  );
}

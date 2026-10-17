/**
 * useLogFollow — bottom-follow for a scrolling log / thread (V2, Agent E).
 *
 * Contract (docs/orcha-v2-architecture.md §5 stream/scroll rules):
 *   - while the reader is at the bottom, new content keeps the view pinned to
 *     the bottom (instant pin — see lib/logScroll.ts for why never smooth);
 *   - once the reader scrolls away, new content NEVER moves the viewport, and
 *     `away` turns true so the caller can render a "Jump to latest" control;
 *     `unseen` turns true when content arrived while away;
 *   - `jump()` pins to the bottom and resumes following;
 *   - it never touches focus or the document selection.
 *
 * Call `onContent()` after every append (a layout effect keyed on the rows is
 * the usual caller), and attach `onScroll` to the scrolling element.
 */
import { useCallback, useRef, useState, type RefObject } from "react";
import { nearBottom, pinToBottom } from "../lib/logScroll";

export interface LogFollow {
  away: boolean;
  unseen: boolean;
  onScroll: () => void;
  onContent: () => void;
  jump: () => void;
}

export function useLogFollow(ref: RefObject<HTMLElement | null>): LogFollow {
  const atBottom = useRef(true);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = nearBottom(el);
    atBottom.current = bottom;
    setAway((prev) => (prev === !bottom ? prev : !bottom));
    if (bottom) setUnseen(false);
  }, [ref]);

  const onContent = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (atBottom.current) pinToBottom(el);
    else setUnseen(true);
  }, [ref]);

  const jump = useCallback(() => {
    const el = ref.current;
    atBottom.current = true;
    setAway(false);
    setUnseen(false);
    if (el) pinToBottom(el);
  }, [ref]);

  return { away, unseen, onScroll, onContent, jump };
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight } from "../../map/kit/icons";
import { useNow } from "../detail/phase-timeline";
import { ScreenThumb } from "../screen-thumb";
import { explorerGoing, sessionLine, waitingExplorer, type FeedItem } from "./lib/drafting-board";
import { cn } from "../../map/kit";
import type { DraftingBoard } from "./use-drafting-board";

const ACTOR_TONE: Record<string, string> = {
  Drafter: "text-primary",
  Explorer: "text-success",
};

function ago(at: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

/**
 * The live conversation between the drafter and the explorer of its task (migration 095):
 * what the drafter says, "Drafter → Explorer: open Routines", "Explorer: found 'New routine' dialog
 * (3 fields) [thumb]", "Drafter: revised 'Create a routine' (Save → Create routine)". Compact
 * rows, newest at the bottom; a new row rises in and its tint fades, and the list follows the
 * newest row unless the reader scrolled up.
 */
export function ConversationFeed({
  board,
  className,
  maxHeight = 220,
  screens: runScreens,
}: {
  board: DraftingBoard;
  /** The exploration's distinct screens, when one is running: the same number the live card
   * shows. */
  screens?: number;
  className?: string;
  /** Height of the scrolling list, in px. */
  maxHeight?: number;
}) {
  const now = useNow(true);
  const { session, feed, waiting } = board;
  const explorers = board.explorers ?? [];
  const screens = runScreens ?? board.screens;
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());

  // Rows already on the board when the feed first loads do not animate; later ones do.
  useEffect(() => {
    if (seen.current === null) {
      if (feed.length > 0) seen.current = new Set(feed.map((i) => i.id));
      return;
    }
    const added = feed.filter((i) => !seen.current!.has(i.id)).map((i) => i.id);
    if (added.length === 0) return;
    for (const id of added) seen.current.add(id);
    setFresh(new Set(added));
  }, [feed]);
  // The tint fades on its own clock, whatever else re-renders meanwhile.
  useEffect(() => {
    if (fresh.size === 0) return;
    const t = setTimeout(() => setFresh(new Set()), 1_600);
    return () => clearTimeout(t);
  }, [fresh]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  if (!session && feed.length === 0) return null;
  // Live while either agent still works: a drafter done before its explorer started is not the end.
  const label = explorers.length > 0 ? "Exploring and drafting" : "Drafter";
  const live = board.running || session?.status === "live" || session?.status === "waiting" || (session?.status === "finished" && explorerGoing(explorers));
  const line = sessionLine(session, now, explorers);
  const queuedFor = session ? waitingExplorer(session, explorers) : null;

  return (
    <section
      aria-label={label}
      className={cn("flex min-h-0 shrink-0 flex-col rounded-lg border border-border bg-panel", className)}
      data-conversation-feed={session?.status ?? "none"}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="relative flex size-2 shrink-0" aria-hidden>
          {live ? <span className="absolute inline-flex size-full animate-ping-slow rounded-full bg-success/60" /> : null}
          <span className={cn("relative inline-flex size-2 rounded-full", live ? "bg-success" : "bg-border-strong")} />
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs font-medium text-fg">{label}</span>
        {/* Wraps rather than truncates: in a narrow column the device the explorer waits for is
            the end of the line, and the part that matters. */}
        {line ? (
          <span className="min-w-0 flex-1 text-xs text-muted" data-conversation-status>
            {line}
          </span>
        ) : null}
        {explorers.length > 0 ? (
          <span className="ml-auto shrink-0 text-[11px] tabular text-muted">
            {screens} screen{screens === 1 ? "" : "s"}
            {waiting > 0 ? ` · ${waiting} waiting` : ""}
          </span>
        ) : null}
      </header>
      {feed.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted">
          {queuedFor || session?.explorer_status === "queued"
            ? `The explorer starts when ${queuedFor?.device ?? "its device"} is free, with its full time; the drafter reads the code meanwhile.`
            : "Nothing said yet."}
        </p>
      ) : (
        <ol
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="flex flex-col overflow-y-auto overscroll-contain py-1 [scrollbar-gutter:stable]"
          style={{ maxHeight }}
          data-conversation-list
        >
          {feed.map((item) => (
            <FeedRow key={item.id} item={item} fresh={fresh.has(item.id)} now={now} />
          ))}
        </ol>
      )}
    </section>
  );
}

function FeedRow({ item, fresh, now }: { item: FeedItem; fresh: boolean; now: number }) {
  return (
    <li
      className={cn(
        "group flex items-center gap-2 px-3 py-1 text-xs leading-5 transition-colors duration-700",
        fresh ? "animate-slide-up bg-accent-soft" : "bg-transparent",
      )}
      data-feed-item={item.kind}
    >
      <span className="min-w-0 flex-1 truncate">
        {item.actor ? (
          <span className={cn("font-medium", ACTOR_TONE[item.actor])}>
            {item.actor}
            {item.to ? (
              <>
                <ArrowRight aria-label="to" className="mx-1 inline size-3 align-[-2px] text-muted" />
                <span className={ACTOR_TONE[item.to]}>{item.to}</span>
              </>
            ) : null}
            <span className="text-muted">: </span>
          </span>
        ) : null}
        <span className={item.actor ? "text-fg" : "text-muted"}>{item.text}</span>
        {item.detail ? <span className="ml-1.5 text-muted">({item.detail})</span> : null}
      </span>
      {item.thumb ? (
        <ScreenThumb
          src={item.thumb}
          label={item.text}
          className="shrink-0"
          imgClassName="h-6 w-10 rounded-[3px]"
          dataAttrs={{ "data-feed-thumb": "" }}
        />
      ) : null}
      <span className="w-7 shrink-0 text-right text-[10px] tabular text-muted">{ago(item.at, now)}</span>
    </li>
  );
}

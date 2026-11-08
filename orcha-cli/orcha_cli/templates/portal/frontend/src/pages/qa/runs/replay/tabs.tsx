import { useLayoutEffect, useRef, type ReactNode } from "react";
import { onTablistKeyDown } from "../../map/kit/tablist-keys";
import { cn } from "../../map/kit";

export interface TabDef<K extends string> {
  key: K;
  label: ReactNode;
  /** Optional muted count after the label (Linear's "Tasks 2"). */
  count?: number;
  /** Tints the count as a small badge (a failure count in red, say). */
  tone?: "danger" | "warning";
  /** The tab's tooltip: what its count counts, when the number alone could mislead. */
  title?: string;
}

const COUNT_TONE = {
  danger: "rounded-full bg-danger/15 px-1.5 text-danger",
  warning: "rounded-full bg-warning/15 px-1.5 text-warning",
} as const;

/**
 * Linear tab bar: `text-sm` labels, the selected one in `text-fg` over a 2px underline, the
 * rest muted. Scrolls sideways instead of wrapping when the row is narrower than its tabs.
 *
 * The underline is one bar that glides to the selected tab (a 1px element translated and
 * scaled to the tab's width: transform only). Until it is measured (the server render) the
 * selected tab draws its own underline, so there is never a frame without one; under reduced
 * motion it jumps.
 */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: readonly TabDef<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const labels = tabs.map((t) => t.key).join("|");

  useLayoutEffect(() => {
    const list = listRef.current;
    const bar = barRef.current;
    const on = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !bar || !on) return;
    const place = (animate: boolean) => {
      const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      bar.style.transition = animate && !reduce ? "transform 300ms cubic-bezier(0.2, 0.7, 0.2, 1)" : "none";
      bar.style.transform = `translateX(${on.offsetLeft}px) scaleX(${on.offsetWidth})`;
    };
    place(placed.current);
    placed.current = true;
    list.dataset.measured = "";
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => place(false)) : null;
    ro?.observe(on);
    return () => ro?.disconnect();
  }, [value, labels]);

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={onTablistKeyDown}
      className={cn(
        "group/tabs relative flex shrink-0 gap-5 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            data-tab={t.key}
            title={t.title}
            onClick={() => onChange(t.key)}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center whitespace-nowrap border-b-2 pb-2 pt-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on
                ? "border-fg text-fg group-data-[measured]/tabs:border-transparent"
                : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label}
            {t.count != null ? (
              <span className={cn("ml-1.5 font-normal tabular", t.tone && t.count ? COUNT_TONE[t.tone] : "text-muted")} data-tab-count>
                {t.count}
              </span>
            ) : null}
          </button>
        );
      })}
      <span
        ref={barRef}
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 h-0.5 w-px origin-left bg-fg opacity-0 group-data-[measured]/tabs:opacity-100"
      />
    </div>
  );
}

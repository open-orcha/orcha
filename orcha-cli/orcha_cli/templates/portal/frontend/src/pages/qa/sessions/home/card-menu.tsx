import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Ellipsis } from "../../map/kit/icons";
import { Button } from "../../map/kit";
import { cn } from "../../map/kit";

export interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * A card's overflow menu (WAI-ARIA menu button): Enter or Space opens it on the first item,
 * the arrow keys move, Home and End jump, Escape closes and returns focus to the button, a
 * click outside closes it.
 */
export function CardMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % all.length;
    else if (e.key === "ArrowUp") next = (i - 1 + all.length) % all.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = all.length - 1;
    else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      if (e.key === "Escape") button.current?.focus();
      return;
    }
    if (next != null && all[next]) {
      e.preventDefault();
      all[next].focus();
    }
  }

  return (
    <div ref={ref} className="relative" onKeyDown={open ? onKey : undefined}>
      <Button
        ref={button}
        variant="ghost"
        size="sm"
        icon
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        data-exploration-menu-trigger
      >
        <Ellipsis />
      </Button>
      {open ? (
        <div
          id={id}
          role="menu"
          aria-label={label}
          className="v-pop absolute right-0 top-full z-30 mt-1 w-[210px] rounded-lg border border-border bg-raised p-1 shadow-[var(--shadow-md)]"
          data-exploration-menu
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted",
                item.danger ? "text-danger" : "text-fg",
              )}
              data-menu-item={item.key}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

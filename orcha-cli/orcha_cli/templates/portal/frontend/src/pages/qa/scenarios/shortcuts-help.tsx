
import { useEffect, useRef, useState } from "react";
import { CircleHelp } from "../map/kit/icons";
import { Button, cn } from "../map/kit";

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "N", label: "New scenario" },
  { keys: "F", label: "Fit view" },
  { keys: "/", label: "Focus search" },
  { keys: "Shift + drag", label: "Box-select nodes" },
  { keys: "Esc", label: "Clear selection / close panel" },
  { keys: "Delete", label: "Remove the selected edge" },
  { keys: "⌘/Ctrl + A", label: "Select all visible" },
  { keys: "⌘/Ctrl + S", label: "Save (in the panel)" },
];

/** Toolbar "?" popover listing canvas keyboard shortcuts (spec §3 rework). */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="sm"
        icon
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-shortcuts-help-trigger
      >
        <CircleHelp />
      </Button>
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        data-shortcuts-help-popover
        className={cn(
          "absolute right-0 top-full z-20 mt-1.5 w-[260px] rounded-lg border border-border bg-raised p-3 shadow-md",
          open ? "block" : "hidden",
        )}
      >
        <h3 className="mb-2 text-sm font-semibold text-fg">Keyboard shortcuts</h3>
        <dl className="flex flex-col gap-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between gap-3 text-sm">
              <dt className="text-muted">{s.label}</dt>
              <dd className="shrink-0 rounded border border-border bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-fg">
                {s.keys}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

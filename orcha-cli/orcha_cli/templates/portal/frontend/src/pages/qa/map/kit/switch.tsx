
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * The one on/off switch (Orcha V2 / Linear): 28x16 track, primary (indigo) when on, a
 * quiet panel track when off. Replaces the hand-rolled `role="switch"` buttons. Always
 * give it an accessible name (`aria-label`, or a <label htmlFor>).
 */
export function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  ...rest
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "type">) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors duration-100",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-border-strong bg-panel-2",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-2.5 rounded-full transition-transform duration-100",
          checked ? "translate-x-3.5 bg-white" : "translate-x-0.5 bg-muted",
        )}
      />
    </button>
  );
}

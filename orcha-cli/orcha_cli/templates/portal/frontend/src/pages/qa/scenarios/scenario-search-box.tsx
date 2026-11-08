
import { forwardRef } from "react";
import { Search, X } from "../map/kit/icons";
import { Button, cn, inputClass } from "../map/kit";

export interface ScenarioSearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/** Toolbar search box (spec §3 rework): `/` focuses it; matches dim the rest of the canvas rather than hiding nodes. */
export const ScenarioSearchBox = forwardRef<HTMLInputElement, ScenarioSearchBoxProps>(
  function ScenarioSearchBox({ value, onChange, className }, ref) {
    return (
      <span className={cn("relative inline-flex w-[200px] items-center", className)}>
        <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-muted" />
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search scenarios…"
          aria-label="Search scenarios"
          data-scenario-search
          className={cn(inputClass, "h-7 pl-7", value && "pr-6")}
        />
        {value ? (
          <Button
            variant="ghost"
            size="sm"
            icon
            aria-label="Clear search"
            onClick={() => onChange("")}
            className="absolute right-0.5 size-6"
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </span>
    );
  },
);

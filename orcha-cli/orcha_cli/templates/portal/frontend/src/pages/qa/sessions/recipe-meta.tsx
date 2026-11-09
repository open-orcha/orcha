import { Compass, ListChecks, ScrollText, Timer, Waypoints, type LucideIcon } from "../map/kit/icons";
import { cn } from "../map/kit";
import { scopeLabel, type ExplorationScope } from "./explorations";

/** Each session kind's glyph; `custom` stands in for a session without one. */
export const RECIPE_ICON: Readonly<Record<ExplorationScope | "custom", LucideIcon>> = {
  explore: Compass,
  map: Waypoints,
  draft: ScrollText,
  check: ListChecks,
  custom: Timer,
};

/** "Map the app", or "Custom" without a kind. */
export function recipeLabel(recipe: ExplorationScope | null | undefined): string {
  return recipe ? scopeLabel(recipe) : "Custom";
}

/** A session's kind as icon + label + minutes ("Map the app · 8 min"). */
export function RecipeMeta({ recipe, minutes, showMinutes = true, size = "md", className }: { recipe: ExplorationScope | null | undefined; minutes?: number | null; showMinutes?: boolean; size?: "sm" | "md"; className?: string }) {
  const Icon = RECIPE_ICON[recipe ?? "custom"];
  return (
    <span data-recipe-meta={recipe ?? "custom"} className={cn("inline-flex min-w-0 items-center gap-1.5 text-fg-2", size === "sm" ? "text-xs" : "text-sm", className)}>
      <Icon aria-hidden className={cn("shrink-0", size === "sm" ? "size-3" : "size-3.5")} strokeWidth={2} />
      <span className="truncate">{recipeLabel(recipe)}</span>
      {showMinutes && minutes != null ? <span className="shrink-0 tabular text-muted">· {minutes} min</span> : null}
    </span>
  );
}

/** Right-pane tabs of /runs/[id]; kept in the `tab` search param. */
export const RUN_TABS = ["overview", "steps", "findings", "scenarios", "decisions", "map", "video", "report", "logs", "api", "performance", "data"] as const;
export type RunTab = (typeof RUN_TABS)[number];

export function isRunTab(v: unknown): v is RunTab {
  return typeof v === "string" && (RUN_TABS as readonly string[]).includes(v);
}

/** `href` with `tab` set to `next`. The tab is always written, Steps included: the page's
 * default depends on the run (Scenarios for scenario runs, Steps for explorations), so an
 * omitted param reloaded a scenario run onto Scenarios after the reviewer picked Steps (#176). */
export function withRunTab(href: string, next: RunTab): string {
  const url = new URL(href);
  url.searchParams.set("tab", next);
  return url.toString();
}

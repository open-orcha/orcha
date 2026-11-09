/** An exploration for a test: a row with the fields it cares about, the rest empty. */
import type { Exploration } from "./explorations";

export function parseExploration(raw: Record<string, unknown>): Exploration {
  const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (k === "result" || k === "charter" || k === "briefing" || k === "lenses" || k === "targets") && typeof v === "string" ? JSON.parse(v) : v]));
  return {
    id: "e1",
    project_id: "p1",
    series_id: "e1",
    name: "Exploration",
    name_is_custom: false,
    description: null,
    recipe: null,
    minutes: null,
    lenses: ["works"],
    goal: null,
    targets: [],
    context: null,
    target_id: null,
    environment_id: null,
    platform: null,
    status: "queued",
    request_id: null,
    run_id: null,
    report_id: null,
    briefing: null,
    charter: [],
    result: null,
    study: null,
    error: null,
    started_at: null,
    study_done_at: null,
    finished_at: null,
    archived_at: null,
    created_at: "",
    updated_at: "",
    ...row,
  } as Exploration;
}
export const parseExplorationRow = parseExploration;

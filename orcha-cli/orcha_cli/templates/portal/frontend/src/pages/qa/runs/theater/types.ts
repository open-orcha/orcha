import type { RunDetailProps } from "../replay/run-detail";
import type { RunDetailHeaderProps } from "../replay/run-detail-header";
import type { RunTab } from "../replay/run-tabs";
import type { RunExploration } from "../../sessions/exploration-link";
import type { CharterItem, ExplorationStatus } from "../../sessions/explorations";

/** What the theater's body (the player, the timeline and the tabs) needs; the tab and step to open
 * on come from the URL, and who may act from the page. */
export type TheaterDetail = Omit<RunDetailProps, "initialTab" | "initialStep" | "initialScenarioId" | "auth" | "onRerun">;

/** The document `theaterOf` builds from `GET /api/qa/sessions/{id}/run`. Plain JSON. */
export interface TheaterData {
  runId: string;
  live: boolean;
  /** The tab the run page opens on without `?tab=`: Scenarios for scenario runs, else Steps. */
  defaultTab: RunTab;
  /** The session's time budget in minutes, when it had one. */
  budgetMinutes: number | null;
  /** An exploration's charter of missions, for the timeline's grouping. */
  charter: CharterItem[];
  detail: TheaterDetail;
  header: RunDetailHeaderProps;
  abandonedReason: string | null;
  /** The exploration this run is: the header's way back to it, null for a check run. */
  exploration: RunExploration | null;
  /** Which phase the session is in: studying, exploring, checking, done... */
  phase: ExplorationStatus;
}

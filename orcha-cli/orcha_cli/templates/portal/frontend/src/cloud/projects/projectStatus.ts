/**
 * Project LIFECYCLE status → label + tone, the one map for every surface that
 * shows a project's status (the All-projects table, Settings › General, the
 * Needs-you "All projects" scope). A project status is NOT a task status: the
 * task map (lib/status statusMeta) has no `paused` and renders `active` with the
 * in-progress glyph, which disagrees with the header's green "Running" chip
 * (parity SG-06). Unknown values fall back to a capitalised word, neutral tone.
 */
import type { ChipTone } from "../../components/primitives";

const WORD: Record<string, string> = {
  active: "Active", completed: "Completed", archived: "Archived", paused: "Paused",
  stopped: "Stopped", failed: "Failed", provisioning: "Provisioning",
};
const TONE: Record<string, ChipTone> = {
  active: "ok", completed: "neutral", archived: "neutral", paused: "warn",
  stopped: "neutral", failed: "danger", provisioning: "info",
};

export function projectStatusMeta(status: string | null | undefined): { label: string; tone: ChipTone } {
  const s = (status || "active").toLowerCase();
  const label = WORD[s] ?? (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "Active");
  return { label, tone: TONE[s] ?? "neutral" };
}

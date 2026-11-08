/**
 * The second level of Quality's navigation, one treatment everywhere it is needed: a segmented
 * control directly under the tab it belongs to. QaPage renders it, so it holds still while a view
 * loads; what belongs to that level (a view's filter, the live wall link) goes in through QaSubEnd.
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Tabs, type TabSpec } from "../../components/primitives";
import type { Platform, PlatformOverview } from "./qaApi";
import { platformWord, plural } from "./qaWords";

export interface QaSubLevel {
  label: string;
  items: { key: string; label: string; icon: string }[];
  value: string;
  /** The URL change that opens `key`, or null when that is where we are. */
  open: (key: string) => Record<string, string | null> | null;
}

const RUNS_SUBS = [
  { key: "sessions", label: "All runs", icon: "routines" },
  { key: "requests", label: "Requests", icon: "requests" },
];

/** The level under a view (pure; tested): only Runs has one. */
export function qaSubLevel(view: string): QaSubLevel | null {
  if (view === "sessions" || view === "requests") {
    return {
      label: "Run views", items: RUNS_SUBS, value: view,
      // "All runs" also leads back from a run's detail page
      open: (k) => (k === "requests" && view === "requests" ? null : { view: k, sub: null, session: null, kind: null, status: null, request: null }),
    };
  }
  return null;
}

/**
 * The views an address can name, and where one that was removed lands (pure; tested): the old
 * Overview and Map on Exploration, Triage on Runs, Apps on Exploration with its settings open.
 */
export const QA_ROUTED_VIEWS = ["exploration", "scenarios", "sessions", "requests", "onboarding", "run"] as const;
export type QaView = (typeof QA_ROUTED_VIEWS)[number];

export function qaViewOf(raw: string | null): QaView {
  if ((QA_ROUTED_VIEWS as readonly string[]).includes(raw ?? "")) return raw as QaView;
  return raw === "triage" ? "sessions" : "exploration";
}

/** The waiting work a first-level tab shows (pure; tested). Counts the project, every platform. */
export function qaTabBadges(overview: Record<Platform, PlatformOverview> | null, running: number): Partial<Record<string, QaTabBadge>> {
  const platforms = overview ? (Object.values(overview) as PlatformOverview[]) : [];
  const out: Partial<Record<string, QaTabBadge>> = {};
  const drafts = platforms.reduce((n, p) => n + (p.scenarios.draft ?? 0), 0);
  if (drafts) {
    const on = platforms.filter((p) => p.scenarios.draft);
    const where = on.length > 1 ? `: ${on.map((p) => `${p.scenarios.draft} on ${platformWord(p.platform)}`).join(", ")}` : "";
    out.scenarios = { n: drafts, says: `${plural(drafts, "draft")} to review${where}` };
  }
  if (running) out.sessions = { n: running, says: `${plural(running, "run")} going`, tone: "live" };
  return out;
}

export interface QaTabBadge { n: number; says: string; tone?: "live" }

export function QaTabCount({ badge }: { badge: QaTabBadge }) {
  return (
    <span className={"qa-tabcount" + (badge.tone ? ` is-${badge.tone}` : "")}>
      {badge.tone === "live" ? <span className="qa-livedot" aria-hidden="true" /> : null}
      <span aria-hidden="true">{badge.n > 99 ? "99+" : badge.n}</span>
      <span className="v2-sr">, {badge.says}</span>
    </span>
  );
}

export function QaSubNav({ level, panelId, onChange, endRef }: {
  level: QaSubLevel; panelId: string; onChange: (key: string) => void;
  /** Where QaSubEnd puts this level's own controls. */
  endRef: (el: HTMLElement | null) => void;
}) {
  const tabs: TabSpec[] = level.items.map((s) => ({ key: s.key, label: s.label, icon: s.icon }));
  return (
    <div className="qa-subnav" data-qa-subnav={level.label}>
      <Tabs variant="segmented" className="qa-subtabs" idPrefix="qa-sub" panelId={panelId} label={level.label} tabs={tabs} value={level.value} onChange={onChange} />
      <div className="qa-subnav-end" ref={endRef} />
    </div>
  );
}

/** A view's control on the second level's row, beside the tabs. */
export function QaSubEnd({ slot, children }: { slot?: HTMLElement | null; children: ReactNode }) {
  return slot ? createPortal(children, slot) : null;
}

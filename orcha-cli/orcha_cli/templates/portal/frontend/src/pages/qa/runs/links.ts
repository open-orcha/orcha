/** Deep links into the run page, as `nav.set` patches: `?view=sessions&session=<id>&sub=run`. */
export interface RunLink {
  step?: number | null;
  finding?: number | null;
  scenario?: string | null;
  tab?: string | null;
}

/** The URL params that open a session's run page, at a step, finding or scenario. */
export function runLink(sessionId: string, at: RunLink = {}): Record<string, string | null> {
  return {
    view: "sessions",
    session: sessionId,
    sub: "run",
    step: at.step != null ? String(at.step) : null,
    finding: at.finding != null ? String(at.finding) : null,
    scenario: at.scenario ?? null,
    tab: at.tab ?? null,
  };
}

/** The params the run page owns: cleared on the way out of it. */
export const LEAVE_RUN: Record<string, null> = { sub: null, step: null, finding: null, action: null, tab: null, scenario: null };

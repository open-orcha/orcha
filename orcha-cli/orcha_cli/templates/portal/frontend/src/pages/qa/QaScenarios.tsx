/**
 * Scenarios: the canvas (a dependency map or a list, `?sub=list`).
 * `?scenario=<id>` opens one scenario's panel. A person validates, pauses or retires; agents
 * draft and suggest. Everything here re-reads on the page's timer, faster while a QA session runs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { QaAuthority } from "./authority";
import { RefreshCw } from "./map/kit/icons";
import { Button, Empty, PortRoot, SkeletonRows } from "./map/kit";
import { listSessions, listSuggestions, listTargets, PLATFORMS, type Platform, type QaScenario } from "./qaApi";
import { useLoad } from "./parts";
import type { QaNav } from "./QaPage";
import { adaptScenario, pendingBy, readPositions, writePositions, type Scenario } from "./scenarios/adapt";
import { listAllScenarios } from "./scenarios/api";
import { ScenariosProvider } from "./scenarios/context";
import { parseScenariosView, type ScenariosView } from "./scenarios/scenario-list";
import { EFFECTIVE_STATUSES } from "./scenarios/scenario-status";
import { ScenariosCanvas } from "./scenarios/scenarios-canvas";

export { diffCriteria, evidenceFor, evidenceSummary, statusActions, type CriteriaDiff } from "./scenarios/review-card";
export { WalkBlock } from "./scenarios/walk-block";

/** How often the lists re-read while a session runs (the page's own timer is 30 s). */
const LIVE_MS = 4000;

export function QaScenarios({ cid, nav, auth }: { cid: string; nav: QaNav; auth: QaAuthority }) {
  const { snap } = useSnapshot();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const nonce = nav.nonce + tick;
  const list = useLoad((s) => listAllScenarios(cid, s), [cid], nonce);
  const sugg = useLoad((s) => listSuggestions(cid, s), [cid], nonce);
  const live = useLoad((s) => listSessions(cid, { status: "running" }, s), [cid], nonce);
  const running = (live.data?.length ?? 0) > 0;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(refresh, LIVE_MS);
    return () => clearInterval(t);
  }, [running, refresh]);

  // Map positions are this browser's: the server keeps no position.
  const positions = useRef(readPositions(cid));
  const pending = useMemo(() => pendingBy(sugg.data ?? []), [sugg.data]);
  const adapt = useCallback(
    (row: QaScenario, all: readonly Pick<Scenario, "id" | "name">[]) => adaptScenario(row, all, { positions: positions.current, pending }),
    [pending],
  );
  const scenarios = useMemo(() => (list.data ? list.data.map((r) => adapt(r, list.data ?? [])) : null), [list.data, adapt]);
  const onPositions = useCallback(
    (moved: Map<string, { x: number; y: number }>) => {
      positions.current = { ...positions.current, ...Object.fromEntries(moved) };
      writePositions(cid, positions.current);
    },
    [cid],
  );
  const targets = useLoad((s) => listTargets(cid, s), [cid]);
  const kinds = useMemo(
    () => PLATFORMS.filter((p) => p === nav.platform || (targets.data ?? []).some((t) => t.platform === p && t.app_id) || (scenarios ?? []).some((s) => s.target_kind === p)),
    [scenarios, nav.platform, targets.data],
  );
  const pendingTotal = useMemo(() => (scenarios ?? []).reduce((n, s) => n + s.pending, 0), [scenarios]);

  const view: ScenariosView = parseScenariosView(nav.get("sub"), scenarios?.length ?? 0);
  const context = useMemo(() => ({ cid, auth, platform: nav.platform, runQa: nav.runQa }), [cid, auth, nav.platform, nav.runQa]);

  const projectName = snap?.container?.name ?? "this project";
  let body;
  if (!scenarios) {
    body = list.error ? (
      <Empty
        title="Couldn't load scenarios"
        description={list.error}
        action={
          <Button size="sm" onClick={refresh}>
            <RefreshCw /> Try again
          </Button>
        }
      />
    ) : (
      <div className="p-4.5" aria-label="Loading scenarios">
        <SkeletonRows />
      </div>
    );
  } else {
    body = (
      <ScenariosCanvas
        key={cid}
        projectName={projectName}
        initialScenarios={scenarios}
        adapt={adapt}
        kinds={kinds}
        platformKind={nav.platform}
        onPlatform={(k: Platform) => nav.set({ platform: k, scenario: null })}
        view={view}
        onViewChange={(v) => nav.set({ sub: v })}
        initialStatus={EFFECTIVE_STATUSES.find((s) => s === nav.get("status")) ?? null}
        scenarioId={nav.get("scenario")}
        onScenarioChange={(id) => nav.set({ scenario: id })}
        pendingTotal={pendingTotal}
        onPositions={onPositions}
        nonce={nonce}
        onRefresh={refresh}
      />
    );
  }

  return (
    <PortRoot refresh={refresh}>
      <ScenariosProvider value={context}>
        {body}
      </ScenariosProvider>
    </PortRoot>
  );
}

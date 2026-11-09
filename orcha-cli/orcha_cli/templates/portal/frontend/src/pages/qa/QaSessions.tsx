/**
 * Sessions: every QA run an agent did. Exploration holds the home (hero, live expedition, history),
 * Runs (`?view=sessions`, `runs`) the history of every run, each narrowed by `?kind=`; one session at
 * `?session=<id>` takes its place in full, with a way back. A session's phases, report and drafting
 * view live in `sessions/`.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState } from "../../components/primitives";
import type { QaAuthority } from "./authority";
import { PortRoot } from "./map/kit";
import { getMap, listSessions, type QaFeature, type QaSession, type SessionDetail, type SessionKind } from "./qaApi";
import { plural } from "./qaWords";
import { useLoad } from "./parts";
import type { QaNav } from "./QaPage";
import { QaSubEnd } from "./SubNav";
import { QaLiveWall } from "./runs/QaLiveWall";
import { QaRun } from "./runs/QaRun";
import { ImportReportButton, ReportsView } from "./report/ReportsView";
import { WebEvents } from "./sessions/detail/finding-actions";
import { explorationOf } from "./sessions/adapt";
import { listDigests, type SessionDigest } from "./sessions/api";
import { ComparePage } from "./sessions/compare/compare-page";
import { ExplorationDetail } from "./sessions/detail/exploration-detail";
import { LIVE_POLL_MS } from "./sessions/detail/use-session-live";
import { ExplorationHistory } from "./sessions/home/exploration-history";
import { ExplorationHome, type ExplorationHomeData } from "./sessions/home/exploration-home";
import { ExploreSkeleton } from "./sessions/home/explore-skeleton";
import { routeOf, type ExplorationRoute } from "./sessions/home/home-model";

export { WebEvents };
export { sessionTitle } from "./sessions/title";

const KINDS: SessionKind[] = ["explore", "map", "draft", "check"];

/** "2 findings · 3 flows walked: 2 passed, 1 failed · 1 draft scenario". */
export function producedLine(d: SessionDetail): string {
  const parts: string[] = [];
  const open = d.findings.filter((f) => f.status !== "dismissed").length;
  parts.push(open ? plural(open, "finding") : "No findings");
  if (d.walks.length) {
    const passed = d.walks.filter((w) => w.status === "passed").length;
    const failed = d.walks.filter((w) => w.status === "failed").length;
    const extra = [passed ? `${passed} passed` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(", ");
    parts.push(`${plural(d.walks.length, "flow")} walked${extra ? ": " + extra : ""}`);
  }
  if (d.drafts.length) parts.push(plural(d.drafts.length, "draft scenario"));
  return parts.join(" · ");
}

/** The sessions on this platform, newest first, each with what its card shows. */
export function homeData(sessions: readonly QaSession[], digests: Record<string, SessionDigest>, features: readonly QaFeature[] | null, platform: string, readAt: number): ExplorationHomeData {
  const rows = sessions.filter((s) => s.platform === platform).sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  const routes: Record<string, ExplorationRoute> = {};
  for (const s of rows) {
    const shots = digests[s.id]?.shots;
    if (shots?.length) routes[s.id] = routeOf(shots.map((x) => ({ seq: x.seq, frame_path: x.frame_id, screen_hash: x.screen_hash })));
  }
  const explorations = rows.map((s) => {
    const d = digests[s.id];
    return explorationOf(s, { findings: d?.findings ?? [], walks: d?.walks ?? [], drafted: d?.drafts.length ?? 0, steps: d?.steps_count, measured: d?.measured });
  });
  return { explorations, routes, features, readAt };
}

export function QaSessions({ cid, nav, auth, runs = false }: { cid: string; nav: QaNav; auth: QaAuthority; runs?: boolean }) {
  const sessionId = nav.get("session");
  return (
    <PortRoot refresh={nav.refresh} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {!sessionId && (nav.get("sub") === "reports" || nav.get("report")) ? <ReportsView cid={cid} nav={nav} auth={auth} /> : !sessionId && nav.get("sub") === "compare" ? <ComparePage cid={cid} nav={nav} /> : !sessionId && nav.get("sub") === "live" ? <QaLiveWall cid={cid} nav={nav} /> : sessionId && nav.get("sub") === "run" ? <QaRun key={sessionId} cid={cid} nav={nav} sessionId={sessionId} auth={auth} /> : sessionId ? <ExplorationDetail key={sessionId} cid={cid} id={sessionId} nav={nav} auth={auth} /> : <SessionsHome cid={cid} nav={nav} auth={auth} runs={runs} />}
    </PortRoot>
  );
}

/** A check runs what is already written: it is Runs' alone. Everything else starts from the Exploration home. */
const startedFromHome = (s: QaSession) => s.kind !== "check";

function SessionsHome({ cid, nav, auth, runs }: { cid: string; nav: QaNav; auth: QaAuthority; runs: boolean }) {
  const [tick, setTick] = useState(0);
  const again = nav.nonce + tick;
  const res = useLoad(
    async (s) => {
      const [sessions, digests] = await Promise.all([listSessions(cid, { platform: nav.platform }, s), listDigests(cid, nav.platform, s).catch(() => ({} as Record<string, SessionDigest>))]);
      return { sessions, digests, readAt: Date.now() };
    },
    [cid, nav.platform],
    again,
  );
  const map = useLoad((s) => getMap(cid, nav.platform, s), [cid, nav.platform], nav.nonce);
  const running = (res.data?.sessions ?? []).some((s) => s.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [running]);
  const raw = nav.get("kind");
  const kind = raw && (KINDS as string[]).includes(raw) ? (raw as SessionKind) : null;
  const data = useMemo(
    () => (res.data ? homeData(runs ? res.data.sessions : res.data.sessions.filter(startedFromHome), res.data.digests, map.data?.features ?? (map.error ? [] : null), nav.platform, res.data.readAt) : null),
    [res.data, map.data, map.error, nav.platform, runs],
  );
  if (res.error && !data) return <EmptyState tone="danger" title="Couldn't load runs" body={res.error} action={<Button size="sm" onClick={nav.refresh}>Retry</Button>} />;
  if (!data) return <ExploreSkeleton />;
  return (
    <>
      <QaSubEnd slot={nav.subEnd}>
        {running ? (
          <button type="button" onClick={() => nav.set({ sub: "live" })} className="qa-subnav-link" data-open-live-wall>
            <span className="qa-livedot" aria-hidden="true" />
            Live wall
          </button>
        ) : null}
        {runs ? <button type="button" onClick={() => nav.set({ sub: "reports" })} className="qa-subnav-link" data-open-reports>Reports</button> : null}
        {runs ? <ImportReportButton cid={cid} auth={auth} onDone={(id) => nav.set({ sub: "reports", report: id })} /> : null}
      </QaSubEnd>
      {!runs ? <ExplorationHome cid={cid} data={data} nav={nav} auth={auth} kind={kind} /> : data.explorations.length ? (
        <section className="flex flex-col gap-8 px-4.5 py-5 pb-10" data-runs-home>
          <ExplorationHistory explorations={data.explorations} routes={data.routes} kind={kind} onKind={(k) => nav.set({ kind: k, session: null })} actor={auth.human?.id ?? null} canAct={auth.can} />
        </section>
      ) : <EmptyState title="No runs yet" body="Every check, exploration and drafting run shows here." />}
    </>
  );
}

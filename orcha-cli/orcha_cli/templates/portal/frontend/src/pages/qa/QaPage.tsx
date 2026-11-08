/**
 * QA — the project tab (route /qa) for app QA on iOS, Android and the web: three tabs, Exploration,
 * Scenarios and Runs (contract: docs/orcha-qa-plan.md "Simplified product").
 *
 * Views by `?view=`: exploration (the default) · scenarios · sessions · requests · onboarding · run;
 * an address that names a removed view lands on one of these (`qaViewOf`). `?platform=ios|android|web`
 * picks the app; `?scenario=`, `?session=`, `?request=` open the inspector; `?settings=1` opens the
 * app and Quality settings over the page. Human-only decisions (approve / pause / retire, suggestions,
 * targets, filing findings) are disabled with the reason for everyone else.
 */
import { cleanConditions, type Conditions } from "./conditions/conditions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Dialog, IconButton, Segmented, Tabs, Tooltip } from "../../components/primitives";
import { Shell } from "../../shell/Shell";
import { PageToolbar } from "../../shell/PageChrome";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { qaAuthority, type QaAuthority } from "./authority";
import { RunPage } from "./run/RunPage";
import { LiveRunOffer, LiveRunPill } from "./run/LiveRunPill";
import type { QaRunKind } from "./runQa";
import { FrameLightboxProvider, FrameShapeProvider } from "./Frames";
import { useQaLiveRuns } from "./live/useQaLive";
import { defaultPlatform, getOverview, listTargets, parsePlatform, PLATFORMS, type Platform } from "./qaApi";
import { qaHref, useLoad } from "./parts";
import { platformWord } from "./qaWords";
import { QaExploration } from "./QaExploration";
import { QaSubNav, QaTabCount, qaSubLevel, qaTabBadges, qaViewOf, type QaView } from "./SubNav";
import { QaScenarios } from "./QaScenarios";
import { QaSessions } from "./QaSessions";
import { QaTargets } from "./QaTargets";
import { QaRequests } from "./requests/QaRequests";
import { OnboardingFlow } from "./onboarding/OnboardingFlow";
import "./qa.css";

const REFRESH_MS = 30_000;

/** The tabs. Runs holds sessions and requests (`?view=requests` is its second level). */
export const QA_VIEWS: { key: QaView; label: string; icon: string }[] = [
  { key: "exploration", label: "Exploration", icon: "map" },
  { key: "scenarios", label: "Scenarios", icon: "checklist" },
  { key: "sessions", label: "Runs", icon: "play" },
];
/** Views that read one platform. */
const PLATFORM_VIEWS: QaView[] = ["exploration", "scenarios", "sessions"];
/** The element both levels of tabs drive. */
const PANEL_ID = "qa-panel";

/** URL helpers every view shares (selection lives in the URL so links deep-link). */
export interface QaNav {
  platform: Platform;
  get: (k: string) => string | null;
  set: (patch: Record<string, string | null>) => void;
  nonce: number;
  refresh: () => void;
  /** open the Run page (at a kind, on `focus`, on a platform when given) */
  runQa: (kind?: QaRunKind, focus?: string | null, options?: { scenarioIds?: string[]; platform?: Platform | null; conditions?: Conditions | null; askConditions?: boolean }) => void;
  /** who may start QA work / take human-only decisions */
  auth: QaAuthority;
  /** Back to the previous place (`?from=`), else to `fallback`. */
  goBack: (fallback: Record<string, string | null>) => void;
  /** The second level's row: QaSubEnd puts a view's own control there. */
  subEnd?: HTMLElement | null;
}

export function QaPage() {
  const { snap, cid } = useSnapshot();
  const auth = qaAuthority(useActingAuthority());
  const [params, setParams] = useSearchParams();
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // live sessions move on their own: re-read quietly (views keep their data while reloading)
  useEffect(() => {
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const rawView = params.get("view");
  const view = qaViewOf(rawView);
  // A web-only project opens on its website, never on an empty iOS map. Re-read on each view: the
  // onboarding saves the targets while this page stays open.
  const [viewTick, setViewTick] = useState(0);
  useEffect(() => setViewTick((n) => n + 1), [view]);
  const targets = useLoad((s) => listTargets(cid ?? "", s), [cid], nonce + viewTick);
  // The tabs' counts, on the page's own refresh: the Overview view reads this copy too.
  const overview = useLoad(cid ? (s) => getOverview(cid, s) : null, [cid], nonce + viewTick);
  const liveRuns = useQaLiveRuns(cid);
  const [subEnd, setSubEnd] = useState<HTMLElement | null>(null);
  const asked = params.get("platform");
  const platform: Platform = asked ? parsePlatform(asked) : defaultPlatform(targets.data);
  const platformReady = Boolean(asked || targets.data || targets.error);

  const set = useCallback((patch: Record<string, string | null>) => {
    setParams((cur) => {
      const next = new URLSearchParams(cur);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  // An old link: the address moves to where it landed, keeping the platform. Apps opens its settings.
  useEffect(() => {
    if (rawView == null || rawView === view) return;
    set({ view: view === "exploration" ? null : view, settings: rawView === "targets" ? "1" : null, sub: null, screen: null, state: null, feature: null, finding: null });
  }, [rawView, view, set]);

  // Leaving the onboarding lands on Exploration, past the gate its row would still open.
  const [flowLeft, setFlowLeft] = useState(false);
  const leaveFlow = useCallback(() => {
    setFlowLeft(true);
    set({ view: null, step: null, after: null });
  }, [set]);

  const navigate = useNavigate();
  const { search } = useLocation();
  // Every way into a run goes to the page; `from` is where its Back returns.
  const runQa = useCallback((kind?: QaRunKind, focus: string | null = null, options?: { scenarioIds?: string[]; platform?: Platform | null; conditions?: Conditions | null; askConditions?: boolean }) => {
    const conditions = cleanConditions(options?.conditions);
    navigate(qaHref({ view: "run", kind, focus, platform: options?.platform, scenarios: options?.scenarioIds?.join(","),
      conditions: conditions ? JSON.stringify(conditions) : null, cond: options?.askConditions ? "1" : null, from: search }));
  }, [navigate, search]);
  const goBack = useCallback((fallback: Record<string, string | null>) => {
    const from = params.get("from");
    if (from != null) navigate("/qa" + from);
    else set({ ...fallback, from: null });
  }, [params, navigate, set]);
  const nav: QaNav = useMemo(() => ({ platform, get: (k: string) => params.get(k), set, nonce, refresh, runQa, auth, goBack, subEnd }),
    [platform, params, set, nonce, refresh, runQa, auth, goBack, subEnd]);

  const runBtn = (
    <Button size="sm" variant="primary" icon="play" disabled={!auth.can} onClick={() => runQa()}>
      Run check
    </Button>
  );

  // The platform switch: one place, and only when there is a choice.
  const appPlatforms = PLATFORMS.filter((p) => (targets.data ?? []).some((t) => t.platform === p && t.app_id));
  const tab = view === "requests" ? "sessions" : view === "onboarding" ? "exploration" : view;
  const badges = qaTabBadges(overview.data, liveRuns.length);
  // A run's own page: Back and the Runs tab lead out, so the sub-tabs give the device their row.
  const subLevel = params.get("session") ? null : qaSubLevel(view);
  const toolbar = view === "run" ? undefined : <div className="qa-nav">
    <PageToolbar label="Quality views" className="qa-navbar" end={<>
      {PLATFORM_VIEWS.includes(view) && appPlatforms.length > 1 ? (
        <Segmented size="sm" label="Platform" value={platform} className="qa-platform"
          onChange={(k) => set({ platform: k, screen: null, scenario: null, session: null })}
          items={appPlatforms.map((p) => ({ key: p, label: platformWord(p) }))} />
      ) : null}
      <LiveRunPill />
      <span className="qa-runslot">{auth.can ? runBtn : <Tooltip label={auth.reason || "Only a person can start a check"} placement="bottom">{runBtn}</Tooltip>}</span>
      <IconButton icon="gear" label="App and Quality settings" size="sm" onClick={() => set({ settings: "1" })} data-qa-settings />
    </>}>
      <Tabs label="Quality views" value={tab} className="qa-tabs" idPrefix="qa-view" panelId={PANEL_ID}
        onChange={(k) => set({ view: k === "exploration" ? null : k, ...(k === "exploration" ? { step: null } : {}), sub: null, screen: null, scenario: null, session: null, request: null, finding: null, status: null, kind: null, from: null })}
        tabs={QA_VIEWS.map((v) => {
          const badge = badges[v.key];
          return { key: v.key, label: v.label, icon: v.icon, title: badge?.says, badge: badge ? <QaTabCount badge={badge} /> : undefined };
        })} />
    </PageToolbar>
    {subLevel ? <QaSubNav level={subLevel} panelId={PANEL_ID} endRef={setSubEnd} onChange={(k) => { const patch = subLevel.open(k); if (patch) set(patch); }} /> : null}
  </div>;

  let body = null;
  if (!cid || !platformReady) body = null;
  else if (view === "scenarios") body = <QaScenarios cid={cid} nav={nav} auth={auth} />;
  else if (view === "sessions") body = <QaSessions cid={cid} nav={nav} auth={auth} runs />;
  else if (view === "run") body = <RunPage />;
  else if (view === "requests") body = <QaRequests cid={cid} nav={nav} auth={auth} />;
  else if (view === "onboarding") body = <OnboardingFlow cid={cid} auth={auth} onManual={() => set({ settings: "1" })} onOpenMap={leaveFlow} onRunQa={runQa} onOpenSessions={() => set({ view: "sessions" })} />;
  else body = <QaExploration cid={cid} nav={nav} auth={auth} overview={overview} flowLeft={flowLeft} onLeaveFlow={leaveFlow} />;

  return (
    <Shell page="qa" title="Quality" ctx={snap?.container?.name ?? undefined} toolbar={toolbar} flush>
      <FrameLightboxProvider>
        <FrameShapeProvider shape={platform === "web" ? "wide" : "phone"}>
          <div className="qa-page" data-view={view} data-platform={platform} {...(view === "run" ? {} : { id: PANEL_ID, role: "tabpanel", "aria-labelledby": `qa-view-tab-${tab}` })}>
            {(view === "exploration" && !params.get("session") && !params.get("sub")) || view === "onboarding" ? <LiveRunOffer /> : null}
            {body}
          </div>
          {cid && params.get("settings") ? (
            <Dialog title="App and Quality settings" size="lg" onClose={() => set({ settings: null })} footer={<Button size="sm" onClick={() => set({ settings: null })}>Close</Button>}>
              <QaTargets cid={cid} nav={nav} auth={auth} />
            </Dialog>
          ) : null}
        </FrameShapeProvider>
      </FrameLightboxProvider>
    </Shell>
  );
}

export default QaPage;

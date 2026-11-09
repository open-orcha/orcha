/**
 * Exploration: the first tab. The explorations home, and a project with no QA set up opens on the
 * onboarding instead, until it is done or skipped.
 */
import { useRef } from "react";
import { useLocation } from "react-router-dom";
import { Button, EmptyState, Skeleton } from "../../components/primitives";
import type { QaAuthority } from "./authority";
import { listTargets, type Platform, type PlatformOverview } from "./qaApi";
import { useLoad, type Loaded } from "./parts";
import type { QaNav } from "./QaPage";
import { QaSessions } from "./QaSessions";
import { OnboardingFlow } from "./onboarding/OnboardingFlow";
import { comingBackFromFirstRun, opensOnOnboarding, setupSteps } from "./onboarding/opens-onboarding";
import { getOnboardingRow } from "./onboarding/use-onboarding-map";

export function QaExploration({ cid, nav, auth, overview: ov, flowLeft, onLeaveFlow }: {
  cid: string; nav: QaNav; auth: QaAuthority; overview: Loaded<Record<Platform, PlatformOverview>>;
  /** The person left the flow: its row may still read as under way. */
  flowLeft: boolean;
  onLeaveFlow: () => void;
}) {
  const tg = useLoad((s) => listTargets(cid, s), [cid], nav.nonce);
  const row = useLoad((s) => getOnboardingRow(cid, s), [cid]);
  const stayOnFlow = useRef(false);
  const resultCard = useRef(false);
  const location = useLocation();
  // A session or a page of its own was asked for by name: no gate stands in front of it.
  if (flowLeft || nav.get("session") || nav.get("sub")) return <QaSessions cid={cid} nav={nav} auth={auth} />;
  if (ov.error && !ov.data) {
    return <EmptyState tone="danger" title="Couldn't load QA" body={ov.error} action={<Button size="sm" onClick={nav.refresh}>Retry</Button>} />;
  }
  if (!ov.data || (!row.data && !row.error)) return <div className="qa-pad"><Skeleton lines={6} label="Loading Quality" /></div>;
  // Once open it stays open: the page's background refresh sees the first session and the first
  // screens arrive, and that must not pull a person off the flow while they watch the live pass.
  if (opensOnOnboarding(setupSteps(ov.data, tg.data ?? []), row.data)) stayOnFlow.current = true;
  // Back from the first run, it opens once more for that run's result card, though the flow is done.
  // Leaving that step (the Exploration tab drops it from the address) closes it.
  const onFirstRun = new URLSearchParams(location.search).get("step") === "first_run";
  if (comingBackFromFirstRun(location.search)) resultCard.current = true;
  else if (!onFirstRun) resultCard.current = false;
  if (stayOnFlow.current || resultCard.current) {
    return <OnboardingFlow cid={cid} auth={auth} onManual={() => nav.set({ settings: "1" })} onOpenMap={onLeaveFlow} onRunQa={nav.runQa} onOpenSessions={() => nav.set({ view: "sessions" })} />;
  }
  return <QaSessions cid={cid} nav={nav} auth={auth} />;
}

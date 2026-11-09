/**
 * Overview: one card per platform — the app, how much of it the map covers, the
 * scenarios by status, open findings, and the last session of each kind. A project with no QA
 * set up opens on the onboarding instead, until it is done or skipped.
 */
import { useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button, EmptyState, Skeleton } from "../../components/primitives";
import { relTime } from "../../lib/format";
import { listTargets, PLATFORMS, viewportWord, type Platform, type PlatformOverview, type QaTarget, type SessionKind } from "./qaApi";
import { platformDeviceWord, platformWord, sessionKindWord, sessionStatusGlyph, sessionStatusWord } from "./qaWords";
import { PlatformIcon, QaStatus, qaHref, useLoad, type Loaded } from "./parts";
import type { QaNav } from "./QaPage";
import { OnboardingFlow } from "./onboarding/OnboardingFlow";
import { comingBackFromFirstRun, opensOnOnboarding, setupSteps } from "./onboarding/opens-onboarding";
import { getOnboardingRow } from "./onboarding/use-onboarding-map";

const KINDS: SessionKind[] = ["map", "explore", "draft", "check"];

export function QaOverview({ cid, nav, overview: ov }: { cid: string; nav: QaNav; overview: Loaded<Record<Platform, PlatformOverview>> }) {
  const tg = useLoad((s) => listTargets(cid, s), [cid], nav.nonce);
  const row = useLoad((s) => getOnboardingRow(cid, s), [cid]);
  const stayOnFlow = useRef(false);
  const resultCard = useRef(false);
  const location = useLocation();
  if (ov.error && !ov.data) {
    return <EmptyState tone="danger" title="Couldn't load QA" body={ov.error} action={<Button size="sm" onClick={nav.refresh}>Retry</Button>} />;
  }
  if (!ov.data || (!row.data && !row.error)) return <div className="qa-pad"><Skeleton lines={6} label="Loading QA overview" /></div>;
  const data = ov.data;
  const targets = tg.data ?? [];
  // Once open it stays open: the page's background refresh sees the first session and the first
  // screens arrive, and that must not pull a person off the flow while they watch the live pass.
  if (opensOnOnboarding(setupSteps(data, targets), row.data)) stayOnFlow.current = true;
  // Back from the first run, it opens once more for that run's result card, though the flow is done.
  // Leaving that step (the Overview or Quality tab drops it from the address) closes it.
  const onFirstRun = new URLSearchParams(location.search).get("step") === "first_run";
  if (comingBackFromFirstRun(location.search)) resultCard.current = true;
  else if (!onFirstRun) resultCard.current = false;
  if (stayOnFlow.current || resultCard.current) {
    return <OnboardingFlow cid={cid} auth={nav.auth} onManual={() => nav.set({ view: "targets" })} onOpenMap={() => nav.set({ view: "map" })} onRunQa={nav.runQa} onOpenSessions={() => nav.set({ view: "sessions" })} />;
  }
  return (
    <div className="qa-pad qa-overview">
      <div className="qa-cards">
        {PLATFORMS.map((p) => (
          <PlatformCard key={p} o={data[p]} target={targets.find((t) => t.platform === p && t.app_id) ?? data[p].target} />
        ))}
      </div>
    </div>
  );
}

function Stat({ n, label, to, hint }: { n: number; label: string; to: string; hint?: string }) {
  return (
    <Link className="qa-stat" to={to} title={hint}>
      <span className="qa-stat-n">{n}</span>
      <span className="qa-stat-l">{label}</span>
    </Link>
  );
}

function PlatformCard({ o, target }: { o: PlatformOverview; target: QaTarget | null }) {
  const p: Platform = o.platform;
  const plat = p;
  const total = o.screens.seen + o.screens.declared + o.screens.blocked;
  const scenarios = (o.scenarios.draft ?? 0) + (o.scenarios.validated ?? 0) + (o.scenarios.paused ?? 0);
  if (!target?.app_id && !total && !o.features && !scenarios && !o.open_findings && !KINDS.some((k) => o.last_sessions[k])) {
    return (
      <section className="qa-card" aria-label={platformWord(p)}>
        <header className="qa-card-h">
          <PlatformIcon platform={p} cls="v2-ico qa-card-ico" />
          <div className="qa-card-t">
            <h2 className="qa-card-title">{platformWord(p)}</h2>
            <div className="qa-card-sub">No app set</div>
          </div>
        </header>
        <p className="qa-muted qa-card-note">This project has no {platformWord(p)} app in Quality. <Link to={qaHref({ view: "targets" })}>Add one in Apps</Link> to test it.</p>
      </section>
    );
  }
  return (
    <section className="qa-card" aria-label={platformWord(p)}>
      <header className="qa-card-h">
        <PlatformIcon platform={p} cls="v2-ico qa-card-ico" />
        <div className="qa-card-t">
          <h2 className="qa-card-title">{platformWord(p)}</h2>
          <div className="qa-card-sub">
            {target?.app_id ? <>{target.app_name || target.app_id}{target.app_name ? <span className="qa-mono"> · {target.app_id}</span> : null}{p === "web" ? <span> · {viewportWord(target.device_name)}</span> : null}</> : <Link to={qaHref({ view: "targets" })}>No app set</Link>}
          </div>
        </div>
      </header>
      <div className="qa-card-row" aria-label="Map">
        <Stat n={o.screens.seen} label="screens seen" to={qaHref({ view: "map", platform: plat, state: "seen" })} hint={`An agent has been on these screens in ${platformDeviceWord(p)}`} />
        <Stat n={o.screens.declared} label="not reached yet" to={qaHref({ view: "map", platform: plat, state: "declared" })} hint="Known from the code, not yet reached by an agent" />
        <Stat n={o.screens.blocked} label="blocked" to={qaHref({ view: "map", platform: plat, state: "blocked" })} hint="An agent tried and couldn't get there" />
        <Stat n={o.features} label={o.features === 1 ? "feature" : "features"} to={qaHref({ view: "map", platform: plat })} />
      </div>
      {total ? (
        <div className="qa-meter" role="img" aria-label={`${o.screens.seen} of ${total} screens seen`}>
          <span className="qa-meter-seen" style={{ width: `${(o.screens.seen / total) * 100}%` }} />
          <span className="qa-meter-blocked" style={{ width: `${(o.screens.blocked / total) * 100}%` }} />
        </div>
      ) : null}
      <div className="qa-card-row" aria-label="Scenarios">
        <Stat n={o.scenarios.draft ?? 0} label="to review" to={qaHref({ view: "scenarios", platform: plat, status: "draft" })} hint="Drafts waiting for a person to approve" />
        <Stat n={o.scenarios.validated ?? 0} label="approved" to={qaHref({ view: "scenarios", platform: plat, status: "validated" })} />
        <Stat n={o.scenarios.paused ?? 0} label="paused" to={qaHref({ view: "scenarios", platform: plat, status: "paused" })} />
        <Stat n={o.open_findings} label={o.open_findings === 1 ? "open finding" : "open findings"} to={qaHref({ view: "sessions", platform: plat })} />
      </div>
      <ul className="qa-card-last" aria-label="Last sessions">
        {KINDS.map((k) => {
          const s = o.last_sessions[k];
          return (
            <li key={k}>
              <span className="qa-card-k">Last {sessionKindWord(k).toLowerCase()}</span>
              {s ? (
                <Link to={qaHref({ view: "sessions", platform: plat, session: s.id })} className="qa-card-v">
                  <QaStatus glyph={sessionStatusGlyph(s.status)} word={sessionStatusWord(s.status)} size={12} />
                  <span>{relTime(s.ended_at || s.started_at)}</span>
                </Link>
              ) : <span className="qa-muted">Never</span>}
            </li>
          );
        })}
      </ul>
      {total === 0 && !o.features ? <p className="qa-muted qa-card-note">Nothing mapped yet. An agent with the QA map skill fills this in from the code and a device.</p> : null}
    </section>
  );
}

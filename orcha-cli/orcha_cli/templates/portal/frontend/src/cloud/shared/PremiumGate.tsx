/**
 * PremiumGate — the shared paywall card (Orcha Cloud local run, plan-gating
 * addendum: docs/orcha-cloud-local-run.md). Local run is the free solo tier;
 * a team-only feature stays visible as a NAV ENTRY POINT but renders this
 * card instead of the real UI. One component makes every future gate a
 * one-liner: `<PremiumGate feature="members" title=… pitch={[...]} … />`.
 *
 * Styled like the existing settings-card/callout idiom (src/cloud/settings/
 * ProviderKeysSection.tsx `.card.set-card` + `.sc-banner` — reused verbatim,
 * no new CSS needed) so a gated page reads as part of the same system, not a
 * bolted-on interstitial.
 */
import { Icon } from "../../components/ui";

export interface PremiumGateProps {
  feature: string;
  title: string;
  pitch: string[];
  upgradeUrl: string;
}

export function PremiumGate({ feature, title, pitch, upgradeUrl }: PremiumGateProps) {
  return (
    <div className="card set-card" data-premium-feature={feature}>
      <div className="card-h"><h2>{title}</h2></div>
      <div className="card-b">
        <div className="sc-banner warn">
          <div className="bt">
            <Icon name="shield" cls="" />
            <span><b>{title} is an Orcha Cloud Team feature.</b> Local run is the free solo tier.</span>
          </div>
        </div>
        {pitch.length > 0 && (
          <ul className="pg-pitch">
            {pitch.map((line) => (
              <li key={line}>
                <Icon name="check" cls="" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="sc-acts">
          <button
            className="btn sm"
            type="button"
            onClick={() => window.open(upgradeUrl, "_blank", "noopener")}
          >
            <Icon name="spark" cls="" />Upgrade to Orcha Cloud Team
          </button>
        </div>
      </div>
      <style>{PREMIUM_GATE_CSS}</style>
    </div>
  );
}

const PREMIUM_GATE_CSS = `
  .pg-pitch { list-style: none; display: flex; flex-direction: column; gap: 8px;
    margin: 14px 0 18px; padding: 0; }
  .pg-pitch li { display: flex; align-items: flex-start; gap: 9px; font-size: 13px;
    color: var(--text-2); line-height: 1.5; }
  .pg-pitch li svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--accent); }
`;

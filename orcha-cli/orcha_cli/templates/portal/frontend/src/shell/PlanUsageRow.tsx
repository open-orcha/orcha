/**
 * Sidebar plan-usage row (web twin of the desktop sidebar "Usage" row).
 *
 * Shows ONLY when the portal-wide display setting is on (Settings › Interface ›
 * Plan usage; GET /api/plan-usage/display). Data: GET /api/plan-usage, the
 * newest snapshot per provider across desktop hosts.
 *  - providers "both": each provider as logo + percent of its busiest window;
 *  - one provider: logo + thin bar + percent.
 * Warn tone above 75 %, danger above 90 %. Clicking opens a popover with every
 * window of each shown provider: label, bar, % and "resets in …".
 * Collapsed rail: one compact gauge with the peak of the shown providers.
 */
import { useRef, useState } from "react";
import { BrandLogo } from "../components/primitives/BrandLogo";
import { Popover } from "../components/primitives/Menu";
import { Tooltip } from "../components/primitives/Tooltip";
import {
  PROVIDER_LABEL, latestByProvider, pctText, resetsInLabel, shownProviders, usageAriaLabel,
  usageTone, usePlanUsagePolling, usePlanUsageState, type ShownProvider,
} from "../state/planUsage";
import "./planUsage.css";

function Bar({ pct, className }: { pct: number; className?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <span className={"v2-pu-bar" + (className ? " " + className : "")} data-tone={usageTone(p)} aria-hidden="true">
      <span className="v2-pu-bar-fill" style={{ width: `${p}%` }} />
    </span>
  );
}

function UsagePopoverBody({ shown }: { shown: ShownProvider[] }) {
  const now = Date.now();
  return (
    <div className="v2-pu-pop-body">
      {shown.map((s) => (
        <section key={s.provider} className="v2-pu-prov" aria-label={PROVIDER_LABEL[s.provider]} data-provider={s.provider}>
          <header className="v2-pu-prov-h">
            <BrandLogo brand={s.provider} size={14} />
            <span className="v2-pu-prov-name">{PROVIDER_LABEL[s.provider]}</span>
            {s.usage.plan ? <span className="v2-pu-prov-plan">{s.usage.plan}</span> : null}
          </header>
          <ul className="v2-pu-wins">
            {s.usage.windows.map((w) => {
              const reset = resetsInLabel(w.resets_at, now);
              return (
                <li key={w.key} className="v2-pu-win" data-window={w.key}>
                  <span className="v2-pu-win-l">{w.label}</span>
                  <Bar pct={w.used_pct} className="v2-pu-win-bar" />
                  <span className="v2-pu-pct" data-tone={usageTone(w.used_pct)}>{pctText(w.used_pct)}</span>
                  <span className="v2-pu-win-reset">{reset ?? ""}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function PlanUsageRow({ collapsed }: { collapsed: boolean }) {
  usePlanUsagePolling();
  const { display, snapshots } = usePlanUsageState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  if (!display.show) return null;
  const shown = shownProviders(display, latestByProvider(snapshots));
  if (!shown.length) return null;
  const label = usageAriaLabel(shown);
  const peak = Math.max(...shown.map((s) => s.peak));
  const single = shown.length === 1 ? shown[0] : null;

  const body = collapsed ? (
    <span className="v2-pu-gauge" data-tone={usageTone(peak)} aria-hidden="true">
      <Bar pct={peak} className="v2-pu-gauge-bar" />
      <span className="v2-pu-pct" data-tone={usageTone(peak)}>{Math.round(peak)}</span>
    </span>
  ) : (
    <>
      <span className="v2-pu-lbl">Usage</span>
      {single ? (
        <span className="v2-pu-one" data-provider={single.provider}>
          <BrandLogo brand={single.provider} size={13} />
          <Bar pct={single.peak} className="v2-pu-one-bar" />
          <span className="v2-pu-pct" data-tone={usageTone(single.peak)}>{pctText(single.peak)}</span>
        </span>
      ) : (
        <span className="v2-pu-many">
          {shown.map((s) => (
            <span key={s.provider} className="v2-pu-item" data-provider={s.provider}>
              <BrandLogo brand={s.provider} size={13} />
              <span className="v2-pu-pct" data-tone={usageTone(s.peak)}>{pctText(s.peak)}</span>
            </span>
          ))}
        </span>
      )}
    </>
  );

  return (
    <div className="v2-sb-usage">
      <Tooltip label={label} placement={collapsed ? "right" : "top"} disabled={open}>
        <button
          ref={ref} type="button" className="v2-sb-usage-btn" data-testid="sb-plan-usage"
          aria-label={label} aria-haspopup="dialog" aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {body}
        </button>
      </Tooltip>
      <Popover
        anchor={ref} open={open} onClose={() => setOpen(false)} role="dialog" label="Plan usage"
        className="v2-pu-pop" placement={collapsed ? "right-start" : "bottom-start"}
      >
        <div className="v2-pu-pop-h">Plan usage</div>
        <UsagePopoverBody shown={shown} />
      </Popover>
    </div>
  );
}

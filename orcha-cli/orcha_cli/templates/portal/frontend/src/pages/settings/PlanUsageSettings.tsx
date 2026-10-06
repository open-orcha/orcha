/**
 * Settings › Interface › Plan usage — the portal-wide display setting
 * (PUT /api/plan-usage/display; contract: one value per stack, off by default).
 * The switch shows/hides the sidebar usage summary on every device connected
 * to this Embodent; Providers picks Both · Claude · Codex (enabled only while
 * the switch is on). Writes are optimistic (state/planUsage saveDisplay).
 */
import { useEffect } from "react";
import { Segmented } from "../../components/primitives";
import { refreshDisplay, saveDisplay, usePlanUsageState, type ProvidersChoice } from "../../state/planUsage";
import { SettingRow, SettingRows, SettingsGroup } from "./settingsUi";

export const PLAN_USAGE_CAPTION =
  "Shows your Claude and Codex plan limits in the sidebar and on each project's Home, on every device connected to this Embodent.";

const PROVIDER_ITEMS: { key: ProvidersChoice; label: string }[] = [
  { key: "both", label: "Both" },
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

export function PlanUsageSettings() {
  const { display, error } = usePlanUsageState();
  useEffect(() => { void refreshDisplay(); }, []);
  const on = display.show;
  return (
    <SettingsGroup settab="interface" title="Plan usage" flush id="setPlanUsage">
      <SettingRows>
        <SettingRow label="Show plan usage" desc={PLAN_USAGE_CAPTION} id="puShowLbl">
          <button
            type="button" role="switch" id="puShow"
            className={"set-switch" + (on ? " on" : "")}
            aria-checked={on} aria-labelledby="puShowLbl"
            onClick={() => void saveDisplay({ show: !on, providers: display.providers })}
          >
            <span className="set-switch-knob" />
          </button>
        </SettingRow>
        <SettingRow label="Providers" desc={on ? undefined : "Turn on Show plan usage to choose."}>
          <Segmented
            label="Providers" size="sm"
            items={PROVIDER_ITEMS.map((it) => ({ ...it, disabled: !on }))}
            value={display.providers}
            onChange={(k) => { if (on) void saveDisplay({ show: true, providers: k as ProvidersChoice }); }}
          />
        </SettingRow>
      </SettingRows>
      {error ? <p className="set-note" role="alert" id="puError">{error}</p> : null}
    </SettingsGroup>
  );
}

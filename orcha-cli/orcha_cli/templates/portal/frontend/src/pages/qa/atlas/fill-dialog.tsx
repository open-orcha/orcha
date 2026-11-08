import { useMemo, useState } from "react";
import { RefreshCw, Sparkles } from "../map/kit/icons";
import { Button, cn, Dialog, PlatformIcon, Select } from "../map/kit";
import { useSnapshot } from "../../../state/SnapshotProvider";
import { DevicePicker } from "../onboarding/device-picker-view";
import { defaultDevicePick, pickedSummary, pickerRows, rowForKey } from "../onboarding/device-picker";
import { rememberDevice, rememberedDevice } from "../onboarding/remembered-device";
import { useLiveDevices } from "../onboarding/use-live-devices";
import { fillPlan, fillWords, PLATFORM_WORD, refreshWords } from "./model";
import type { Atlas, Platform } from "./types";

/** What a pass was told to run on: a device's name (a viewport on the web), null for Default. */
export interface PassStart {
  device: string | null;
  agentAlias: string;
}

/**
 * "Fill in iOS", or "Refresh atlas" with `pass="refresh"`: what the pass visits, the device it runs
 * on (the onboarding's picker, "Default" first, remembered per project and platform in this
 * browser, so Fill and Refresh share it) and the agent who runs it. Nothing starts until its
 * button. Mounted per platform (`key`), so a pick made for iOS never carries over to Android.
 */
export function FillDialog({
  cid,
  atlas,
  platform,
  open,
  busy,
  onClose,
  onStart,
  pass = "fill",
  label = "Refresh atlas",
}: {
  cid: string;
  atlas: Atlas;
  platform: Platform;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onStart: (start: PassStart) => void;
  pass?: "fill" | "refresh";
  /** Refresh's title and button: the words on the button that opened it. */
  label?: string;
}) {
  const live = useLiveDevices(cid, open);
  const { snap } = useSnapshot();
  const agents = useMemo(() => (snap?.agents ?? []).filter((a) => a.kind === "ai" && a.status !== "retired" && a.status !== "terminated"), [snap]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === agentId) ?? (agents.length === 1 ? agents[0] : null);
  // The pick made here ("": "Default"); none yet: the remembered one.
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const rows = useMemo(() => pickerRows(live.devices), [live.devices]);
  const key = chosen ?? rememberedDevice(cid, platform);
  const row = rowForKey(rows, key);
  const word = PLATFORM_WORD[platform];
  const refresh = pass === "refresh";
  const title = refresh ? label : `Fill in ${word}`;
  const fallback = defaultDevicePick(platform, rows);
  const device = !row ? null : row.device.kind === "web" ? (row.device.viewport ?? null) : row.device.name;

  function pick(k: string) {
    setChosen(k);
    rememberDevice(cid, platform, k);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={refresh ? refreshWords(atlas.refresh, platform) : fillWords(fillPlan(atlas, platform), atlas.refresh).detail}
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-atlas-fill-cancel>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => agent && onStart({ device, agentAlias: agent.alias })}
            disabled={busy || !agent}
            aria-busy={busy || undefined}
            data-atlas-fill-start={refresh ? undefined : platform}
            data-atlas-refresh-start={refresh ? platform : undefined}
          >
            {refresh ? <RefreshCw /> : <Sparkles />} {title}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-2" data-atlas-fill-device={platform} data-atlas-pass={pass}>
        <span id="atlas-fill-device-label" className="text-sm font-medium text-fg">
          Device
        </span>
        <p className="flex min-w-0 items-center gap-1.5 text-sm" data-atlas-fill-on={row ? "picked" : "default"} aria-live="polite">
          <PlatformIcon kind={platform} className="size-3.5 shrink-0 text-fg-2" />
          <span className={cn("min-w-0 truncate", row ? "text-fg" : "text-muted")}>{row ? pickedSummary(rows, platform, key) : `Default: ${fallback.noun}`}</span>
        </p>
        <p className="text-xs text-muted" id="atlas-fill-device-hint">
          {`Default lets the agent pick. Local is this Mac's ${platform === "ios" ? "simulators and phones" : platform === "android" ? "emulators and phones" : "browser"}. Embodent remembers your pick for this project on ${word}.`}
        </p>
        <div role="group" aria-labelledby="atlas-fill-device-label" aria-describedby="atlas-fill-device-hint">
          <DevicePicker devices={live.devices} kinds={[platform]} loading={live.loading} selected={{ [platform]: key }} onSelect={(_kind, k) => pick(k)} maxHeight={300} hideSummary />
        </div>
        <span id="atlas-fill-agent-label" className="mt-2 text-sm font-medium text-fg">
          Agent
        </span>
        {agents.length ? (
          <Select
            aria-labelledby="atlas-fill-agent-label"
            value={agent?.id ?? ""}
            placeholder="Pick an agent"
            options={agents.map((a) => ({ value: a.id, label: a.alias, description: a.role || undefined }))}
            onChange={(e) => setAgentId(e.target.value)}
            data-atlas-fill-agent
          />
        ) : (
          <p className="text-xs text-muted">This project has no AI agents yet: add one under Agents.</p>
        )}
      </div>
    </Dialog>
  );
}

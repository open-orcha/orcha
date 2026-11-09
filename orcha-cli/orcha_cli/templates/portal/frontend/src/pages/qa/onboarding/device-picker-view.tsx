import "../map/utilities.css";
import "../map/port.css";
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Laptop, Search, Sparkles, X } from "../map/kit/icons";
import {
  AWAY_GROUP_LABEL,
  CONNECTED_GROUP_LABEL,
  CONNECT_PHONE_HELP,
  DEVICE_STATE_LABELS,
  defaultDevicePick,
  impliedLocalPick,
  pickedSummary,
  pickerGroups,
  pickerRows,
  rowForKey,
  sortKinds,
  splitConnected,
  type DeviceState,
  type PickerInput,
  type PickerRow,
} from "./device-picker";
import { PlatformIcon, PLATFORM_NAMES, cn } from "./ui";
import type { DeviceSetup, TargetKind } from "./types";

/** Rows whose entrance is staggered; the rest appear at once. */
const STAGGER_ROWS = 14;

const STATE_DOT: Record<DeviceState, string> = {
  booted: "bg-success",
  running: "bg-success",
  ready: "bg-success",
  stopped: "bg-muted/60",
  setup: "bg-info",
  busy: "bg-warning",
  offline: "bg-muted/60",
};

function StateChip({ state }: { state: DeviceState }) {
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-2xs font-medium text-fg-2"
      data-device-state={state}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", STATE_DOT[state])} />
      {DEVICE_STATE_LABELS[state]}
    </span>
  );
}

function SetupNote({ setup }: { setup: DeviceSetup }) {
  return (
    <span className="mt-0.5 block text-xs leading-snug text-fg-2" data-device-setup-note={setup.code}>
      <span className="font-medium text-info">{setup.title}</span> {setup.fix}
    </span>
  );
}

function RowIcon({ row }: { row: PickerRow }) {
  return (
    <span aria-hidden className="relative flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-2">
      <PlatformIcon kind={row.kind} className="size-3.5" />
    </span>
  );
}

function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        on ? "border-primary" : "border-border-strong",
      )}
    >
      <span className={cn("size-2 rounded-full bg-primary transition-transform duration-150", on ? "scale-100" : "scale-0")} />
    </span>
  );
}

/** "Local": every device here runs on this machine. */
function WhereBadge() {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-2xs font-medium text-fg-2" data-placement-where="local" title="Runs on this Mac">
      <Laptop className="size-2.5" aria-hidden />
      Local
    </span>
  );
}

export interface DevicePickerProps {
  /** The devices this machine reports, and the browser sizes. */
  devices: readonly PickerInput[];
  /** The platforms to pick a device for (one pick each). */
  kinds: readonly TargetKind[];
  /** The picked key per platform ("" or missing = the agent's default). */
  selected: Partial<Record<TargetKind, string>>;
  onSelect: (kind: TargetKind, key: string) => void;
  /** Still reading the machine. */
  loading?: boolean;
  /** Cap the list's height (px); it scrolls inside. */
  maxHeight?: number;
  /** Hide the "Picked" summary strip. */
  hideSummary?: boolean;
  className?: string;
}

/**
 * The device picker: a search over model, OS and state, devices grouped by platform with their
 * marks, compact rows with a state chip.
 */
export function DevicePicker({ devices, kinds: kindsProp, selected, onSelect, loading = false, maxHeight = 420, hideSummary = false, className }: DevicePickerProps) {
  const id = useId();
  const kinds = useMemo(() => sortKinds(kindsProp), [kindsProp]);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => pickerRows(devices), [devices]);
  const groups = useMemo(() => pickerGroups(rows, { kinds, query }), [rows, kinds, query]);
  const searching = query.trim().length > 0;

  function choose(kind: TargetKind, row: PickerRow | null) {
    onSelect(kind, row?.key ?? "");
  }

  // Every platform with nothing listed still gets a group, to pick "Default".
  const shownKinds = !searching ? kinds : groups.map((g) => g.kind);
  let stagger = 0;

  return (
    <div className={cn("qa-port flex flex-col gap-2.5", className)} data-device-picker>
      {!hideSummary && kinds.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Picked devices" data-device-picked>
          {kinds.map((k) => {
            const row = rowForKey(rows, selected[k]);
            return (
              <li key={k} className="flex min-w-0 items-center gap-2 text-xs" data-device-picked-kind={k}>
                <PlatformIcon kind={k} className="size-3 shrink-0 text-muted" />
                <span className="shrink-0 text-muted">{PLATFORM_NAMES[k]}</span>
                <span aria-hidden className="text-muted">
                  ·
                </span>
                <span className={cn("min-w-0 truncate", row ? "text-fg" : "text-muted")}>{pickedSummary(rows, k, selected[k])}</span>
                <WhereBadge />
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex min-w-[180px] flex-1 items-center">
          <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted" aria-hidden />
          <span className="sr-only">Search devices</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search devices"
            className="h-8 w-full rounded-md border border-border bg-panel pl-8 pr-7 text-sm text-fg placeholder:text-muted hover:border-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 [&::-webkit-search-cancel-button]:hidden"
            data-device-search
            data-dictation="off"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 flex size-5 items-center justify-center rounded text-muted hover:text-fg"
              aria-label="Clear search"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </label>
      </div>

      <div className="flex flex-col overflow-y-auto overscroll-contain rounded-lg border border-border bg-panel" style={{ maxHeight }} data-device-list-panel>
        <div className="flex flex-col divide-y divide-border">
          {loading ? (
            <p className="px-3 py-3 text-sm text-muted" data-device-loading>
              Looking for devices…
            </p>
          ) : shownKinds.length === 0 ? (
            <div className="flex flex-col items-start gap-1 px-3 py-4" data-device-empty>
              <span className="text-sm text-fg">No device matches the search.</span>
            </div>
          ) : (
            shownKinds.map((kind) => {
              const group = groups.find((g) => g.kind === kind);
              const list = group?.rows ?? [];
              const picked = selected[kind] ?? "";
              const labelId = `${id}-${kind}`;
              return (
                <section key={kind} className="flex flex-col" data-device-group={kind}>
                  <h3
                    id={labelId}
                    className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-panel/95 px-3 py-1.5 text-xs font-semibold text-fg-2 backdrop-blur"
                  >
                    <PlatformIcon kind={kind} className="size-3.5" />
                    {PLATFORM_NAMES[kind]}
                    <span className="font-normal text-muted">{list.length} local</span>
                  </h3>
                  <ul role="radiogroup" aria-labelledby={labelId} className="flex flex-col py-1">
                    {!searching && !impliedLocalPick(kind) ? (
                      <li>
                        <PickerButton
                          on={!rowForKey(rows, picked)}
                          onClick={() => choose(kind, null)}
                          dataKey=""
                          delay={stagger++}
                          icon={
                            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted">
                              <Sparkles className="size-3.5" />
                            </span>
                          }
                          title="Default"
                          detail={defaultDevicePick(kind, rows).detail}
                        />
                      </li>
                    ) : null}
                    {(() => {
                      // Phones connected to this Mac first, under their own heading, then the paired
                      // ones not connected now, then the simulators or emulators.
                      const { connected, away, virtual } = splitConnected(kind, list);
                      const row = (r: PickerRow) => (
                        <li key={r.key} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px" } as CSSProperties}>
                          <PickerButton
                            on={picked === r.key || (!picked && impliedLocalPick(kind) && r.key === "desktop")}
                            onClick={() => choose(kind, r)}
                            dataKey={r.key}
                            delay={stagger++}
                            icon={<RowIcon row={r} />}
                            title={r.title}
                            detail={r.detail}
                            note={r.setup ? <SetupNote setup={r.setup} /> : null}
                            physical={r.physical}
                            trailing={<StateChip state={r.state} />}
                          />
                        </li>
                      );
                      if (connected === null || searching) return [...(connected ?? []), ...(away ?? []), ...virtual].map(row);
                      return (
                        <>
                          <SubHeading>{CONNECTED_GROUP_LABEL}</SubHeading>
                          {connected.length > 0 ? (
                            connected.map(row)
                          ) : (
                            <li className="px-3 pb-2 pt-0.5 text-xs leading-relaxed text-muted" data-device-connect-help={kind}>
                              {CONNECT_PHONE_HELP[kind as "ios" | "android"]}
                            </li>
                          )}
                          {away && away.length > 0 ? <SubHeading>{AWAY_GROUP_LABEL}</SubHeading> : null}
                          {away?.map(row)}
                          {virtual.length > 0 ? <SubHeading>{kind === "ios" ? "Simulators" : "Emulators"}</SubHeading> : null}
                          {virtual.map(row)}
                        </>
                      );
                    })()}
                    {list.length === 0 ? (
                      <li className="px-3 py-2 text-xs text-muted" data-device-none={kind}>
                        {kind === "ios" ? "No simulator on this Mac." : "No emulator on this Mac. Create one in Android Studio and it shows here."}
                      </li>
                    ) : null}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** A heading inside a platform group: "This Mac · connected", "Paired · not connected", "Simulators". */
function SubHeading({ children }: { children: ReactNode }) {
  return (
    <li role="presentation" className="px-3 pb-0.5 pt-2 text-2xs font-medium uppercase tracking-wide text-muted" data-device-subheading>
      {children}
    </li>
  );
}

function PickerButton({
  on,
  onClick,
  dataKey,
  delay,
  icon,
  title,
  detail,
  note,
  physical,
  trailing,
}: {
  on: boolean;
  onClick: () => void;
  dataKey: string;
  delay: number;
  icon: ReactNode;
  title: string;
  detail: string;
  note?: ReactNode;
  physical?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      data-device-option={dataKey}
      data-device-physical={physical || undefined}
      data-selected={on || undefined}
      className={cn(
        "flex min-h-11 w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors focus-visible:bg-hover focus-visible:outline-none",
        on ? "bg-selected" : "enabled:hover:bg-hover",
        delay < STAGGER_ROWS && "motion-safe:animate-[qa-fade-in_260ms_ease-out_both]",
      )}
      style={delay < STAGGER_ROWS ? ({ animationDelay: `${delay * 22}ms` } as CSSProperties) : undefined}
    >
      <Radio on={on} />
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-fg">{title}</span>
        <span className="truncate text-xs text-muted">{detail}</span>
        {note}
      </span>
      {trailing}
    </button>
  );
}

import { useEffect, useId, type CSSProperties, type ReactNode } from "react";
import { Bot, Database, FlaskConical, FolderGit2, Globe, Radar, Server, Smartphone, TriangleAlert, Workflow } from "../map/kit/icons";
import { Button, PlatformIcon, PLATFORM_NAMES, cn, frameworkLabel } from "./ui";
import type { TargetKind } from "./types";
import { DeviceStep } from "./device-step";
import { pickedSummary, pickerRows, DEFAULT_DEVICE_NOUN } from "./device-picker";
import { componentTests, deviceUiTests, surveyOf } from "./tests-found";
import { enabledTargets, type DeviceOption, type SetField, type WizardState } from "./state";
import { TargetStep } from "./target-step";
import { detectedBackends, targetBackend } from "./backends";
import type { FoundSheet as FoundSheetData, SandboxFound } from "./contract";
import { FoundBackends } from "./found-backends";
import styles from "./onboarding-map.module.css";

export const FOUND_SECTIONS = ["platforms", "environment", "backend", "tests", "ci", "device", "test_data", "agent", "live"] as const;
export type FoundSection = (typeof FOUND_SECTIONS)[number];

const d = (ms: number): CSSProperties => ({ "--d": `${ms}ms` }) as CSSProperties;

const SEGMENT = "flex items-center gap-1.5 rounded-[4px] px-2.5 py-0.5 text-xs font-medium transition-colors";
const SEGMENT_ON = "bg-raised text-fg shadow-sm";
const SEGMENT_OFF = "text-muted hover:bg-hover hover:text-fg";

/** The platforms a live pass can map on, in the order Embodent tries them. */
export function livePassKinds(kinds: readonly TargetKind[]): TargetKind[] {
  return (["ios", "android", "web"] as const).filter((k) => kinds.includes(k));
}

function repoName(repo: string): string {
  const parts = repo.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "").split(/[/\\:]/);
  return parts[parts.length - 1] || repo;
}

export type FoundPreview = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; found: FoundSheetData } | { kind: "missing" };

/** The device a platform runs on, as the Device editor's own summary says it (#454): the picked
 * device, else the default ("Any booted simulator", "Any running emulator"). A device is named
 * only when it is the one picked, so a run never lands somewhere the sheet did not say. A name
 * saved or typed earlier reads as itself; a picked device that has gone reads as the default. */
export function deviceLabel(devices: readonly DeviceOption[], key: string, kind: TargetKind): string {
  const said = pickedSummary(pickerRows(devices), kind, key);
  return said !== DEFAULT_DEVICE_NOUN[kind] || !key || key.startsWith(`${kind}:`) || kind === "web" ? said : key;
}

/** `deviceLabel` inside a sentence: "a high-level map on any booted simulator", "on Pixel 9 Pro". */
export function deviceSentence(label: string): string {
  return label.replace(/^Boots /, "").replace(/^(Any|This) /, (m) => m.toLowerCase());
}

function Row({
  icon,
  label,
  children,
  section,
  open,
  onOpen,
  editor,
  index,
  editLabel = "Edit",
  error,
  editsIn,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  section: FoundSection;
  open: boolean;
  onOpen: (s: FoundSection | null) => void;
  editor?: ReactNode;
  index: number;
  editLabel?: string;
  error?: string | null;
  /** Edit opens another row's editor (the Backend line is set in the Environment's). */
  editsIn?: FoundSection;
}) {
  const panelId = useId();
  return (
    <li className={cn(styles.rise, "border-b border-border last:border-b-0")} style={d(80 + index * 70)} data-found-row={section}>
      <div className="flex items-start gap-3 py-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-2 [&_svg]:size-3.5" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted">{label}</p>
          <div className="mt-0.5 text-sm text-fg">{children}</div>
          {error ? (
            <p className="mt-1 text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        {editor ? (
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={panelId} onClick={() => onOpen(open ? null : section)} data-found-edit={section}>
            {open ? "Done" : editLabel}
          </Button>
        ) : editsIn ? (
          <Button size="sm" variant="ghost" onClick={() => onOpen(editsIn)} data-found-edit={section}>
            {editLabel}
          </Button>
        ) : null}
      </div>
      {editor && open ? (
        <div id={panelId} className="mb-3 rounded-lg border border-border bg-bg p-4" data-found-editor={section}>
          {editor}
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={() => onOpen(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * "We found": everything the repository told Embodent, on one sheet, each with an inline Edit
 * that opens its editor in place (Platforms, Device). Nothing here is required: the defaults are
 * chosen, and "Save and map" goes on.
 */
const SANDBOX_NAMES: Record<string, string> = { purchases: "Purchases", payments: "Payments", email: "Email", sms: "SMS" };

export function FoundSheet({
  state,
  set,
  preview,
  agentField,
  devices,
  devicesLoading,
  devicesAvailable,
  open,
  onOpen,
  errors = {},
}: {
  state: WizardState;
  set: SetField;
  /** What the repository scan answered. */
  preview: FoundPreview;
  /** Who runs the live pass, the drafts and the first run. */
  agentField: ReactNode;
  devices: DeviceOption[];
  devicesLoading?: boolean;
  /** This portal can see the machine's devices. */
  devicesAvailable: boolean;
  open: FoundSection | null;
  onOpen: (s: FoundSection | null) => void;
  errors?: Partial<Record<FoundSection, string>>;
}) {
  const enabled = enabledTargets(state);
  const kinds = [...new Set(enabled.map((t) => t.kind))];
  // UI tests are the tests that drive the app on a device or in a browser, the ones the Map step
  // ties to screens (#454).
  const readyFound = preview.kind === "ready" ? preview.found : null;
  // Each service once, across the platforms: the one a person still has to confirm wins.
  const sandboxMap = new Map<string, SandboxFound>();
  for (const k of new Set(enabled.map((t) => t.kind))) {
    for (const [key, box] of Object.entries(readyFound?.sandboxes?.[k] ?? {})) {
      const had = sandboxMap.get(key);
      if (!had || (had.ready && !box.ready)) sandboxMap.set(key, box);
    }
  }
  const sandboxes = [...sandboxMap];
  const unconfirmed = sandboxes.some(([, box]) => !box.ready);
  const tests = readyFound ? deviceUiTests(surveyOf(readyFound)).map((f) => ({ framework: f.framework, count: f.ui, path: readyFound.tests.find((t) => t.framework === f.framework)?.path ?? "" })) : [];
  // Tests that only render a component (Jest, Vitest) are named apart, so this line and the Map
  // step's never disagree (#454).
  const components = readyFound ? componentTests(surveyOf(readyFound)) : [];
  const componentCount = components.reduce((n, f) => n + f.ui, 0);
  const repo = state.repoUrl.trim();
  const backendKey = repo;
  // What the sheet read about backends is kept with the wizard once per folder (#453).
  useEffect(() => {
    if (!readyFound || state.backends?.for === backendKey) return;
    set("backends", detectedBackends(backendKey, readyFound));
    // Once per folder: the state is read as it is when the sheet arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyFound, backendKey]);
  const prodKinds = kinds.filter((k) => enabled.some((t) => t.kind === k && targetBackend(state.backends, t)?.production));
  // The URL a person set for the website is the one the runs use: the scanned guess only fills in.
  const envUrl = enabled.find((t) => t.kind === "web")?.locator.trim() || state.envLocator.trim();
  let i = 0;

  return (
    <div className="flex flex-col gap-4" data-onboarding-found>
      <section className={cn(styles.rise, "flex items-center gap-3 rounded-lg border border-border bg-bg px-4 py-3")} style={d(0)}>
        <FolderGit2 className="size-5 shrink-0 text-fg-2" strokeWidth={1.6} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">{state.repoName || (repo ? repoName(repo) : "No repository")}</p>
          <p className="truncate font-mono text-xs text-muted">{repo || "Embodent maps the app by using it instead of reading it."}</p>
        </div>
      </section>

      <ul className="flex flex-col px-1" aria-label="What Embodent found">
        <Row
          index={i++}
          icon={<Smartphone />}
          label="Platforms and app ids"
          section="platforms"
          open={open === "platforms"}
          onOpen={onOpen}
          error={errors.platforms}
          editor={<TargetStep state={state} set={set} />}
        >
          {enabled.length === 0 ? (
            <span className="text-muted">None yet. Add the app to test with Edit.</span>
          ) : (
            <span className="flex flex-col gap-1">
              {enabled.map((t) => (
                <span key={t.key} className="flex min-w-0 items-center gap-2" data-found-platform={t.kind}>
                  <PlatformIcon kind={t.kind} className="size-3.5 shrink-0 text-fg-2" />
                  <span className="shrink-0 font-medium">{PLATFORM_NAMES[t.kind]}</span>
                  <span className="truncate font-mono text-xs text-fg-2">{t.locator || "no id yet"}</span>
                  {t.stack ? <span className="shrink-0 rounded-sm bg-panel-2 px-1.5 text-xs text-fg-2">{t.stack}</span> : null}
                </span>
              ))}
            </span>
          )}
        </Row>
        <Row index={i++} icon={<Globe />} label="Environment" section="environment" open={false} onOpen={onOpen} error={errors.environment}>
          <span className="font-medium">{state.envName.trim() || "local"}</span>
          {envUrl ? <span className="ml-2 font-mono text-xs text-fg-2">{envUrl}</span> : null}
          {prodKinds.length ? (
            <span className="ml-2 inline-flex h-[18px] items-center gap-1 rounded-full border border-danger/40 bg-danger/5 px-1.5 align-middle text-2xs font-medium text-danger" data-found-env-production>
              <TriangleAlert className="size-2.5" aria-hidden />
              Production for {prodKinds.map((k) => PLATFORM_NAMES[k]).join(" and ")}
            </span>
          ) : null}
          <span className="block text-xs text-muted" data-found-auth>
            {readyFound?.auth?.summary ?? "No sign-in needed, as far as the code says."}
          </span>
        </Row>
        <Row index={i++} icon={<Server />} label="Backend" section="backend" open={false} onOpen={onOpen}>
          <FoundBackends detected={state.backends?.for === backendKey ? state.backends : null} targets={enabled} reading={preview.kind === "loading"} />
        </Row>
        <Row
          index={i++}
          icon={<FlaskConical />}
          label="Existing UI tests"
          section="tests"
          open={open === "tests"}
          onOpen={onOpen}
        >
          {tests.length > 0 ? (
            <span className="flex flex-col gap-1.5">
              <span className="flex flex-wrap gap-1.5" data-found-tests>
                {tests.map((t) => (
                  <span key={t.framework} className="inline-flex items-center gap-1 rounded-md border border-border bg-panel px-1.5 py-0.5 text-xs" title={t.path || undefined}>
                    <span className="font-medium text-fg">{frameworkLabel(t.framework)}</span>
                    <span className="tabular-nums text-fg-2">{t.count}</span>
                  </span>
                ))}
              </span>
              <span className="text-xs text-muted">They light up on the map; you can bring them in after mapping.</span>
            </span>
          ) : preview.kind === "ready" ? (
            <span className="text-muted" data-found-no-ui-tests>
              No UI tests found. Embodent drafts scenarios for your screens instead.
            </span>
          ) : preview.kind === "loading" ? (
            <span className="text-muted" role="status">
              Reading the repository…
            </span>
          ) : (
            <span className="text-muted">{repo ? "Read when the map starts." : "None: there is no repository to read."}</span>
          )}
          {componentCount > 0 ? (
            <span className="mt-1 block text-xs text-muted" data-found-component-tests>
              Also {componentCount} {components.map((f) => frameworkLabel(f.framework)).join(" and ")} {componentCount === 1 ? "test renders" : "tests render"} screens
              without a device. They keep running where they are; the map ties only tests that drive the app.
            </span>
          ) : null}
        </Row>
        <Row index={i++} icon={<Workflow />} label="CI" section="ci" open={false} onOpen={onOpen}>
          {preview.kind === "ready" && preview.found.ci?.length ? (
            <span className="flex flex-col gap-0.5" data-found-ci>
              {preview.found.ci.map((c) => (
                <span key={`${c.provider}:${c.path}`}>
                  {c.provider} <span className="ml-1 font-mono text-xs text-fg-2">{c.path}</span>
                </span>
              ))}
            </span>
          ) : preview.kind === "loading" ? (
            <span className="text-muted" role="status">
              Reading the repository…
            </span>
          ) : preview.kind === "ready" ? (
            <span className="text-muted">None found.</span>
          ) : (
            <span className="text-muted">{repo ? "Read from the repository when the map starts, and shown on the map." : "None"}</span>
          )}
        </Row>
        <Row
          index={i++}
          icon={<Radar />}
          label="Device"
          section="device"
          open={open === "device"}
          onOpen={onOpen}
          editor={<DeviceStep state={state} set={set} devices={devices} loading={devicesLoading} available={devicesAvailable} />}
        >
          <span className="flex flex-col gap-0.5">
            {kinds.map((k) => (
              <span key={k} className="flex items-center gap-2" data-found-device={k}>
                <PlatformIcon kind={k} className="size-3.5 text-fg-2" />
                {deviceLabel(devices, state.deviceKeys[k], k)}
              </span>
            ))}
            {kinds.length === 0 ? <span className="text-muted">Chosen once a platform is on.</span> : null}
          </span>
        </Row>
        <Row index={i++} icon={<Database />} label="Test data" section="test_data" open={false} onOpen={onOpen}>
          {sandboxes.length ? (
            <span className="flex flex-col" data-found-sandboxes>
              <span>{sandboxes.length} {sandboxes.length === 1 ? "sandbox" : "sandboxes"} {unconfirmed ? "to confirm" : "ready"}</span>
              {sandboxes.map(([key, box]) => (
                <span key={key} className="text-xs text-muted" data-found-sandbox={key}>
                  {SANDBOX_NAMES[key] ?? key}: {box.evidence}
                </span>
              ))}
            </span>
          ) : readyFound?.defaults.test_data ? (
            <span>{readyFound.defaults.test_data}</span>
          ) : (
            <span className="text-muted">Nothing to reset found. Embodent tags everything it creates so it can clean up.</span>
          )}
        </Row>
        <Row index={i++} icon={<Bot />} label="Agent" section="agent" open={false} onOpen={onOpen}>
          <span className="flex flex-col items-start gap-1">
            {agentField}
            <span className="text-xs text-muted">
              Runs the live pass, the drafts and the first run as normal tasks.
            </span>
          </span>
        </Row>
        <Row index={i++} icon={<Radar />} label="Live pass" section="live" open={false} onOpen={onOpen}>
          {state.livePass && livePassKinds(kinds).length > 1 ? (
            <span className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs text-fg-2">Maps on</span>
              <span role="radiogroup" aria-label="Platform the live pass maps on" className="inline-flex rounded-[6px] bg-panel-2 p-0.5" data-onboarding-live-platform>
                {livePassKinds(kinds).map((k) => {
                  const on = state.livePlatform === k || (!state.livePlatform && k === livePassKinds(kinds)[0]);
                  return (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => set("livePlatform", k)}
                      className={cn(SEGMENT, on ? SEGMENT_ON : SEGMENT_OFF)}
                      data-onboarding-live-platform-option={k}
                    >
                      <PlatformIcon kind={k} className="size-3" />
                      {PLATFORM_NAMES[k]}
                    </button>
                  );
                })}
              </span>
              {!state.livePlatform ? <span className="text-xs text-muted">or the next one, if Embodent cannot read the app&apos;s screen there</span> : null}
            </span>
          ) : null}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 size-3.5 accent-[var(--color-primary)]"
              checked={state.livePass}
              onChange={(e) => set("livePass", e.target.checked)}
              data-onboarding-live-pass
            />
            <span>
              {state.livePass ? "On" : "Off"}
              <span className="block text-xs text-muted">
                After reading the code, Embodent offers to open the app on the device and visit each main area, so the map shows real
                screenshots. It waits for your click on the Map step, with its cost shown, and you can skip it there.
              </span>
            </span>
          </label>
        </Row>
      </ul>
    </div>
  );
}

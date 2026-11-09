/**
 * The wizard's state, as far as a project's QA needs it: the platforms the repository told us
 * (each editable on the We found sheet), the device per platform, the live-pass choice and the
 * backends read. The project already exists in Orcha, so there is no create step: Connect and
 * We found save through `POST C/onboarding` (`confirm`).
 */
import type { DetectedBackends } from "./backends";
import type { FoundSheet } from "./contract";
import type { BuildSource, RunDevice, TargetKind, WorkerDevice } from "./types";
import { devicePickerKey } from "./device-picker";

/** One device the picker offers. */
export interface DeviceOption {
  device: WorkerDevice;
  online: boolean;
}

export interface BuildState {
  source: BuildSource;
  path: string;
  url: string;
}

/** One platform card on the Platforms editor. */
export interface WizardTarget {
  key: string;
  kind: TargetKind;
  enabled: boolean;
  locator: string;
  /** App folder path relative to the repository root, "" when not from a repo. */
  subdir: string;
  appName: string | null;
  /** Detected from the repository scan (kind and subdir are then fixed). */
  detected: boolean;
  build: BuildState;
  isDefault?: boolean;
  /** Human-readable framework label ("Flutter", "React Native (Expo)", "Next.js", "Native iOS"). */
  stack?: string | null;
  from?: string;
  /** Every plausible id the scan found for this kind, `locator` included. */
  candidates?: string[];
}

export interface WizardState {
  /** The repository the portal reads: the project folder. */
  repoUrl: string;
  repoName: string | null;
  targets: WizardTarget[];
  envName: string;
  envLocator: string;
  deviceKeys: Record<TargetKind, string>;
  /** Which enabled target's kind the first run uses. */
  firstRunTargetKey: string;
  /** With several platforms: the chosen one, or one run on each. */
  firstRunScope: "one" | "all";
  /** First run, "More ways to start": explore the app, or check a scenario file. */
  mode: "exploratory" | "scenarios";
  /** Exploratory: the time budget, as typed. */
  minutes: string;
  /** Exploratory: what to look at first. */
  focus: string;
  /** Scenarios: a repo-relative file; empty, the approved scenarios. */
  scenarioFile: string;
  /** The map's live pass: on by default, skippable on the We found sheet and on the Map step. */
  livePass: boolean;
  /** The platform the live pass maps on, when the person picked one; empty: the first it can read. */
  livePlatform: TargetKind | "";
  /** The backend each platform's app talks to, as the We found sheet read it. */
  backends: DetectedBackends | null;
  /** A person changed something: this tab keeps it across a reload. */
  touched: boolean;
}

/** Setter shared by the steps: one field at a time. A function gets the field's latest value. */
export type SetField = <K extends keyof WizardState>(key: K, value: WizardState[K] | ((prev: WizardState[K]) => WizardState[K])) => void;

export function applySet<T>(prev: T, value: T | ((prev: T) => T)): T {
  return typeof value === "function" ? (value as (prev: T) => T)(prev) : value;
}

function emptyBuild(source: BuildSource = "path"): BuildState {
  return { source, path: "", url: "" };
}

/** New manual target card, `web` by default (the "Add platform" button). */
export function newManualTarget(kind: TargetKind = "web", isDefault = false): WizardTarget {
  return {
    key: `manual:${kind}:${Math.random().toString(36).slice(2, 9)}`,
    kind,
    enabled: true,
    locator: kind === "web" ? "http://localhost:3000" : "",
    subdir: "",
    appName: null,
    detected: false,
    build: emptyBuild(),
    isDefault,
  };
}

export function initialState(): WizardState {
  return {
    repoUrl: "",
    repoName: null,
    targets: [],
    envName: "local",
    envLocator: "",
    deviceKeys: { ios: "", android: "", web: "desktop" },
    firstRunTargetKey: "",
    firstRunScope: "one",
    mode: "exploratory",
    minutes: "20",
    focus: "",
    scenarioFile: "",
    livePass: true,
    livePlatform: "",
    backends: null,
    touched: false,
  };
}

/** What the scan found, as the sheet's editable state; what the person already changed stays. */
export function stateFromFound(state: WizardState, found: FoundSheet): WizardState {
  const edited = state.targets.filter((t) => !t.detected);
  const detected = found.platforms.map((p, i): WizardTarget => {
    const prev = state.targets.find((t) => t.detected && t.kind === p.kind);
    return {
      key: `detected:${p.kind}:${i}`,
      kind: p.kind,
      enabled: prev?.enabled ?? true,
      locator: prev?.locator || p.app_id || (p.kind === "web" ? found.environments[0]?.base_url ?? "http://localhost:3000" : ""),
      subdir: p.path ?? "",
      appName: null,
      detected: true,
      build: prev?.build ?? emptyBuild(p.kind === "web" ? "path" : "repo"),
      stack: p.stack ?? null,
      from: p.app_id ? p.path ?? "" : "",
      candidates: p.candidates ?? [],
    };
  });
  const env = found.environments[0];
  return {
    ...state,
    repoUrl: state.repoUrl || found.repo.path || found.repo.url || "",
    repoName: found.repo.name || state.repoName,
    targets: [...edited.filter((t) => !detected.some((d) => d.kind === t.kind)), ...detected],
    envName: env?.name || state.envName,
    envLocator: state.envLocator || env?.base_url || "",
  };
}

export function enabledTargets(state: WizardState): WizardTarget[] {
  return state.targets.filter((t) => t.enabled);
}

/** The option behind a pick, or undefined when that device is gone. */
export function findDeviceOption(devices: readonly DeviceOption[], key: string): DeviceOption | undefined {
  return key ? devices.find((o) => devicePickerKey(o.device) === key) : undefined;
}

/** A key the picker wrote (`ios:<udid>`), rather than a name typed or saved earlier. */
const isPickerKey = (kind: TargetKind, key: string) => key.startsWith(`${kind}:`);

/** The device a run takes. A picked device that is gone is no pick (the agent's default), so a
 * run never lands somewhere the sheet did not say. */
export function toRunDevice(kind: TargetKind, key: string, devices: readonly DeviceOption[]): RunDevice | null {
  if (!key) return null;
  if (kind === "web") return { kind, viewport: key };
  const option = findDeviceOption(devices, key);
  const name = option ? (option.device as { name: string }).name : isPickerKey(kind, key) ? null : key;
  return name ? { kind, name } : null;
}

/** A run device's name, as `qa_targets.device_name` keeps it. */
export const deviceNameOf = (device: RunDevice | null): string | null => (!device ? null : device.kind === "web" ? device.viewport : device.name);

/** First run target: first ios/android target if any, else the first enabled target. */
export function defaultFirstRunTarget(targets: WizardTarget[]): WizardTarget | null {
  const enabled = targets.filter((t) => t.enabled);
  return enabled.find((t) => t.kind === "ios" || t.kind === "android") ?? enabled[0] ?? null;
}

/** Why the platforms cannot be saved yet, or null. */
export function validateTargets(state: WizardState): string | null {
  const enabled = enabledTargets(state);
  if (enabled.length === 0) return "Enable at least one platform.";
  for (const t of enabled) {
    const locator = t.locator.trim();
    if (!locator) return t.kind === "web" ? "Enter a URL." : t.kind === "android" ? "Enter a package name." : "Enter a bundle id.";
    if (t.kind === "web" && !/^https?:\/\//i.test(locator)) return "URL must start with http:// or https://.";
  }
  return null;
}

/** The picks `confirm` saves: one `qa_targets` row per enabled platform, plus the live-pass choice. */
export function confirmOptions(state: WizardState, devices: readonly DeviceOption[]): Record<string, unknown> {
  const platforms = enabledTargets(state).map((t) => {
    const buildPath = t.build.source === "path" ? t.build.path.trim() : "";
    return {
      kind: t.kind,
      app_id: t.locator.trim(),
      app_name: t.appName,
      device_name: deviceNameOf(toRunDevice(t.kind, state.deviceKeys[t.kind], devices)),
      ...(buildPath ? { build_path: buildPath } : {}),
    };
  });
  return { platforms, live: state.livePass ? "ask" : false, ...(state.livePlatform ? { platform: state.livePlatform } : {}) };
}

/** Why the first run cannot start yet, or null. */
export function validateFirstRun(state: WizardState): string | null {
  if (state.mode !== "exploratory") return null;
  const m = Number(state.minutes);
  return !Number.isInteger(m) || m < 5 || m > 240 ? "Give it between 5 and 240 minutes." : null;
}

/** Where this tab keeps a project's edits, so a reload comes back with everything entered. */
const draftKey = (cid: string) => `orcha:qa-onboarding:${cid}`;

export function writeDraft(cid: string, state: WizardState): void {
  try {
    sessionStorage.setItem(draftKey(cid), JSON.stringify(state));
  } catch {
    // A private window: the edits live as long as the page.
  }
}

export function clearDraft(cid: string): void {
  try {
    sessionStorage.removeItem(draftKey(cid));
  } catch {
    // Nothing kept.
  }
}

/** The state a reload resumes from: the draft over a fresh state (a draft from an older build
 * lacks newer fields), or null when there is none this wizard wrote. */
export function readDraft(cid: string): WizardState | null {
  try {
    const raw = sessionStorage.getItem(draftKey(cid));
    const d = raw ? (JSON.parse(raw) as Partial<WizardState>) : null;
    if (!d || typeof d !== "object" || !Array.isArray(d.targets)) return null;
    const base = initialState();
    return { ...base, ...d, deviceKeys: { ...base.deviceKeys, ...(d.deviceKeys ?? {}) } };
  } catch {
    return null;
  }
}

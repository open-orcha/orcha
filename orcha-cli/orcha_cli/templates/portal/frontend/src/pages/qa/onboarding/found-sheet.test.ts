// @vitest-environment jsdom
import { createElement as h, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { testsNoteText, type TestSurvey } from "./tests-found";
import { WEB_OPTIONS } from "./use-live-devices";
import { applySet, confirmOptions, initialState, stateFromFound, validateTargets, type DeviceOption, type SetField, type WizardState } from "./state";
import type { FoundBackend, FoundSheet as FoundData } from "./contract";
import { deviceLabel, deviceSentence, FoundSheet, type FoundSection } from "./found-sheet";


const REPO = "/Users/mary/Code/truckline";
const LOCAL: FoundBackend = {
  platforms: ["ios", "android"],
  service: "Supabase",
  url: "http://127.0.0.1:54321",
  source: "apps/mobile/.env",
  variable: "EXPO_PUBLIC_SUPABASE_URL",
  build: "checkout",
  production: false,
};
const PROD: FoundBackend = { ...LOCAL, url: "https://abcdefghijklmnopqrst.supabase.co", source: "apps/mobile/eas.json", build: "release", production: true };
/** Jest tests that render screens: what FleetMate's survey found (185 of 448). */
const SURVEY: TestSurvey = { total: 448, ui: 185, frameworks: [{ framework: "jest", ui: 185 }] };

const FOUND: FoundData = {
  repo: { path: REPO, name: "truckline" },
  platforms: [{ kind: "ios", app_id: "com.truckline.app" }, { kind: "android", app_id: "com.truckline.app" }, { kind: "web" }],
  environments: [],
  tests: [],
  ci: [{ provider: "GitHub Actions", path: ".github/workflows/android-build.yml" }],
  defaults: {},
  backends: [LOCAL, PROD],
};

function startState(): WizardState {
  const base = initialState();
  const target = (kind: "ios" | "android" | "web", locator: string, source: "repo" | "path") => ({
    key: `detected:${kind}`,
    kind,
    enabled: true,
    locator,
    subdir: kind === "web" ? "apps/web" : "apps/mobile",
    appName: null,
    detected: true,
    build: { source, path: "", url: "" },
  });
  return {
    ...base,
    repoUrl: REPO,
    targets: [target("ios", "com.truckline.app", "repo"), target("android", "com.truckline.app", "repo"), target("web", "http://localhost:3000", "path")],
  };
}

const seen: { latest: WizardState | null } = { latest: null };
function Harness({ initial, found = FOUND }: { initial: WizardState; found?: FoundData }) {
  const [state, setState] = useState(initial);
  useEffect(() => {
    seen.latest = state;
  });
  const set: SetField = (key, value) => setState((s) => ({ ...s, [key]: applySet(s[key], value) }));
  const [open, setOpen] = useState<FoundSection | null>(null);
  return h(MemoryRouter, null, h(FoundSheet, { state, set, preview: { kind: "ready", found }, agentField: "forge", devices: DEVICES, devicesAvailable: true, open, onOpen: setOpen }));
}

const DEVICES: DeviceOption[] = [{ device: { kind: "ios", name: "iPhone 17 Pro", udid: "U1", runtime: "iOS 26.5", state: "booted" }, online: true }, ...WEB_OPTIONS];

beforeEach(() => {
  seen.latest = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("We found: the backend (#453)", () => {
  it("lists each backend per build, marks the one runs use and production", async () => {
    render(h(Harness, { initial: startState() }));
    const rows = await screen.findAllByText("Supabase");
    expect(rows).toHaveLength(2);
    const local = document.querySelector("[data-found-backend='checkout']") as HTMLElement;
    expect(local.textContent).toContain("127.0.0.1:54321");
    expect(local.textContent).toContain("Local");
    expect(local.textContent).toContain("Runs use this");
    expect(local.textContent).toContain("Builds from this checkout · apps/mobile/.env");
    const prod = document.querySelector("[data-found-backend='release']") as HTMLElement;
    expect(prod.textContent).toContain("abcdefghijklmnopqrst.supabase.co");
    expect(prod.textContent).toContain("Production");
    expect(prod.textContent).not.toContain("Runs use this");
    expect(document.querySelector("[data-found-production-means]")?.textContent).toBe(
      "Production: each run asks first and stays read-only unless you allow changes to real data.",
    );
    await waitFor(() => expect(seen.latest?.backends?.list).toEqual([LOCAL, PROD]));
    // Builds from the checkout reach the local stack: no environment is production yet.
    expect(document.querySelector("[data-found-env-production]")).toBeNull();
  });

  it("a release build someone adds reaches production: that platform's environment says so", async () => {
    const s = startState();
    s.targets = s.targets.map((t) => (t.kind === "android" ? { ...t, build: { ...t.build, source: "upload" as const } } : t));
    render(h(Harness, { initial: s }));
    await waitFor(() => expect(document.querySelector("[data-found-env-production]")?.textContent).toBe("Production for Android"));
    expect((document.querySelector("[data-found-backend='release']") as HTMLElement).textContent).toContain("Runs use this");
  });

  it("says plainly when a phone's backend cannot be told", async () => {
    const s = startState();
    s.targets = s.targets.filter((t) => t.kind === "ios");
    const found: FoundData = {
      repo: { name: "truckline" },
      platforms: [{ kind: "ios" }],
      environments: [],
      tests: [],
      defaults: {},
      backend_unknown: { ios: "It reads EXPO_PUBLIC_API_URL, but no value for it is in the repository" },
    };
    render(h(Harness, { initial: s, found }));
    const line = await screen.findByText("Embodent cannot tell which backend iOS builds from this checkout talk to.");
    expect(line.closest("[data-found-backend-unknown='ios']")?.textContent).toContain("If it could be production, set it with Edit before the live pass.");
  });
});

describe("We found: what #454 found", () => {
  it("the device line is what the Device editor has selected, a name only when one is picked", () => {
    expect(deviceLabel(DEVICES, "", "ios")).toBe("Any booted simulator");
    expect(deviceLabel(DEVICES, "ios:U1", "ios")).toBe("iPhone 17 Pro");
    // A name saved earlier reads as itself; a picked device that has gone reads as the default.
    expect(deviceLabel(DEVICES, "iPhone 16", "ios")).toBe("iPhone 16");
    expect(deviceLabel(DEVICES, "ios:GONE", "ios")).toBe("Any booted simulator");
    expect(deviceLabel(DEVICES, "", "android")).toBe("Any running emulator");
    expect(deviceLabel(DEVICES, "desktop", "web")).toBe("Desktop browser (1280×800)");
    expect(deviceLabel(DEVICES, "mobile", "web")).toBe("Mobile browser (390×844)");
    expect(deviceSentence("Any booted simulator")).toBe("any booted simulator");
  });

  it("counts UI tests as the Map step does: Jest component tests are named apart, never as UI tests", () => {
    expect(testsNoteText(SURVEY)).toBe("No UI tests that drive the app; 185 Jest tests that render screens without a device. They keep running where they are.");
    expect(testsNoteText({ total: 19, ui: 19, frameworks: [{ framework: "xcuitest", ui: 9 }, { framework: "maestro", ui: 10 }] })).toBe("Found 19 UI tests (9 XCUITest, 10 Maestro). You can bring them in after mapping.");
  });

  it("the live pass waits for a click on the Map step, as its line says", async () => {
    render(h(Harness, { initial: startState() }));
    await act(async () => undefined);
    expect(document.querySelector("[data-found-row='live']")?.textContent).toContain("It waits for your click on the Map step, with its cost shown");
  });
});

describe("what the scan fills in, and what confirm saves", () => {
  it("nobody types an id: found platforms become the sheet's targets, a person's edit stays", () => {
    const s = stateFromFound(initialState(), { ...FOUND, environments: [{ name: "Local", base_url: "http://localhost:5173" }] });
    expect(s.repoUrl).toBe(REPO);
    expect(s.repoName).toBe("truckline");
    expect(s.targets.map((t) => [t.kind, t.locator])).toEqual([["ios", "com.truckline.app"], ["android", "com.truckline.app"], ["web", "http://localhost:5173"]]);
    expect(validateTargets(s)).toBeNull();
    const edited = { ...s, targets: s.targets.map((t) => (t.kind === "ios" ? { ...t, locator: "com.truckline.beta" } : t)) };
    expect(stateFromFound(edited, FOUND).targets.find((t) => t.kind === "ios")?.locator).toBe("com.truckline.beta");
  });

  it("confirm saves each enabled platform and the live-pass choice", () => {
    const s = stateFromFound(initialState(), FOUND);
    const off = { ...s, targets: s.targets.map((t) => (t.kind === "android" ? { ...t, enabled: false } : t)), deviceKeys: { ...s.deviceKeys, ios: "ios:U1", web: "mobile" } };
    expect(confirmOptions(off, DEVICES)).toEqual({
      platforms: [
        { kind: "ios", app_id: "com.truckline.app", app_name: null, device_name: "iPhone 17 Pro" },
        { kind: "web", app_id: "http://localhost:3000", app_name: null, device_name: "mobile" },
      ],
      live: "ask",
    });
    expect(confirmOptions({ ...off, livePass: false }, DEVICES).live).toBe(false);
  });

  it("refuses a web target without a URL scheme, and no platform at all", () => {
    const s = stateFromFound(initialState(), FOUND);
    expect(validateTargets({ ...s, targets: [] })).toBe("Enable at least one platform.");
    expect(validateTargets({ ...s, targets: s.targets.map((t) => (t.kind === "web" ? { ...t, locator: "staging.acme.com" } : t)) })).toBe("URL must start with http:// or https://.");
  });
});

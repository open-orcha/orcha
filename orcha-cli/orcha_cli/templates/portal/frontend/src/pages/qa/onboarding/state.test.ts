import { afterEach, describe, expect, it } from "vitest";
import { clearDraft, confirmOptions, initialState, readDraft, stateFromFound, toRunDevice, writeDraft, type DeviceOption } from "./state";
import type { FoundSheet } from "./contract";

const iphone: DeviceOption = { device: { kind: "ios", name: "iPhone 17 Pro", udid: "U1", runtime: "iOS 26.5", state: "booted" }, online: true };
const FOUND = { repo: { path: "/w/app", name: "app" }, platforms: [{ kind: "ios", app_id: "com.a" }], environments: [], tests: [], ci: [], defaults: { device: "A simulator", test_data: "A fresh install" } } as unknown as FoundSheet;

afterEach(() => sessionStorage.clear());

describe("the device a run takes", () => {
  it("is the picked device's name, which is what a session finds it by", () => {
    expect(toRunDevice("ios", "ios:U1", [iphone])).toEqual({ kind: "ios", name: "iPhone 17 Pro" });
  });
  it("a picked device that has gone is no pick", () => {
    expect(toRunDevice("ios", "ios:GONE", [iphone])).toBeNull();
  });
  it("a name saved or typed earlier stays a name", () => {
    expect(toRunDevice("ios", "iPad Pro 13-inch (M5)", [])).toEqual({ kind: "ios", name: "iPad Pro 13-inch (M5)" });
  });
  it("a browser size is the viewport", () => {
    expect(toRunDevice("web", "mobile", [])).toEqual({ kind: "web", viewport: "mobile" });
  });
  it("nothing picked is the default", () => {
    expect(toRunDevice("android", "", [iphone])).toBeNull();
  });
});

describe("what the scan fills in", () => {
  it("the scan's word for a device is never taken for a device: no session could find \"A simulator\"", () => {
    const s = stateFromFound(initialState(), FOUND);
    expect(s.deviceKeys.ios).toBe("");
    expect((confirmOptions(s, []).platforms as { device_name: unknown }[])[0].device_name).toBeNull();
  });

  it("the live pass platform a person picks is sent; no pick sends nothing", () => {
    const s = stateFromFound(initialState(), FOUND);
    expect(confirmOptions(s, [])).not.toHaveProperty("platform");
    expect(confirmOptions({ ...s, livePlatform: "web" }, [])).toMatchObject({ platform: "web" });
  });

  it("a build path typed on the sheet is saved; an empty one sends nothing", () => {
    const s = stateFromFound(initialState(), FOUND);
    expect((confirmOptions(s, []).platforms as object[])[0]).not.toHaveProperty("build_path");
    const typed = { ...s, targets: s.targets.map((t) => ({ ...t, build: { ...t.build, source: "path" as const, path: " /b/App.app " } })) };
    expect((confirmOptions(typed, []).platforms as object[])[0]).toMatchObject({ build_path: "/b/App.app" });
  });
});

describe("a reload keeps what was entered (#454)", () => {
  it("comes back from this tab, per project", () => {
    const s = { ...stateFromFound(initialState(), FOUND), touched: true, deviceKeys: { ios: "ios:U1", android: "", web: "mobile" } };
    writeDraft("c1", s);
    expect(readDraft("c1")).toEqual(s);
    expect(readDraft("c2")).toBeNull();
    clearDraft("c1");
    expect(readDraft("c1")).toBeNull();
  });
  it("a draft from an older build takes the newer fields' defaults", () => {
    sessionStorage.setItem("orcha:qa-onboarding:c1", JSON.stringify({ targets: [], deviceKeys: { ios: "x" } }));
    expect(readDraft("c1")).toMatchObject({ mode: "exploratory", deviceKeys: { ios: "x", android: "", web: "desktop" } });
  });
  it("something that is not a draft is ignored", () => {
    sessionStorage.setItem("orcha:qa-onboarding:c1", "{not json");
    expect(readDraft("c1")).toBeNull();
    sessionStorage.setItem("orcha:qa-onboarding:c1", JSON.stringify({ step: "found" }));
    expect(readDraft("c1")).toBeNull();
  });
});

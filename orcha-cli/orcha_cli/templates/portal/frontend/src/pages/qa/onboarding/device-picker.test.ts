import { describe, expect, it } from "vitest";
import { blockedWords, defaultDevicePick, devicePickerKey, deviceValue, matchesQuery, physicalDetail, pickedSummary, pickerGroups, pickerRows, rowForValue, splitConnected, type PickerInput } from "./device-picker";
import type { WorkerDevice } from "./types";

const iphone: WorkerDevice = { kind: "ios", name: "iPhone 17 Pro", udid: "AAAA1111-2222", state: "booted", runtime: "iOS 26.5" };
const pixel: WorkerDevice = { kind: "android", name: "Pixel_9a", serial: "emulator-5554", state: "device" };
const phone: WorkerDevice = { kind: "android", name: "SM-S918B", serial: "R58M", state: "device", physical: true, connection: "usb" };
const desktop: WorkerDevice = { kind: "web", name: "Desktop browser (1280×800)", viewport: "desktop", size: "1280×800" };
const setup = { code: "device_disconnected", title: "iPhone not connected.", fix: "Connect it by cable." };
const away: WorkerDevice = { kind: "ios", name: "Demo Phone", udid: "00008110-001C610A2610401E", physical: true, model: "iPhone 13", os: "iOS 26.7", connection: null, ready: false, setup };
const tethered: WorkerDevice = { kind: "ios", name: "Hussein's iPhone", udid: "00008150-00167C982240401C", physical: true, model: "iPhone 17 Pro Max", os: "iOS 26.6.1", connection: "usb", ready: true };
const inputs: PickerInput[] = [{ device: pixel }, { device: phone }, { device: iphone }, { device: desktop }];

describe("device picker rows", () => {
  const rows = pickerRows(inputs);

  it("groups by platform in the standard order, each with its state", () => {
    const groups = pickerGroups(rows, { kinds: ["android", "ios", "web"] });
    expect(groups.map((g) => g.kind)).toEqual(["web", "ios", "android"]);
    expect(groups[1].rows[0]).toMatchObject({ title: "iPhone 17 Pro", detail: "iOS 26.5", state: "booted" });
    expect(groups[2].rows.map((r) => [r.title, r.state])).toEqual([["Pixel 9a", "running"], ["SM-S918B", "ready"]]);
  });

  it("searches by model, OS and state: every word has to match", () => {
    expect(pickerGroups(rows, { kinds: ["android", "ios"], query: "pixel running" }).flatMap((g) => g.rows.map((r) => r.title))).toEqual(["Pixel 9a"]);
    expect(pickerGroups(rows, { kinds: ["ios"], query: "ios 26.5" })[0].rows).toHaveLength(1);
    expect(pickerGroups(rows, { kinds: ["ios"], query: "windows" })).toEqual([]);
    expect(matchesQuery({ haystack: "a b c" }, "c a")).toBe(true);
  });

  it("marks a device no longer seen, unless it is seen again", () => {
    expect(pickerRows([{ device: pixel, online: false }])[0].state).toBe("offline");
    const both = pickerRows([{ device: pixel, online: false }, { device: pixel, online: true }]);
    expect(both).toHaveLength(1);
    expect(both[0].state).toBe("running");
  });

  it("tells identically named simulators apart by the udid", () => {
    const a: WorkerDevice = { kind: "ios", name: "iPad Pro 13-inch (M5)", udid: "11111111-aaaa", runtime: "iOS 26.5" };
    const b: WorkerDevice = { kind: "ios", name: "iPad Pro 13-inch (M5)", udid: "22222222-bbbb", runtime: "iOS 26.5" };
    expect(pickerRows([{ device: a }, { device: b }]).map((r) => r.detail)).toEqual(["iOS 26.5 · 11111111", "iOS 26.5 · 22222222"]);
  });

  it("keys a device by udid or serial, never by position; a browser size is its own key", () => {
    expect(devicePickerKey(iphone)).toBe("ios:AAAA1111-2222");
    expect(devicePickerKey(pixel)).toBe("android:Pixel_9a");
    expect(devicePickerKey(phone)).toBe("android:R58M");
    expect(devicePickerKey(desktop)).toBe("desktop");
  });

  it("puts connected phones first, then paired ones, then simulators; the web has no phones", () => {
    const android = pickerGroups(rows, { kinds: ["android"] })[0].rows;
    expect(splitConnected("android", android).connected?.map((r) => r.title)).toEqual(["SM-S918B"]);
    expect(splitConnected("android", android).virtual.map((r) => r.title)).toEqual(["Pixel 9a"]);
    const ios = pickerGroups(pickerRows([{ device: iphone }, { device: away }, { device: tethered }]), { kinds: ["ios"] })[0].rows;
    const split = splitConnected("ios", ios);
    expect(split.connected?.map((r) => r.title)).toEqual(["Hussein's iPhone"]);
    expect(split.away?.map((r) => r.title)).toEqual(["Demo Phone"]);
    expect(split.virtual.map((r) => r.title)).toEqual(["iPhone 17 Pro"]);
    expect(splitConnected("web", pickerGroups(rows, { kinds: ["web"] })[0].rows)).toMatchObject({ connected: null, away: null });
  });

  it("says a phone's model, OS and connection, and what it needs", () => {
    expect(physicalDetail({ name: "iPad", model: "iPad Pro (11-inch)", os: "iOS 26.7", connection: null })).toBe("iPad Pro (11-inch) · iOS 26.7 · Not connected");
    expect(physicalDetail({ name: "SM-S918B", model: "SM-S918B", os: "Android 15", connection: "usb" })).toBe("Android 15 · USB");
    const row = pickerRows([{ device: away }])[0];
    expect(row).toMatchObject({ state: "setup", physical: true, setup: { title: "iPhone not connected." } });
    expect(blockedWords(row)).toBe("iPhone not connected. Connect it by cable.");
    expect(blockedWords(pickerRows([{ device: tethered }])[0])).toBeNull();
  });

  it("offers a stopped device and says it boots; a device a run holds reads as in use", () => {
    const stopped: WorkerDevice = { kind: "ios", name: "iPad Pro", udid: "BBBB", runtime: "iOS 26.5", state: "shutdown" };
    const avd: WorkerDevice = { kind: "android", name: "Pixel_9_Pro", serial: null, state: "stopped" };
    const [ipad, emulator] = pickerRows([{ device: stopped }, { device: avd }]);
    expect(ipad).toMatchObject({ state: "stopped", detail: "iOS 26.5 · Boots when the run starts" });
    expect(emulator).toMatchObject({ title: "Pixel 9 Pro", state: "stopped", detail: "Emulator · Boots when the run starts", key: "android:Pixel_9_Pro" });
    const held: WorkerDevice = { ...iphone, held_by: { project: "sada", kind: "check" } };
    expect(pickerRows([{ device: held }])[0]).toMatchObject({ state: "busy", detail: "sada's check run has it" });
  });

  it("finds a saved device by what the session is told", () => {
    expect(rowForValue(rows, "android", "Pixel_9a")?.title).toBe("Pixel 9a");
    expect(rowForValue(rows, "ios", "Pixel_9a")).toBeNull();
    expect(deviceValue(desktop)).toBe("desktop");
  });

  it("says the default as a session does it, and never promises to boot anything", () => {
    expect(defaultDevicePick("ios")).toEqual({ noun: "Any booted simulator", detail: "The agent picks: any booted simulator" });
    expect(defaultDevicePick("android").noun).toBe("Any running emulator");
    expect(pickedSummary(rows, "ios", "ios:AAAA1111-2222")).toBe("iPhone 17 Pro");
    expect(pickedSummary(rows, "ios", "")).toBe("Any booted simulator");
  });
});

describe("Default when nothing runs", () => {
  const stopped = (name: string): WorkerDevice => ({ kind: "android", name, serial: null, state: "stopped" });
  it("says which emulator it boots, and stays plain when one runs", () => {
    const idle = pickerRows([{ device: stopped("Pixel_9_Pro") }, { device: stopped("Pixel_Tablet") }]);
    expect(defaultDevicePick("android", idle)).toEqual({ noun: "Boots Pixel 9 Pro", detail: "Nothing is running. Orcha boots Pixel 9 Pro first, about a minute." });
    const busy = pickerRows([{ device: stopped("Pixel_9_Pro") }, { device: { kind: "android", name: "Pixel_9a", serial: "emulator-5554", state: "device" } }]);
    expect(defaultDevicePick("android", busy).noun).toBe("Any running emulator");
    const sims = pickerRows([{ device: { kind: "ios", name: "iPhone 17 Pro", udid: "A", runtime: "iOS 26.5", state: "shutdown" } }]);
    expect(defaultDevicePick("ios", sims).noun).toBe("Boots iPhone 17 Pro");
  });
});

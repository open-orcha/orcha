import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickerInput } from "./device-picker";
import { DevicePicker } from "./device-picker-view";
import { WEB_OPTIONS } from "./use-live-devices";
import type { WorkerDevice } from "./types";

afterEach(cleanup);

const pixelPro: WorkerDevice = { kind: "android", name: "Pixel_9_Pro", serial: "emulator-5554", state: "device" };
const pixelXl: WorkerDevice = { kind: "android", name: "Pixel_9_Pro_XL", serial: "emulator-5556", state: "device" };
const devices: PickerInput[] = [{ device: pixelPro }, { device: pixelXl }];
const option = (container: HTMLElement, key: string) => container.querySelector<HTMLButtonElement>(`[data-device-option='${key}']`);

describe("DevicePicker", () => {
  it("picks one device with radios and offers Default", () => {
    const onSelect = vi.fn();
    const { container } = render(<DevicePicker devices={devices} kinds={["android"]} selected={{}} onSelect={onSelect} />);
    expect(container.querySelector("[role='radiogroup']")).not.toBeNull();
    expect(option(container, "")?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(option(container, "android:Pixel_9_Pro_XL")!);
    expect(onSelect).toHaveBeenCalledWith("android", "android:Pixel_9_Pro_XL");
    fireEvent.click(option(container, "")!);
    expect(onSelect).toHaveBeenLastCalledWith("android", "");
  });

  it("a picked device that has gone falls back to Default on the screen", () => {
    const { container } = render(<DevicePicker devices={devices} kinds={["android"]} selected={{ android: "android:emulator-9999" }} onSelect={vi.fn()} />);
    expect(option(container, "")?.getAttribute("aria-checked")).toBe("true");
  });

  it("with no simulator says so", () => {
    const { container } = render(<DevicePicker devices={[]} kinds={["ios"]} selected={{}} onSelect={vi.fn()} />);
    expect(container.querySelector("[data-device-none='ios']")?.textContent).toBe("No simulator on this Mac.");
    expect(option(container, "")).not.toBeNull();
  });

  it("offers the browser sizes with no Default, the current one picked", () => {
    const { container } = render(<DevicePicker devices={WEB_OPTIONS} kinds={["web"]} selected={{ web: "desktop" }} onSelect={vi.fn()} />);
    expect(option(container, "")).toBeNull();
    expect(option(container, "desktop")?.getAttribute("aria-checked")).toBe("true");
    expect(option(container, "mobile")?.getAttribute("aria-checked")).toBe("false");
  });

  it("narrows by search, and says so when nothing matches", () => {
    const { container } = render(<DevicePicker devices={devices} kinds={["android"]} selected={{}} onSelect={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "Search devices" });
    fireEvent.change(search, { target: { value: "xl" } });
    expect(option(container, "android:Pixel_9_Pro")).toBeNull();
    expect(option(container, "android:Pixel_9_Pro_XL")).not.toBeNull();
    fireEvent.change(search, { target: { value: "nokia" } });
    expect(container.querySelector("[data-device-empty]")?.textContent).toContain("No device matches the search.");
  });

  it("says it is reading while the list is on its way", () => {
    const { container } = render(<DevicePicker devices={[]} kinds={["ios"]} selected={{}} onSelect={vi.fn()} loading />);
    expect(container.querySelector("[data-device-loading]")).not.toBeNull();
  });
});

describe("DevicePicker phones", () => {
  const setup = { code: "device_locked", title: "iPhone is locked.", fix: "Unlock it." };
  const home: WorkerDevice = { kind: "ios", name: "iPhone 17 Pro", udid: "16D2179E", runtime: "iOS 26.5", state: "booted" };
  const here: WorkerDevice = { kind: "ios", name: "My iPhone", udid: "00008150-00167C982240401C", physical: true, model: "iPhone 17 Pro Max", os: "iOS 26.6.1", connection: "usb", ready: false, setup };
  const gone: WorkerDevice = { kind: "ios", name: "Demo Phone", udid: "00008110-001C610A2610401E", physical: true, model: "iPhone 13", os: "iOS 26.7", connection: null, ready: false, setup };

  it("lists connected, then paired, then simulators, each phone with its fix", () => {
    const { container } = render(<DevicePicker devices={[{ device: home }, { device: gone }, { device: here }]} kinds={["ios"]} selected={{}} onSelect={vi.fn()} />);
    expect([...container.querySelectorAll("[data-device-subheading]")].map((h) => h.textContent)).toEqual(["This Mac · connected", "Paired · not connected", "Simulators"]);
    expect([...container.querySelectorAll("[data-device-option]")].map((o) => o.getAttribute("data-device-option"))).toEqual(["", "ios:" + here.udid, "ios:" + gone.udid, "ios:16D2179E"]);
    expect(container.querySelector("[data-device-setup-note='device_locked']")?.textContent).toBe("iPhone is locked. Unlock it.");
  });

  it("says how to connect a phone when none is connected", () => {
    const { container } = render(<DevicePicker devices={[{ device: home }]} kinds={["ios"]} selected={{}} onSelect={vi.fn()} />);
    expect(container.querySelector("[data-device-connect-help='ios']")?.textContent).toContain("No iPhone or iPad connected");
  });
});

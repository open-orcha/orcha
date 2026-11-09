import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConditionsField } from "./ConditionsField";
import { cleanConditions, conditionWords, mergeConditions, nativeKeys, parseConditions } from "./conditions";
import { qaTaskBody } from "../runQa";

afterEach(cleanup);

describe("run conditions", () => {
  it("reads in plain words and merges key by key", () => {
    expect(conditionWords({ os: "13", locale: "sw-KE", text_size: "large", account: "Premium subscriber" }, "android"))
      .toEqual(["Android 13", "Swahili (Kenya)", "Text: Large", "Account: Premium subscriber"]);
    expect(conditionWords({ os: "iOS 18.2", network: "slow" }, "ios")).toEqual(["iOS 18.2", "Slow network"]);
    expect(mergeConditions({ os: "13", locale: "en-US" }, { locale: "sw-KE", os: null })).toEqual({ os: "13", locale: "sw-KE" });
    expect(cleanConditions({ os: " ", appearance: null })).toBeNull();
  });

  it("knows what Orcha sets itself on each device", () => {
    expect([...nativeKeys("android")].sort()).toEqual(["appearance", "locale", "network", "os", "text_size"]);
    expect([...nativeKeys("android", true)]).not.toContain("network");
    expect([...nativeKeys("ios", true)].sort()).toEqual(["locale", "os"]);
    expect([...nativeKeys("web")].sort()).toEqual(["appearance", "locale", "network", "text_size", "timezone"]);
  });

  it("reads conditions from a link safely", () => {
    expect(parseConditions('{"os":"13","text_size":"huge","network":"slow","x":"y"}')).toEqual({ os: "13", network: "slow" });
    expect(parseConditions("not json")).toBeNull();
    expect(parseConditions("[1]")).toBeNull();
  });

  it("tells the agent the conditions in the task", () => {
    const body = qaTaskBody({ kind: "check", platform: "android", conditions: { os: "13", locale: "sw-KE" }, agentAlias: "qa", humanId: "h" });
    expect(body.description).toContain("Run it under these conditions: Android 13; Swahili (Kenya).");
    expect(body.description).toContain('Conditions: pass conditions={"os":"13","locale":"sw-KE"} to start_session.');
    expect(qaTaskBody({ kind: "check", platform: "web", agentAlias: "qa", humanId: "h" }).description).not.toContain("Conditions:");
  });
});

describe("ConditionsField", () => {
  it("shows every condition as a tile, set ones with their value and who sets them, and clears one", () => {
    const onChange = vi.fn();
    const { container } = render(<ConditionsField value={{ locale: "sw-KE", account: "Premium subscriber" }} onChange={onChange} platform="android" />);
    const tile = (k: string) => container.querySelector(`[data-qa-condition='${k}']`)!;
    expect(tile("locale").textContent).toContain("Swahili (Kenya)");
    expect(tile("locale").textContent).toContain("Orcha");
    expect(tile("account").textContent).toContain("Agent");
    expect(tile("timezone").textContent).toContain("Any");
    expect(tile("locale").className).toContain("is-set");
    fireEvent.click(screen.getByRole("button", { name: "Clear account" }));
    expect(onChange).toHaveBeenCalledWith({ locale: "sw-KE" });
  });

  it("shows the scenario's own beside the run's, dashed", () => {
    const { container } = render(<ConditionsField value={{ text_size: "large" }} inherited={{ os: "13" }} onChange={vi.fn()} platform="android" />);
    const os = container.querySelector("[data-qa-condition='os']")!;
    expect(os.className).toContain("is-base");
    expect(os.textContent).toContain("Android 13 · scenario");
  });

  it("opens a visual picker per condition: text sizes, appearance and network are cards", () => {
    const onChange = vi.fn();
    const { container } = render(<ConditionsField value={null} onChange={onChange} platform="ios" />);
    fireEvent.click(container.querySelector("[data-qa-condition='text_size'] button")!);
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["Small", "Default", "Large", "Larger", "Largest"]);
    fireEvent.click(screen.getByRole("radio", { name: "Larger" }));
    expect(onChange).toHaveBeenLastCalledWith({ text_size: "larger" });
    fireEvent.click(container.querySelector("[data-qa-condition='network'] button")!);
    fireEvent.click(screen.getByRole("radio", { name: "Offline" }));
    expect(onChange).toHaveBeenLastCalledWith({ network: "offline" });
  });

  it("offers languages by their own names, with a sample of how the app reads", () => {
    const onChange = vi.fn();
    const { container } = render(<ConditionsField value={{ locale: "fr-FR" }} onChange={onChange} platform="web" />);
    expect(container.querySelector("[data-qa-condition='os']")).toBeNull(); // no OS on the web
    fireEvent.click(container.querySelector("[data-qa-condition='locale'] button")!);
    expect(container.querySelector(".qa-cv-sample")?.textContent).toContain("French (France)");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "kenya" } });
    fireEvent.click(screen.getByRole("radio", { name: "Swahili (Kenya)" }));
    expect(onChange).toHaveBeenLastCalledWith({ locale: "sw-KE" });
  });
});

describe("a physical phone", () => {
  it("greys out what it cannot take and says why", () => {
    const { container } = render(<ConditionsField value={{ locale: "fr-FR" }} onChange={vi.fn()} platform="ios" physical />);
    const tile = (k: string) => container.querySelector(`[data-qa-condition='${k}']`)!;
    expect(tile("text_size").className).toContain("is-off");
    expect(tile("text_size").textContent).toContain("Simulator or emulator only");
    expect(tile("text_size").querySelector("button")?.hasAttribute("disabled")).toBe(true);
    expect(tile("locale").className).not.toContain("is-off");
  });

  it("names what a phone cannot take, so Start can stop", async () => {
    const { unavailableWords } = await import("./conditions");
    expect(unavailableWords({ text_size: "larger", network: "offline", locale: "fr-FR" }, "ios", true))
      .toBe("A physical phone can't be set to a text size and network. Pick a simulator or an emulator on the Device tab, or clear them on Conditions.");
    expect(unavailableWords({ text_size: "larger" }, "android", true)).toBeNull();
    expect(unavailableWords({ network: "offline" }, "ios", false)).toBeNull();
  });
});

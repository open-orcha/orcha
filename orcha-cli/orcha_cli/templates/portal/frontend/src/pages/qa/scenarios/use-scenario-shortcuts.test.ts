// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScenarioShortcuts, type ScenarioShortcutHandlers } from "./use-scenario-shortcuts";

afterEach(cleanup);

function handlers(onEscape: ScenarioShortcutHandlers["onEscape"]): ScenarioShortcutHandlers {
  return { onNew: vi.fn(), onFitView: vi.fn(), onFocusSearch: vi.fn(), onEscape, onDelete: vi.fn(), onSelectAll: vi.fn() };
}

function pressEscape(target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("useScenarioShortcuts Escape (#189)", () => {
  it("consumes the Escape that closed the panel or opened its Save prompt", () => {
    // Not consumed, the browser's own Escape handling ran after this listener and cancelled the
    // "Save your changes?" dialog the same keystroke had just opened: Escape never asked.
    const onEscape = vi.fn(() => true);
    renderHook(() => useScenarioShortcuts(handlers(onEscape)));
    expect(pressEscape().defaultPrevented).toBe(true);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("also from the Name field, where the edit was typed", () => {
    renderHook(() => useScenarioShortcuts(handlers(() => true)));
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(pressEscape(input).defaultPrevented).toBe(true);
    input.remove();
  });

  it("leaves Escape alone when there was nothing to close", () => {
    renderHook(() => useScenarioShortcuts(handlers(() => false)));
    expect(pressEscape().defaultPrevented).toBe(false);
  });

  it("leaves Escape to an open dialog", () => {
    const onEscape = vi.fn(() => true);
    renderHook(() => useScenarioShortcuts(handlers(onEscape)));
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(pressEscape().defaultPrevented).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
    dialog.remove();
  });
});

/** The global shortcut: matching, hold-to-talk vs tap-to-toggle, auto-repeat. */
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_PREFS, normalizeVoicePrefs, readVoicePrefs, shortcutLabel, writeVoicePrefs } from "./prefs";
import { HOLD_MS, ShortcutTracker, matchShortcut, releasesShortcut, type KeyLike } from "./shortcut";

const k = (over: Partial<KeyLike>): KeyLike => ({ key: " ", code: "Space", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over });

describe("matchShortcut", () => {
  it("⌥Space (macOS sends a non-breaking space as the key)", () => {
    expect(matchShortcut(k({ altKey: true }), "alt+space")).toBe(true);
    expect(matchShortcut(k({ altKey: true, key: " " }), "alt+space")).toBe(true);
    expect(matchShortcut(k({}), "alt+space")).toBe(false);
    expect(matchShortcut(k({ altKey: true, metaKey: true }), "alt+space")).toBe(false);
  });
  it("⌃⇧Space and ⌃⌥D", () => {
    expect(matchShortcut(k({ ctrlKey: true, shiftKey: true }), "ctrl+shift+space")).toBe(true);
    expect(matchShortcut(k({ key: "∂", code: "KeyD", ctrlKey: true, altKey: true }), "ctrl+alt+d")).toBe(true);
  });
  it("never claims the existing portal keys (⌘K, /, c, Enter, ⌘↵, Esc)", () => {
    const keys: KeyLike[] = [
      k({ key: "k", code: "KeyK", metaKey: true }), k({ key: "/", code: "Slash" }), k({ key: "c", code: "KeyC" }),
      k({ key: "Enter", code: "Enter" }), k({ key: "Enter", code: "Enter", metaKey: true }), k({ key: "Escape", code: "Escape" }),
      k({}), k({ shiftKey: true }),
    ];
    for (const sc of ["alt+space", "ctrl+shift+space", "ctrl+alt+d"] as const) {
      for (const e of keys) expect(matchShortcut(e, sc)).toBe(false);
    }
  });
  it("release detection: the key or its modifier", () => {
    expect(releasesShortcut(k({ key: "Alt", code: "AltLeft" }), "alt+space")).toBe(true);
    expect(releasesShortcut(k({}), "alt+space")).toBe(true);
    expect(releasesShortcut(k({ key: "Shift", code: "ShiftLeft" }), "alt+space")).toBe(false);
  });
});

describe("ShortcutTracker", () => {
  it("tap = toggle: a quick press starts; release does nothing; the next press stops", () => {
    const t = new ShortcutTracker();
    expect(t.down(k({ altKey: true }), "alt+space", false, 1000)).toEqual({ type: "start", mode: "toggle" });
    expect(t.up(k({}), "alt+space", 1000 + HOLD_MS - 50)).toBeNull();
    expect(t.down(k({ altKey: true }), "alt+space", true, 5000)).toEqual({ type: "stop" });
  });
  it("hold = push-to-talk: releasing after the hold threshold stops", () => {
    const t = new ShortcutTracker();
    t.down(k({ altKey: true }), "alt+space", false, 0);
    expect(t.down(k({ altKey: true, repeat: true }), "alt+space", true, 200)).toEqual({ type: "hold" });
    expect(t.up(k({ key: "Alt", code: "AltLeft" }), "alt+space", 2400)).toEqual({ type: "stop" });
  });
  it("ignores unrelated keys", () => {
    const t = new ShortcutTracker();
    expect(t.down(k({ key: "a", code: "KeyA" }), "alt+space", false, 0)).toBeNull();
    expect(t.up(k({}), "alt+space", 900)).toBeNull();
  });
});

describe("voice prefs", () => {
  it("normalises junk and round-trips through localStorage", () => {
    expect(normalizeVoicePrefs({ engine: "warp", language: "xx", cleanup: "yes" })).toEqual(DEFAULT_VOICE_PREFS);
    writeVoicePrefs({ engine: "device", language: "fr", shortcut: "ctrl+alt+d" });
    expect(readVoicePrefs()).toMatchObject({ engine: "device", language: "fr", shortcut: "ctrl+alt+d" });
    localStorage.clear();
  });
  it("labels the shortcut per platform", () => {
    expect(shortcutLabel("alt+space", true)).toBe("⌥ Space");
    expect(shortcutLabel("alt+space", false)).toBe("Alt+Space");
  });
});

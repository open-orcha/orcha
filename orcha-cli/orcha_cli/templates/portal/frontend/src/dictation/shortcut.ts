/**
 * The global dictation shortcut: HOLD to talk (release to insert) or TAP to
 * toggle (tap again to insert). Default ⌥Space / Alt+Space — it clashes with
 * nothing in the portal (⌘K palette, / search, c create, ⌘↵ submit) or the
 * desktop app's menu (⌘N, ⌘T, ⌘⌥T, ⌃`, ⌘K, ⌘R, ⌘,, ⌘W). Esc cancels.
 */
import type { VoiceShortcut } from "./prefs";

/** A press held at least this long is push-to-talk; shorter is a toggle tap. */
export const HOLD_MS = 350;

export interface KeyLike {
  key: string;
  code?: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}

/** Pure: does this keydown match the configured shortcut? */
export function matchShortcut(e: KeyLike, sc: VoiceShortcut): boolean {
  const space = e.code === "Space" || e.key === " " || e.key === " " || e.key === "Spacebar";
  switch (sc) {
    case "alt+space":
      return space && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    case "ctrl+shift+space":
      return space && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
    case "ctrl+alt+d":
      return (e.code === "KeyD" || e.key.toLowerCase() === "d" || e.key === "∂") && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey;
  }
}

/** Is this keyup releasing part of the shortcut (its key or a modifier)? */
export function releasesShortcut(e: KeyLike, sc: VoiceShortcut): boolean {
  const k = e.key;
  if (k === "Alt" || k === "Control" || k === "Shift" || k === "Meta") {
    if (sc === "alt+space") return k === "Alt";
    if (sc === "ctrl+shift+space") return k === "Control" || k === "Shift";
    return k === "Control" || k === "Alt";
  }
  if (sc === "ctrl+alt+d") return e.code === "KeyD" || k.toLowerCase() === "d" || k === "∂";
  return e.code === "Space" || k === " " || k === " ";
}

export type ShortcutAction = { type: "start"; mode: "toggle" } | { type: "stop" } | { type: "hold" } | null;

/**
 * Pure tracker for the press/release dance. Feed it keydown/keyup and whether
 * a dictation is recording; it says what to do.
 */
export class ShortcutTracker {
  private pressedAt: number | null = null;
  private startedByPress = false;

  down(e: KeyLike, sc: VoiceShortcut, recording: boolean, now: number): ShortcutAction {
    if (!matchShortcut(e, sc)) return null;
    if (e.repeat) return { type: "hold" }; // swallow auto-repeat (no NBSP spam)
    if (recording) {
      this.pressedAt = null;
      this.startedByPress = false;
      return { type: "stop" };
    }
    this.pressedAt = now;
    this.startedByPress = true;
    return { type: "start", mode: "toggle" };
  }

  up(e: KeyLike, sc: VoiceShortcut, now: number): ShortcutAction {
    if (!this.startedByPress || this.pressedAt == null || !releasesShortcut(e, sc)) return null;
    const held = now - this.pressedAt;
    this.pressedAt = null;
    this.startedByPress = false;
    return held >= HOLD_MS ? { type: "stop" } : null;
  }
}

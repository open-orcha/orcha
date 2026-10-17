/**
 * <DictationProvider> — dictation for EVERY text field, mounted once at the
 * app root. No per-field wiring: it watches focus/hover, decides eligibility
 * from the DOM (dictation/target.ts), and renders
 *
 *   - a small mic button inside the field (bottom-right of a textarea,
 *     right edge of an input) while it is hovered or focused;
 *   - the HUD under the field while dictating: live waveform, the words as
 *     ghost text that settles, elapsed time, Stop, and "esc to cancel";
 *   - a done chip (Undo · Use original) after the text lands.
 *
 * The global shortcut (default ⌥Space) dictates into the focused field: hold
 * for push-to-talk, tap to toggle. Esc cancels without inserting anything.
 * Enter / ⌘↵ are never touched.
 *
 * Fields that render their own mic (the Composer toolbars) carry
 * `data-dictation-inline` and get no floating button; they call `useDictation()`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { startCapture } from "./audio";
import { DictationController, INITIAL_STATE, WAVE_BARS, type ControllerDeps, type DictationState } from "./controller";
import { deviceSupported, startEngine } from "./engines";
import { VOICE_PREFS_EVENT, readVoicePrefs, shortcutLabel, type VoicePrefs } from "./prefs";
import { ShortcutTracker } from "./shortcut";
import { isDictationTarget, type DictationTarget } from "./target";
import "./dictation.css";

export interface DictationApi {
  controller: DictationController;
  /** start (or stop, when this field is already dictating) */
  toggle: (el: DictationTarget | null) => void;
  prefs: VoicePrefs;
}

const Ctx = createContext<DictationApi | null>(null);

/** The dictation API, or null outside a provider (tests, isolated renders). */
export function useDictationApi(): DictationApi | null {
  return useContext(Ctx);
}

/** Live dictation state (re-renders on every change). */
export function useDictationState(c: DictationController | null): DictationState {
  return useSyncExternalStore(
    (cb) => (c ? c.subscribe(cb) : () => undefined),
    () => (c ? c.getState() : INITIAL_STATE),
    () => INITIAL_STATE,
  );
}

/**
 * Hook for a component that owns a field: `{ state, active, toggle }` for that
 * field. Returns null outside a provider so callers can render nothing.
 */
export function useDictation(getEl: () => DictationTarget | null) {
  const api = useDictationApi();
  const state = useDictationState(api?.controller ?? null);
  if (!api) return null;
  const el = getEl();
  const mine = !!el && api.controller.getTarget() === el && state.phase !== "idle";
  return {
    state,
    active: mine && (state.phase === "starting" || state.phase === "listening"),
    busy: mine && (state.phase === "transcribing" || state.phase === "cleaning"),
    toggle: () => api.toggle(getEl()),
    shortcut: shortcutLabel(api.prefs.shortcut),
  };
}

function usePrefs(): VoicePrefs {
  const [p, setP] = useState<VoicePrefs>(() => readVoicePrefs());
  useEffect(() => {
    const on = () => setP(readVoicePrefs());
    window.addEventListener(VOICE_PREFS_EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(VOICE_PREFS_EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  return p;
}

export function MicGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7.25" y="2.75" width="5.5" height="9.5" rx="2.75" />
      <path d="M4.75 9.5a5.25 5.25 0 0 0 10.5 0M10 14.75v2.5" />
    </svg>
  );
}

function StopSquare() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.6" fill="currentColor" /></svg>
  );
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Waveform({ levels, live }: { levels: number[]; live: boolean }) {
  const bars = Array.from({ length: WAVE_BARS }, (_, i) => levels[levels.length - WAVE_BARS + i] ?? 0);
  return (
    <span className={"dict-wave" + (live ? " is-live" : "")} aria-hidden="true">
      {bars.map((l, i) => (
        <span key={i} className="dict-bar" style={{ transform: `scaleY(${0.12 + Math.min(1, l) * 0.88})` }} />
      ))}
    </span>
  );
}

type Rect = { top: number; left: number; width: number; height: number; bottom: number; right: number };
const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
};

/** Follow an element's box while it is shown (scroll, resize, layout shifts). */
function useTrackedRect(el: Element | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!el) { setRect(null); return; }
    let raf = 0;
    let last = "";
    const loop = () => {
      if (!el.isConnected) { setRect(null); return; }
      const r = rectOf(el);
      const k = `${r.top}|${r.left}|${r.width}|${r.height}`;
      if (k !== last) { last = k; setRect(r); }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [el]);
  return rect;
}

const SETTINGS_HREF = "/settings#tab=voice";

/** What a host app must supply: how to read engine status and run the clean-up (the
 *  portal calls its own API; the desktop app calls a running project's portal). Tests may
 *  also replace the microphone and engine. */
export type DictationHostDeps = Pick<ControllerDeps, "getStatus" | "cleanup"> & Partial<ControllerDeps>;

export function DictationProvider({ cid, children, deps, settingsHref = SETTINGS_HREF, onOpenSettings }: {
  cid: string | null;
  children: ReactNode;
  deps: DictationHostDeps;
  /** where "Open Settings › Voice" goes (a link) … */
  settingsHref?: string;
  /** … or what it does (the desktop app opens the project's portal) */
  onOpenSettings?: () => void;
}) {
  const prefs = usePrefs();
  const cidRef = useRef(cid);
  cidRef.current = cid;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  // deps may change (the desktop app's running project); the controller always reads the latest
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const controller = useMemo(
    () =>
      new DictationController({
        getCid: () => (depsRef.current.getCid ? depsRef.current.getCid() : cidRef.current),
        getBaseUrl: () => depsRef.current.getBaseUrl?.(),
        getPrefs: () => (depsRef.current.getPrefs ? depsRef.current.getPrefs() : prefsRef.current),
        getStatus: (c) => depsRef.current.getStatus(c),
        cleanup: (c, t, single, lang) => depsRef.current.cleanup(c, t, single, lang),
        startCapture: (o) => (depsRef.current.startCapture || startCapture)(o),
        startEngine: (k, o) => (depsRef.current.startEngine || startEngine)(k, o),
        deviceSupported: () => (depsRef.current.deviceSupported || deviceSupported)(),
        noEngineMessage: () => depsRef.current.noEngineMessage?.(),
        now: deps.now,
        doneMs: deps.doneMs,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one controller per mount
    [],
  );
  const state = useDictationState(controller);
  const [focused, setFocused] = useState<DictationTarget | null>(null);
  const [hovered, setHovered] = useState<DictationTarget | null>(null);
  const lastField = useRef<DictationTarget | null>(null);
  const tracker = useRef(new ShortcutTracker());
  const [hint, setHint] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);

  const toggle = useCallback((el: DictationTarget | null) => {
    if (controller.isRecording()) {
      void controller.stop();
      return;
    }
    if (controller.isActive()) return;
    if (!el || !isDictationTarget(el)) {
      setHint("Click into a text field first, then press " + shortcutLabel(prefsRef.current.shortcut) + ".");
      window.setTimeout(() => setHint(null), 2600);
      return;
    }
    void controller.start(el, "toggle");
  }, [controller]);

  // focus + hover tracking (document-level: every field, present and future)
  useEffect(() => {
    if (prefs.engine === "off") { setFocused(null); setHovered(null); return; }
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Element | null;
      if (isDictationTarget(t)) { setFocused(t); lastField.current = t; }
      else if (!(t as HTMLElement | null)?.closest?.(".dict-ui")) setFocused(null);
    };
    const onOver = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (isDictationTarget(t)) setHovered(t);
      else if (!(t as HTMLElement | null)?.closest?.(".dict-ui")) setHovered(null);
    };
    // the floating mic steps aside while you type (it sits over the field's edge)
    let typingTimer = 0;
    const onTyping = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || !isDictationTarget(e.target as Element)) return;
      setTyping(true);
      window.clearTimeout(typingTimer);
      typingTimer = window.setTimeout(() => setTyping(false), 1200);
    };
    const onMove = () => { window.clearTimeout(typingTimer); setTyping(false); };
    document.addEventListener("keydown", onTyping);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerover", onOver);
    const a = document.activeElement;
    if (isDictationTarget(a)) setFocused(a);
    return () => {
      window.clearTimeout(typingTimer);
      document.removeEventListener("keydown", onTyping);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerover", onOver);
    };
  }, [prefs.engine]);

  // the global shortcut + Esc (capture phase: runs before dialogs/pages)
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && controller.isActive()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        controller.cancel();
        return;
      }
      if (prefsRef.current.engine === "off") return;
      // terminals and code editors keep every key (they may bind ⌥Space themselves)
      const t = e.target as HTMLElement | null;
      if (!controller.isRecording() && t?.closest?.(".xterm, .cm-editor")) return;
      const act = tracker.current.down(e, prefsRef.current.shortcut, controller.isRecording(), Date.now());
      if (!act) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (act.type === "stop") void controller.stop();
      else if (act.type === "hold") controller.setMode("hold");
      else if (act.type === "start") {
        const a = document.activeElement;
        const el = isDictationTarget(a) ? a : lastField.current && lastField.current.isConnected ? lastField.current : null;
        toggle(el);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const act = tracker.current.up(e, prefsRef.current.shortcut, Date.now());
      if (act?.type === "stop") void controller.stop();
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [controller, toggle]);

  // Push-to-talk whose key-up never arrives (the window lost focus mid-hold): finish it
  // rather than leave the mic open. Unmount cancels.
  useEffect(() => {
    const onBlur = () => { if (controller.isRecording() && controller.getState().mode === "hold") void controller.stop(); };
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("blur", onBlur); controller.cancel(); };
  }, [controller]);

  const api = useMemo<DictationApi>(() => ({ controller, toggle, prefs }), [controller, toggle, prefs]);
  const activeTarget = state.phase !== "idle" ? controller.getTarget() : null;
  const buttonFor = activeTarget || focused || hovered;
  const showButton = !!buttonFor && prefs.engine !== "off" && !buttonFor.hasAttribute("data-dictation-inline") && buttonFor.isConnected && (!typing || !!activeTarget);

  return (
    <Ctx.Provider value={api}>
      {children}
      {typeof document !== "undefined"
        ? createPortal(
            <>
              {showButton ? <FieldMic el={buttonFor!} state={state} active={!!activeTarget && activeTarget === buttonFor} onToggle={() => toggle(buttonFor)} shortcut={shortcutLabel(prefs.shortcut)} /> : null}
              {state.phase !== "idle" && activeTarget ? <Hud el={activeTarget} state={state} controller={controller} settingsHref={settingsHref} onOpenSettings={onOpenSettings} /> : null}
              {hint ? <div className="dict-ui dict-hint" role="status">{hint}</div> : null}
            </>,
            document.body,
          )
        : null}
    </Ctx.Provider>
  );
}

function FieldMic({ el, state, active, onToggle, shortcut }: { el: DictationTarget; state: DictationState; active: boolean; onToggle: () => void; shortcut: string }) {
  const rect = useTrackedRect(el);
  if (!rect || rect.width < 60) return null;
  const multi = el.tagName !== "INPUT";
  const size = 24;
  const top = multi ? rect.bottom - size - 6 : rect.top + (rect.height - size) / 2;
  const left = rect.right - size - 6;
  const recording = active && (state.phase === "starting" || state.phase === "listening");
  const label = recording ? "Stop dictation" : `Dictate (${shortcut})`;
  return (
    <button
      type="button"
      className={"dict-ui dict-mic" + (recording ? " is-rec" : "") + (active && !recording ? " is-busy" : "")}
      style={{ top, left }}
      aria-label={label}
      title={label}
      aria-pressed={recording}
      data-testid="dictation-mic"
      onMouseDown={(e) => e.preventDefault() /* keep the caret where it is */}
      onClick={onToggle}
    >
      {recording ? <StopSquare /> : <MicGlyph size={14} />}
    </button>
  );
}

function Hud({ el, state, controller, settingsHref, onOpenSettings }: { el: DictationTarget; state: DictationState; controller: DictationController; settingsHref: string; onOpenSettings?: () => void }) {
  const rect = useTrackedRect(el);
  if (!rect) return null;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const width = Math.min(Math.max(rect.width, 340), 560, vw - 16);
  const left = Math.max(8, Math.min(rect.left, vw - width - 8));
  const below = rect.bottom + 8;
  const placeAbove = below + 96 > vh && rect.top > 120;
  const style = placeAbove ? { left, width, bottom: vh - rect.top + 8 } : { left, width, top: below };
  const recording = state.phase === "starting" || state.phase === "listening";
  const working = state.phase === "transcribing" || state.phase === "cleaning";

  let status: ReactNode;
  if (state.phase === "error") status = <span className="dict-err">{state.error}</span>;
  else if (state.phase === "done") status = <span className="dict-done-t">{state.cleaned ? "Cleaned up and inserted" : "Inserted"}</span>;
  else if (state.phase === "cleaning") status = <span className="dict-muted">Tidying punctuation…</span>;
  else if (state.phase === "transcribing") status = <span className="dict-muted">Finishing…</span>;
  else if (state.progress) status = <span className="dict-muted">{state.progress.label}{state.progress.fraction != null ? ` · ${Math.round(state.progress.fraction * 100)}%` : "…"}</span>;
  else if (state.phase === "starting") status = <span className="dict-muted">{state.engine === "cloud" ? "Connecting…" : "Starting the microphone…"}</span>;
  else status = <span className="dict-muted">Listening{state.targetLabel ? ` · ${state.targetLabel}` : ""}</span>;

  const hasText = !!(state.final || state.interim);
  return (
    <div className={"dict-ui dict-hud is-" + state.phase} style={style} role="group" aria-label="Dictation">
      <div className="dict-hud-row">
        {state.phase === "error" ? (
          <span className="dict-ico-err" aria-hidden="true">!</span>
        ) : state.phase === "done" ? (
          <span className="dict-ico-ok" aria-hidden="true">✓</span>
        ) : (
          <Waveform levels={state.levels} live={recording} />
        )}
        <span className="dict-status" role="status" aria-live="polite">{status}</span>
        {recording || working ? <span className="dict-time tnum">{formatElapsed(state.elapsedMs)}</span> : null}
        <span className="dict-actions">
          {recording ? (
            <>
              <button type="button" className="dict-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => void controller.stop()}>Done</button>
              <kbd className="dict-kbd" title="Cancel without inserting">esc</kbd>
            </>
          ) : null}
          {working ? <button type="button" className="dict-btn ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => controller.cancel()}>Cancel</button> : null}
          {state.phase === "done" ? (
            <>
              {state.cleaned ? <button type="button" className="dict-btn ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => controller.useOriginal()}>Use original</button> : null}
              <button type="button" className="dict-btn ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => controller.undo()}>Undo</button>
            </>
          ) : null}
          {state.phase === "error" ? (
            <>
              {state.errorSettings ? (
                onOpenSettings
                  ? <button type="button" className="dict-btn" onClick={() => { controller.reset(); onOpenSettings(); }}>Open Settings › Voice</button>
                  : <a className="dict-btn" href={settingsHref}>Open Settings › Voice</a>
              ) : null}
              <button type="button" className="dict-btn ghost" aria-label="Dismiss" onClick={() => controller.reset()}>Dismiss</button>
            </>
          ) : null}
        </span>
      </div>
      {(recording || working) && hasText ? (
        <div className="dict-text" aria-hidden="true">
          {state.final ? <span className="dict-final">{state.final} </span> : null}
          {state.interim ? <span className="dict-interim">{state.interim}</span> : null}
          {recording ? <span className="dict-caret" /> : null}
        </div>
      ) : null}
      {state.phase === "done" && state.notice ? <div className="dict-note">{state.notice}</div> : null}
    </div>
  );
}

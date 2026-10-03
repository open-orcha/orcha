/**
 * The dictation state machine — framework-free so it is unit-testable with
 * fakes for the microphone, the engine and the clean-up call.
 *
 *   idle ─start→ starting ─(mic + engine)→ listening ─stop→ transcribing
 *     ↑                                                        │
 *     │                         (clean-up on) cleaning ←───────┤ insert raw text
 *     └──── done (chip: Undo / Use original) ←─────────────────┘
 *   any ─cancel / Esc→ idle (nothing inserted)     any ─failure→ error
 *
 * The raw words go into the field the moment the engine settles (fast), then
 * the optional clean-up swaps that span for the tidied text — native undo
 * steps back to the raw words, and "Use original" / "Undo" are one click.
 */
import { MicError, classifyMicError, type Capture, type CaptureOptions } from "./audio";
import { EngineError, NO_ENGINE_MESSAGE, deviceSupported as defaultDeviceSupported, pickEngine, type EngineKind, type EngineSession, type EngineStartOptions, type VoiceStatus } from "./engines";
import type { VoicePrefs } from "./prefs";
import { insertAt, isSingleLine, readSelection, replaceInserted, targetLabel, undoInsert, type DictationTarget, type InsertRecord, type Selection } from "./target";

export type DictationPhase = "idle" | "starting" | "listening" | "transcribing" | "cleaning" | "done" | "error";
export type DictationMode = "toggle" | "hold";

export interface DictationState {
  phase: DictationPhase;
  mode: DictationMode;
  final: string;
  interim: string;
  level: number;
  /** recent levels for the waveform (newest last) */
  levels: number[];
  startedAt: number | null;
  elapsedMs: number;
  engine: EngineKind | null;
  provider: string | null;
  progress: { label: string; fraction: number | null } | null;
  notice: string | null;
  error: string | null;
  /** the error needs the Settings › Voice link */
  errorSettings: boolean;
  targetLabel: string;
  /** after insert: whether the clean-up changed the words (enables "Use original") */
  cleaned: boolean;
  inserted: string;
}

export const INITIAL_STATE: DictationState = {
  phase: "idle", mode: "toggle", final: "", interim: "", level: 0, levels: [], startedAt: null, elapsedMs: 0,
  engine: null, provider: null, progress: null, notice: null, error: null, errorSettings: false,
  targetLabel: "", cleaned: false, inserted: "",
};

export const WAVE_BARS = 28;

export interface ControllerDeps {
  /** the project to dictate against (may resolve asynchronously, e.g. the desktop app) */
  getCid: () => string | null | Promise<string | null>;
  /** the portal origin when this page isn't served by it (desktop app) */
  getBaseUrl?: () => string | undefined;
  getPrefs: () => VoicePrefs;
  getStatus: (cid: string) => Promise<VoiceStatus | null>;
  startCapture: (o: CaptureOptions) => Promise<Capture>;
  startEngine: (kind: EngineKind, o: EngineStartOptions) => EngineSession;
  cleanup: (cid: string, text: string, singleLine: boolean, language: string) => Promise<string>;
  deviceSupported?: () => boolean;
  /** host-specific wording when no engine is available (the desktop app) */
  noEngineMessage?: () => string | undefined;
  now?: () => number;
  /** how long the done chip lingers before returning to idle */
  doneMs?: number;
}

export class DictationController {
  private state: DictationState = INITIAL_STATE;
  private listeners = new Set<(s: DictationState) => void>();
  private capture: Capture | null = null;
  private session: EngineSession | null = null;
  private target: DictationTarget | null = null;
  private sel: Selection | null = null;
  private record: InsertRecord | null = null;
  private raw = "";
  private gen = 0;
  private tick: ReturnType<typeof setInterval> | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRequested = false;
  private cid: string | null = null;

  constructor(private deps: ControllerDeps) {}

  getState(): DictationState {
    return this.state;
  }
  getTarget(): DictationTarget | null {
    return this.target;
  }
  subscribe(fn: (s: DictationState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  isActive(): boolean {
    return this.state.phase === "starting" || this.state.phase === "listening" || this.state.phase === "transcribing" || this.state.phase === "cleaning";
  }
  isRecording(): boolean {
    return this.state.phase === "starting" || this.state.phase === "listening";
  }

  setMode(mode: DictationMode): void {
    if (this.isRecording() && this.state.mode !== mode) this.set({ mode });
  }

  private set(patch: Partial<DictationState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }
  private now(): number {
    return (this.deps.now || Date.now)();
  }
  private clearTimers(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.doneTimer = null;
  }
  private teardownAudio(): void {
    try { this.capture?.stop(); } catch { /* already stopped */ }
    this.capture = null;
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  async start(target: DictationTarget, mode: DictationMode = "toggle"): Promise<void> {
    if (this.isActive()) return;
    this.clearTimers();
    const gen = ++this.gen;
    this.target = target;
    this.sel = readSelection(target);
    this.record = null;
    this.raw = "";
    this.stopRequested = false;
    this.set({ ...INITIAL_STATE, phase: "starting", mode, startedAt: this.now(), targetLabel: targetLabel(target) });
    let cid: string | null = null;
    try { cid = await this.deps.getCid(); } catch { cid = null; }
    if (gen !== this.gen) return;
    this.cid = cid;
    const prefs = this.deps.getPrefs();
    let status: VoiceStatus | null = null;
    if (cid && prefs.engine !== "device" && prefs.engine !== "off") {
      try { status = await this.deps.getStatus(cid); } catch { status = null; }
    }
    if (gen !== this.gen) return;
    const pick = pickEngine(prefs, status, (this.deps.deviceSupported || defaultDeviceSupported)());
    if (!pick.engine || (pick.engine === "cloud" && !cid)) {
      const reason = pick.reason || NO_ENGINE_MESSAGE;
      this.fail(reason === NO_ENGINE_MESSAGE ? this.deps.noEngineMessage?.() || reason : reason, true);
      return;
    }
    const engine = pick.engine;
    let session: EngineSession | null = null;
    const pending: Float32Array[] = [];
    try {
      const capture = await this.deps.startCapture({
        onFrame: (f) => { if (session) session.push(f); else pending.push(f); },
        onLevel: (l) => this.onLevel(l),
      });
      if (gen !== this.gen) { capture.stop(); return; }
      this.capture = capture;
      session = this.deps.startEngine(engine, {
        cid: cid || "",
        baseUrl: this.deps.getBaseUrl?.(),
        captureRate: capture.sampleRate,
        prefs,
        onTranscript: (t) => { if (gen === this.gen) this.set({ final: t.final, interim: t.interim }); },
        onProgress: (label, fraction) => { if (gen === this.gen) this.set({ progress: fraction === 1 ? null : { label, fraction } }); },
        onReady: (info) => { if (gen === this.gen) this.set({ phase: this.state.phase === "starting" ? "listening" : this.state.phase, provider: info.provider || null }); },
        onNotice: (msg) => { if (gen === this.gen) { this.set({ notice: msg }); void this.stop(); } },
        onError: (e) => { if (gen === this.gen) this.fail(e.message, e.code === "unavailable" || /Settings › Voice/.test(e.message)); },
      });
      this.session = session;
      pending.splice(0).forEach((f) => session!.push(f));
      this.set({ engine, phase: engine === "device" ? "listening" : this.state.phase });
      this.tick = setInterval(() => {
        if (this.state.startedAt != null && this.isRecording()) this.set({ elapsedMs: this.now() - this.state.startedAt });
      }, 200);
      if (this.stopRequested) void this.stop();
    } catch (e) {
      if (gen !== this.gen) return;
      const m = e instanceof MicError ? e : classifyMicError(e);
      this.teardownAudio();
      this.fail(m.message, false);
    }
  }

  private onLevel(level: number): void {
    const levels = this.state.levels.length >= WAVE_BARS ? this.state.levels.slice(1) : this.state.levels.slice();
    levels.push(level);
    this.set({ level, levels });
  }

  async stop(): Promise<void> {
    if (this.state.phase === "starting" && !this.session) {
      this.stopRequested = true; // mic still opening: stop as soon as it is
      return;
    }
    if (!this.isRecording() || !this.session) return;
    const gen = this.gen;
    const session = this.session;
    this.teardownAudio();
    this.set({ phase: "transcribing", level: 0 });
    let text = "";
    try {
      text = (await session.stop()).trim();
    } catch (e) {
      if (gen !== this.gen) return;
      this.fail(e instanceof EngineError ? e.message : "Transcription failed.", e instanceof EngineError && /Settings › Voice/.test(e.message));
      return;
    }
    if (gen !== this.gen) return;
    this.session = null;
    if (!text) {
      this.set({ phase: "error", error: "Didn't catch anything — try again a little closer to the mic.", errorSettings: false });
      this.scheduleIdle(3200);
      return;
    }
    const target = this.target;
    if (!target || !target.isConnected) {
      this.fail("The field closed before the text arrived. It's copied to your clipboard.", false);
      try { void navigator.clipboard?.writeText(text); } catch { /* no clipboard */ }
      return;
    }
    this.raw = text;
    this.record = insertAt(target, text, this.sel || undefined);
    // what "Use original" puts back: the raw words exactly as they first landed
    if (this.record) this.raw = this.record.inserted.trim();
    this.set({ final: text, interim: "", inserted: this.record?.inserted || "" });
    const prefs = this.deps.getPrefs();
    const cid = this.cid;
    let status: VoiceStatus | null = null;
    if (prefs.cleanup && cid && this.record) {
      try { status = await this.deps.getStatus(cid); } catch { status = null; }
    }
    if (gen !== this.gen) return;
    if (prefs.cleanup && cid && this.record && status?.cleanup_available && text.split(/\s+/).length >= 3) {
      this.set({ phase: "cleaning" });
      try {
        const cleaned = (await this.deps.cleanup(cid, text, isSingleLine(target), prefs.language)).trim();
        if (gen !== this.gen) return;
        if (cleaned && cleaned !== text && this.record) {
          const next = replaceInserted(this.record, cleaned);
          if (next) {
            this.record = next;
            this.set({ cleaned: true, inserted: next.inserted });
          }
        }
      } catch {
        /* clean-up is best effort: the raw words are already in the field */
      }
      if (gen !== this.gen) return;
    }
    this.set({ phase: "done" });
    this.scheduleIdle(this.deps.doneMs ?? 6000);
  }

  private scheduleIdle(ms: number): void {
    if (this.doneTimer) clearTimeout(this.doneTimer);
    const gen = this.gen;
    this.doneTimer = setTimeout(() => { if (gen === this.gen) this.reset(); }, ms);
  }

  /** Esc: drop everything, insert nothing. */
  cancel(): void {
    if (this.state.phase === "idle") return;
    this.gen++;
    try { this.session?.cancel(); } catch { /* gone */ }
    this.session = null;
    this.teardownAudio();
    this.clearTimers();
    const t = this.target;
    this.set({ ...INITIAL_STATE });
    try { (t as HTMLElement | null)?.focus(); } catch { /* detached */ }
  }

  /** Put the field back exactly as it was before this dictation. */
  undo(): void {
    if (this.record) undoInsert(this.record);
    this.record = null;
    this.reset();
  }

  /** Swap the cleaned-up text back to the raw words. */
  useOriginal(): void {
    if (this.record && this.raw && this.state.cleaned) {
      const next = replaceInserted(this.record, this.raw);
      if (next) this.record = next;
    }
    this.set({ cleaned: false });
    this.scheduleIdle(2500);
  }

  reset(): void {
    this.gen++;
    this.clearTimers();
    this.set({ ...INITIAL_STATE });
  }

  private fail(message: string, settings: boolean): void {
    try { this.session?.cancel(); } catch { /* gone */ }
    this.session = null;
    this.teardownAudio();
    this.set({ phase: "error", error: message, errorSettings: settings, level: 0 });
    this.scheduleIdle(9000);
  }
}

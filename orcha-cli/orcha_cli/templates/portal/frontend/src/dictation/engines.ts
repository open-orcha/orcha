/**
 * Dictation engines — one interface, pluggable backends.
 *
 *   cloud   the browser streams PCM over a WebSocket to the portal, which
 *           proxies to the project's speech provider (OpenAI realtime,
 *           Deepgram, Groq). The provider key never reaches the browser.
 *           If the socket can't open (an old proxy without WebSocket support)
 *           the session falls back to recording + one REST transcription.
 *   device  on-device recognition in the browser: transformers.js (Apache-2.0)
 *           running Moonshine (English, fastest) or Whisper (multilingual) on
 *           WebGPU, WASM otherwise, in a Web Worker. The model downloads once
 *           (cached by the browser) with progress; audio never leaves the machine.
 *
 * A session receives raw mic frames (`push`) at the capture rate and reports
 * text as `{final, interim}`; `stop()` resolves with the whole dictation.
 */
import { Resampler, encodeWav, floatToPcm16, rms } from "./audio";
import type { DeviceModel, VoicePrefs } from "./prefs";

export interface Transcript {
  final: string;
  interim: string;
}

export interface EngineCallbacks {
  onTranscript: (t: Transcript) => void;
  /** model download / warm-up progress (0..1, or null when unknown) */
  onProgress?: (label: string, fraction: number | null) => void;
  /** the engine is ready for audio (the HUD flips from "Connecting…" to "Listening") */
  onReady?: (info: { engine: "cloud" | "device"; provider?: string }) => void;
  /** a non-fatal notice (e.g. hit the max duration) */
  onNotice?: (msg: string) => void;
  /** a fatal error while still recording (e.g. no provider) — the session is over */
  onError?: (e: EngineError) => void;
}

export interface EngineSession {
  push(frame: Float32Array): void;
  stop(): Promise<string>;
  cancel(): void;
}

export interface EngineStartOptions extends EngineCallbacks {
  cid: string;
  captureRate: number;
  prefs: VoicePrefs;
  /** Portal origin when the page isn't served by it (the desktop app): "http://localhost:8123". */
  baseUrl?: string;
  /** test seams */
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
}

export type EngineKind = "cloud" | "device";

export interface VoiceStatus {
  providers: { provider: string; name: string; configured: boolean; streaming: boolean; masked?: string | null; source?: string | null; model?: string; note?: string }[];
  default_provider: string | null;
  cloud_available: boolean;
  cleanup_available: boolean;
  max_seconds: number;
}

export class EngineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const NO_ENGINE_MESSAGE = "Dictation isn't set up yet. Add a speech provider key or turn on on-device dictation in Settings › Voice.";

/** Pure: which engine a dictation should use, or null (with the reason). */
export function pickEngine(prefs: VoicePrefs, status: VoiceStatus | null, deviceSupported: boolean): { engine: EngineKind | null; reason?: string } {
  if (prefs.engine === "off") return { engine: null, reason: "Dictation is turned off in Settings › Voice." };
  const cloudOk = !!status?.cloud_available && (prefs.provider === "auto" || !!status.providers.find((p) => p.provider === prefs.provider && p.configured));
  if (prefs.engine === "cloud") return cloudOk ? { engine: "cloud" } : { engine: null, reason: "No speech provider key is set up for this project. Add one in Settings › Voice." };
  if (prefs.engine === "device") return deviceSupported ? { engine: "device" } : { engine: null, reason: "This browser can't run on-device dictation (it needs WebAssembly and Web Workers)." };
  if (cloudOk) return { engine: "cloud" };
  if (deviceSupported) return { engine: "device" };
  return { engine: null, reason: NO_ENGINE_MESSAGE };
}

export function deviceSupported(): boolean {
  return typeof Worker !== "undefined" && typeof WebAssembly !== "undefined" && typeof Blob !== "undefined";
}

const join = (...xs: string[]) => xs.map((x) => x.trim()).filter(Boolean).join(" ");

/* ------------------------------------------------------------------ cloud */

export function streamUrl(cid: string, prefs: VoicePrefs, loc: Pick<Location, "protocol" | "host"> = window.location, baseUrl?: string): string {
  const where = baseUrl ? new URL(baseUrl) : loc;
  const proto = where.protocol === "https:" ? "wss:" : "ws:";
  const q = new URLSearchParams({ provider: prefs.provider, language: prefs.language });
  return `${proto}//${where.host}/api/containers/${encodeURIComponent(cid)}/voice/stream?${q.toString()}`;
}

export function startCloudSession(o: EngineStartOptions): EngineSession {
  const WS = o.WebSocketImpl || WebSocket;
  const doFetch = o.fetchImpl || fetch.bind(window);
  let ws: WebSocket | null = null;
  let ready = false;
  let rate = 24000;
  let resampler: Resampler | null = null;
  const pending: Float32Array[] = [];
  // 16 kHz copy for the REST fallback, kept only until the socket proves itself.
  const backupResampler = new Resampler(o.captureRate, 16000);
  let backup: Int16Array[] | null = [];
  let fallback = false;
  let state: Transcript = { final: "", interim: "" };
  let finished: ((text: string) => void) | null = null;
  let failed: ((e: Error) => void) | null = null;
  let done = false;
  let cancelled = false;
  let lastError: EngineError | null = null;

  const finishWith = (text: string) => {
    if (done) return;
    done = true;
    finished?.(text);
  };
  const failWith = (e: EngineError) => {
    if (done || lastError) return;
    lastError = e;
    if (finished || failed) {
      done = true;
      failed?.(e);
    } else {
      o.onError?.(e);
    }
  };

  const sendFrame = (f: Float32Array) => {
    if (!ws || ws.readyState !== 1 || !resampler) return;
    const pcm = floatToPcm16(resampler.push(f));
    if (pcm.length) ws.send(pcm.buffer as ArrayBuffer);
  };

  try {
    ws = new WS(streamUrl(o.cid, o.prefs, window.location, o.baseUrl));
    ws.binaryType = "arraybuffer";
  } catch {
    fallback = true;
  }
  if (ws) {
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let m: { type?: string; [k: string]: unknown };
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "ready") {
        ready = true;
        backup = null; // the socket works: drop the fallback copy
        rate = Number(m.sample_rate) || 24000;
        resampler = new Resampler(o.captureRate, rate);
        o.onReady?.({ engine: "cloud", provider: String(m.provider || "") });
        pending.splice(0).forEach(sendFrame);
      } else if (m.type === "transcript") {
        state = { final: String(m.final || ""), interim: String(m.interim || "") };
        o.onTranscript(state);
      } else if (m.type === "done") {
        state = { final: String(m.text || ""), interim: "" };
        o.onTranscript(state);
        finishWith(state.final);
      } else if (m.type === "limit") {
        o.onNotice?.(String(m.message || "Reached the maximum dictation length."));
      } else if (m.type === "error") {
        failWith(new EngineError(String(m.code || "error"), String(m.message || "Dictation failed.")));
      }
    };
    ws.onerror = () => {
      if (!ready && !cancelled) fallback = true;
    };
    ws.onclose = (ev: CloseEvent) => {
      if (cancelled || done) return;
      if (!ready && !lastError) {
        fallback = true;
        if (finished) void runFallback();
        return;
      }
      if (lastError) failWith(lastError);
      else if (ev.code !== 1000) failWith(new EngineError("closed", "The connection to the speech service dropped."));
      else finishWith(join(state.final, state.interim));
    };
  }

  async function runFallback(): Promise<void> {
    if (!backup || !backup.length) {
      finishWith("");
      return;
    }
    const total = backup.reduce((n, b) => n + b.length, 0);
    const pcm = new Int16Array(total);
    let off = 0;
    for (const b of backup) { pcm.set(b, off); off += b.length; }
    backup = null;
    try {
      const q = new URLSearchParams({ provider: o.prefs.provider, language: o.prefs.language });
      const r = await doFetch(`${o.baseUrl || ""}/api/containers/${encodeURIComponent(o.cid)}/voice/transcribe?${q}`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: encodeWav(pcm, 16000),
      });
      const d = (await r.json().catch(() => ({}))) as { text?: string; detail?: unknown };
      if (!r.ok) throw new EngineError("http_" + r.status, typeof d.detail === "string" ? d.detail : "Transcription failed.");
      finishWith(d.text || "");
    } catch (e) {
      failWith(e instanceof EngineError ? e : new EngineError("network", "Couldn't reach the portal to transcribe."));
    }
  }

  return {
    push(frame) {
      if (backup) backup.push(floatToPcm16(backupResampler.push(frame)));
      if (ready) sendFrame(frame);
      else if (!fallback) pending.push(frame);
    },
    stop() {
      return new Promise<string>((resolve, reject) => {
        finished = resolve;
        failed = reject;
        if (lastError) { done = true; reject(lastError); return; }
        if (fallback && !ready) { void runFallback(); return; }
        if (ws && ws.readyState === 1 && ready) {
          ws.send(JSON.stringify({ type: "stop" }));
          return;
        }
        if (ws && ws.readyState === 0) return; // still connecting: onclose/onmessage decide
        void runFallback();
      });
    },
    cancel() {
      cancelled = true;
      done = true;
      backup = null;
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "cancel" }));
        ws?.close(1000);
      } catch { /* already closed */ }
    },
  };
}

/* ------------------------------------------------------------------ device */

export const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";

export const DEVICE_MODELS: Record<Exclude<DeviceModel, "auto">, { id: string; label: string; size: string; multilingual: boolean }> = {
  moonshine: { id: "onnx-community/moonshine-base-ONNX", label: "Moonshine Base (English, fastest)", size: "≈ 60 MB", multilingual: false },
  whisper: { id: "onnx-community/whisper-base", label: "Whisper Base (99 languages)", size: "≈ 80 MB", multilingual: true },
};

export function resolveDeviceModel(prefs: VoicePrefs): Exclude<DeviceModel, "auto"> {
  if (prefs.deviceModel !== "auto") return prefs.deviceModel;
  return prefs.language === "" || prefs.language === "en" ? "moonshine" : "whisper";
}

// The worker imports transformers.js from the CDN (lazy: nothing ships in the
// portal bundle) and keeps ONE pipeline warm for the life of the page.
const WORKER_SRC = `
let asr = null; let loadedKey = "";
async function load(model, cdn) {
  const key = model;
  if (asr && loadedKey === key) return;
  const T = await import(cdn);
  T.env.allowLocalModels = false;
  // Moonshine is small: WASM q8 transcribes ~5 s of speech in ~0.5 s with no GPU
  // shader warm-up, so it always runs there. Whisper uses WebGPU on a REAL adapter;
  // a software (fallback / SwiftShader) adapter is ~50x slower than WASM, so never that.
  let device = "wasm";
  if (!model.includes("moonshine")) {
    try {
      const ad = self.navigator && self.navigator.gpu ? await self.navigator.gpu.requestAdapter() : null;
      const info = ad && ad.info ? ad.info : {};
      const soft = !ad || ad.isFallbackAdapter || info.isFallbackAdapter || /swiftshader|llvmpipe/i.test(String(info.architecture || "") + String(info.description || ""));
      if (!soft) device = "webgpu";
    } catch (e) {}
  }
  const opts = { device, progress_callback: (p) => self.postMessage({ type: "progress", p }) };
  opts.dtype = device === "wasm" ? "q8" : { encoder_model: "fp32", decoder_model_merged: "q4" };
  asr = await T.pipeline("automatic-speech-recognition", model, opts);
  loadedKey = key;
  self.postMessage({ type: "loaded", device });
}
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") { await load(m.model, m.cdn); return; }
    if (m.type === "transcribe") {
      const opts = m.language && m.multilingual ? { language: m.language, task: "transcribe" } : {};
      const out = await asr(m.audio, opts);
      self.postMessage({ type: "result", id: m.id, text: (out && out.text ? String(out.text) : "").trim() });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m && m.id, message: String((err && err.message) || err) });
  }
};
`;

let sharedWorker: Worker | null = null;
let workerModel = "";
let loadPromise: Promise<void> | null = null;
const progressListeners = new Set<(label: string, f: number | null) => void>();

function deviceWorker(): Worker {
  if (!sharedWorker) {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
    sharedWorker = new Worker(url, { type: "module" });
  }
  return sharedWorker;
}

/** Download + warm the on-device model (Settings uses this for "Download now"). */
export function loadDeviceModel(model: Exclude<DeviceModel, "auto">, onProgress?: (label: string, f: number | null) => void): Promise<void> {
  const id = DEVICE_MODELS[model].id;
  if (onProgress) progressListeners.add(onProgress);
  if (loadPromise && workerModel === id) return loadPromise.finally(() => { if (onProgress) progressListeners.delete(onProgress); });
  const w = deviceWorker();
  workerModel = id;
  const files = new Map<string, { loaded: number; total: number }>();
  loadPromise = new Promise<void>((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data as { type: string; p?: { status?: string; file?: string; loaded?: number; total?: number }; message?: string };
      if (m.type === "progress" && m.p) {
        if (m.p.file && typeof m.p.total === "number" && m.p.total > 0) files.set(m.p.file, { loaded: m.p.loaded || 0, total: m.p.total });
        let loaded = 0; let total = 0;
        files.forEach((f) => { loaded += f.loaded; total += f.total; });
        const frac = total > 0 ? loaded / total : null;
        progressListeners.forEach((l) => l(`Downloading on-device model (${DEVICE_MODELS[model].size})`, frac));
      } else if (m.type === "loaded") {
        w.removeEventListener("message", onMsg);
        progressListeners.forEach((l) => l("On-device model ready", 1));
        resolve();
      } else if (m.type === "error" && !("id" in m && (m as { id?: unknown }).id)) {
        w.removeEventListener("message", onMsg);
        loadPromise = null;
        const err = new EngineError("model", "The on-device model couldn't load. Check your connection for the one-time download, or use a cloud provider.");
        reject(err);
      }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ type: "load", model: id, cdn: TRANSFORMERS_CDN });
  });
  return loadPromise.finally(() => { if (onProgress) progressListeners.delete(onProgress); });
}

let reqSeq = 0;
function transcribeOnDevice(audio: Float32Array, language: string, multilingual: boolean): Promise<string> {
  const w = deviceWorker();
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data as { type: string; id?: number; text?: string; message?: string };
      if (m.id !== id) return;
      w.removeEventListener("message", onMsg);
      if (m.type === "result") resolve(m.text || "");
      else reject(new EngineError("device", m.message || "On-device transcription failed."));
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ type: "transcribe", id, audio, language, multilingual }, [audio.buffer]);
  });
}

/** Pure: should the current segment be closed (a pause after enough speech)? */
export function shouldCloseSegment(segSeconds: number, silentSeconds: number): boolean {
  return (segSeconds >= 2 && silentSeconds >= 0.7) || segSeconds >= 25;
}

export function startDeviceSession(o: EngineStartOptions): EngineSession {
  const model = resolveDeviceModel(o.prefs);
  const meta = DEVICE_MODELS[model];
  const rs = new Resampler(o.captureRate, 16000);
  let seg: Float32Array[] = [];
  const preroll: Float32Array[] = [];
  let segLen = 0;
  let silent = 0;
  const finals: string[] = [];
  let interim = "";
  let busy = false;
  let lastPartialAt = 0;
  let cancelled = false;
  let queue: Promise<void> = Promise.resolve();
  let loaded = false;
  const lang = meta.multilingual ? o.prefs.language : "";

  const ready = loadDeviceModel(model, o.onProgress).then(() => {
    loaded = true;
    if (!cancelled) o.onReady?.({ engine: "device" });
  });
  ready.catch((e: EngineError) => { if (!cancelled) o.onError?.(e); });

  const concat = (parts: Float32Array[], n: number) => {
    const a = new Float32Array(n);
    let off = 0;
    for (const p of parts) { a.set(p, off); off += p.length; }
    return a;
  };
  const emit = () => { if (!cancelled) o.onTranscript({ final: join(...finals), interim }); };

  const closeSegment = () => {
    if (!segLen) return;
    const audio = concat(seg, segLen);
    seg = []; segLen = 0; silent = 0;
    const idx = finals.length;
    finals.push("");
    queue = queue.then(() => ready).then(async () => {
      if (cancelled) return;
      const text = await transcribeOnDevice(audio, lang, meta.multilingual);
      finals[idx] = text;
      interim = "";
      emit();
    });
  };

  const partial = () => {
    if (busy || !loaded || segLen < 16000 * 0.6) return;
    const now = Date.now();
    if (now - lastPartialAt < 600) return;
    lastPartialAt = now;
    busy = true;
    const audio = concat(seg, segLen);
    transcribeOnDevice(audio, lang, meta.multilingual)
      .then((t) => { if (segLen) { interim = t; emit(); } })
      .catch(() => undefined)
      .finally(() => { busy = false; });
  };

  return {
    push(frame) {
      if (cancelled) return;
      const f = rs.push(frame);
      const quiet = rms(f) < 0.01;
      if (!segLen && quiet) {
        // before any speech: keep only a short pre-roll (no compute on silence,
        // and Whisper-family models invent words on long silence)
        preroll.push(f);
        let n = preroll.reduce((a, b) => a + b.length, 0);
        while (n > 16000 * 0.3 && preroll.length > 1) n -= preroll.shift()!.length;
        return;
      }
      if (!segLen && preroll.length) {
        for (const p of preroll.splice(0)) { seg.push(p); segLen += p.length; }
      }
      seg.push(f);
      segLen += f.length;
      silent = quiet ? silent + f.length / 16000 : 0;
      if (shouldCloseSegment(segLen / 16000, silent)) closeSegment();
      else partial();
    },
    async stop() {
      closeSegment();
      await queue;
      return join(...finals);
    },
    cancel() {
      cancelled = true;
      seg = []; segLen = 0;
    },
  };
}

export function startEngine(kind: EngineKind, o: EngineStartOptions): EngineSession {
  return kind === "cloud" ? startCloudSession(o) : startDeviceSession(o);
}

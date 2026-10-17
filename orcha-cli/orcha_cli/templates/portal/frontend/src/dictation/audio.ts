/**
 * Microphone capture for dictation: mono Float32 frames + a smoothed level.
 *
 * An AudioWorklet (inline, no extra file to serve) hands raw frames to the
 * main thread every ~20 ms; a ScriptProcessor fallback covers engines without
 * worklets. Engines resample to whatever rate their backend wants
 * (`Resampler`) and encode PCM16 (`floatToPcm16`). Nothing is recorded to
 * disk or kept after the session — the frames go straight to the engine.
 */

export type MicErrorKind = "denied" | "no-device" | "insecure" | "unsupported" | "busy" | "unknown";

export class MicError extends Error {
  kind: MicErrorKind;
  constructor(kind: MicErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Plain words for every way the microphone can fail (shown in the HUD). */
export function micErrorMessage(kind: MicErrorKind): string {
  switch (kind) {
    case "denied":
      return "Microphone access is blocked. Allow it for this site in your browser (or in System Settings › Privacy & Security › Microphone for the desktop app), then try again.";
    case "no-device":
      return "No microphone found. Plug one in or pick one in your system sound settings.";
    case "insecure":
      return "Dictation needs a secure connection (https or localhost) before the browser will share the microphone.";
    case "unsupported":
      return "This browser can't record audio. Try a current Chrome, Edge, Safari or Firefox.";
    case "busy":
      return "Another app is using the microphone. Close it and try again.";
    default:
      return "The microphone couldn't start. Try again.";
  }
}

export function classifyMicError(e: unknown): MicError {
  if (e instanceof MicError) return e;
  const name = (e as { name?: string } | null)?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return new MicError("denied", micErrorMessage("denied"));
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return new MicError("no-device", micErrorMessage("no-device"));
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return new MicError("busy", micErrorMessage("busy"));
  return new MicError("unknown", micErrorMessage("unknown"));
}

/** Streaming linear resampler (any rate → target rate), state kept across frames. */
export class Resampler {
  private pos = 0;
  private last = 0;
  constructor(readonly from: number, readonly to: number) {}
  push(input: Float32Array): Float32Array {
    if (this.from === this.to) return input;
    const step = this.from / this.to;
    const out: number[] = [];
    // `pos` is the fractional read position relative to this frame (may be < 0: between last frame's tail and input[0]).
    let p = this.pos;
    while (p < input.length - 1 + 1e-9) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = i < 0 ? this.last : input[i];
      const b = i + 1 < input.length ? input[i + 1] : input[i];
      out.push(a + (b - a) * frac);
      p += step;
    }
    this.pos = p - input.length;
    if (input.length) this.last = input[input.length - 1];
    return Float32Array.from(out);
  }
}

export function floatToPcm16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function rms(f: Float32Array): number {
  if (!f.length) return 0;
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  return Math.sqrt(sum / f.length);
}

/** 0..1 loudness for the meter (perceptual-ish curve so quiet speech still moves). */
export function levelFromRms(r: number): number {
  if (r <= 0) return 0;
  const db = 20 * Math.log10(r);
  return Math.max(0, Math.min(1, (db + 60) / 50));
}

/** 16-bit mono WAV (for the batch fallback). */
export function encodeWav(pcm: Int16Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

export interface Capture {
  sampleRate: number;
  stop(): void;
}

export interface CaptureOptions {
  onFrame: (frame: Float32Array) => void;
  onLevel?: (level: number) => void;
  deviceId?: string;
}

const WORKLET_SRC = `
class OrchaDictationTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) { this.buf.push(new Float32Array(ch)); this.n += ch.length; }
    if (this.n >= 960) {
      const out = new Float32Array(this.n); let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; }
      this.port.postMessage(out, [out.buffer]); this.buf = []; this.n = 0;
    }
    return true;
  }
}
registerProcessor("orcha-dictation-tap", OrchaDictationTap);
`;

type HostBridge = { requestMicAccess?: () => Promise<boolean | string> };

/** The desktop app asks macOS for microphone access first (TCC prompt) when it can. */
async function askHostForMic(): Promise<void> {
  const host = (window as unknown as { orchaHost?: HostBridge }).orchaHost;
  if (host && typeof host.requestMicAccess === "function") {
    try {
      const r = await host.requestMicAccess();
      if (r === false || r === "denied" || r === "restricted") throw new MicError("denied", micErrorMessage("denied"));
    } catch (e) {
      if (e instanceof MicError) throw e;
    }
  }
}

export async function startCapture(opts: CaptureOptions): Promise<Capture> {
  if (typeof window === "undefined") throw new MicError("unsupported", micErrorMessage("unsupported"));
  if (window.isSecureContext === false) throw new MicError("insecure", micErrorMessage("insecure"));
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== "function") throw new MicError("unsupported", micErrorMessage("unsupported"));
  await askHostForMic();
  let stream: MediaStream;
  try {
    stream = await md.getUserMedia({
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    throw classifyMicError(e);
  }
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) {
    stream.getTracks().forEach((t) => t.stop());
    throw new MicError("unsupported", micErrorMessage("unsupported"));
  }
  const ctx = new Ctx();
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch { /* resumes on the next gesture */ }
  }
  const src = ctx.createMediaStreamSource(stream);
  let smoothed = 0;
  const handle = (frame: Float32Array) => {
    opts.onFrame(frame);
    if (opts.onLevel) {
      const l = levelFromRms(rms(frame));
      smoothed = l > smoothed ? l : smoothed * 0.85 + l * 0.15;
      opts.onLevel(smoothed);
    }
  };
  let node: AudioNode | null = null;
  let cleanupNode: () => void = () => undefined;
  if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    // A strict CSP (the desktop app) can refuse a blob: worklet — fall back, don't fail.
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
      const w = new AudioWorkletNode(ctx, "orcha-dictation-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
      w.port.onmessage = (ev: MessageEvent<Float32Array>) => handle(ev.data);
      src.connect(w);
      node = w;
      cleanupNode = () => { w.port.onmessage = null; };
    } catch {
      node = null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!node) {
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    sp.onaudioprocess = (ev) => handle(new Float32Array(ev.inputBuffer.getChannelData(0)));
    src.connect(sp);
    sp.connect(ctx.destination);
    node = sp;
    cleanupNode = () => { sp.onaudioprocess = null; };
  }
  let stopped = false;
  return {
    sampleRate: ctx.sampleRate,
    stop() {
      if (stopped) return;
      stopped = true;
      cleanupNode();
      try { src.disconnect(); node?.disconnect(); } catch { /* already gone */ }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
    },
  };
}

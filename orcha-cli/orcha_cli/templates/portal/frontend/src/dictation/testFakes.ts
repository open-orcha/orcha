/** Fakes for the dictation tests: a microphone, an engine and a status. */
import type { Capture, CaptureOptions } from "./audio";
import type { ControllerDeps } from "./controller";
import type { EngineKind, EngineSession, EngineStartOptions, VoiceStatus } from "./engines";
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from "./prefs";

export const CLOUD_STATUS: VoiceStatus = {
  providers: [{ provider: "openai", name: "OpenAI", configured: true, streaming: true, masked: "sk-...ABCD", source: "db" }],
  default_provider: "openai",
  cloud_available: true,
  cleanup_available: true,
  max_seconds: 600,
};

export interface FakeRig {
  deps: ControllerDeps;
  mic: { opts: CaptureOptions | null; stopped: boolean; frame: (n?: number) => void; level: (l: number) => void };
  engine: { kind: EngineKind | null; opts: EngineStartOptions | null; pushed: number; cancelled: boolean; stopped: boolean; say: (final: string, interim?: string) => void; ready: () => void; result: string; fail: Error | null };
  cleanups: string[];
  prefs: VoicePrefs;
}

export function fakeRig(over: Partial<VoicePrefs> = {}, status: VoiceStatus | null = CLOUD_STATUS): FakeRig {
  const prefs: VoicePrefs = { ...DEFAULT_VOICE_PREFS, ...over };
  const rig: FakeRig = {
    prefs,
    cleanups: [],
    mic: {
      opts: null,
      stopped: false,
      frame: (n = 480) => rig.mic.opts?.onFrame(new Float32Array(n).fill(0.1)),
      level: (l) => rig.mic.opts?.onLevel?.(l),
    },
    engine: {
      kind: null, opts: null, pushed: 0, cancelled: false, stopped: false, result: "", fail: null,
      say: (final, interim = "") => rig.engine.opts?.onTranscript({ final, interim }),
      ready: () => rig.engine.opts?.onReady?.({ engine: rig.engine.kind || "cloud", provider: "openai" }),
    },
    deps: {
      getCid: () => "c1",
      getPrefs: () => rig.prefs,
      getStatus: async () => status,
      startCapture: async (o: CaptureOptions): Promise<Capture> => {
        rig.mic.opts = o;
        return { sampleRate: 48000, stop: () => { rig.mic.stopped = true; } };
      },
      startEngine: (kind: EngineKind, o: EngineStartOptions): EngineSession => {
        rig.engine.kind = kind;
        rig.engine.opts = o;
        return {
          push: () => { rig.engine.pushed++; },
          stop: async () => {
            rig.engine.stopped = true;
            if (rig.engine.fail) throw rig.engine.fail;
            return rig.engine.result;
          },
          cancel: () => { rig.engine.cancelled = true; },
        };
      },
      cleanup: async (_cid, text) => {
        rig.cleanups.push(text);
        return text.replace(/^um,? /i, "").replace(/^./, (c) => c.toUpperCase()) + ".";
      },
      deviceSupported: () => true,
      doneMs: 60_000,
    },
  };
  return rig;
}

export const flush = () => new Promise((r) => setTimeout(r, 0));

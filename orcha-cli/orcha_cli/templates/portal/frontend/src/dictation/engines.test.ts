/** Engine choice, the cloud WebSocket session (fake socket) and its REST fallback, audio helpers. */
import { describe, expect, it, vi } from "vitest";
import { Resampler, encodeWav, floatToPcm16, levelFromRms } from "./audio";
import { pickEngine, resolveDeviceModel, shouldCloseSegment, startCloudSession, streamUrl, type VoiceStatus } from "./engines";
import { DEFAULT_VOICE_PREFS, type VoicePrefs } from "./prefs";

const prefs = (o: Partial<VoicePrefs> = {}): VoicePrefs => ({ ...DEFAULT_VOICE_PREFS, ...o });
const cloud: VoiceStatus = {
  providers: [
    { provider: "openai", name: "OpenAI", configured: true, streaming: true },
    { provider: "deepgram", name: "Deepgram", configured: false, streaming: true },
  ],
  default_provider: "openai", cloud_available: true, cleanup_available: true, max_seconds: 600,
};
const none: VoiceStatus = { providers: [], default_provider: null, cloud_available: false, cleanup_available: false, max_seconds: 600 };

describe("pickEngine", () => {
  it("Auto: cloud when the project has a key, else on-device, else a plain reason", () => {
    expect(pickEngine(prefs(), cloud, true).engine).toBe("cloud");
    expect(pickEngine(prefs(), none, true).engine).toBe("device");
    const r = pickEngine(prefs(), none, false);
    expect(r.engine).toBeNull();
    expect(r.reason).toMatch(/Settings › Voice/);
  });
  it("explicit choices are honoured", () => {
    expect(pickEngine(prefs({ engine: "device" }), cloud, true).engine).toBe("device");
    expect(pickEngine(prefs({ engine: "cloud" }), none, true).engine).toBeNull();
    expect(pickEngine(prefs({ engine: "cloud", provider: "deepgram" }), cloud, true).engine).toBeNull();
    expect(pickEngine(prefs({ engine: "off" }), cloud, true).engine).toBeNull();
  });
  it("on-device model follows the language", () => {
    expect(resolveDeviceModel(prefs())).toBe("moonshine");
    expect(resolveDeviceModel(prefs({ language: "fr" }))).toBe("whisper");
    expect(resolveDeviceModel(prefs({ deviceModel: "whisper" }))).toBe("whisper");
  });
  it("closes on-device segments on a pause after speech", () => {
    expect(shouldCloseSegment(3, 0.8)).toBe(true);
    expect(shouldCloseSegment(1, 2)).toBe(false);
    expect(shouldCloseSegment(26, 0)).toBe(true);
  });
});

class FakeWS {
  static last: FakeWS | null = null;
  readyState = 0;
  binaryType = "";
  sent: (string | ArrayBuffer)[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  constructor(public url: string) { FakeWS.last = this; }
  send(d: string | ArrayBuffer) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; }
  msg(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) } as MessageEvent); }
  shut(code: number) { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
}

describe("cloud session", () => {
  it("builds the stream URL (ws/wss, provider, language)", () => {
    const loc = { protocol: "https:", host: "orcha.example" } as Location;
    expect(streamUrl("c 1", prefs({ language: "de" }), loc)).toBe("wss://orcha.example/api/containers/c%201/voice/stream?provider=auto&language=de");
  });

  it("buffers until ready, sends PCM16 at the server's rate, streams text, stop → done", async () => {
    const onTranscript = vi.fn();
    const onReady = vi.fn();
    const s = startCloudSession({ cid: "c1", captureRate: 48000, prefs: prefs(), onTranscript, onReady, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    const ws = FakeWS.last!;
    s.push(new Float32Array(960).fill(0.5)); // before ready: buffered
    expect(ws.sent).toHaveLength(0);
    ws.open();
    ws.msg({ type: "ready", provider: "openai", sample_rate: 24000 });
    expect(onReady).toHaveBeenCalledWith({ engine: "cloud", provider: "openai" });
    const first = ws.sent[0] as ArrayBuffer;
    expect(first.byteLength).toBe(480 * 2); // 960 @48k → 480 @24k, int16
    ws.msg({ type: "transcript", final: "Hello", interim: "wor" });
    expect(onTranscript).toHaveBeenLastCalledWith({ final: "Hello", interim: "wor" });
    const p = s.stop();
    expect(JSON.parse(ws.sent[ws.sent.length - 1] as string)).toEqual({ type: "stop" });
    ws.msg({ type: "done", text: "Hello world." });
    await expect(p).resolves.toBe("Hello world.");
  });

  it("a server error (e.g. no provider) surfaces immediately", () => {
    const onError = vi.fn();
    startCloudSession({ cid: "c1", captureRate: 48000, prefs: prefs(), onTranscript: vi.fn(), onError, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    const ws = FakeWS.last!;
    ws.open();
    ws.msg({ type: "error", code: "unavailable", message: "No speech provider is set up for this project. Add one in Settings › Voice." });
    expect(onError.mock.calls[0][0].message).toMatch(/Settings › Voice/);
  });

  it("socket never opens → records and transcribes once over REST", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "from rest" }) }) as unknown as Response);
    const s = startCloudSession({ cid: "c1", captureRate: 16000, prefs: prefs({ language: "en" }), onTranscript: vi.fn(), WebSocketImpl: FakeWS as unknown as typeof WebSocket, fetchImpl: fetchImpl as unknown as typeof fetch });
    const ws = FakeWS.last!;
    s.push(new Float32Array(1600).fill(0.2));
    ws.onerror?.();
    ws.shut(1006);
    await expect(s.stop()).resolves.toBe("from rest");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/containers/c1/voice/transcribe?provider=auto&language=en");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("audio/wav");
    expect((init.body as Blob).size).toBe(44 + 1600 * 2);
  });

  it("cancel tells the server and never resolves text", () => {
    const s = startCloudSession({ cid: "c1", captureRate: 48000, prefs: prefs(), onTranscript: vi.fn(), WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    const ws = FakeWS.last!;
    ws.open();
    ws.msg({ type: "ready", sample_rate: 24000 });
    s.cancel();
    expect(ws.sent.map((x) => (typeof x === "string" ? JSON.parse(x).type : "pcm"))).toContain("cancel");
  });
});

describe("audio helpers", () => {
  it("resamples 48k → 16k by a third, continuously across frames", () => {
    const r = new Resampler(48000, 16000);
    const a = r.push(new Float32Array(480));
    const b = r.push(new Float32Array(480));
    expect(a.length + b.length).toBe(320);
  });
  it("PCM16 clamps and WAV has a 44-byte header", () => {
    expect(Array.from(floatToPcm16(Float32Array.from([2, -2, 0])))).toEqual([32767, -32768, 0]);
    expect(encodeWav(new Int16Array(10), 16000).size).toBe(64);
  });
  it("level meter is 0 for silence and rises with loudness", () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(0.1)).toBeGreaterThan(levelFromRms(0.01));
  });
});

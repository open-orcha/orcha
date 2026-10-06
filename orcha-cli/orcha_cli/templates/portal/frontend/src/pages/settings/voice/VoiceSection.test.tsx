/** Settings › Voice: engine/language/clean-up/shortcut (this device), provider keys (project), privacy. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui";
import { readVoicePrefs } from "../../../dictation/prefs";
import type { VoiceStatus } from "../../../dictation/engines";
import { VoiceSection, engineSummary } from "./VoiceSection";
import { DEFAULT_VOICE_PREFS } from "../../../dictation/prefs";

vi.mock("../grantAuthority", () => ({
  useGrantAuthority: () => ({ can: true, human: { id: "h1", alias: "kedar", kind: "human" }, pending: false, reason: null }),
}));

const STATUS: VoiceStatus = {
  providers: [
    { provider: "openai", name: "OpenAI", configured: false, streaming: true, masked: null, source: null, note: "Live streaming, best accuracy." },
    { provider: "deepgram", name: "Deepgram", configured: true, streaming: true, masked: "...WXYZ", source: "db", note: "Lowest latency." },
    { provider: "groq", name: "Groq", configured: false, streaming: false, masked: null, source: null, note: "Cheapest." },
  ],
  default_provider: "deepgram", cloud_available: true, cleanup_available: true, max_seconds: 600,
};
let calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("Worker", class {}); // jsdom has no Web Workers; on-device needs one
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const res = (d: unknown) => ({ ok: true, status: 200, json: async () => d }) as Response;
    if (url.endsWith("/voice/status")) return res(STATUS);
    return res({ configured: true });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const renderIt = () => render(<ToastProvider><VoiceSection cid="c1" /></ToastProvider>);

describe("Settings › Voice", () => {
  it("summarises the engine Auto picked, and saves engine/language/clean-up/shortcut on this device", async () => {
    renderIt();
    expect(await screen.findByText(/Streaming through Deepgram/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "On-device" }));
    expect(readVoicePrefs().engine).toBe("device");
    fireEvent.change(screen.getByLabelText("Dictation language"), { target: { value: "fr" } });
    expect(readVoicePrefs().language).toBe("fr");
    fireEvent.click(screen.getByRole("switch", { name: "AI clean-up" }));
    expect(readVoicePrefs().cleanup).toBe(false);
    fireEvent.change(screen.getByLabelText("Dictation shortcut"), { target: { value: "ctrl+alt+d" } });
    expect(readVoicePrefs().shortcut).toBe("ctrl+alt+d");
  });

  it("lists speech providers; a key is saved with the acting human and never shown back", async () => {
    renderIt();
    await waitFor(() => expect(document.querySelector('[data-provider="openai"]')).toBeTruthy());
    const row = document.querySelector('[data-provider="openai"]') as HTMLElement;
    const input = within(row).getByLabelText("OpenAI API key");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "sk-test-123" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/containers/c1/settings/voice-keys/openai");
    expect(put.body).toEqual({ actor_agent_id: "h1", api_key: "sk-test-123" });
    const dg = document.querySelector('[data-provider="deepgram"]') as HTMLElement;
    expect(dg).toHaveTextContent("Connected");
    expect(dg).toHaveTextContent("...WXYZ");
  });

  it("says plainly that audio is never stored", async () => {
    renderIt();
    expect(screen.getByText(/Audio is never stored/)).toBeInTheDocument();
  });

  it("engineSummary explains each case", () => {
    expect(engineSummary(DEFAULT_VOICE_PREFS, STATUS, true)).toMatch(/Deepgram/);
    expect(engineSummary({ ...DEFAULT_VOICE_PREFS, engine: "device" }, STATUS, true)).toMatch(/never leaves your computer/);
    expect(engineSummary({ ...DEFAULT_VOICE_PREFS, engine: "off" }, STATUS, true)).toMatch(/turned off/);
  });
});

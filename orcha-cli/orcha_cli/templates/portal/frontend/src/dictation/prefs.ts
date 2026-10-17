/**
 * Voice dictation preferences — per device, in localStorage.
 *
 * Deliberately NOT the server-side cosmetic prefs bag (/api/prefs): the engine,
 * microphone behaviour and on-device model are properties of THIS machine (a
 * laptop with WebGPU vs a phone), so they should not follow the account.
 */
export type VoiceEngine = "auto" | "cloud" | "device" | "off";
export type VoiceProvider = "auto" | "openai" | "deepgram" | "groq";
export type VoiceShortcut = "alt+space" | "ctrl+shift+space" | "ctrl+alt+d";
export type DeviceModel = "auto" | "moonshine" | "whisper";

export interface VoicePrefs {
  engine: VoiceEngine;
  provider: VoiceProvider;
  /** ISO-639-1 code, or "" for automatic detection */
  language: string;
  /** run the AI clean-up pass after a dictation (keeps the raw words for undo) */
  cleanup: boolean;
  shortcut: VoiceShortcut;
  /** on-device model: Moonshine (English, fastest) or Whisper (multilingual) */
  deviceModel: DeviceModel;
}

export const VOICE_PREFS_KEY = "orcha:voice";
export const VOICE_PREFS_EVENT = "orcha:voice-prefs";

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  engine: "auto",
  provider: "auto",
  language: "",
  cleanup: true,
  shortcut: "alt+space",
  deviceModel: "auto",
};

export const SHORTCUTS: { key: VoiceShortcut; label: string; mac: string; other: string }[] = [
  { key: "alt+space", label: "Option Space", mac: "⌥ Space", other: "Alt+Space" },
  { key: "ctrl+shift+space", label: "Control Shift Space", mac: "⌃ ⇧ Space", other: "Ctrl+Shift+Space" },
  { key: "ctrl+alt+d", label: "Control Option D", mac: "⌃ ⌥ D", other: "Ctrl+Alt+D" },
];

export const LANGUAGES: { code: string; name: string }[] = [
  { code: "", name: "Automatic" },
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "nl", name: "Dutch" },
  { code: "sv", name: "Swedish" },
  { code: "pl", name: "Polish" },
  { code: "tr", name: "Turkish" },
  { code: "ar", name: "Arabic" },
  { code: "so", name: "Somali" },
  { code: "hi", name: "Hindi" },
  { code: "ru", name: "Russian" },
  { code: "uk", name: "Ukrainian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
];

const ENGINES: VoiceEngine[] = ["auto", "cloud", "device", "off"];
const PROVIDERS: VoiceProvider[] = ["auto", "openai", "deepgram", "groq"];
const MODELS: DeviceModel[] = ["auto", "moonshine", "whisper"];

/** Pure: coerce anything (old/corrupt storage) into valid prefs. */
export function normalizeVoicePrefs(raw: unknown): VoicePrefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof VoicePrefs, unknown>>;
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (typeof v === "string" && (ok as readonly string[]).includes(v) ? (v as T) : d);
  const lang = typeof o.language === "string" && LANGUAGES.some((l) => l.code === o.language) ? o.language : DEFAULT_VOICE_PREFS.language;
  return {
    engine: pick(o.engine, ENGINES, DEFAULT_VOICE_PREFS.engine),
    provider: pick(o.provider, PROVIDERS, DEFAULT_VOICE_PREFS.provider),
    language: lang,
    cleanup: typeof o.cleanup === "boolean" ? o.cleanup : DEFAULT_VOICE_PREFS.cleanup,
    shortcut: pick(o.shortcut, SHORTCUTS.map((s) => s.key), DEFAULT_VOICE_PREFS.shortcut),
    deviceModel: pick(o.deviceModel, MODELS, DEFAULT_VOICE_PREFS.deviceModel),
  };
}

export function readVoicePrefs(): VoicePrefs {
  try {
    const s = window.localStorage.getItem(VOICE_PREFS_KEY);
    return normalizeVoicePrefs(s ? JSON.parse(s) : null);
  } catch {
    return { ...DEFAULT_VOICE_PREFS };
  }
}

export function writeVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  const next = normalizeVoicePrefs({ ...readVoicePrefs(), ...patch });
  try {
    window.localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* private window / blocked storage: the change still applies for this page */
  }
  try {
    window.dispatchEvent(new CustomEvent(VOICE_PREFS_EVENT, { detail: next }));
  } catch {
    /* no window */
  }
  return next;
}

export function isMacPlatform(): boolean {
  try {
    const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent;
    return /mac|iphone|ipad/i.test(p);
  } catch {
    return false;
  }
}

export function shortcutLabel(key: VoiceShortcut, mac = isMacPlatform()): string {
  const s = SHORTCUTS.find((x) => x.key === key) || SHORTCUTS[0];
  return mac ? s.mac : s.other;
}

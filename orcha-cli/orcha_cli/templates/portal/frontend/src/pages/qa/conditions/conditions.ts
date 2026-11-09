/**
 * Run conditions (`qa_conditions.py`): the state a case needs before it can be judged. Every key
 * is optional. A run's own conditions win over its scenario's, key by key. Orcha sets what it can
 * on the device (`nativeKeys`); the agent sets up the rest with its own tools. These are words:
 * an account is described, never given.
 */
import type { Platform } from "../qaApi";

export type TextSize = "small" | "default" | "large" | "larger" | "largest";
export type ConditionKey = "os" | "locale" | "text_size" | "appearance" | "timezone" | "network" | "account" | "setup";

export interface Conditions {
  os?: string | null;
  locale?: string | null;
  text_size?: TextSize | null;
  appearance?: "light" | "dark" | null;
  timezone?: string | null;
  network?: "online" | "offline" | "slow" | null;
  account?: string | null;
  setup?: string | null;
}

export const CONDITION_KEYS: readonly ConditionKey[] = ["os", "locale", "text_size", "appearance", "timezone", "network", "account", "setup"];

export const CONDITION_LABELS: Record<ConditionKey, string> = {
  os: "OS version",
  locale: "Language and region",
  text_size: "Text size",
  appearance: "Appearance",
  timezone: "Time zone",
  network: "Network",
  account: "Account",
  setup: "Setup steps",
};

export const TEXT_SIZES: readonly TextSize[] = ["small", "default", "large", "larger", "largest"];
export const COMMON_LOCALES: readonly { code: string; label: string }[] = [
  { code: "en-US", label: "English (United States)" },
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "sw-KE", label: "Swahili (Kenya)" },
  { code: "sw-TZ", label: "Swahili (Tanzania)" },
  { code: "fr-FR", label: "French (France)" },
  { code: "es-ES", label: "Spanish (Spain)" },
  { code: "ar-AE", label: "Arabic (United Arab Emirates)" },
  { code: "de-DE", label: "German (Germany)" },
];
export const COMMON_TIMEZONES: readonly string[] = ["Africa/Nairobi", "Africa/Dar_es_Salaam", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Dubai", "UTC"];

const LANGUAGES: Record<string, string> = { en: "English", sw: "Swahili", fr: "French", es: "Spanish", pt: "Portuguese", de: "German", ar: "Arabic", zh: "Chinese", ja: "Japanese", ko: "Korean", hi: "Hindi", it: "Italian", nl: "Dutch", ru: "Russian", tr: "Turkish", am: "Amharic", so: "Somali", he: "Hebrew", id: "Indonesian", pl: "Polish" };
const REGIONS: Record<string, string> = { KE: "Kenya", TZ: "Tanzania", UG: "Uganda", US: "United States", GB: "United Kingdom", FR: "France", ES: "Spain", MX: "Mexico", BR: "Brazil", PT: "Portugal", DE: "Germany", AE: "United Arab Emirates", SA: "Saudi Arabia", CN: "China", JP: "Japan", IN: "India", CA: "Canada", AU: "Australia", NG: "Nigeria", ZA: "South Africa", ET: "Ethiopia", SO: "Somalia", EG: "Egypt", IT: "Italy", NL: "Netherlands" };
const PLATFORM: Record<Platform, string> = { ios: "iOS", android: "Android", web: "Web" };

/** Only the keys asked, or null when nothing is. */
export function cleanConditions(c: Conditions | null | undefined): Conditions | null {
  if (!c) return null;
  const out: Conditions = {};
  for (const k of CONDITION_KEYS) {
    const v = c[k];
    if (typeof v === "string" ? v.trim() : v) (out as Record<string, unknown>)[k] = typeof v === "string" ? v.trim() : v;
  }
  return Object.keys(out).length ? out : null;
}

/** The run's own win key by key; a key it leaves empty keeps the base's. */
export function mergeConditions(base: Conditions | null | undefined, over: Conditions | null | undefined): Conditions | null {
  return cleanConditions({ ...(cleanConditions(base) ?? {}), ...(cleanConditions(over) ?? {}) });
}

export function localeWords(code: string): string {
  const parts = code.replace(/_/g, "-").split("-");
  const lang = LANGUAGES[parts[0].toLowerCase()];
  const region = parts.slice(1).map((p) => (p.length === 2 ? REGIONS[p.toUpperCase()] : undefined)).find(Boolean);
  if (!lang) return code;
  return region ? `${lang} (${region})` : lang;
}

export function osWords(os: string, platform: Platform | null | undefined): string {
  return platform && platform !== "web" && /^\d/.test(os) ? `${PLATFORM[platform]} ${os}` : os;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One condition in plain words: "Android 13", "Swahili (Kenya)", "Text: Large". */
export function conditionWord(key: ConditionKey, c: Conditions, platform?: Platform | null): string | null {
  const v = c[key];
  if (!v) return null;
  switch (key) {
    case "os": return osWords(String(v), platform);
    case "locale": return localeWords(String(v));
    case "text_size": return `Text: ${cap(String(v))}`;
    case "appearance": return cap(String(v));
    case "timezone": return `Time zone: ${v}`;
    case "network": return v === "slow" ? "Slow network" : cap(String(v));
    case "account": return `Account: ${v}`;
    case "setup": return `Setup: ${v}`;
  }
}

export function conditionWords(c: Conditions | null | undefined, platform?: Platform | null): string[] {
  const clean = cleanConditions(c);
  if (!clean) return [];
  return CONDITION_KEYS.map((k) => conditionWord(k, clean, platform)).filter((w): w is string => Boolean(w));
}

/** What Orcha sets on the device itself; the agent sets up the rest. `os` is checked, not set. */
export function nativeKeys(platform: Platform | null | undefined, physical = false): ReadonlySet<ConditionKey> {
  if (platform === "web") return new Set<ConditionKey>(["locale", "text_size", "appearance", "timezone", "network"]);
  if (platform === "android") return new Set<ConditionKey>(physical ? ["os", "locale", "text_size", "appearance"] : ["os", "locale", "text_size", "appearance", "network"]);
  if (platform === "ios") return new Set<ConditionKey>(physical ? ["os", "locale"] : ["os", "locale", "text_size", "appearance"]);
  return new Set();
}

/** What a physical phone cannot be put in: Orcha never changes a person's own phone's settings
 * (an iPhone does not allow it), and the agent has no safe way to. A simulator or emulator can. */
export function unavailableKeys(platform: Platform | null | undefined, physical = false): ReadonlySet<ConditionKey> {
  if (!physical) return new Set();
  if (platform === "ios") return new Set<ConditionKey>(["text_size", "appearance", "network", "timezone"]);
  if (platform === "android") return new Set<ConditionKey>(["network", "timezone"]);
  return new Set();
}

/** The asked conditions this device cannot take, in plain words, or null when it can take all. */
export function unavailableWords(c: Conditions | null | undefined, platform: Platform | null | undefined, physical: boolean): string | null {
  const off = unavailableKeys(platform, physical);
  const asked = CONDITION_KEYS.filter((k) => cleanConditions(c)?.[k] && off.has(k));
  if (!asked.length) return null;
  const names = asked.map((k) => CONDITION_LABELS[k].toLowerCase());
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `A physical phone can't be set to a ${list}. Pick a simulator or an emulator on the Device tab, or clear ${asked.length > 1 ? "them" : "it"} on Conditions.`;
}

/** Compact JSON, as a worker passes them to start_session. */
export const conditionsJson = (c: Conditions) => JSON.stringify(cleanConditions(c) ?? {});

/** Conditions from a URL parameter: JSON, checked key by key; anything else is ignored. */
export function parseConditions(text: string | null | undefined): Conditions | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out: Conditions = {};
    for (const k of CONDITION_KEYS) {
      const v = raw[k];
      if (typeof v !== "string") continue;
      if (k === "text_size" && !(TEXT_SIZES as readonly string[]).includes(v)) continue;
      if (k === "appearance" && v !== "light" && v !== "dark") continue;
      if (k === "network" && !["online", "offline", "slow"].includes(v)) continue;
      (out as Record<string, unknown>)[k] = v.slice(0, k === "setup" ? 2000 : 300);
    }
    return cleanConditions(out);
  } catch {
    return null;
  }
}

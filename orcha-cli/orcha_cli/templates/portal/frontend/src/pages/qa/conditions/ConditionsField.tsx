/**
 * "Conditions": what the case needs before it can be judged, picked visually. Each condition is a
 * tile (its value, and who sets it on this platform); a tile opens its own picker below the grid:
 * OS versions, languages with a live sample of their dates and money, text sizes drawn at their
 * size, light and dark phones, time zones with their clock now, network strengths, and words for an
 * account and setup steps. Used on a run, a scenario, a finding's reproduction and a handoff.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/primitives";
import { Clock, Globe, Moon, Smartphone, Sun, Type, UserRound, Wifi, Wrench, X } from "../map/kit/icons";
import type { Platform } from "../qaApi";
import {
  CONDITION_KEYS, CONDITION_LABELS, TEXT_SIZES, cleanConditions, conditionWord, localeWords, nativeKeys, unavailableKeys,
  type ConditionKey, type Conditions, type TextSize,
} from "./conditions";
import "./conditions.css";

export const CONDITIONS_HINT =
  "Orcha sets what it can on the device. The agent sets up the rest with its own tools, such as an MCP server for test accounts. A condition that cannot be met makes those checks blocked, never passed.";

export const CONDITION_ICON: Record<ConditionKey, typeof Globe> = {
  os: Smartphone, locale: Globe, text_size: Type, appearance: Moon, timezone: Clock, network: Wifi, account: UserRound, setup: Wrench,
};

const OS_VERSIONS: Record<Platform, string[]> = {
  android: ["16", "15", "14", "13", "12", "11", "10"],
  ios: ["26", "18", "17", "16"],
  web: [],
};
const LOCALES = ["en-US", "en-GB", "sw-KE", "sw-TZ", "fr-FR", "fr-CA", "es-ES", "es-MX", "pt-BR", "de-DE", "it-IT", "nl-NL", "ar-AE", "ar-SA", "he-IL",
  "tr-TR", "ru-RU", "hi-IN", "ja-JP", "ko-KR", "zh-CN", "am-ET", "so-SO", "pl-PL"];
const CURRENCY: Record<string, string> = { US: "USD", GB: "GBP", KE: "KES", TZ: "TZS", FR: "EUR", CA: "CAD", ES: "EUR", MX: "MXN", BR: "BRL", DE: "EUR", IT: "EUR",
  NL: "EUR", AE: "AED", SA: "SAR", IL: "ILS", TR: "TRY", RU: "RUB", IN: "INR", JP: "JPY", KR: "KRW", CN: "CNY", ET: "ETB", SO: "SOS", PL: "PLN" };
const ZONES = ["Africa/Nairobi", "Africa/Dar_es_Salaam", "Africa/Lagos", "Africa/Cairo", "Africa/Johannesburg", "Europe/London", "Europe/Paris", "Europe/Istanbul",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Sao_Paulo", "UTC"];
const TEXT_PX: Record<TextSize, number> = { small: 13, default: 16, large: 19, larger: 22, largest: 28 };
const TEXT_PCT: Record<TextSize, string> = { small: "85%", default: "100%", large: "115%", larger: "130%", largest: "200%" };
const ACCOUNTS = ["A new user", "A signed-out visitor", "An account with an active subscription", "An account whose subscription expired", "An admin account"];
const SETUPS = ["Use the test accounts MCP server to fetch an account with an active subscription, then sign in with it",
  "Seed one saved card on the account before the run", "Start with the app's cache cleared and the onboarding not seen"];
const LOCALE_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Kiswahili": the language's own name for itself, else ours. */
export function nativeName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return name ? cap(name) : localeWords(code);
  } catch {
    return localeWords(code);
  }
}

/** What the app shows in that language: a date, a number and money, formatted there. */
export function localeSample(code: string): string {
  try {
    const region = code.replace("_", "-").split("-")[1]?.toUpperCase();
    const date = new Intl.DateTimeFormat(code, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
    const num = new Intl.NumberFormat(code).format(1234567.89);
    const money = region && CURRENCY[region] ? new Intl.NumberFormat(code, { style: "currency", currency: CURRENCY[region] }).format(1500) : null;
    return [date, num, money].filter(Boolean).join("  ·  ");
  } catch {
    return "";
  }
}

function zoneNow(zone: string): { time: string; offset: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset" }).formatToParts(new Date());
    return { time: parts.filter((p) => p.type === "hour" || p.type === "minute" || p.type === "literal").map((p) => p.value).join("").trim(),
      offset: parts.find((p) => p.type === "timeZoneName")?.value ?? "" };
  } catch {
    return { time: "", offset: "" };
  }
}

/** An option drawn as a card: radio semantics, a ring when chosen. */
function Card({ on, onPick, children, label, className }: { on: boolean; onPick: () => void; children: ReactNode; label: string; className?: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={label} className={"qa-cv-card" + (on ? " is-on" : "") + (className ? " " + className : "")} onClick={onPick}>
      {children}
    </button>
  );
}

function Phone({ dark }: { dark: boolean }) {
  return (
    <span className={"qa-cv-phone" + (dark ? " is-dark" : "")} aria-hidden="true">
      <span className="qa-cv-phone-notch" />
      <span className="qa-cv-phone-line is-title" />
      <span className="qa-cv-phone-line" />
      <span className="qa-cv-phone-line is-short" />
      <span className="qa-cv-phone-btn" />
    </span>
  );
}

export function NetworkBars({ level }: { level: "online" | "slow" | "offline" }) {
  const lit = level === "online" ? 4 : level === "slow" ? 1 : 0;
  return (
    <span className={"qa-cv-bars is-" + level} aria-hidden="true">
      {[1, 2, 3, 4].map((n) => <span key={n} className={n <= lit ? "is-lit" : ""} style={{ height: 4 + n * 4 }} />)}
      {level === "offline" ? <span className="qa-cv-bars-x" /> : null}
    </span>
  );
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <input className="qa-input qa-cv-search" type="search" value={value} placeholder={placeholder} aria-label={placeholder} onChange={(e) => onChange(e.target.value)} autoFocus data-dictation="off" />;
}

/** The picker of one condition. `set(value)` keeps it; null clears it. */
function Panel({ k, value, platform, set }: { k: ConditionKey; value: string; platform: Platform | null | undefined; set: (v: string | null, close?: boolean) => void }) {
  const [q, setQ] = useState("");
  const [text, setText] = useState(value);
  const query = q.trim().toLowerCase();
  if (k === "os") {
    const p = platform && platform !== "web" ? platform : "android";
    const word = p === "ios" ? "iOS" : "Android";
    return (
      <div className="qa-cv-panel-body">
        <div className="qa-cv-chips" role="radiogroup" aria-label="OS version">
          {OS_VERSIONS[p].map((v) => (
            <Card key={v} on={value === v || value === `${word} ${v}`} onPick={() => set(v, true)} label={`${word} ${v}`} className="qa-cv-chipcard">
              <span className="qa-cv-os-word">{word}</span><span className="qa-cv-os-num">{v}</span>
            </Card>
          ))}
        </div>
        <div className="qa-cv-row">
          <input className="qa-input" value={text} maxLength={40} placeholder="An exact version, like 13.0.1" aria-label="Exact version" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); set(text.trim() || null, true); } }} />
          <Button size="sm" onClick={() => set(text.trim() || null, true)}>Use</Button>
        </div>
        <p className="qa-cv-note">Orcha checks the device's version before the run. Pick a device that runs it on the Device tab.</p>
      </div>
    );
  }
  if (k === "locale") {
    const list = LOCALES.filter((c) => !query || `${c} ${nativeName(c)} ${localeWords(c)}`.toLowerCase().includes(query));
    const typed = q.trim() && LOCALE_RE.test(q.trim()) && !LOCALES.includes(q.trim()) ? q.trim() : null;
    const shown = value || list[0];
    return (
      <div className="qa-cv-panel-body">
        <Search value={q} onChange={setQ} placeholder="Search languages, or type a code like sw-KE" />
        <ul className="qa-plain qa-cv-list" role="radiogroup" aria-label="Language and region">
          {typed ? (
            <li><Card on={value === typed} onPick={() => set(typed, true)} label={typed} className="qa-cv-listcard"><span className="qa-cv-l1">Use {typed}</span><span className="qa-cv-l2">{localeWords(typed)}</span></Card></li>
          ) : null}
          {list.map((c) => (
            <li key={c}>
              <Card on={value === c} onPick={() => set(c, true)} label={localeWords(c)} className="qa-cv-listcard">
                <span className="qa-cv-l1">{nativeName(c)}</span>
                <span className="qa-cv-l2">{localeWords(c)}</span>
                <code className="qa-cv-code">{c}</code>
              </Card>
            </li>
          ))}
        </ul>
        {shown ? <p className="qa-cv-sample" aria-live="polite"><span className="qa-cv-note">In {localeWords(shown)} the app shows</span><span>{localeSample(shown)}</span></p> : null}
      </div>
    );
  }
  if (k === "text_size") {
    return (
      <div className="qa-cv-panel-body">
        <div className="qa-cv-grid5" role="radiogroup" aria-label="Text size">
          {TEXT_SIZES.map((s) => (
            <Card key={s} on={(value || "") === s} onPick={() => set(s, true)} label={cap(s)}>
              <span className="qa-cv-aa" style={{ fontSize: TEXT_PX[s] }}>Aa</span>
              <span className="qa-cv-cap">{cap(s)}</span>
              <span className="qa-cv-sub">{TEXT_PCT[s]}</span>
            </Card>
          ))}
        </div>
        <p className="qa-cv-note">The system text size: Android's font size, iOS's Dynamic Type, the browser's default font.</p>
      </div>
    );
  }
  if (k === "appearance") {
    return (
      <div className="qa-cv-panel-body">
        <div className="qa-cv-grid2" role="radiogroup" aria-label="Appearance">
          {(["light", "dark"] as const).map((a) => (
            <Card key={a} on={value === a} onPick={() => set(a, true)} label={cap(a)}>
              <Phone dark={a === "dark"} />
              <span className="qa-cv-cap">{a === "dark" ? <Moon size={14} /> : <Sun size={14} />} {cap(a)}</span>
            </Card>
          ))}
        </div>
      </div>
    );
  }
  if (k === "network") {
    const opts = [
      { key: "online" as const, title: "Online", sub: "A normal connection" },
      { key: "slow" as const, title: "Slow", sub: "About 3G: 400 ms, 400 kbps" },
      { key: "offline" as const, title: "Offline", sub: "No connection at all" },
    ];
    return (
      <div className="qa-cv-panel-body">
        <div className="qa-cv-grid3" role="radiogroup" aria-label="Network">
          {opts.map((o) => (
            <Card key={o.key} on={value === o.key} onPick={() => set(o.key, true)} label={o.title}>
              <NetworkBars level={o.key} />
              <span className="qa-cv-cap">{o.title}</span>
              <span className="qa-cv-sub">{o.sub}</span>
            </Card>
          ))}
        </div>
      </div>
    );
  }
  if (k === "timezone") {
    const list = ZONES.filter((z) => !query || z.toLowerCase().replace(/_/g, " ").includes(query));
    const typed = q.trim().includes("/") && !ZONES.includes(q.trim()) ? q.trim() : null;
    return (
      <div className="qa-cv-panel-body">
        <Search value={q} onChange={setQ} placeholder="Search time zones, or type one like Africa/Kampala" />
        <ul className="qa-plain qa-cv-list" role="radiogroup" aria-label="Time zone">
          {typed ? <li><Card on={value === typed} onPick={() => set(typed, true)} label={typed} className="qa-cv-listcard"><span className="qa-cv-l1">Use {typed}</span></Card></li> : null}
          {list.map((z) => {
            const now = zoneNow(z);
            return (
              <li key={z}>
                <Card on={value === z} onPick={() => set(z, true)} label={z} className="qa-cv-listcard">
                  <span className="qa-cv-l1">{z.split("/").pop()!.replace(/_/g, " ")}</span>
                  <span className="qa-cv-l2">{z.includes("/") ? z.split("/")[0] : "Coordinated"} · {now.offset}</span>
                  <span className="qa-cv-time">{now.time}</span>
                </Card>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  const long = k === "setup";
  const ideas = k === "account" ? ACCOUNTS : SETUPS;
  return (
    <div className="qa-cv-panel-body">
      <div className="qa-cv-ideas" aria-label="Suggestions">
        {ideas.map((i) => <button key={i} type="button" className={"qa-cv-idea" + (text === i ? " is-on" : "")} onClick={() => setText(i)}>{i}</button>)}
      </div>
      <textarea className="qa-input qa-cv-text" rows={long ? 3 : 2} maxLength={long ? 2000 : 300} value={text} aria-label={CONDITION_LABELS[k]}
        placeholder={long ? "Steps for the agent, in words. It can use its own tools, such as an MCP server." : "The kind of user, in words. Never a password."}
        onChange={(e) => setText(e.target.value)} />
      <div className="qa-cv-row is-end">
        <span className="qa-cv-note">{k === "account" ? "The agent fetches a matching account with its own tools, and never invents one." : "The agent does these before the checks."}</span>
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => set(text.trim(), true)}>Use</Button>
      </div>
    </div>
  );
}

export function ConditionsField({ value, onChange, platform, physical = false, disabled = false, label = "Conditions", hint = true, inherited }: {
  value: Conditions | null | undefined;
  onChange: (next: Conditions | null) => void;
  platform: Platform | null | undefined;
  /** The device is a physical phone: Orcha sets less there. */
  physical?: boolean;
  disabled?: boolean;
  label?: string;
  hint?: boolean;
  /** What the scenario already asks: shown, and a run's own conditions add to it. */
  inherited?: Conditions | null;
}) {
  const id = useId();
  const [open, setOpen] = useState<ConditionKey | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const c = cleanConditions(value) ?? {};
  const base = cleanConditions(inherited) ?? {};
  const native = nativeKeys(platform, physical);
  const off = unavailableKeys(platform, physical);
  const keys = useMemo(() => CONDITION_KEYS.filter((k) => !(k === "os" && platform === "web")), [platform]);
  const count = keys.filter((k) => c[k] || base[k]).length;
  useEffect(() => {
    if (open) panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [open]);
  const set = (k: ConditionKey, v: string | null, close = false) => {
    onChange(cleanConditions({ ...c, [k]: v }));
    if (close) setOpen(null);
  };
  return (
    <div className="qa-field qa-cond" data-qa-conditions>
      {label ? (
        <div className="qa-cv-head">
          <span className="qa-label" id={id}>{label}</span>
          <span className="qa-cv-count">{count ? `${count} set` : "None set"}</span>
        </div>
      ) : null}
      <div className="qa-cv-tiles" role="group" aria-labelledby={label ? id : undefined} aria-label={label ? undefined : "Conditions"}>
        {keys.map((k) => {
          const Icon = CONDITION_ICON[k];
          const mine = c[k] ? conditionWord(k, c, platform) : null;
          const theirs = !mine && base[k] ? conditionWord(k, base, platform) : null;
          const word = (mine ?? theirs)?.replace(/^(Text|Time zone|Account|Setup): /, "");
          return (
            <div key={k} className={"qa-cv-tile" + (mine ? " is-set" : theirs ? " is-base" : "") + (open === k ? " is-open" : "") + (off.has(k) ? " is-off" : "")} data-qa-condition={k}
              title={off.has(k) ? "A physical phone can't be set to this. Pick a simulator or an emulator." : undefined}>
              <button type="button" className="qa-cv-tile-btn" disabled={disabled || (off.has(k) && !mine)} aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>
                <span className="qa-cv-ico"><Icon size={15} /></span>
                <span className="qa-cv-tile-text">
                  <span className="qa-cv-tile-k">
                    <span>{CONDITION_LABELS[k]}</span>
                    <span className={"qa-cv-who" + (native.has(k) ? " is-orcha" : "") + (off.has(k) ? " is-off" : "")}>{off.has(k) ? "Not on a phone" : native.has(k) ? "Orcha" : "Agent"}</span>
                  </span>
                  <span className={"qa-cv-tile-v" + (word ? "" : " is-empty")} title={word ?? undefined}>{off.has(k) && !word ? "Simulator or emulator only" : word ?? "Any"}{theirs ? " · scenario" : ""}</span>
                </span>
              </button>
              {mine && !disabled ? <button type="button" className="qa-cv-clear" aria-label={`Clear ${CONDITION_LABELS[k].toLowerCase()}`} onClick={() => set(k, null)}><X size={12} /></button> : null}
            </div>
          );
        })}
      </div>
      {open ? (
        <div className="qa-cv-panel" ref={panelRef} data-qa-condition-panel={open}>
          <div className="qa-cv-panel-head">
            <span className="qa-cv-panel-title">{CONDITION_LABELS[open]}</span>
            <span className={"qa-cv-who" + (native.has(open) ? " is-orcha" : "")}>{native.has(open) ? "Orcha sets this on the device" : "The agent sets this up"}</span>
            <span className="qa-cv-spacer" />
            {c[open] ? <Button size="sm" variant="ghost" onClick={() => set(open, null, true)}>Clear</Button> : null}
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Done</Button>
          </div>
          <Panel key={open} k={open} value={String(c[open] ?? base[open] ?? "")} platform={platform} set={(v, close) => set(open, v, close)} />
        </div>
      ) : null}
      {hint ? <span className="qa-hint">{CONDITIONS_HINT}</span> : null}
    </div>
  );
}

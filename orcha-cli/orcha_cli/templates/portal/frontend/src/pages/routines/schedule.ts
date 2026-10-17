/**
 * Routine schedule presets ⇄ 5-field cron (pure, unit-tested).
 *
 * The backend (portal_backend/routine_schedule.py) is the authority: it validates,
 * computes next runs and returns the plain-English `schedule_text`. This module only
 * turns the dialog's preset controls into a cron string, reads a saved cron back into
 * presets, and mirrors the server's wording for an instant preview while the server
 * preview (/routines/preview) is in flight. The strings MUST match describe() there.
 */

export type Preset = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "advanced";

export interface ScheduleForm {
  preset: Preset;
  /** hourly: minute past the hour */
  minute: number;
  /** daily / weekdays / weekly / monthly: "HH:MM" */
  time: string;
  /** weekly: 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** monthly: 1–28 (every month has it) */
  monthDay: number;
  /** advanced: raw cron */
  cron: string;
}

export const PRESETS: { key: Preset; label: string }[] = [
  { key: "hourly", label: "Hourly" },
  { key: "daily", label: "Daily" },
  { key: "weekdays", label: "Weekdays" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "advanced", label: "Custom" },
];

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const DEFAULT_FORM: ScheduleForm = { preset: "weekdays", minute: 0, time: "09:00", weekday: 1, monthDay: 1, cron: "0 9 * * 1-5" };

function hm(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return [9, 0];
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return [h, mi];
}

const pad = (n: number) => String(n).padStart(2, "0");

export function toCron(f: ScheduleForm): string {
  const [h, m] = hm(f.time);
  switch (f.preset) {
    case "hourly": return `${Math.min(59, Math.max(0, Math.floor(f.minute) || 0))} * * * *`;
    case "daily": return `${m} ${h} * * *`;
    case "weekdays": return `${m} ${h} * * 1-5`;
    case "weekly": return `${m} ${h} * * ${((f.weekday % 7) + 7) % 7}`;
    case "monthly": return `${m} ${h} ${Math.min(28, Math.max(1, Math.floor(f.monthDay) || 1))} * *`;
    default: return f.cron.trim().split(/\s+/).join(" ");
  }
}

const NUM = /^\d{1,2}$/;

/** Read a saved cron back into the preset controls (advanced when it isn't a preset shape). */
export function fromCron(cron: string): ScheduleForm {
  const expr = (cron || "").trim().split(/\s+/).join(" ");
  const base: ScheduleForm = { ...DEFAULT_FORM, preset: "advanced", cron: expr };
  const f = expr.split(" ");
  if (f.length !== 5) return base;
  const [mi, hr, dom, mon, dow] = f;
  if (!NUM.test(mi) || mon !== "*") return base;
  const minute = Number(mi);
  if (hr === "*" && dom === "*" && dow === "*") return { ...base, preset: "hourly", minute };
  if (!NUM.test(hr)) return base;
  const time = `${pad(Number(hr))}:${pad(minute)}`;
  if (dom === "*" && dow === "*") return { ...base, preset: "daily", time };
  if (dom === "*" && (dow === "1-5" || dow.toUpperCase() === "MON-FRI")) return { ...base, preset: "weekdays", time };
  if (dom === "*" && /^[0-7]$/.test(dow)) return { ...base, preset: "weekly", time, weekday: Number(dow) % 7 };
  if (dow === "*" && NUM.test(dom) && Number(dom) >= 1 && Number(dom) <= 28) return { ...base, preset: "monthly", time, monthDay: Number(dom) };
  return base;
}

/** "Africa/Nairobi" → "Nairobi time"; "UTC" → "UTC" (mirrors routine_schedule.zone_label). */
export function zoneLabel(tz: string): string {
  if (["UTC", "Etc/UTC", "GMT", "Etc/GMT"].includes(tz)) return "UTC";
  const city = tz.split("/").pop() || tz;
  return `${city.replace(/_/g, " ")} time`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 10 && n % 100 <= 20 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] || "th";
  return `${n}${s}`;
}

/** Plain English for preset shapes; mirrors routine_schedule.describe (server wins when it answers). */
export function describeSchedule(cron: string, tz: string): string {
  const f = fromCron(cron);
  const zl = zoneLabel(tz);
  const at = f.time;
  switch (f.preset) {
    case "hourly": return `Every hour at :${pad(f.minute)}`;
    case "daily": return `Every day at ${at} ${zl}`;
    case "weekdays": return `Every weekday at ${at} ${zl}`;
    case "weekly": return `Every ${DAY_NAMES[f.weekday]} at ${at} ${zl}`;
    case "monthly": return `On the ${ordinal(f.monthDay)} of every month at ${at} ${zl}`;
    default: return `Custom schedule (${f.cron}) ${zl}`;
  }
}

/** Every IANA zone the browser knows (falls back to a short list on old engines). */
export function timeZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const all = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
    if (all.length) return all.includes("UTC") ? all : ["UTC", ...all];
  } catch { /* old engine */ }
  return ["UTC", "Africa/Nairobi", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"];
}

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A fire time rendered in the routine's own timezone, e.g. "Tue 30 Sep, 09:00". */
export function formatInZone(iso: string, tz: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  try {
    return d.toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return d.toLocaleString();
  }
}

/** Relative "in 3h" / "in 2d" for an upcoming time (absolute goes in the tooltip). */
export function relFuture(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.round((t - now) / 1000);
  if (s <= 60) return s < -60 ? "overdue" : "now";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/**
 * Calendar days in the viewer's time zone (#172). Charts bucket runs, results and issues by
 * day; bucketing in UTC put a run at 21:40 on 15 Oct in New York on 16 Oct. These helpers are
 * pure (no cookies, no I/O) so the server, the client and tests share them; the server reads
 * the viewer's zone from the `orcha_tz` cookie (`viewer-tz-server.ts`), which the client
 * sets from the browser (`components/shell/time-zone-sync.tsx`).
 */

/** Cookie holding the browser's IANA time zone (`America/New_York`). */
export const TZ_COOKIE = "orcha_tz";

/** The variable a Python process reads the person's zone from (`orcha.person_time`, #461). */
export const PYTHON_TZ_ENV = "ORCHA_TZ";

const DAY_MS = 86_400_000;

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone this process runs in (the server's, on the server). */
export function runtimeTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(zone, f);
  }
  return f;
}

function parts(ms: number, zone: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, min: out.minute, s: out.second };
}

/** Calendar day (`YYYY-MM-DD`) of instant `ms` in `zone`. */
export function zonedDay(ms: number, zone: string = "UTC"): string {
  if (zone === "UTC") return new Date(ms).toISOString().slice(0, 10);
  const { y, m, d } = parts(ms, zone);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Offset of `zone` from UTC at instant `ms`, in milliseconds (New York in October: -4 h). */
function offsetMs(ms: number, zone: string): number {
  const p = parts(ms, zone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant local midnight starts calendar day `day` (`YYYY-MM-DD`) in `zone`. */
export function zonedMidnight(day: string, zone: string = "UTC"): Date {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  if (zone === "UTC") return new Date(guess);
  // Two passes settle a midnight next to a daylight-saving change.
  let t = guess - offsetMs(guess, zone);
  t = guess - offsetMs(t, zone);
  return new Date(t);
}

/** `day` moved by `n` calendar days (`2026-10-15`, -1 gives `2026-10-14`). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Local midnight `days - 1` days before today in `zone`: the start of a `days`-day window. */
export function windowStart(days: number, now: Date = new Date(), zone: string = "UTC"): Date {
  return zonedMidnight(addDays(zonedDay(now.getTime(), zone), -(days - 1)), zone);
}

/** The zone a `Cookie` header's `orcha_tz` names, or null (none, or no real zone). */
export function zoneFromCookieHeader(header: string | null | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== TZ_COOKIE) continue;
    let zone: string;
    try {
      zone = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    return isValidTimeZone(zone) ? zone : null;
  }
  return null;
}

/** The person's zone for a route handler (#461): the request's `orcha_tz` cookie (the
 * browser's zone, `components/shell/time-zone-sync.tsx`), else this process's own. Dates a route
 * writes for the person (an exploration's "Deep dive · Oct 28") fall on their day. */
export function requestTimeZone(req: { headers: { get(name: string): string | null } }): string {
  return zoneFromCookieHeader(req.headers.get("cookie")) ?? runtimeTimeZone();
}

/** The environment that hands the person's zone to a Python process (`orcha.person_time`):
 * nothing for no zone, so Python falls back to the Mac's own. */
export function pythonTzEnv(zone: string | null | undefined): Record<string, string> {
  return isValidTimeZone(zone) ? { [PYTHON_TZ_ENV]: zone } : {};
}

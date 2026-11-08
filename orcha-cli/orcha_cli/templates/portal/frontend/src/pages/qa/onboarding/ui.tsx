/**
 * What the onboarding's screens import beside the shared kit (`../map/kit`, the same API as the
 * original's controls): the few pure helpers they share. Keeping the same names lets the screens
 * stay line-for-line with the original.
 */
import type { TargetKind } from "./types";

export { Button, Chip, Field, Input, ImageLightbox, Link, PlatformIcon, Select, StatusGlyph, Switch, buttonVariants, cn, usePrefersReducedMotion } from "../map/kit";

/* ---- text helpers ---------------------------------------------------------- */
export const PLATFORM_NAMES: Record<TargetKind, string> = { ios: "iOS", android: "Android", web: "Web" };
export const PLATFORM_TITLES: Record<TargetKind, string> = { ios: "iOS app", android: "Android app", web: "Website" };

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const FRAMEWORK_LABEL: Record<string, string> = {
  gherkin: "Gherkin", playwright: "Playwright", cypress: "Cypress", jest: "Jest", vitest: "Vitest", detox: "Detox",
  xcuitest: "XCUITest", xctest: "XCTest", "swift-testing": "Swift Testing", espresso: "Espresso", junit: "JUnit",
  maestro: "Maestro", pytest: "pytest", "page-object": "Page object",
};
export function frameworkLabel(fw: string): string {
  return FRAMEWORK_LABEL[fw] ?? fw;
}

/* ---- cost words ------------------------------------------------------------ */
function dollars(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const known = (usd: number | null | undefined): usd is number => usd != null && Number.isFinite(usd);

/** "≈$0.88 at API prices", "" when unknown. */
export function apiPriceLabel(usd: number | null | undefined): string {
  if (!known(usd)) return "";
  const d = dollars(usd);
  return `${d.startsWith("<") ? d : `≈${d}`} at API prices`;
}
/** "your Claude Code subscription"; "your subscription" stays as it is. */
export function subscriptionPhrase(subscription: string): string {
  const s = subscription.trim();
  if (/^your\b/i.test(s)) return s;
  return /subscription|plan$/i.test(s) ? `your ${s}` : `your ${s} subscription`;
}
export function notChargedTitle(subscription: string, usd?: number | null): string {
  const head = `Not charged: this runs on ${subscriptionPhrase(subscription)}.`;
  return known(usd) ? `${head} At API prices it would be ${dollars(usd)}.` : head;
}

/* ---- hosts ------------------------------------------------------------------ */
const LOCAL_TLDS = new Set(["local", "localhost", "test", "internal", "lan", "home", "example", "invalid"]);
const isIp = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
function isPrivateIp(host: string): boolean {
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  const p = host.split(".").map(Number);
  if (p.length !== 4) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 169 && p[1] === 254);
}
/** The lowercased hostname of `url` (a bare host is accepted), or "". */
export function hostOf(url: string | null | undefined): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}
export function isLocalHost(host: string): boolean {
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIp(host)) return isPrivateIp(host);
  return LOCAL_TLDS.has(host.split(".").pop() ?? "") || !host.includes(".");
}

/* ---- text with `code` ------------------------------------------------------- */
/** Backticked or launch-argument pieces of a sentence set as code. */
function codeSpans(text: string): { text: string; code: boolean }[] {
  return text.split(/(`[^`]+`)/).filter(Boolean).map((t) => (t.startsWith("`") && t.endsWith("`") ? { text: t.slice(1, -1), code: true } : { text: t, code: false }));
}
export function WithCode({ text }: { text: string }) {
  return (
    <>
      {codeSpans(text).map((part, i) =>
        part.code ? (
          <code key={i} className="rounded border border-border bg-panel-2 px-1 font-mono text-[0.92em] text-fg">{part.text}</code>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/* ---- navigation -------------------------------------------------------------- */
/** Quality is one page: a link out needs no way back. */
export function useWithReturn(): (href: string) => string {
  return (href) => href;
}

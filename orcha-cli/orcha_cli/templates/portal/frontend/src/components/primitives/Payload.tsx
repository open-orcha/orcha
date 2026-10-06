/**
 * Payload / KeyValue / ShortId — human-readable rendering of request,
 * notification and activity payloads (design directive D4: never raw JSON,
 * "{...}" or "[object Object]").
 *
 *   payloadTitle(p)   one-line human title: summary / question / title / … ,
 *                     else the first short string field, else the fallback.
 *   payloadText(p)    one-line plain text for search results / list previews.
 *   <Payload value>   title (optional) + long text as markdown + the remaining
 *                     fields as a labelled key-value list; ids render as
 *                     <ShortId> (mono, muted, copy); unknown / deep values go in
 *                     a collapsed disclosure (pretty-printed, labelled "Raw payload"
 *                     or by the value's own title).
 *   <KeyValue items>  the labelled list on its own (inspector metadata).
 *
 * Strings that contain JSON are parsed first, so a payload stored as a JSON
 * string renders exactly like the object.
 *
 * Links (D4/D8): `*_url` keys read as the noun ("pr_url" → "Pull request",
 * "url" → "Link"); a GitHub pull-request URL renders as a PR chip ("⟟ #102"),
 * a GitHub issue URL as an "#N" chip, any other URL as a short one-line link
 * (host/path, full URL in the tooltip) — never a long bare underlined URL.
 * GitHub PR / issue links in an object payload render INLINE at the end of the
 * title line (no "Pull request" label row); a matching pr_number is dropped.
 */
import { useState, type ReactNode } from "react";
import type { Task } from "../../types";
import { Md } from "../ui";
import { Button } from "./Button";
import { Chip, PrChip } from "./Chip";

/* ---- pure helpers --------------------------------------------------------- */
/** Keys that carry the human title, in priority order. */
export const TITLE_KEYS = ["summary", "question", "title", "subject", "headline", "name", "message", "prompt"] as const;
/** Keys that carry long-form body text (rendered as markdown). */
export const BODY_KEYS = ["body", "details", "description", "text", "content", "context", "message", "answer", "response", "reason", "notes", "rationale", "plan"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const URL_RE = /^https?:\/\/\S+$/;
const GH_REF_RE = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#]\S*)?$/i;

/** A GitHub pull-request / issue reference parsed from its web URL, else null. */
export function githubRef(url: string): { kind: "pull" | "issue"; owner: string; repo: string; number: number } | null {
  const m = GH_REF_RE.exec(url.trim());
  if (!m) return null;
  return { kind: m[3].toLowerCase() === "pull" ? "pull" : "issue", owner: m[1], repo: m[2], number: Number(m[4]) };
}

/** "https://www.example.com/a/b/" → "example.com/a/b" (display only; the href keeps the full URL). */
export function prettyUrl(url: string): string {
  return url.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

/** Parse a JSON-looking string into a value; anything else is returned as-is. */
export function normalizePayload(p: unknown): unknown {
  if (typeof p !== "string") return p;
  const s = p.trim();
  if (!s || !/^[[{]/.test(s)) return p;
  try { return JSON.parse(s); } catch { return p; }
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Human one-line title for a payload; `fallback` when nothing readable exists. */
export function payloadTitle(p: unknown, fallback = ""): string {
  const v = normalizePayload(p);
  if (v == null) return fallback;
  if (typeof v === "string") return clean(v) || fallback;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === "string" || isObj(x));
    return first != null ? payloadTitle(first, fallback) : fallback;
  }
  if (isObj(v)) {
    for (const k of TITLE_KEYS) {
      const x = v[k];
      if (typeof x === "string" && x.trim()) return clean(x);
    }
    for (const k of BODY_KEYS) {
      const x = v[k];
      if (typeof x === "string" && x.trim()) return clean(x);
    }
    for (const x of Object.values(v)) {
      if (typeof x === "string" && x.trim() && !UUID_RE.test(x) && !ISO_RE.test(x) && !URL_RE.test(x.trim())) return clean(x);
    }
  }
  return fallback;
}

/** One-line plain text for search/list previews: title, then the other readable strings. */
export function payloadText(p: unknown): string {
  const v = normalizePayload(p);
  if (!isObj(v)) return payloadTitle(v);
  const parts: string[] = [];
  const t = payloadTitle(v);
  if (t) parts.push(t);
  for (const [, x] of Object.entries(v)) {
    if (typeof x === "string" && x.trim() && !UUID_RE.test(x) && !ISO_RE.test(x)) {
      const c = clean(x);
      if (!parts.includes(c)) parts.push(c);
    }
  }
  return parts.join(" · ");
}

/** Link-key nouns that read better than their words ("pr_url" → "Pull request"). */
const LINK_KEY_RE = /(^|_)(url|link|href)$|(Url|URL|Link|Href)$|^(url|link|href)$/;
const LINK_NAMES: Record<string, string> = { pr: "Pull request", "pull request": "Pull request", html: "Link", web: "Link" };

/**
 * snake_case / camelCase / kebab → "Sentence case"; `_id` suffixes read as the
 * noun, and so do `_url` / `_link` suffixes ("pr_url" → "Pull request",
 * "docs_url" → "Docs", "url" → "Link") — never "Pr url".
 */
export function humanizeKey(k: string): string {
  const linkKey = /(^|_)(url|link|href)$|(Url|URL|Link|Href)$/.test(k);
  const s = k
    .replace(/_id$|Id$/, "")
    .replace(/(^|_)(url|link|href)$|(Url|URL|Link|Href)$/, "$1")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  if (!s) return linkKey ? "Link" : k;
  if (linkKey && LINK_NAMES[s]) return LINK_NAMES[s];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const isScalar = (x: unknown) => x == null || ["string", "number", "boolean"].includes(typeof x);
/** A value we can show inline without a raw dump. */
function isSimple(x: unknown, depth = 0): boolean {
  if (isScalar(x)) return true;
  if (Array.isArray(x)) return x.length <= 20 && x.every((y) => isScalar(y) || (depth < 1 && isObj(y) && isSimple(y, depth + 1)));
  if (isObj(x)) return depth < 1 && Object.keys(x).length <= 12 && Object.values(x).every((y) => isScalar(y) || (Array.isArray(y) && y.every(isScalar)));
  return false;
}

/* ---- ShortId -------------------------------------------------------------- */
export function ShortId({ id, len = 8, copy = true, label }: { id: string; len?: number; copy?: boolean; label?: string }) {
  const [done, setDone] = useState(false);
  const short = id.length > len + 1 ? id.slice(0, len) : id;
  return (
    <span className="v2-shortid">
      <code title={id}>{short}</code>
      {copy ? (
        <button
          type="button"
          className="v2-shortid-copy"
          aria-label={done ? "Copied" : `Copy ${label ?? "id"} ${id}`}
          title={done ? "Copied" : "Copy full id"}
          onClick={(e) => {
            e.stopPropagation();
            try { void navigator.clipboard?.writeText(id); } catch { /* insecure context */ }
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          }}
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {done ? <path d="M4 10.5 8 14l8-8.5" /> : <><rect x="6.5" y="6.5" width="9" height="9" rx="2" /><path d="M4.5 12.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" /></>}
          </svg>
        </button>
      ) : null}
    </span>
  );
}

/* ---- KeyValue ------------------------------------------------------------- */
export interface KVItem { key?: string; label: ReactNode; value: ReactNode; wide?: boolean }

export function KeyValue({ items, className, label }: { items: KVItem[]; className?: string; label?: string }) {
  const shown = items.filter((it) => it.value != null && it.value !== "" && it.value !== false);
  if (!shown.length) return null;
  return (
    <dl className={`v2-kv${className ? " " + className : ""}`} aria-label={label}>
      {shown.map((it, i) => (
        <div key={it.key ?? i} className={"v2-kv-row" + (it.wide ? " is-wide" : "")}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---- links ---------------------------------------------------------------- */
/** A URL as a D8 chip (GitHub PR / issue) or a short one-line external link. */
export function UrlValue({ url }: { url: string }) {
  const ref = githubRef(url);
  if (ref) {
    const what = ref.kind === "pull" ? "Pull request" : "Issue";
    const name = `${what} ${ref.owner}/${ref.repo}#${ref.number} (opens GitHub)`;
    return (
      <a className="v2-urlchip" href={url} target="_blank" rel="noopener noreferrer" title={url} aria-label={name}>
        {ref.kind === "pull" ? <PrChip number={ref.number} title={url} /> : <Chip title={url}>#{ref.number}</Chip>}
      </a>
    );
  }
  return (
    <a className="lnk v2-url" href={url} target="_blank" rel="noopener noreferrer" title={url}>
      {prettyUrl(url)}
    </a>
  );
}

/* ---- value renderer ------------------------------------------------------- */
function fmtDate(s: string): ReactNode {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return <time dateTime={s} title={s}>{d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>;
}

function Value({ v, tasks, k }: { v: unknown; tasks?: Task[]; k?: string }): ReactNode {
  if (v == null || v === "") return <span className="v2-muted">None</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return <span className="tnum">{v}</span>;
  if (typeof v === "string") {
    const s = v.trim();
    if (UUID_RE.test(s) || (k && /(^|_)id$/.test(k) && /^[\w-]{12,}$/.test(s))) return <ShortId id={s} label={k ? humanizeKey(k).toLowerCase() : undefined} />;
    if (ISO_RE.test(s)) return fmtDate(s);
    if (URL_RE.test(s)) return <UrlValue url={s} />;
    if (s.length > 80 || s.includes("\n")) return <Md className="tx md v2-kv-md" text={s} tasks={tasks} />;
    return s;
  }
  if (Array.isArray(v)) {
    if (!v.length) return <span className="v2-muted">None</span>;
    if (v.every((x) => typeof x === "string" || typeof x === "number")) {
      const short = v.every((x) => String(x).length <= 32);
      if (short && v.length <= 8) return v.map(String).join(", ");
      return <ul className="v2-kv-list">{v.map((x, i) => <li key={i}><Value v={x} tasks={tasks} /></li>)}</ul>;
    }
    return <ul className="v2-kv-list">{v.map((x, i) => <li key={i}><Value v={x} tasks={tasks} /></li>)}</ul>;
  }
  if (isObj(v)) {
    const t = payloadTitle(v);
    if (isSimple(v)) {
      return (
        <KeyValue
          className="v2-kv-nested"
          items={Object.entries(v).map(([kk, vv]) => ({ key: kk, label: humanizeKey(kk), value: <Value v={vv} tasks={tasks} k={kk} /> }))}
        />
      );
    }
    return <RawPayload value={v} label={t || "Details"} />;
  }
  return String(v);
}

/* ---- Raw payload disclosure ------------------------------------------------ */
export function RawPayload({ value, label = "Raw payload", defaultOpen = false }: { value: unknown; label?: string; defaultOpen?: boolean }) {
  let text = "";
  try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
  const [copied, setCopied] = useState(false);
  return (
    <details className="v2-raw" open={defaultOpen || undefined}>
      <summary>
        <svg className="v2-raw-chev" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7.5 5 12 10l-4.5 5" /></svg>
        {label}
      </summary>
      <div className="v2-raw-b">
        <pre><code>{text}</code></pre>
        <Button
          size="sm"
          variant="ghost"
          icon={copied ? "check" : "copy"}
          className="v2-raw-copy"
          onClick={() => {
            try { void navigator.clipboard?.writeText(text); } catch { /* insecure context */ }
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </details>
  );
}

/* ---- Payload -------------------------------------------------------------- */
export interface PayloadProps {
  value: unknown;
  /** show the derived title as a heading (default true) */
  showTitle?: boolean;
  /** keys never shown (e.g. ones the caller renders elsewhere) */
  exclude?: string[];
  /** extra label overrides, e.g. { eta: "Expected by" } */
  labels?: Record<string, string>;
  tasks?: Task[];
  /** shown when the payload is empty */
  empty?: ReactNode;
  className?: string;
  /** always offer the collapsed raw JSON (debugging); default only for unknown shapes */
  raw?: boolean;
}

export function Payload({ value, showTitle = true, exclude = [], labels = {}, tasks, empty, className, raw }: PayloadProps) {
  const v = normalizePayload(value);
  const cls = `v2-payload${className ? " " + className : ""}`;
  const isEmpty = v == null || v === "" || (isObj(v) && !Object.keys(v).length) || (Array.isArray(v) && !v.length);
  if (isEmpty) return empty ? <div className={cls}><p className="v2-payload-empty">{empty}</p></div> : null;

  if (typeof v === "string") return <div className={cls}><Md className="tx md v2-payload-body" text={v} tasks={tasks} /></div>;
  if (typeof v !== "object") return <div className={cls}><p className="v2-payload-body">{String(v)}</p></div>;
  if (Array.isArray(v)) {
    return (
      <div className={cls}>
        {isSimple(v) ? <Value v={v} tasks={tasks} /> : <RawPayload value={v} defaultOpen />}
      </div>
    );
  }

  const o = v as Obj;
  const skip = new Set(exclude);
  let titleKey: string | null = null;
  for (const k of TITLE_KEYS) {
    if (!skip.has(k) && typeof o[k] === "string" && (o[k] as string).trim() && (o[k] as string).length <= 240) { titleKey = k; break; }
  }
  const title = showTitle && titleKey ? clean(o[titleKey] as string) : null;
  if (title) skip.add(titleKey!);

  // GitHub PR / issue links ride inline after the title (D12: "Implemented… ⟟ #102"),
  // never as a nested "Pull request [#102]" key-value row; a pr_number that
  // repeats the linked PR's number is the same fact twice and is dropped.
  const refs: string[] = [];
  const refNums = new Set<number>();
  for (const [k, x] of Object.entries(o)) {
    if (skip.has(k) || typeof x !== "string" || !LINK_KEY_RE.test(k)) continue;
    const ref = githubRef(x);
    if (!ref) continue;
    refs.push(x.trim());
    refNums.add(ref.number);
    skip.add(k);
  }
  for (const [k, x] of Object.entries(o)) {
    if (!skip.has(k) && /^(pr|pull|issue)(_?num(ber)?|_?no)?$/i.test(k) && refNums.has(Number(x))) skip.add(k);
  }
  const refChips = refs.length ? (
    <span className="v2-payload-refs">{refs.map((u) => <UrlValue key={u} url={u} />)}</span>
  ) : null;

  const bodies: [string, string][] = [];
  const fields: KVItem[] = [];
  for (const [k, x] of Object.entries(o)) {
    if (skip.has(k)) continue;
    if (typeof x === "string" && (BODY_KEYS as readonly string[]).includes(k) && (x.length > 80 || x.includes("\n"))) {
      bodies.push([k, x]);
      continue;
    }
    fields.push({ key: k, label: labels[k] ?? humanizeKey(k), value: <Value v={x} tasks={tasks} k={k} /> });
  }

  return (
    <div className={cls}>
      {title ? <div className="v2-payload-title">{title}{refChips ? <>{" "}{refChips}</> : null}</div> : null}
      {bodies.map(([k, x]) => (
        <section key={k} className="v2-payload-sec" aria-label={labels[k] ?? humanizeKey(k)}>
          {bodies.length > 1 || fields.length ? <div className="v2-payload-label">{labels[k] ?? humanizeKey(k)}</div> : null}
          <Md className="tx md v2-payload-body" text={x} tasks={tasks} />
        </section>
      ))}
      {!title && refChips ? <div className="v2-payload-refline">{refChips}</div> : null}
      <KeyValue items={fields} />
      {raw ? <RawPayload value={o} /> : null}
    </div>
  );
}

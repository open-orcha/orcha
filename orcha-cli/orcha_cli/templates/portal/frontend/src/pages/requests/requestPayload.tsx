/**
 * Human-readable request payloads (D4). Requests carry a free-form `payload`
 * (and `response`) that is either prose or an arbitrary JSON object from the
 * agent. Nothing here ever renders raw JSON, "{...}" or "[object Object]" as
 * content:
 *   - title: the prose, or the object's summary/question/title-like field
 *   - remaining fields: a labeled key-value list (long text → markdown)
 *   - nested / unknown shapes: a collapsed, pretty-printed "Raw payload" block
 *
 * The backend stores `payload` / `response` as TEXT, so an agent's object
 * arrives as a JSON-encoded string: every entry point parses a JSON-looking
 * string first (`normalizePayload`), so it reads as fields, never as "{...}".
 *
 * Local to /requests (also used by the Needs-you queue via RequestDetail and
 * the exported `payloadText`) until a shared Payload primitive exists.
 */
import type { ReactNode } from "react";
import { Linkified, Md } from "../../components/ui";
import { Chip, StatusGlyph, normalizePayload } from "../../components/primitives";
import { shortId, taskByRef } from "../../lib/format";
import type { Task } from "../../types";

/** Fields that read as the "headline" of an object payload, in preference order. */
export const TITLE_KEYS = ["title", "question", "summary", "subject", "message", "body", "text", "prompt", "description", "ask"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);

/** "proposed_alias" / "dueAt" → "Proposed alias" / "Due at". */
export function humanKey(k: string): string {
  // a task reference field names the task, not its id (wave-4: "Task id [Review PR #212]")
  if (/^task[_-]?id$/i.test(k)) return "Task";
  const s = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : k;
}

/** The object's headline field (key + text), if any. */
export function headlineOf(p0: unknown): { key: string | null; text: string } | null {
  const p = normalizePayload(p0);
  if (p == null) return null;
  if (typeof p === "string") return p.trim() ? { key: null, text: p } : null;
  if (typeof p === "number" || typeof p === "boolean") return { key: null, text: String(p) };
  if (isObj(p)) {
    for (const k of TITLE_KEYS) {
      const v = p[k];
      if (typeof v === "string" && v.trim()) return { key: k, text: v };
    }
  }
  return null;
}

/** One-line scalar rendering for summaries (never JSON). */
function inlineValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.every(isScalar) ? v.map((x) => (x == null ? "—" : String(x))).join(", ") : v.length + (v.length === 1 ? " item" : " items");
  if (isObj(v)) { const n = Object.keys(v).length; return n + (n === 1 ? " field" : " fields"); }
  return "";
}

/**
 * Single-line human summary of a payload/response: the prose, the headline
 * field, or "Key: value · Key: value". Used for row subtitles, search results
 * and the Needs-you queue. Never returns JSON.
 */
export function payloadText(p0: unknown): string {
  const p = normalizePayload(p0);
  if (p == null) return "";
  const h = headlineOf(p);
  if (h) return h.text;
  if (Array.isArray(p)) return inlineValue(p);
  if (isObj(p)) {
    // only readable fields make a summary — nulls and nested objects don't
    const keys = Object.keys(p).filter((k) => {
      const v = p[k];
      return (typeof v === "string" && v.trim()) || typeof v === "number" || typeof v === "boolean" || (Array.isArray(v) && v.length > 0 && v.every(isScalar));
    });
    if (!keys.length) return "";
    return keys.slice(0, 4).map((k) => humanKey(k) + ": " + inlineValue(p[k])).join(" · ");
  }
  return "";
}

/** Headline for titles/crumbs: first line (and first sentence when long) of payloadText. */
export function payloadTitle(p: unknown, fallback = "Request"): string {
  const t = payloadText(p).replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  const firstLine = payloadText(p).split(/\n/).find((l) => l.trim())?.trim() ?? t;
  // first sentence when the prose has more than one; else the line, word-truncated past 110
  const m = firstLine.match(/^(.{20,110}?[.?!])(\s|$)/);
  const head = m && m[1].length < firstLine.length ? m[1]
    : firstLine.length <= 110 ? firstLine
    : firstLine.slice(0, 100).replace(/\s+\S*$/, "") + "…";
  return head.replace(/^#+\s*/, "");
}

/**
 * Detail-view headline for PROSE payloads: the first sentence (or first line)
 * when it is short enough to be a whole title (<= `max` chars), plus the rest
 * of the text — so the detail shows the title once and the description only
 * adds what the title didn't say (D12: no fact twice). Null for object
 * payloads or when the first sentence is too long to be a title.
 */
export function splitHeadline(p: unknown, max = 200): { title: string; rest: string } | null {
  if (typeof p !== "string") return null;
  const text = p.trim();
  if (!text) return null;
  const nl = text.indexOf("\n");
  const rawLine = (nl < 0 ? text : text.slice(0, nl)).trim();
  const line = rawLine.replace(/^#+\s*/, "");
  if (!line) return null;
  const m = line.match(/^(.{12,}?[.?!])(\s|$)/);
  const title = m ? m[1] : line;
  if (title.length > max) return null;
  const at = text.indexOf(title);
  const rest = at < 0 ? text : text.slice(at + title.length).trim();
  return { title, rest };
}

/** Default cap for a detail title (D12: a short title, the full text lives in the body). */
export const TITLE_MAX = 100;

/**
 * Detail title for a request payload: the first sentence of its prose /
 * headline field when it fits `max`, else the first line word-truncated with
 * "…". Never the whole multi-sentence question (the body carries the rest).
 */
export function requestTitle(p0: unknown, fallback = "Request", max = TITLE_MAX): string {
  const p = normalizePayload(p0);
  const h = headlineOf(p);
  const text = h ? h.text : payloadText(p);
  if (!text.trim()) return fallback;
  const sp = splitHeadline(text, max);
  if (sp) return sp.title;
  const line = (text.trim().split(/\n/).find((l) => l.trim()) ?? text).trim().replace(/^#+\s*/, "").replace(/\s+/g, " ");
  return line.length <= max ? line : line.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

/** A request-like row: its display title (code-thread questions carry one, lib/requestText.ts) wins. */
type Titled = { title?: string | null; payload: unknown };

/** List/crumb headline of a request: its display title, else payloadTitle. */
export function reqTitle(r: Titled, fallback = "Request"): string {
  const t = (r.title || "").trim();
  return t || payloadTitle(r.payload, fallback);
}

/** Detail headline of a request: its display title (capped at `max`), else requestTitle. */
export function reqDetailTitle(r: Titled, fallback = "Request", max = TITLE_MAX): string {
  const t = (r.title || "").trim();
  if (!t) return requestTitle(r.payload, fallback, max);
  return t.length <= max ? t : t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

/**
 * The payload with an already-shown title removed, so the body never repeats
 * it (D12). Strings drop the title prefix; objects drop it from their headline
 * field (keeping the rest of that field and every other field). `empty` = the
 * title was the whole payload. Null when the title isn't a clean prefix (e.g.
 * a truncated "…" title) — then the body shows the full payload.
 */
export function payloadAfterTitle(p0: unknown, title: string): { value: unknown; empty: boolean } | null {
  const p = normalizePayload(p0);
  const t = title.trim();
  if (!t) return null;
  const strip = (text: string): string | null => {
    const x = text.trim().replace(/^#+\s*/, "");
    if (x === t) return "";
    const sp = splitHeadline(text, Number.MAX_SAFE_INTEGER);
    return sp && sp.title === t ? sp.rest : null;
  };
  if (typeof p === "string") {
    const rest = strip(p);
    return rest == null ? null : { value: rest, empty: !rest };
  }
  if (isObj(p)) {
    const h = headlineOf(p);
    if (!h || !h.key) return null;
    const rest = strip(h.text);
    if (rest == null) return null;
    const next: Obj = {};
    for (const [k, v] of Object.entries(p)) {
      if (k === h.key) { if (rest) next[k] = rest; } else next[k] = v;
    }
    const left = Object.values(next).some((v) => v != null && v !== "" && !(Array.isArray(v) && !v.length));
    return { value: next, empty: !left };
  }
  return null;
}

/** Full-text search haystack: every string/number anywhere in the payload. */
export function payloadSearchText(p0: unknown): string {
  const p = normalizePayload(p0);
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (v == null || depth > 6) return;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") { out.push(String(v)); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (isObj(v)) for (const [k, x] of Object.entries(v)) { out.push(k); walk(x, depth + 1); }
  };
  walk(p, 0);
  return out.join("\n");
}

function pretty(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? ""; } catch { return ""; }
}

function Value({ v, tasks }: { v: unknown; tasks?: Task[] }): ReactNode {
  if (v == null || v === "") return <span className="rq-muted">—</span>;
  if (typeof v === "boolean") return <span>{v ? "Yes" : "No"}</span>;
  if (typeof v === "number") return <span className="rq-num">{v}</span>;
  if (typeof v === "string") {
    // a value that is exactly one task ref reads as a task chip (glyph + short id + title),
    // not the prose-style "[title]" brackets (those stay for refs inside prose, ISS-82)
    const ref = v.trim();
    const t = tasks && /^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(ref) ? taskByRef(tasks, ref) : null;
    if (t) {
      return (
        <a className="rq-tasklink" href={"/tasks?task=" + encodeURIComponent(t.id)} title={t.title || shortId(t.id)}>
          {t.status ? <StatusGlyph status={t.status} size={14} /> : null}
          <span className="rq-tasklink-id">{shortId(t.id)}</span>
          {t.title ? <span className="rq-tasklink-t">{t.title}</span> : null}
        </a>
      );
    }
    return v.length > 80 || /\n|`|\*\*|^\s*[-*]\s/m.test(v) ? <Md text={v} tasks={tasks} className="rq-md" /> : <Linkified text={v} tasks={tasks} />; // short values still linkify (ISS-44)
  }
  if (Array.isArray(v) && v.every(isScalar)) {
    if (!v.length) return <span className="rq-muted">none</span>;
    return (
      <span className="rq-chips">
        {v.map((x, i) => <Chip key={i} size="sm" className="rq-chip">{x == null ? "—" : String(x)}</Chip>)}
      </span>
    );
  }
  // one flat level of nesting reads fine as a nested list; deeper shapes live in "Raw payload"
  if (isObj(v) && Object.values(v).every((x) => isScalar(x) || (Array.isArray(x) && x.every(isScalar)))) {
    const ents = Object.entries(v);
    if (!ents.length) return <span className="rq-muted">none</span>;
    return (
      <dl className="rq-kv rq-kv-nested">
        {ents.map(([k, x]) => (
          <div key={k} className="rq-kv-row"><dt title={k}>{humanKey(k)}</dt><dd><Value v={x} tasks={tasks} /></dd></div>
        ))}
      </dl>
    );
  }
  return <span className="rq-muted">{inlineValue(v)} · see raw payload</span>;
}

const flatEnough = (v: unknown) =>
  isScalar(v) || (Array.isArray(v) && v.every(isScalar)) ||
  (isObj(v) && Object.values(v).every((x) => isScalar(x) || (Array.isArray(x) && x.every(isScalar))));

/**
 * Rendered payload/response block. `hideHeadline` drops the headline field when
 * the view already shows it verbatim as its title.
 */
export function PayloadView({ value: value0, tasks, hideHeadline, className, testClass }: {
  value: unknown; tasks?: Task[]; hideHeadline?: boolean; className?: string; testClass?: string;
}) {
  const value = normalizePayload(value0);
  const cls = "rq-payload" + (testClass ? " " + testClass : "") + (className ? " " + className : "");
  if (value == null || value === "") return <div className={cls}><span className="rq-muted">Empty</span></div>;
  if (typeof value === "string") {
    return <div className={cls}>{hideHeadline ? null : <Md text={value} tasks={tasks} className="rq-md" />}</div>;
  }
  if (!isObj(value)) {
    // top-level arrays / numbers: scalar lists read fine inline, anything else is raw
    return (
      <div className={cls}>
        {Array.isArray(value) && !value.every(isScalar) ? <RawBlock value={value} open /> : <Value v={value} tasks={tasks} />}
      </div>
    );
  }
  const h = headlineOf(value);
  const rest = Object.entries(value).filter(([k]) => !h || k !== h.key);
  const lossy = rest.some(([, v]) => !flatEnough(v));
  return (
    <div className={cls}>
      {h && !hideHeadline ? <Md text={h.text} tasks={tasks} className="rq-md rq-lead" /> : null}
      {rest.length ? (
        <dl className="rq-kv">
          {rest.map(([k, v]) => (
            <div key={k} className="rq-kv-row">
              <dt title={k}>{humanKey(k)}</dt>
              <dd><Value v={v} tasks={tasks} /></dd>
            </div>
          ))}
        </dl>
      ) : null}
      {lossy || (!h && !rest.length) ? <RawBlock value={value} /> : null}
    </div>
  );
}

function RawBlock({ value, open }: { value: unknown; open?: boolean }) {
  return (
    <details className="rq-raw" open={open}>
      <summary>Raw payload</summary>
      <pre className="rq-code">{pretty(value)}</pre>
    </details>
  );
}

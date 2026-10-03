/**
 * Formatting helpers ported from app.js: esc/trunc/shortId/relTime/clockTime,
 * the ISS-44 linkify, the safe inline-markdown subset (mdText), and the ISS-82
 * task-ref chips (taskRefs/taskByRef). linkify/mdText return TRUSTED HTML
 * (esc() runs first) for use with dangerouslySetInnerHTML via <Md>/<Linkified>.
 * Task-ref chips link into the hash router (/tasks?task=...).
 */
import type { Task } from "../types";

export const esc = (s: unknown): string =>
  (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export const trunc = (s: string | null | undefined, n: number): string => {
  const v = s || "";
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};

export const shortId = (s: unknown): string => (s ? String(s).slice(0, 8) : "—");

/** Relative time, both directions: "just now", "5m ago" for the past and
 *  "in 30m" for the future (screen review: a future expiry used to render
 *  "just now" because negative diffs were clamped). Invalid → "—". */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = (Date.now() - t) / 1000;
  const a = Math.abs(diff);
  if (a < 5) return "just now";
  const n =
    a < 60 ? Math.floor(a) + "s"
    : a < 3600 ? Math.floor(a / 60) + "m"
    : a < 86400 ? Math.floor(a / 3600) + "h"
    : Math.floor(a / 86400) + "d";
  return diff < 0 ? "in " + n : n + " ago";
}

/** Bytes on disk for people: "512 B", "20.1 MB", "2.3 GB". Unknown → "—". */
export function formatSize(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return Math.round(n) + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? Math.round(v).toString() : v.toFixed(1)) + " " + units[i];
}

/** A deadline (e.g. request expires_at) for display: "in 30m" / "overdue by 2h"
 *  plus an `overdue` flag so callers can style it. Null when there is none. */
export function deadlineLabel(iso: string | null | undefined): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  if (t > Date.now()) return { text: relTime(iso), overdue: false };
  const r = relTime(iso);
  return { text: r === "just now" ? "expired just now" : "overdue by " + r.replace(/ ago$/, ""), overdue: true };
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// ISS-83 recency band (12h window): 0 = recent, 1 = older; sort key between
// status and priority.
const RECENCY_WINDOW_MS = 12 * 60 * 60 * 1000;
export function recencyTs(...isos: (string | null | undefined)[]): number {
  let max = 0;
  for (const iso of isos) {
    const t = Date.parse(iso || "");
    if (t > max) max = t;
  }
  return max;
}
export function recencyBand(...isos: (string | null | undefined)[]): number {
  const ts = recencyTs(...isos);
  return ts && Date.now() - ts <= RECENCY_WINDOW_MS ? 0 : 1;
}

export function hue(s: string | null | undefined): number {
  let h = 0;
  for (const c of s || "") h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/* ---- ISS-82 task-ref chips ---------------------------------------------- */
export function taskByRef(tasks: Task[], token: string): Task | null {
  if (!token) return null;
  const tok = String(token).toLowerCase();
  const exact = tasks.find((t) => String(t.id).toLowerCase() === tok);
  if (exact) return exact;
  if (tok.length >= 8 && tok.length < 36) {
    let hit: Task | null = null,
      n = 0;
    for (const t of tasks) {
      if (String(t.id).toLowerCase().startsWith(tok)) {
        hit = t;
        if (++n > 1) return null;
      }
    }
    if (n === 1) return hit;
  }
  return null;
}

const TASK_REF_RE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;
// tag-aware + anchor-aware rewrite of ALREADY-ESCAPED html (see app.js taskRefs).
export function taskRefs(html: string, tasks: Task[]): string {
  if (html == null) return "";
  let inAnchor = false;
  return String(html)
    .split(/(<[^>]*>)/)
    .map((seg) => {
      if (seg.charAt(0) === "<") {
        const lt = seg.toLowerCase();
        if (lt.indexOf("<a") === 0) inAnchor = true;
        else if (lt.indexOf("</a") === 0) inAnchor = false;
        return seg;
      }
      if (inAnchor) return seg;
      return seg.replace(TASK_REF_RE, (tok) => {
        const t = taskByRef(tasks, tok);
        if (!t) return tok;
        return `<a class="tref" href="/tasks?task=${encodeURIComponent(t.id)}" title="task ${esc(tok)}">[${esc(t.title)}]</a>`;
      });
    })
    .join("");
}

/* ---- portal paths → link chips ---------------------------------------------
 * A bare portal-relative path in prose ("/code?path=a.ts&thread=…",
 * "/tasks?task=…", "/requests?req=…", "/agents") renders as a compact link
 * chip naming where it goes ("Open thread in Code"), never as a raw URL. Only
 * the portal's own sections match, only at a word start (never inside an
 * http URL or a longer path like /code/foo or /codex), and trailing
 * punctuation stays outside. Runs on ALREADY-ESCAPED text: the href keeps the
 * escaping (valid in an attribute) and the label is re-escaped. The cid link
 * interceptor (lib/scope.ts) adds project scope on click. */
const PORTAL_SECTIONS: Record<string, string> = {
  code: "Code", tasks: "Tasks", requests: "Requests", agents: "Agents", needs: "Needs you",
  activity: "Activity", routines: "Routines", github: "GitHub", metrics: "Metrics",
  members: "Members", settings: "Settings",
};
const PORTAL_PATH_RE = /(^|[\s(])(\/(?:code|tasks|requests|agents|needs|activity|routines|github|metrics|members|settings)(?:\?[^\s<]*)?)(?=[\s<).,;:!?]|$)/gm;
const LINK_ICON =
  '<svg class="v2-ico plink-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 12.5 13 7M8.5 7H13v4.5"/></svg>';

/** What a portal path opens, in words ("Open thread in Code"). `path` is raw (unescaped). */
export function portalLinkLabel(path: string, tasks: Task[] = []): string {
  const qi = path.indexOf("?");
  const section = (qi < 0 ? path : path.slice(0, qi)).replace(/^\//, "");
  let q: URLSearchParams;
  try { q = new URLSearchParams(qi < 0 ? "" : path.slice(qi + 1)); } catch { q = new URLSearchParams(); }
  const name = PORTAL_SECTIONS[section] || section;
  if (section === "code") {
    if (q.get("thread")) return "Open thread in Code";
    const p = q.get("path");
    if (p) return "Open " + (p.replace(/\/+$/, "").split("/").pop() || p) + " in Code";
    return "Open Code";
  }
  if (section === "tasks" && q.get("task")) {
    const t = taskByRef(tasks, q.get("task") as string);
    return t && t.title ? "Open task · " + trunc(t.title, 48) : "Open task " + shortId(q.get("task"));
  }
  if (section === "requests" && q.get("req")) return "Open request " + shortId(q.get("req"));
  if (section === "agents" && q.get("agent")) return "Open agent " + q.get("agent");
  if (section === "github" && q.get("pr")) return "Open PR #" + q.get("pr");
  if (section === "github" && q.get("issue")) return "Open issue #" + q.get("issue");
  return "Open " + name;
}

/** One chip for an ESCAPED portal path (see PORTAL_PATH_RE). */
function portalChip(escPath: string, tasks: Task[]): string {
  const raw = unesc(escPath);
  return `<a class="lnk plink v2-chip v2-chip-sm is-interactive" href="${escPath}" title="${escPath}">${LINK_ICON}<span class="v2-chip-text">${esc(portalLinkLabel(raw, tasks))}</span></a>`;
}

/** Replace bare portal paths in ESCAPED text with chips; `wrap` lets mdText stash them. */
function portalPaths(s: string, tasks: Task[], wrap: (html: string) => string = (h) => h): string {
  return s.replace(PORTAL_PATH_RE, (_m, lead: string, p: string) => {
    let tail = "";
    const t = p.match(/[)\].,;:!?]+$/);
    if (t && p.indexOf("?") >= 0) {
      tail = p.slice(p.length - t[0].length);
      p = p.slice(0, p.length - t[0].length);
    }
    return lead + wrap(portalChip(p, tasks)) + tail;
  });
}

/* ---- ISS-44 linkify (esc first; anchors escape-proof) -------------------- */
export const linkify = (s: unknown, tasks: Task[] = []): string =>
  taskRefs(
    portalPaths(
      esc(s == null ? "" : String(s)).replace(/https?:\/\/[^\s<]+/g, (m) => {
        let tail = "";
        const t = m.match(/[)\].,;:!?]+$/);
        if (t) {
          tail = m.slice(m.length - t[0].length);
          m = m.slice(0, m.length - t[0].length);
        }
        return `<a class="lnk" href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>${tail}`;
      }),
      tasks,
    ),
    tasks,
  );

/* ---- markdown links [text](href) ------------------------------------------
 * Runs on ALREADY-ESCAPED text (esc() first), so `text` and `href` can never
 * carry markup; `"` is &quot; and cannot break out of the attribute.
 *  - http(s) and mailto: an external anchor (new tab for http).
 *  - a relative path (docs/a.md, ./x, ../y, /README.md): an in-app anchor to
 *    Code Space (/code?path=...; the cid link interceptor adds scope) that
 *    also carries data-md-path with the path AS WRITTEN, so a renderer that
 *    knows the current file (MdRenderedPane) can resolve it relative to that
 *    file instead of the repo root.
 *  - a bare #fragment: plain text (no page to go to; never a dead link).
 *  - any other scheme (javascript:, data:, vbscript:, file:, //host ...):
 *    dropped — only the link text is kept.
 * Images ![alt](src) are left alone. An optional "title" is ignored. */
const MD_LINK_RE = /(?<!!)\[([^\]\n]+)\]\(([^\s()]+)(?:\s+&quot;[^\n]*?&quot;)?\)/g;

const unesc = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] as string);

/** The repo path a relative markdown href points at (raw text, not HTML):
 *  fragment/query dropped, leading ./ and / removed. `href` is escaped. */
export function mdLinkPath(href: string): string {
  const raw = unesc(href).replace(/[#?].*$/, "");
  return raw.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
}

function mdLink(text: string, href: string): string {
  if (/^(?:https?:\/\/|mailto:)/i.test(href)) {
    const ext = /^https?:/i.test(href);
    return `<a class="lnk" href="${href}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
  }
  // any other scheme, or protocol-relative //host — refuse to link
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || /^\/\//.test(href)) return text;
  if (href.charAt(0) === "#") return text;
  const path = mdLinkPath(href);
  if (!path) return text;
  return `<a class="lnk md-rel" href="/code?path=${encodeURIComponent(path)}" data-md-path="${href}" title="${esc(path)}">${text}</a>`;
}

/* ---- safe inline-markdown subset (port of app.js mdText) ----------------- */
export const mdText = (src: unknown, tasks: Task[] = []): string => {
  let s = esc(src == null ? "" : String(src));
  const stash: string[] = [];
  const Z = String.fromCharCode(0);
  const keep = (html: string) => {
    stash.push(html);
    return Z + (stash.length - 1) + Z;
  };
  s = s.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code: string) => keep(`<pre class="md-pre"><code>${code.replace(/\n+$/, "")}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code class="md-code">${code}</code>`));
  {
    const splitRow = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const isDelim = (line: string | undefined) => line != null && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
    const cell = (c: string, tag: string, al: string) => `<${tag}${al ? ` style="text-align:${al}"` : ""}>${c}</${tag}>`;
    const lines = s.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("|") >= 0 && isDelim(lines[i + 1])) {
        const head = splitRow(lines[i]);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const L = c.startsWith(":"), R = c.endsWith(":");
          return L && R ? "center" : R ? "right" : L ? "left" : "";
        });
        const rows: string[][] = [];
        let j = i + 2;
        for (; j < lines.length && lines[j].indexOf("|") >= 0 && lines[j].trim() !== ""; j++) rows.push(splitRow(lines[j]));
        const thead = "<tr>" + head.map((c, k) => cell(c, "th", aligns[k])).join("") + "</tr>";
        const tbody = rows.map((r) => "<tr>" + head.map((_, k) => cell(r[k] == null ? "" : r[k], "td", aligns[k])).join("") + "</tr>").join("");
        out.push(`<table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
        i = j - 1;
      } else {
        out.push(lines[i]);
      }
    }
    s = out.join("\n");
  }
  // [text](href) — BEFORE bare-URL linkify so the href is not linked twice.
  s = s.replace(MD_LINK_RE, (_m, text: string, href: string) => keep(mdLink(text, href)));
  s = s.replace(/https?:\/\/[^\s<]+/g, (m) => {
    let tail = "";
    const t = m.match(/[)\].,;:!?]+$/);
    if (t) {
      tail = m.slice(m.length - t[0].length);
      m = m.slice(0, m.length - t[0].length);
    }
    return keep(`<a class="lnk" href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`) + tail;
  });
  s = portalPaths(s, tasks, keep);
  s = s.replace(/\*\*(?!\s)([^\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?!\s)([^\n_]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");
  s = s.replace(/^\s{0,3}#{1,3}\s+(.+)$/gm, '<span class="md-h">$1</span>');
  // task-list items BEFORE the generic bullet rule (which would swallow the [ ]).
  s = s.replace(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm, (_m, chk: string, body: string) =>
    `<span class="md-li md-task"><span class="md-cb${/x/i.test(chk) ? " on" : ""}" aria-hidden="true"></span>${body}</span>`);
  s = s.replace(/^\s*[-*]\s+(.+)$/gm, '<span class="md-li">$1</span>');
  // ordered lists: 1. / 1) — GitHub bodies lean on these heavily.
  s = s.replace(/^\s*(\d{1,3})[.)]\s+(.+)$/gm, '<span class="md-li md-oli"><span class="md-num">$1.</span>$2</span>');
  s = taskRefs(s, tasks);
  return s.replace(new RegExp(Z + "(\\d+)" + Z, "g"), (_m, i: string) => stash[+i]);
};

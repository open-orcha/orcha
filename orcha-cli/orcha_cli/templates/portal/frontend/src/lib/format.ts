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

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return Math.floor(diff) + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
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

/* ---- ISS-44 linkify (esc first; anchors escape-proof) -------------------- */
export const linkify = (s: unknown, tasks: Task[] = []): string =>
  taskRefs(
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
  );

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
  s = s.replace(/https?:\/\/[^\s<]+/g, (m) => {
    let tail = "";
    const t = m.match(/[)\].,;:!?]+$/);
    if (t) {
      tail = m.slice(m.length - t[0].length);
      m = m.slice(0, m.length - t[0].length);
    }
    return keep(`<a class="lnk" href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`) + tail;
  });
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

/**
 * Learn — pure lesson model. Turns an agent's teach/why answer (markdown) into a
 * stepped LESSON: title, one-line summary, ordered steps (each with the line refs
 * it cites), key concepts, and follow-up questions.
 *
 * The agent is nudged toward this exact shape by the wake payload
 * (portal_backend/code_space_routes.py LESSON_FORMAT_GUIDE):
 *
 *   # Title
 *   > one-line summary
 *   ## Steps
 *   1. **Step title** (L24-32) what those lines do…
 *   ## Key concepts
 *   - concept
 *   ## Follow-ups
 *   - question?
 *
 * but nothing here REQUIRES it: an answer without a step list falls back to one
 * step per paragraph (structured=false), and every step — structured or not —
 * carries whatever line refs its text contains, so a plain prose answer still
 * highlights the lines it talks about. No DOM, no fetch.
 */

export interface LineRef {
  start: number;
  end: number;
  /** A file named by the ref itself (`file.ts:24`); undefined = the lesson's own file. */
  path?: string;
  /** The exact matched text, for rendering the chip. */
  label: string;
}

export interface LessonStep {
  title: string;
  /** Markdown body (the step text minus its title / leading ref). */
  body: string;
  refs: LineRef[];
}

export interface Lesson {
  title: string;
  summary: string;
  steps: LessonStep[];
  concepts: string[];
  followUps: string[];
  /** true when the answer used the numbered step format; false = paragraph fallback. */
  structured: boolean;
}

const DASH = "[-–—]"; // hyphen, en dash, em dash
const MAX_LINE = 1_000_000;

function mkRef(a: number, b: number | undefined, label: string, path?: string): LineRef | null {
  if (!Number.isFinite(a) || a < 1 || a > MAX_LINE) return null;
  let end = b != null && Number.isFinite(b) ? b : a;
  if (end < a) end = a; // "L32-24" typo → just the start line
  return path ? { start: a, end, path, label } : { start: a, end, label };
}

/**
 * Every line reference in `text`, in order of appearance, de-duplicated.
 * Recognised: `L24`, `L24-32`, `L24-L32`, `#L24-L32`, `line 24`, `lines 24–32`,
 * `lines 24 to 32`, `lines 24 and 25`, `file.ts:24`, `path/to/file.ts:24-32`.
 * A `file:line` ref whose basename is the current file is folded into a local ref.
 */
export function parseLineRefs(text: string, currentPath?: string): LineRef[] {
  if (!text) return [];
  const hits: { at: number; ref: LineRef }[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const push = (at: number, len: number, ref: LineRef | null) => {
    if (!ref || overlaps(at, at + len)) return;
    taken.push([at, at + len]);
    hits.push({ at, ref });
  };
  const curBase = currentPath ? baseName(currentPath) : "";

  // 1) path:line[-line] — must run first so "Shell.tsx:24" isn't also read as a bare number.
  const fileRe = new RegExp(String.raw`([\w@./-]*\w\.[A-Za-z0-9]{1,8}):L?(\d+)(?:\s*${DASH}\s*L?(\d+))?`, "g");
  for (const m of text.matchAll(fileRe)) {
    const file = m[1];
    const local = !!curBase && (file === currentPath || baseName(file) === curBase);
    push(m.index!, m[0].length, mkRef(+m[2], m[3] ? +m[3] : undefined, m[0], local ? undefined : file));
  }
  // 2) L24 / L24-32 / L24-L32 / #L24-L32 (not inside a word: "HTML5" is not a ref)
  const lRe = new RegExp(String.raw`(?<![\w])#?L(\d+)(?:\s*${DASH}\s*L?(\d+))?(?![\w])`, "g");
  for (const m of text.matchAll(lRe)) push(m.index!, m[0].length, mkRef(+m[1], m[2] ? +m[2] : undefined, m[0]));
  // 3) line 24 / lines 24-32 / lines 24 to 32 / lines 24 and 25
  const wordRe = new RegExp(String.raw`\blines?\s+(\d+)(?:\s*(?:${DASH}|to|through|and)\s*(\d+))?`, "gi");
  for (const m of text.matchAll(wordRe)) push(m.index!, m[0].length, mkRef(+m[1], m[2] ? +m[2] : undefined, m[0]));

  hits.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: LineRef[] = [];
  for (const { ref } of hits) {
    const key = (ref.path ?? "") + ":" + ref.start + "-" + ref.end;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Refs that point at the lesson's own file (no path, or the same path). */
export function localRefs(refs: LineRef[], currentPath?: string): LineRef[] {
  return refs.filter((r) => !r.path || (currentPath != null && (r.path === currentPath || baseName(r.path) === baseName(currentPath))));
}

/**
 * Where a step points the editor: its local refs on the lesson's own file, else
 * (a step that only cites ANOTHER file) the first other file it names with all
 * of that file's ranges. null = the step cites no lines at all. Full-page mode
 * follows this target across files; the rail only ever glows the local file.
 */
export function stepTarget(step: Pick<LessonStep, "refs"> | null | undefined, lessonPath: string): { path: string; ranges: { start: number; end: number }[] } | null {
  if (!step) return null;
  const local = localRefs(step.refs, lessonPath);
  if (local.length) return { path: lessonPath, ranges: local.map((r) => ({ start: r.start, end: r.end })) };
  const other = step.refs.find((r) => !!r.path);
  if (!other || !other.path) return null;
  const same = step.refs.filter((r) => r.path === other.path);
  return { path: other.path, ranges: same.map((r) => ({ start: r.start, end: r.end })) };
}

export function refLabel(r: { start: number; end: number }): string {
  return r.start === r.end ? "L" + r.start : "L" + r.start + "–" + r.end;
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/* ---- markdown sectioning -------------------------------------------------- */

type SectionKey = "steps" | "concepts" | "followups" | "summary" | "other";

function sectionKeyOf(heading: string): SectionKey {
  const h = heading.toLowerCase().replace(/[^a-z ]/g, " ").trim();
  if (/\b(steps?|walk ?through|walkthrough|tour|how it works)\b/.test(h)) return "steps";
  if (/\b(key )?concepts?\b|\bkey ideas?\b|\bterms\b|\bglossary\b/.test(h)) return "concepts";
  if (/\bfollow ?ups?\b|\bnext questions?\b|\bquestions\b|\bgo deeper\b|\bdig deeper\b|\bask next\b/.test(h)) return "followups";
  if (/\b(summary|tl ?dr|in short)\b/.test(h)) return "summary";
  return "other";
}

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const NUM_ITEM_RE = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const BULLET_RE = /^\s{0,3}[-*+•]\s+(.*)$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;

function stripMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^\s*[*_]+|[*_]+\s*$/g, "").trim();
}

/** Split "**Title** (L24-32) — body" / "Title: body" into {title, body}. */
function splitStepHead(first: string): { title: string; rest: string } {
  const bold = first.match(/^\s*\*\*(.+?)\*\*\s*(.*)$/) || first.match(/^\s*__(.+?)__\s*(.*)$/);
  if (bold) return { title: bold[1].replace(/[:.]\s*$/, "").trim(), rest: bold[2] };
  const colon = first.match(/^([^:.!?]{3,70})[:—–]\s+(.+)$/);
  if (colon && !/\d$/.test(colon[1]) && !/^(line|lines|L)\b/i.test(colon[1])) return { title: colon[1].trim(), rest: colon[2] };
  return { title: "", rest: first };
}

/** Drop a leading "(L24-32)" / "— " glue that sits between a step title and its body. */
function tidyRest(rest: string): string {
  return rest.replace(/^\s*\(([^)]*)\)\s*/, (all, inner: string) => (/\d/.test(inner) && /^(#?L|lines?\s|[\w./-]+:)/i.test(inner.trim()) ? "" : all))
    .replace(/^\s*[—–:-]\s*/, "")
    .trim();
}

function firstSentence(text: string, max = 90): string {
  const clean = stripMd(text.replace(/\s+/g, " "));
  const m = clean.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1] : clean).trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const ln of lines) {
    if (FENCE_RE.test(ln)) {
      fence = !fence;
      cur.push(ln);
      continue;
    }
    if (!fence && !ln.trim()) {
      if (cur.length) out.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur.push(ln);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out.map((p) => p.trim()).filter(Boolean);
}

/**
 * Parse an agent's answer into a Lesson. `opts.path` is the lesson's file (used to
 * fold `thatFile.ts:24` refs into local refs); `opts.fallbackTitle` is used when the
 * answer has no `# heading` (e.g. the question itself).
 */
export function parseLesson(markdown: string, opts: { path?: string; fallbackTitle?: string } = {}): Lesson {
  const src = (markdown || "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  let title = "";
  let summary = "";
  const sections: Record<SectionKey, string[]> = { steps: [], concepts: [], followups: [], summary: [], other: [] };
  let cur: SectionKey = "other";
  let fence = false;

  for (const raw of lines) {
    if (FENCE_RE.test(raw)) fence = !fence;
    const h = !fence ? raw.match(HEADING_RE) : null;
    if (h) {
      const level = h[1].length;
      const text = stripMd(h[2]);
      if (level === 1 && !title) { title = text; cur = "other"; continue; }
      const key = sectionKeyOf(text);
      if (key !== "other") { cur = key; continue; }
      if (!title && level <= 2) { title = text; cur = "other"; continue; }
      // an unrecognised sub-heading inside the steps section is a step title
      if (cur === "steps") { sections.steps.push("1. **" + text + "**"); continue; }
      cur = "other";
      sections.other.push(raw);
      continue;
    }
    if (!fence && !summary && /^\s{0,3}>\s?/.test(raw) && cur !== "steps") {
      summary = stripMd(raw.replace(/^\s{0,3}>\s?/, ""));
      continue;
    }
    sections[cur].push(raw);
  }

  const listItems = (ls: string[]): string[] => {
    const items: string[] = [];
    for (const ln of ls) {
      const b = ln.match(BULLET_RE) || ln.match(NUM_ITEM_RE);
      const text = b ? (b.length === 3 ? b[2] : b[1]) : null;
      if (text != null) items.push(text.trim());
      else if (ln.trim() && items.length) items[items.length - 1] += " " + ln.trim();
    }
    return items.map((s) => stripMd(s)).filter(Boolean);
  };

  // Steps: the numbered list under a Steps heading, else ANY numbered list in the body.
  const stepSource = sections.steps.length ? sections.steps : sections.other;
  const numbered = collectNumbered(stepSource);
  const structured = numbered.length >= 2 || (sections.steps.length > 0 && numbered.length >= 1);

  let steps: LessonStep[];
  if (structured) {
    steps = numbered.map((item) => {
      const [first, ...restLines] = item.split("\n");
      const { title: t, rest } = splitStepHead(first);
      const body = [tidyRest(rest), ...restLines.map((l) => l.replace(/^\s{2,4}/, ""))].join("\n").trim();
      const refs = parseLineRefs(item, opts.path);
      return { title: t || firstSentence(body || first, 70), body: t ? body : body, refs };
    });
  } else {
    const paras = paragraphs(sections.other.concat(sections.steps)).filter((p) => !HEADING_RE.test(p));
    steps = paras.map((p) => ({ title: "", body: p, refs: parseLineRefs(p, opts.path) }));
  }

  if (!summary && sections.summary.length) summary = firstSentence(sections.summary.join(" "), 160);
  // Plain answer: no summary line — the first paragraph IS step 1 (repeating its
  // opening sentence above it read as a stutter in the browser review).
  if (!summary && structured) {
    const intro = paragraphs(sections.other).find((p) => !NUM_ITEM_RE.test(p.split("\n")[0]));
    if (intro) summary = firstSentence(intro, 160);
  }
  if (!title) title = opts.fallbackTitle ? questionTitle(opts.fallbackTitle) : steps[0] ? firstSentence(steps[0].title || steps[0].body, 70) : "Lesson";

  return {
    title,
    summary,
    steps,
    concepts: listItems(sections.concepts).map((c) => c.replace(/[:—–-]\s.*$/, "").trim()).filter(Boolean).slice(0, 8),
    followUps: listItems(sections.followups).slice(0, 5),
    structured,
  };
}

/** Numbered list items (with their continuation lines) from a block of lines. */
function collectNumbered(ls: string[]): string[] {
  const items: string[] = [];
  let open = false;
  let fence = false;
  for (const ln of ls) {
    if (FENCE_RE.test(ln)) fence = !fence;
    const m = !fence ? ln.match(NUM_ITEM_RE) : null;
    if (m) { items.push(m[2]); open = true; continue; }
    if (!open) continue;
    if (!ln.trim() && !fence) { items[items.length - 1] += "\n"; continue; }
    if (!fence && /^\S/.test(ln) && !BULLET_RE.test(ln)) { open = false; continue; }
    items[items.length - 1] += "\n" + ln;
  }
  return items.map((s) => s.replace(/\n{3,}/g, "\n\n").trim());
}

/**
 * A short human title for a learn thread from its QUESTION (library rows, lesson
 * fallback title): first line / sentence, stripped of "Teach me"/"please" filler.
 */
export function questionTitle(question: string | null | undefined, max = 72): string {
  const first = String(question || "").split("\n").find((l) => l.trim()) || "";
  let t = stripMd(first).replace(/\s+/g, " ").trim();
  t = t.replace(/^(please\s+)?(can you\s+)?/i, "");
  const m = t.match(/^(.+?[.?!])(\s|$)/);
  if (m) t = m[1];
  t = t.replace(/[.]$/, "");
  if (!t) return "Lesson";
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/* ---- thread → lesson ------------------------------------------------------ */

export interface LessonMessage {
  is_human: boolean;
  body: string;
  author_alias?: string | null;
  author_agent_id?: string | null;
}

/**
 * The question (first message) and the answer (the FIRST agent message after it;
 * later messages are follow-up conversation) of a learn thread.
 */
export function lessonParts<M extends LessonMessage>(messages: M[] | null | undefined): { question: M | null; answer: M | null } {
  const list = messages ?? [];
  const question = list[0] ?? null;
  const answer = list.slice(1).find((m) => !m.is_human) ?? null;
  return { question, answer };
}

/**
 * Learn library — remembered lesson titles. The thread LIST only carries the
 * question (first_message), not the agent's answer, so a library row titles itself
 * from the question until the lesson has been opened once; after that it shows the
 * lesson's own `# title`. Per-browser convenience only (localStorage, capped, every
 * access guarded) — losing it just falls back to the question title.
 */
const KEY = "orcha:cs:lesson-titles";
const CAP = 300;

let mem: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (mem) return mem;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    mem = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    mem = {};
  }
  return mem!;
}

export function lessonTitleFor(threadId: string): string | null {
  return load()[threadId] ?? null;
}

export function rememberLessonTitle(threadId: string, title: string): void {
  const m = load();
  if (!title || m[threadId] === title) return;
  delete m[threadId];
  m[threadId] = title;
  const keys = Object.keys(m);
  for (let i = 0; i < keys.length - CAP; i++) delete m[keys[i]];
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* private mode */ }
}

/** test-only */
export function _resetLessonTitles(): void {
  mem = null;
}

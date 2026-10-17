/**
 * Line-level text diff for prompt revisions (pure, tested). Classic LCS table over lines —
 * prompts are bounded (MAX_PROMPT_LEN server-side), so O(n·m) is fine; past CELL_CAP cells
 * the diff degrades honestly to "all old lines removed, all new lines added" instead of
 * freezing the tab.
 */
export type DiffOp = { kind: "same" | "add" | "del"; text: string };

const CELL_CAP = 4_000_000;

function lines(s: string | null | undefined): string[] {
  if (s == null || s === "") return [];
  return String(s).replace(/\r\n?/g, "\n").split("\n");
}

export function lineDiff(before: string | null | undefined, after: string | null | undefined): DiffOp[] {
  const a = lines(before);
  const b = lines(after);
  // trim the common head/tail first: most prompt edits touch a few lines
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  const out: DiffOp[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  if (ma.length * mb.length > CELL_CAP) {
    ma.forEach((text) => out.push({ kind: "del", text }));
    mb.forEach((text) => out.push({ kind: "add", text }));
  } else {
    const n = ma.length;
    const m = mb.length;
    const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i][j] = ma[i] === mb[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        out.push({ kind: "same", text: ma[i] });
        i++;
        j++;
      } else if (t[i + 1][j] >= t[i][j + 1]) {
        out.push({ kind: "del", text: ma[i++] });
      } else {
        out.push({ kind: "add", text: mb[j++] });
      }
    }
    while (i < n) out.push({ kind: "del", text: ma[i++] });
    while (j < m) out.push({ kind: "add", text: mb[j++] });
  }
  a.slice(a.length - tail).forEach((text) => out.push({ kind: "same", text }));
  return out;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.kind === "add") added++;
    else if (o.kind === "del") removed++;
  }
  return { added, removed };
}

/** Collapse long unchanged runs to `context` lines around each change (Linear/GitHub style). */
export type DiffRow = DiffOp | { kind: "gap"; count: number };
export function withContext(ops: DiffOp[], context = 2): DiffRow[] {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let gap = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (gap) out.push({ kind: "gap", count: gap });
      gap = 0;
      out.push(o);
    } else gap++;
  });
  if (gap) out.push({ kind: "gap", count: gap });
  return out;
}

/**
 * Edits of an examples table for the scenario panel's table editor (#191). Each returns a new
 * table and never grows past the limits, so the editor cannot build what Save would refuse.
 */
import { isSecretColumn, isSecretRef, MAX_COLUMNS, MAX_ROWS, secretColumns, type ExamplesTable } from "./examples";

export function emptyTable(columns: readonly string[]): ExamplesTable {
  const cols = columns.length ? columns.slice(0, MAX_COLUMNS) : ["value"];
  const t: ExamplesTable = { columns: [...cols], rows: [cols.map(() => "")] };
  return withDetectedSecrets(t);
}

/** The table with its secret columns stated (`secret`): what detection finds by name and value
 * (a password, PIN, code, token or key column), on by default; for a pasted or new table. */
export function withDetectedSecrets(t: ExamplesTable): ExamplesTable {
  const secret = secretColumns({ columns: t.columns, rows: t.rows });
  return secret.length ? { ...t, secret } : { columns: t.columns, rows: t.rows };
}

/** Whether column `col` is secret (its toggle). */
export function isSecretAt(t: ExamplesTable, col: number): boolean {
  const name = (t.columns[col] ?? "").toLowerCase();
  return secretColumns(t).some((c) => c.toLowerCase() === name);
}

/** Turn column `col`'s secret toggle. Turning it off clears its stored (sealed) cells: their
 * values are only in the encrypted store, so the column starts over in plain text. */
export function toggleSecret(t: ExamplesTable, col: number): ExamplesTable {
  const current = secretColumns(t);
  const name = t.columns[col];
  if (name === undefined) return t;
  if (isSecretAt(t, col)) {
    return {
      columns: t.columns,
      rows: t.rows.map((r) => r.map((v, i) => (i === col && isSecretRef(v) ? "" : v))),
      secret: current.filter((c) => c.toLowerCase() !== name.toLowerCase()),
    };
  }
  return { ...t, secret: t.columns.filter((c) => c === name || current.some((s) => s.toLowerCase() === c.toLowerCase())) };
}

/** `secret` after the columns changed: kept for the columns still there (by position). */
function keepSecret(t: ExamplesTable, columns: string[], from: (i: number) => number): ExamplesTable["secret"] {
  if (!t.secret && !t.rows.some((r) => r.some(isSecretRef))) return t.secret;
  const was = new Set(secretColumns(t).map((c) => c.toLowerCase()));
  return columns.filter((_, i) => {
    const j = from(i);
    return j >= 0 && was.has((t.columns[j] ?? "").toLowerCase());
  });
}

export function setCell(t: ExamplesTable, row: number, col: number, value: string): ExamplesTable {
  return { ...t, rows: t.rows.map((r, i) => (i === row ? t.columns.map((_, c) => (c === col ? value : (r[c] ?? ""))) : r)) };
}

export function addRow(t: ExamplesTable, at = t.rows.length): ExamplesTable {
  if (t.rows.length >= MAX_ROWS) return t;
  const rows = [...t.rows];
  rows.splice(at, 0, t.columns.map(() => ""));
  return { ...t, rows };
}

export function duplicateRow(t: ExamplesTable, row: number): ExamplesTable {
  if (t.rows.length >= MAX_ROWS || !t.rows[row]) return t;
  const rows = [...t.rows];
  rows.splice(row + 1, 0, [...t.rows[row]]);
  return { ...t, rows };
}

export function removeRow(t: ExamplesTable, row: number): ExamplesTable {
  return { ...t, rows: t.rows.filter((_, i) => i !== row) };
}

/** A new column named `name` (or `column N`, the first free one). */
export function addColumn(t: ExamplesTable, name?: string): ExamplesTable {
  if (t.columns.length >= MAX_COLUMNS) return t;
  let n = t.columns.length + 1;
  let col = name ?? `column_${n}`;
  const taken = new Set(t.columns.map((c) => c.toLowerCase()));
  while (taken.has(col.toLowerCase())) col = `column_${++n}`;
  const columns = [...t.columns, col];
  const out: ExamplesTable = { columns, rows: t.rows.map((r) => [...r, ""]) };
  const secret = keepSecret(t, columns, (i) => (i < t.columns.length ? i : -1));
  return secret ? { ...out, secret } : out;
}

export function removeColumn(t: ExamplesTable, col: number): ExamplesTable {
  const columns = t.columns.filter((_, i) => i !== col);
  const out: ExamplesTable = { columns, rows: t.rows.map((r) => r.filter((_, i) => i !== col)) };
  const secret = keepSecret(t, columns, (i) => (i < col ? i : i + 1));
  return secret ? { ...out, secret } : out;
}

export function renameColumn(t: ExamplesTable, col: number, name: string): ExamplesTable {
  const columns = t.columns.map((c, i) => (i === col ? name : c));
  // A secret column keeps its toggle under its new name. A name that reads secret turns it on,
  // and one turned on only by its old name (no stored cells) follows the name back off.
  const was = new Set(secretColumns(t).map((c) => c.toLowerCase()));
  const old = t.columns[col] ?? "";
  const stored = t.rows.some((r) => isSecretRef(r[col]));
  const secret = columns.filter((_c, i) => {
    if (i !== col) return was.has((t.columns[i] ?? "").toLowerCase());
    if (stored || isSecretColumn(name)) return true;
    return was.has(old.toLowerCase()) && !isSecretColumn(old);
  });
  const out: ExamplesTable = { ...t, columns };
  return t.secret || secret.length ? { ...out, secret } : out;
}

/** Text pasted into one cell: several lines or tab-separated cells fill the grid from there,
 * adding rows (and columns) as needed, up to the limits. A single value just sets the cell. */
export function pasteInto(t: ExamplesTable, row: number, col: number, text: string): ExamplesTable {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const grid = lines.map((l) => l.split("\t"));
  if (grid.length === 1 && grid[0].length === 1) return setCell(t, row, col, grid[0][0]);
  let out = t;
  const width = Math.max(...grid.map((g) => g.length));
  while (out.columns.length < Math.min(MAX_COLUMNS, col + width)) out = addColumn(out);
  while (out.rows.length < Math.min(MAX_ROWS, row + grid.length)) out = addRow(out);
  grid.forEach((cells, r) => {
    cells.forEach((value, c) => {
      if (row + r < out.rows.length && col + c < out.columns.length) out = setCell(out, row + r, col + c, value.trim());
    });
  });
  return out;
}

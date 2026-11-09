/**
 * Examples tables on a scenario (`scenarios.examples`, migration 079, `orcha.scenarios.examples`): the
 * same journey over rows of inputs and expectations. A run fans the scenario out into one child
 * per row, with `{{column}}` filled from that row everywhere (the same placeholder syntax as
 * `## Data` keys and `{{tag}}`). The Python side is the authority; this mirrors its rules so the
 * table editor catches a problem before Save.
 *
 * Tables converted from existing tests (test.each, parametrize, Gherkin Examples) can be wide
 * and long and carry columns the scenario does not mention: empty cells are values, a short
 * row is padded, and an unused column is a quiet hint, never an error.
 */

export interface ExamplesTable {
  columns: string[];
  rows: string[][];
  /** The columns marked secret (the editor's toggles). Their cells hold `secret:sec_<id>` once
   * saved: the value lives only in the encrypted secrets table (`orcha.scenarios.example_secrets`). */
  secret?: string[];
}

/** How a secret cell is shown anywhere a row is named or listed. */
export const SECRET_MASK = "••••";
const SECRET_REF_RE = /^secret:sec_[0-9a-f]{8,64}$/;
const SECRET_TOKENS = new Set([
  "password", "passwd", "passphrase", "passcode", "pwd", "pin", "otp", "totp", "hotp", "token", "secret", "apikey", "mfa", "2fa",
  "cvv", "cvc", "cvv2", "iban", "ssn", "credential", "credentials",
]);
const SECRET_SUBSTRINGS = ["password", "passwd", "passphrase", "passcode", "apikey", "secret", "token"];
const PASS_WITH = new Set(["user", "username", "login", "admin", "account", "db", "wifi", "sign", "signin", "my", "new", "old", "current"]);
const CODE_WITH = new Set([
  "otp", "mfa", "2fa", "verification", "verify", "auth", "authentication", "security", "sms", "login", "signin", "access",
  "confirmation", "confirm", "magic", "recovery", "backup", "reset", "one", "time", "onetime",
]);
const KEY_WITH = new Set([
  "api", "secret", "private", "access", "auth", "license", "licence", "ssh", "signing", "encryption", "client", "master", "app",
  "service", "account", "recovery", "setup", "totp",
]);
const KEY_SHAPES =
  /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,})|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}|PRIVATE KEY/i;

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a column's name says it holds a secret: PASSWORD, pwd, pin, otp, "sms code", apiKey,
 * client_secret, any case; not country_code, sort_key, pass_rate or email
 * (`orcha.scenarios.examples.is_secret_column`). */
export function isSecretColumn(name: string): boolean {
  const tokens = nameTokens(name ?? "");
  if (tokens.length === 0) return false;
  if (tokens.some((t) => SECRET_TOKENS.has(t))) return true;
  const joined = tokens.join("");
  if (SECRET_SUBSTRINGS.some((s) => joined.includes(s))) return true;
  if (tokens.some((t) => t === "pass" || t === "pw") && (tokens.length === 1 || tokens.some((t) => PASS_WITH.has(t)))) return true;
  if (tokens.includes("code") && (tokens.length === 1 || tokens.some((t) => CODE_WITH.has(t)))) return true;
  if (tokens.includes("key") && (tokens.length === 1 || tokens.some((t) => KEY_WITH.has(t)))) return true;
  return false;
}

/** A sealed cell: a reference into the encrypted secrets table, never the value. */
export function isSecretRef(value: unknown): boolean {
  return typeof value === "string" && SECRET_REF_RE.test(value);
}

/** A value shaped like a key or token (API key, bearer token, JWT, PEM key), whatever its column. */
export function looksSecret(value: unknown): boolean {
  return typeof value === "string" && value.length >= 12 && !isSecretRef(value) && KEY_SHAPES.test(value);
}

/** The table's secret columns, in order: its `secret` list when it has one (the toggles), else the
 * columns whose name or values say so; a column holding a sealed cell always is. */
export function secretColumns(table: ExamplesTable | null | undefined): string[] {
  if (!table) return [];
  const marked = Array.isArray(table.secret) ? new Set(table.secret.map((c) => c.trim().toLowerCase())) : null;
  return table.columns.filter((col, i) => {
    const cells = table.rows.map((r) => r[i] ?? "");
    if (cells.some(isSecretRef)) return true;
    if (marked) return marked.has(col.trim().toLowerCase());
    return isSecretColumn(col) || cells.some(looksSecret);
  });
}

/** Whether a secret column holds a value that is not sealed yet (the save seals it). */
export function hasPlainSecrets(table: ExamplesTable | null | undefined): boolean {
  if (!table) return false;
  const secret = new Set(secretColumns(table).map((c) => c.toLowerCase()));
  return table.columns.some((col, i) => secret.has(col.toLowerCase()) && table.rows.some((r) => (r[i] ?? "") !== "" && !isSecretRef(r[i])));
}

/**
 * A row's values as they may be shown: `••••` for a sealed cell, a column marked or named secret,
 * or a value shaped like a key. The one masking rule every row label, tile, strip, title and
 * tooltip goes through (`orcha.scenarios.examples.display_values`).
 */
export function displayValues(
  values: Readonly<Record<string, unknown>> | null | undefined,
  secret: readonly string[] = [],
): Record<string, string> {
  const marked = new Set(secret.map((c) => c.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(values ?? {})) {
    const v = cell(raw);
    out[k] = v !== "" && (isSecretRef(v) || marked.has(k.toLowerCase()) || isSecretColumn(k) || looksSecret(v)) ? SECRET_MASK : v;
  }
  return out;
}

/** A run request's stored row values with any secret that is not sealed yet as `••••`; a sealed
 * cell keeps its reference (it holds no value, and the editor matches a row's result by it). */
export function safeRowValues(values: Readonly<Record<string, unknown>> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(values ?? {})) {
    const v = cell(raw);
    out[k] = v !== "" && !isSecretRef(v) && (isSecretColumn(k) || looksSecret(v)) ? SECRET_MASK : v;
  }
  return out;
}

/** The table as it may be shown outside the editor (YAML, export, Ask cards): a sealed cell as its
 * reference, a secret value that is not sealed yet as `••••`. */
export function exportableTable(table: ExamplesTable | null): ExamplesTable | null {
  if (!table) return table;
  const secret = new Set(secretColumns(table).map((c) => c.toLowerCase()));
  return {
    columns: table.columns,
    rows: table.rows.map((r) => r.map((v, i) => (secret.has((table.columns[i] ?? "").toLowerCase()) && v !== "" && !isSecretRef(v) ? SECRET_MASK : v))),
    ...(secret.size ? { secret: table.columns.filter((c) => secret.has(c.toLowerCase())) } : {}),
  };
}

export const MAX_COLUMNS = 20;
export const MAX_ROWS = 100;
export const MAX_CELL = 500;
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_ .-]{0,63}$/;
const RESERVED = new Set(["tag", "tag4"]);
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_ .-]*?)\s*\}\}/g;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Why a column name cannot be used, or null. */
export function columnError(name: string, others: readonly string[] = []): string | null {
  const c = name.trim();
  if (!c) return "Name the column.";
  if (!COLUMN_RE.test(c)) return `"${c}": start with a letter or _, then letters, digits, spaces, ".", "_" or "-".`;
  if (RESERVED.has(c.toLowerCase())) return `"${c}" is reserved for the run tag ({{${c.toLowerCase()}}}).`;
  if (others.some((o) => o.trim().toLowerCase() === c.toLowerCase())) return `"${c}" appears twice.`;
  return null;
}

/** The table as stored JSON, or null for none. Parses a JSON string too. */
export function parseExamples(raw: unknown): ExamplesTable | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as { columns?: unknown; rows?: unknown; secret?: unknown };
  const columns = Array.isArray(o.columns) ? o.columns.map((c) => cell(c)) : [];
  const rows = Array.isArray(o.rows) ? o.rows.filter(Array.isArray).map((r) => (r as unknown[]).map(cell)) : [];
  if (columns.length === 0 && rows.length === 0) return null;
  const table: ExamplesTable = {
    columns,
    rows: rows.map((r) => [...r, ...Array(Math.max(0, columns.length - r.length)).fill("")].slice(0, Math.max(columns.length, r.length))),
  };
  if (Array.isArray(o.secret)) table.secret = o.secret.filter((c): c is string => typeof c === "string");
  return table;
}

/** Sessions a run of these scenarios starts: one per Examples row, one for a scenario without
 * a table (#284: "3 sessions" for 3 scenarios whose tables hold 6 rows). */
export function sessionCount(scenarios: readonly { examples?: unknown }[]): number {
  return scenarios.reduce((n, s) => n + Math.max(1, parseExamples(s.examples)?.rows.length ?? 0), 0);
}

/** First problem with a table, or null. */
export function examplesError(table: ExamplesTable | null): string | null {
  if (!table) return null;
  if (table.columns.length === 0) return table.rows.length ? "A table with rows needs at least one column." : null;
  if (table.columns.length > MAX_COLUMNS) return `At most ${MAX_COLUMNS} columns.`;
  for (let i = 0; i < table.columns.length; i++) {
    const err = columnError(table.columns[i], table.columns.slice(0, i));
    if (err) return err;
  }
  if (table.rows.length > MAX_ROWS) return `At most ${MAX_ROWS} rows (this table has ${table.rows.length}).`;
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r];
    if (row.length > table.columns.length) return `Row ${r + 1} has ${row.length} cells for ${table.columns.length} columns.`;
    for (const c of row) {
      if (c.length > MAX_CELL) return `Row ${r + 1}: a cell is at most ${MAX_CELL} characters.`;
      if (/[\r\n]/.test(c)) return `Row ${r + 1}: a cell is one line.`;
    }
  }
  return null;
}

export type ExamplesValidation = { ok: true; examples: ExamplesTable | null } | { ok: false; error: string };

/** Validate a PATCH body's `examples` (an object, or null to remove the table). */
export function validateExamples(raw: unknown): ExamplesValidation {
  if (raw === null) return { ok: true, examples: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "examples must be an object with columns and rows." };
  const o = raw as { columns?: unknown; rows?: unknown; secret?: unknown };
  if (o.secret !== undefined && (!Array.isArray(o.secret) || !o.secret.every((c) => typeof c === "string"))) {
    return { ok: false, error: "examples: secret must be a list of column names." };
  }
  if (o.columns !== undefined && (!Array.isArray(o.columns) || !o.columns.every((c) => typeof c === "string"))) {
    return { ok: false, error: "examples: columns must be a list of names." };
  }
  if (o.rows !== undefined && (!Array.isArray(o.rows) || !o.rows.every(Array.isArray))) {
    return { ok: false, error: "examples: rows must be a list of lists." };
  }
  const table = parseExamples(raw);
  if (!table) return { ok: true, examples: null };
  const clean: ExamplesTable = { columns: table.columns.map((c) => c.trim()), rows: table.rows };
  const error = examplesError(clean);
  if (error) return { ok: false, error: `examples: ${error}` };
  if (clean.columns.length === 0) return { ok: true, examples: null };
  // The secret columns are always stated once saved: the toggles, or what detection found.
  const secret = secretColumns({ ...clean, ...(table.secret ? { secret: table.secret.map((c) => c.trim()) } : {}) });
  if (secret.length || table.secret) clean.secret = secret;
  return { ok: true, examples: clean };
}

/** Every `{{name}}` in the texts, lower-cased. */
export function referencedNames(texts: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(PLACEHOLDER_RE)) out.add(m[1].toLowerCase());
  }
  return out;
}

/** Columns no `{{column}}` in the scenario's texts refers to. */
export function unusedColumns(table: ExamplesTable | null, texts: readonly (string | null | undefined)[]): string[] {
  if (!table) return [];
  const used = referencedNames(texts);
  return table.columns.filter((c) => c.trim() && !used.has(c.trim().toLowerCase()));
}

/** `plate = KBX 421T, expect = saved`: how a row is named (empty cells as "(empty)", secret ones as
 * `••••`, `displayValues`). */
export function rowLabel(values: Readonly<Record<string, unknown>> | null | undefined, max = 80, secret: readonly string[] = []): string {
  if (!values) return "";
  const text = Object.entries(displayValues(values, secret))
    .map(([k, v]) => `${k} = ${v === "" ? "(empty)" : v}`)
    .join(", ");
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function rowValues(table: ExamplesTable, index: number): Record<string, string> {
  const row = table.rows[index] ?? [];
  return Object.fromEntries(table.columns.map((c, i) => [c, row[i] ?? ""]));
}

/** `{{column}}` filled from `values` (columns ignore case); other placeholders stay. */
export function fillRow(text: string, values: Readonly<Record<string, string>>): string {
  const lookup = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(PLACEHOLDER_RE, (m, name: string) => lookup.get(name.toLowerCase()) ?? m);
}

function splitPipeRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && (t[i + 1] === "|" || t[i + 1] === "\\")) {
      cur += t[i + 1];
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function splitCsvRow(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur.trim() === "") {
      quoted = true;
      cur = "";
    } else if (c === sep) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * A table pasted from a spreadsheet (tab-separated), a CSV, a markdown or Gherkin pipe table:
 * the first line names the columns. Null when the text has no header row.
 */
export function parsePastedTable(text: string): ExamplesTable | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "" && !/^\s*examples\s*:?\s*$/i.test(l) && !/^\s*##\s*examples\s*$/i.test(l));
  if (lines.length === 0) return null;
  let split: (l: string) => string[];
  if (lines[0].trim().startsWith("|")) split = splitPipeRow;
  else if (lines[0].includes("\t")) split = (l) => l.split("\t").map((c) => c.trim());
  else split = (l) => splitCsvRow(l, lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",");
  const isSeparator = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
  const columns = split(lines[0]).map((c) => c.replace(/^<|>$/g, ""));
  const rows = lines.slice(1).filter((l) => !isSeparator(l)).map(split);
  return { columns, rows: rows.map((r) => [...r, ...Array(Math.max(0, columns.length - r.length)).fill("")]) };
}

/** The table as `## Examples` and a pipe table (scenario files, the YAML view). */
export function examplesToMarkdown(input: ExamplesTable | null): string {
  // References only, never a value: a secret not sealed yet is written as `••••`.
  const table = exportableTable(input);
  if (!table || table.columns.length === 0) return "";
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  const lines = ["## Examples", `| ${table.columns.map(esc).join(" | ")} |`, `|${table.columns.map(() => " --- ").join("|")}|`];
  for (const r of table.rows) lines.push(`| ${table.columns.map((_, i) => esc(r[i] ?? "")).join(" | ")} |`);
  return lines.join("\n");
}

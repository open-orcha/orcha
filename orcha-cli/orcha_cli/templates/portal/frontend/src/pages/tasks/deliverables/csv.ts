/**
 * A small RFC 4180 CSV/TSV parser for deliverable previews: quoted fields,
 * doubled quotes, embedded delimiters and newlines, CRLF. Bounded — stops after
 * `maxRows` rows (the preview never renders an unbounded table) and reports
 * whether more rows existed.
 */
export interface ParsedTable {
  rows: string[][];
  truncated: boolean;
  columns: number;
}

export function delimiterFor(path: string): "," | "\t" {
  return /\.tsv$/i.test(path) ? "\t" : ",";
}

export function parseCsv(text: string, delimiter: "," | "\t" = ",", maxRows = 200): ParsedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let truncated = false;
  let i = 0;
  const n = text.length;
  const pushRow = () => {
    row.push(field);
    field = "";
    // a trailing blank line is not a row
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      pushRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (rows.length >= maxRows) {
        truncated = /\S/.test(text.slice(i));
        break;
      }
      continue;
    }
    field += c;
    i++;
  }
  if (i >= n && (field !== "" || row.length) && rows.length < maxRows) pushRow();
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { rows, truncated, columns };
}

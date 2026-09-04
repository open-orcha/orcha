/**
 * Code Space — Phase 3 (language intelligence, built-in symbol provider).
 * Wire shapes for code_space_routes.py's symbols/outline CONTRACT (see the
 * module doc there + docs/orcha-code-space-design.md):
 *
 *   GET /api/containers/{cid}/code/symbols?ref=&q=   — workspace symbol search
 *       -> {available, repo, ref, results:[{name,kind,path,line}], truncated}
 *   GET /api/containers/{cid}/code/outline?ref=&path= — one file's outline
 *       -> {available, repo, ref, path, language, symbols:[{name,kind,line}]}
 *
 * Both routes degrade to `{available:false, reason, detail}` as an ordinary
 * 200 body (never a thrown HTTPException) for the not-connected/rate-limited/
 * generic-error cases — mirrors github_hub_routes._not_connected/_error_payload
 * exactly. `reason` values seen: repo_not_connected | rate_limited |
 * not_found | github_error | unreachable.
 *
 * Pure types + tiny pure helpers only — no DOM, no fetch (matches the
 * codespaceTypes.ts / browseTypes.ts convention).
 */

// class covers class/struct/object/enum; interface covers interface/protocol.
export type SymbolKind = "function" | "class" | "interface" | "type" | "const" | "var";

export interface WorkspaceSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
}

export interface OutlineSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
}

export interface SymbolSearchPayload {
  available: true;
  repo?: string | null;
  ref: string;
  results: WorkspaceSymbol[];
  truncated?: boolean;
}

export interface OutlinePayload {
  available: true;
  repo?: string | null;
  ref: string;
  path: string;
  language: string | null;
  symbols: OutlineSymbol[];
}

// The degrade shape both routes return as a normal 200 body when the repo
// isn't connected / rate-limited / unreachable — an honest "can't tell you
// right now", never a guessed empty result.
export type SymbolReason = "repo_not_connected" | "rate_limited" | "not_found" | "github_error" | "unreachable";
export interface SymbolUnavailable {
  available: false;
  reason: SymbolReason;
  detail?: string | null;
}

/* ---- kind display + grouping ----------------------------------------------
 * Order mirrors the design doc's kind list and code_space_routes.py's module
 * doc: function | class | interface | type | const | var. */
export const SYMBOL_KIND_ORDER: SymbolKind[] = ["function", "class", "interface", "type", "const", "var"];

export function symbolKindLabel(kind: SymbolKind): string {
  switch (kind) {
    case "function": return "Function";
    case "class": return "Class";
    case "interface": return "Interface";
    case "type": return "Type";
    case "const": return "Const";
    default: return "Var";
  }
}

// Groups outline/search symbols by kind, in SYMBOL_KIND_ORDER, dropping empty
// groups — the outline rail's section list. Preserves each group's original
// (file-order or relevance-order) item ordering.
export function groupByKind<T extends { kind: SymbolKind }>(symbols: T[]): { kind: SymbolKind; items: T[] }[] {
  const buckets = new Map<SymbolKind, T[]>();
  symbols.forEach((s) => {
    const list = buckets.get(s.kind);
    if (list) list.push(s);
    else buckets.set(s.kind, [s]);
  });
  return SYMBOL_KIND_ORDER
    .filter((k) => buckets.has(k))
    .map((k) => ({ kind: k, items: buckets.get(k) as T[] }));
}

// Groups workspace search results by path (the search results list's section
// headers), preserving each file's relative result order and the paths'
// first-seen order (stable, not re-sorted alphabetically — matches the
// backend's file-order-within-tree-scan emission).
export function groupByPath(results: WorkspaceSymbol[]): { path: string; items: WorkspaceSymbol[] }[] {
  const buckets = new Map<string, WorkspaceSymbol[]>();
  const order: string[] = [];
  results.forEach((r) => {
    const list = buckets.get(r.path);
    if (list) list.push(r);
    else { buckets.set(r.path, [r]); order.push(r.path); }
  });
  return order.map((path) => ({ path, items: buckets.get(path) as WorkspaceSymbol[] }));
}

/* ---- identifier-click best-effort (v1) -------------------------------------
 * A token the highlighter classified "plain" (i.e. not a keyword/string/
 * number/comment) is identifier-ISH when it looks like a real identifier —
 * letters/digits/_/$ , not starting with a digit. This is deliberately NOT
 * "go to definition": it only decides whether the code pane offers a
 * "Find symbol '<word>'" affordance that runs the workspace search prefilled
 * with that word — see the design doc's Phase 3 non-goals (no LSP pretense). */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isIdentifierLike(text: string): boolean {
  return IDENTIFIER_RE.test(text);
}

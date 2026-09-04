/**
 * Lightweight syntax highlighting for the repo file browser's content pane.
 * NO heavy deps, no CDNs, no worker — a small hand-written tokenizer that
 * classifies a line of source into spans (comment/string/number/keyword/
 * plain), rendered by RepoBrowser with CSS classes matching the diff token
 * color variables (--diff-add/--diff-hunk/--accent) already in tokens.css.
 * Pure + deterministic: no DOM, so every branch is unit-testable in
 * highlight.test.ts without mounting anything.
 *
 * Covers ~8 common languages by file extension: JS/TS(X), Python, Go, Rust,
 * JSON, CSS, Shell, and a generic C-family fallback (C/C++/Java/etc.) that
 * still gets line comments + strings + numbers. Anything unrecognized (or a
 * language this tokenizer doesn't know) renders as plain text — never wrong,
 * just unhighlighted.
 */
import { extOf } from "./browseTypes";

export type TokenKind = "comment" | "string" | "number" | "keyword" | "plain";

export interface Token {
  kind: TokenKind;
  text: string;
}

interface LangSpec {
  keywords: Set<string>;
  lineComment: string | null; // e.g. "//", "#" — null if the language has none
  blockComment: [string, string] | null; // e.g. ["/*", "*/"]
  strings: string[]; // quote characters, e.g. ['"', "'", "`"]
}

const JS_KEYWORDS = [
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "class", "extends", "new", "this", "super",
  "import", "export", "default", "from", "as", "async", "await", "try", "catch",
  "finally", "throw", "typeof", "instanceof", "in", "of", "yield", "static", "get",
  "set", "interface", "type", "enum", "implements", "public", "private", "protected",
  "readonly", "namespace", "declare", "true", "false", "null", "undefined", "void",
];
const PY_KEYWORDS = [
  "def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue",
  "pass", "import", "from", "as", "with", "try", "except", "finally", "raise", "yield",
  "lambda", "async", "await", "global", "nonlocal", "del", "assert", "in", "is", "not",
  "and", "or", "True", "False", "None", "self",
];
const GO_KEYWORDS = [
  "func", "package", "import", "return", "if", "else", "for", "range", "switch", "case",
  "break", "continue", "default", "struct", "interface", "map", "chan", "go", "defer",
  "var", "const", "type", "const", "nil", "true", "false", "select", "fallthrough",
];
const RUST_KEYWORDS = [
  "fn", "let", "mut", "return", "if", "else", "for", "while", "loop", "match", "break",
  "continue", "struct", "enum", "impl", "trait", "pub", "use", "mod", "crate", "self",
  "super", "async", "await", "move", "ref", "static", "const", "true", "false", "unsafe",
  "where", "dyn", "as", "in",
];
const SHELL_KEYWORDS = [
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac",
  "function", "return", "local", "export", "echo", "exit", "break", "continue",
];
const C_KEYWORDS = [
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return",
  "struct", "class", "public", "private", "protected", "static", "const", "void",
  "int", "char", "float", "double", "long", "short", "unsigned", "signed", "new",
  "delete", "this", "true", "false", "null", "nullptr", "namespace", "template",
  "typename", "virtual", "override", "final", "import", "package", "interface",
  "extends", "implements", "throws", "try", "catch", "finally", "throw",
];

const LANGS: Record<string, LangSpec> = {
  js: { keywords: new Set(JS_KEYWORDS), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  jsx: { keywords: new Set(JS_KEYWORDS), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  ts: { keywords: new Set(JS_KEYWORDS), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  tsx: { keywords: new Set(JS_KEYWORDS), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  mjs: { keywords: new Set(JS_KEYWORDS), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  py: { keywords: new Set(PY_KEYWORDS), lineComment: "#", blockComment: null, strings: ['"', "'"] },
  go: { keywords: new Set(GO_KEYWORDS), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"', "'", "`"] },
  rs: { keywords: new Set(RUST_KEYWORDS), lineComment: "//", blockComment: ["/*", "*/"], strings: ['"'] },
  json: { keywords: new Set(), lineComment: null, blockComment: null, strings: ['"'] },
  css: { keywords: new Set(), lineComment: null, blockComment: ["/*", "*/"], strings: ['"', "'"] },
  sh: { keywords: new Set(SHELL_KEYWORDS), lineComment: "#", blockComment: null, strings: ['"', "'"] },
  bash: { keywords: new Set(SHELL_KEYWORDS), lineComment: "#", blockComment: null, strings: ['"', "'"] },
};
// Generic C-family fallback for anything else with C-like syntax.
const C_FALLBACK: LangSpec = {
  keywords: new Set(C_KEYWORDS),
  lineComment: "//",
  blockComment: ["/*", "*/"],
  strings: ['"', "'"],
};
const C_FAMILY_EXTS = new Set(["c", "h", "cc", "cpp", "cxx", "hpp", "java", "kt", "swift", "cs", "php", "scala"]);

export function langForPath(path: string): LangSpec | null {
  const ext = extOf(path);
  if (!ext) return null;
  if (LANGS[ext]) return LANGS[ext];
  if (C_FAMILY_EXTS.has(ext)) return C_FALLBACK;
  return null;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER_RE = /^(0x[0-9a-fA-F]+|\d+\.?\d*(e[+-]?\d+)?)/;

/**
 * Tokenizes a SINGLE line (no multi-line block-comment tracking across
 * lines — each line is scanned independently, which keeps the tokenizer a
 * pure O(line length) pass with no cross-line state to get wrong). A `//`
 * or `#` line-comment prefix, once seen, swallows the rest of the line.
 */
export function tokenizeLine(line: string, lang: LangSpec | null): Token[] {
  if (!lang) return line ? [{ kind: "plain", text: line }] : [];
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;
  const push = (kind: TokenKind, text: string) => {
    if (text) tokens.push({ kind, text });
  };

  while (i < n) {
    // line comment: swallow the remainder
    if (lang.lineComment && line.startsWith(lang.lineComment, i)) {
      push("comment", line.slice(i));
      break;
    }
    // block comment (single-line occurrence; no cross-line state)
    if (lang.blockComment && line.startsWith(lang.blockComment[0], i)) {
      const end = line.indexOf(lang.blockComment[1], i + lang.blockComment[0].length);
      if (end === -1) { push("comment", line.slice(i)); break; }
      push("comment", line.slice(i, end + lang.blockComment[1].length));
      i = end + lang.blockComment[1].length;
      continue;
    }
    const ch = line[i];
    // string literal
    if (lang.strings.includes(ch)) {
      let j = i + 1;
      while (j < n && line[j] !== ch) {
        if (line[j] === "\\") j++; // skip escaped char
        j++;
      }
      j = Math.min(j + 1, n);
      push("string", line.slice(i, j));
      i = j;
      continue;
    }
    // number
    const rest = line.slice(i);
    const numMatch = NUMBER_RE.exec(rest);
    if (numMatch && (i === 0 || !/[A-Za-z0-9_$]/.test(line[i - 1] || ""))) {
      push("number", numMatch[0]);
      i += numMatch[0].length;
      continue;
    }
    // identifier / keyword
    const idMatch = IDENT_RE.exec(rest);
    if (idMatch) {
      const word = idMatch[0];
      push(lang.keywords.has(word) ? "keyword" : "plain", word);
      i += word.length;
      continue;
    }
    // whitespace / punctuation run — batch consecutive plain chars
    let j = i + 1;
    while (
      j < n &&
      !lang.strings.includes(line[j]) &&
      !(lang.lineComment && line.startsWith(lang.lineComment, j)) &&
      !(lang.blockComment && line.startsWith(lang.blockComment[0], j)) &&
      !IDENT_RE.test(line.slice(j)) &&
      !NUMBER_RE.test(line.slice(j))
    ) {
      j++;
    }
    push("plain", line.slice(i, j));
    i = j;
  }
  return tokens;
}

export function highlightLine(line: string, path: string): Token[] {
  return tokenizeLine(line, langForPath(path));
}

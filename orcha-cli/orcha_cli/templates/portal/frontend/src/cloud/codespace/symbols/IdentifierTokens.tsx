/**
 * IdentifierTokens — the code pane's per-line token renderer, a drop-in
 * alternative to the shared TokenSpans (cloud/shared/browseTree.tsx) that
 * additionally makes identifier-ish "plain" tokens clickable: clicking one
 * fires onIdentifierClick(word), which CodeSpacePage wires to prefill the
 * SymbolSearch panel — a best-effort v1 "Find symbol '<word>'" affordance,
 * deliberately NOT "go to definition" (no LSP pretense; see the design
 * doc's Phase 3 non-goals). Every other token kind renders byte-identical to
 * TokenSpans.
 */
import type { Token } from "../../github/browse/highlight";
import { isIdentifierLike } from "./symbolsTypes";

export interface IdentifierTokensProps {
  tokens: Token[];
  onIdentifierClick: (word: string) => void;
}

export function IdentifierTokens({ tokens, onIdentifierClick }: IdentifierTokensProps) {
  if (!tokens.length) return <>{" "}</>;
  return (
    <>
      {tokens.map((t, ti) => {
        if (t.kind === "plain" && isIdentifierLike(t.text)) {
          return (
            <span
              key={ti}
              className="cs-ident-tok"
              title={`Find symbol '${t.text}'`}
              onClick={(e) => { e.stopPropagation(); onIdentifierClick(t.text); }}
            >
              {t.text}
            </span>
          );
        }
        return (
          <span key={ti} className={t.kind === "plain" ? undefined : "rb-tok-" + t.kind}>
            {t.text}
          </span>
        );
      })}
    </>
  );
}

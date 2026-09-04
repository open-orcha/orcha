/**
 * Outline rail — the fourth ThreadRail tab (alongside Threads/Live/Learn):
 * GET .../code/outline?ref=&path= for the currently open file, grouped by
 * kind (function/class/interface/type/const/var) using the house kind-tag
 * pill style (codespace.css's .kind-tag idiom, extended with .cs-symkind-*
 * per-kind colors). Clicking a symbol jumps the code viewer to its line via
 * the SAME onJumpToLine callback CodeSpacePage already wires for ?line=
 * deep-links and thread anchors.
 */
import { useEffect, useRef, useState } from "react";
import { BrowseErrorBody } from "../../shared/browseTree";
import type { GhError } from "../../github/ghlib";
import { fetchOutline } from "./symbolsApi";
import { groupByKind, symbolKindLabel, type OutlineSymbol } from "./symbolsTypes";

export interface OutlineRailProps {
  cid: string;
  gitRef: string;
  path: string;
  onJumpToLine: (line: number) => void;
}

type OutlineState =
  | { phase: "empty" }
  | { phase: "loading" }
  | { phase: "error"; error: GhError }
  | { phase: "loaded"; language: string | null; symbols: OutlineSymbol[] };

export function OutlineRail({ cid, gitRef, path, onJumpToLine }: OutlineRailProps) {
  const [state, setState] = useState<OutlineState>({ phase: "empty" });
  const token = useRef(0);

  useEffect(() => {
    if (!path) { setState({ phase: "empty" }); return; }
    const myToken = ++token.current;
    setState({ phase: "loading" });
    fetchOutline(cid, { ref: gitRef, path }).then((res) => {
      if (myToken !== token.current) return;
      if (!res.ok) { setState({ phase: "error", error: res.error }); return; }
      setState({ phase: "loaded", language: res.data.language, symbols: res.data.symbols });
    });
  }, [cid, gitRef, path]);

  if (state.phase === "empty") {
    return <div className="none" style={{ padding: 10 }}>Select a file to view its outline.</div>;
  }
  if (state.phase === "loading") {
    return <div className="muted" style={{ padding: 10 }}>Loading outline…</div>;
  }
  if (state.phase === "error") {
    return <BrowseErrorBody err={state.error} what="Outline" />;
  }
  if (!state.language) {
    return <div className="none" style={{ padding: 10 }}>No outline available for this file type.</div>;
  }
  if (!state.symbols.length) {
    return <div className="none" style={{ padding: 10 }}>No symbols found in this file.</div>;
  }

  const grouped = groupByKind(state.symbols);
  return (
    <div className="cs-outline">
      {grouped.map((g) => (
        <div key={g.kind} className="cs-outline-group">
          <div className="cs-outline-group-head">{symbolKindLabel(g.kind)}</div>
          {g.items.map((s, i) => (
            <div
              key={g.kind + ":" + s.name + ":" + s.line + ":" + i}
              className="cs-outline-row"
              onClick={() => onJumpToLine(s.line)}
              title={`Jump to line ${s.line}`}
            >
              <span className={"kind-tag cs-symkind-" + s.kind}>{symbolKindLabel(s.kind)}</span>
              <span className="cs-outline-name mono">{s.name}</span>
              <span className="grow" />
              <span className="cs-outline-line mono muted">:{s.line}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

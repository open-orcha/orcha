/**
 * SymbolSearch — the Code Space header's workspace symbol search affordance:
 * debounced GET .../code/symbols?ref=&q= (reuses browse/useDebounce.ts's
 * 300ms primitive, same cadence as RepoBrowser's own search), results
 * grouped by path, click navigates the viewer to that file at the symbol's
 * line. Cmd/Ctrl+P is a bonus focus-shortcut (a plain input already works
 * without it) — mirrors Shell.tsx's "/" global-search precedent, scoped to
 * this page only via a document keydown listener owned by this component.
 *
 * This is WORKSPACE SYMBOL SEARCH, never "go to definition" — no LSP
 * pretense (design doc's Phase 3 non-goal).
 */
import { useEffect, useRef, useState } from "react";
import type { GhError } from "../../github/ghlib";
import { BrowseErrorBody } from "../../shared/browseTree";
import { useDebouncedValue } from "../../github/browse/useDebounce";
import { fetchSymbolSearch } from "./symbolsApi";
import { groupByPath, symbolKindLabel, type WorkspaceSymbol } from "./symbolsTypes";

export interface SymbolSearchProps {
  cid: string;
  gitRef: string;
  onNavigate: (path: string, line: number) => void;
  // identifier-click hookup (CodeSpacePage): prefills + re-triggers the
  // search whenever prefillToken changes, even if the text is unchanged from
  // a previous prefill (e.g. clicking the same identifier twice).
  prefill?: string;
  prefillToken?: number;
  // Landing-state quick action ("Search symbols") — bumping this focuses +
  // opens the palette from OUTSIDE the component, same re-trigger-on-token
  // idiom as prefillToken (no query text change needed, unlike a prefill).
  focusToken?: number;
  // BUG 4 fix — the currently open file's path. Closes the panel whenever
  // this changes: a file switch mid-search left stale, wrong-context
  // results open (never literally "detached" under live testing, but
  // stale results reading as broken is the same bad outcome for a human).
  path?: string;
}

type SearchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; error: GhError }
  | { phase: "loaded"; results: WorkspaceSymbol[]; truncated: boolean };

export function SymbolSearch({ cid, gitRef, onNavigate, prefill, prefillToken, focusToken, path }: SymbolSearchProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const debouncedQuery = useDebouncedValue(query, 300);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const token = useRef(0);
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number; width: number } | null>(null);

  // Cmd/Ctrl+P: focus + open the palette from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (prefill === undefined) return;
    setQuery(prefill);
    setOpen(true);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillToken]);

  useEffect(() => {
    if (!focusToken) return;
    setOpen(true);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  // BUG 4 fix — close on file navigation. A file switch invalidates
  // whatever's currently shown (results were scoped to the OLD context the
  // human was searching from) — closing is the same "picked something,
  // done" convention RecentFilesDropdown.tsx already uses for its own panel.
  // Skips the FIRST run (mount) — otherwise this would immediately close a
  // panel the prefill/focusToken effects just opened on the same mount,
  // since every effect runs once on mount regardless of its dependency
  // array actually having "changed".
  const prevPathRef = useRef(path);
  useEffect(() => {
    if (prevPathRef.current !== path) {
      setOpen(false);
      prevPathRef.current = path;
    }
  }, [path]);

  // BUG 4 fix — close on scroll. A window/ancestor scroll while the panel is
  // open would otherwise leave it visually anchored to wherever the input
  // WAS, not where it now is — capture:true catches scroll on any
  // scrollable ancestor (scroll events don't bubble, only capture).
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open]);

  // BUG 4 defensive hardening — recompute the anchor's own rect every time
  // the panel opens, and apply it as an EXPLICIT inline position rather than
  // relying purely on the CSS position:relative/absolute containing-block
  // chain. If some future layout change ever breaks that chain (a missing
  // position:relative on an ancestor, a transform/contain property that
  // creates an unexpected new containing block), the panel still lands in
  // the right place instead of falling back to the viewport's initial
  // containing block (the exact "stranded at top-left" failure mode the
  // original bug report described — not reproduced live, but this is a
  // cheap, correct hardening either way).
  useEffect(() => {
    if (!open || !rootRef.current) { setAnchorRect(null); return; }
    const r = rootRef.current.getBoundingClientRect();
    setAnchorRect({ top: r.bottom + 6, left: r.left, width: r.width });
  }, [open]);

  useEffect(() => {
    if (!debouncedQuery.trim()) { setState({ phase: "idle" }); return; }
    const myToken = ++token.current;
    setState({ phase: "loading" });
    fetchSymbolSearch(cid, { ref: gitRef, q: debouncedQuery }).then((res) => {
      if (myToken !== token.current) return;
      if (!res.ok) { setState({ phase: "error", error: res.error }); return; }
      setState({ phase: "loaded", results: res.data.results, truncated: !!res.data.truncated });
    });
  }, [cid, gitRef, debouncedQuery]);

  const showPanel = open && query.trim().length > 0;

  return (
    <div className="cs-symsearch" ref={rootRef}>
      <div className="cs-symsearch-box">
        <input
          ref={inputRef}
          className="cs-symsearch-in"
          type="search"
          placeholder="Search symbols… (Ctrl/Cmd+P)"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        />
      </div>
      {showPanel ? (
        <div
          className="cs-symsearch-panel"
          style={anchorRect ? { position: "fixed", top: anchorRect.top, left: anchorRect.left, width: anchorRect.width, right: "auto" } : undefined}
        >
          {state.phase === "loading" ? (
            <div className="muted" style={{ padding: 10 }}>Searching…</div>
          ) : state.phase === "error" ? (
            <BrowseErrorBody err={state.error} what="Symbol search" />
          ) : state.phase === "loaded" ? (
            state.results.length ? (
              <>
                {groupByPath(state.results).map((g) => (
                  <div key={g.path} className="cs-symsearch-group">
                    <div className="cs-symsearch-group-path mono">{g.path}</div>
                    {g.items.map((s, i) => (
                      <div
                        key={g.path + ":" + s.name + ":" + s.line + ":" + i}
                        className="cs-symsearch-row"
                        onClick={() => { onNavigate(s.path, s.line); setOpen(false); }}
                      >
                        <span className={"kind-tag cs-symkind-" + s.kind}>{symbolKindLabel(s.kind)}</span>
                        <span className="cs-symsearch-name mono">{s.name}</span>
                        <span className="grow" />
                        <span className="cs-symsearch-line mono muted">:{s.line}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {state.truncated ? (
                  <div className="cs-symsearch-note muted">More results exist — narrow your search.</div>
                ) : null}
              </>
            ) : (
              <div className="none" style={{ padding: 10 }}>No symbols match &#34;{query}&#34;.</div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

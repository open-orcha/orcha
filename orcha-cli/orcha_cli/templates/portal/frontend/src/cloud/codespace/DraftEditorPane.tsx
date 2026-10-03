/**
 * CM6 editor wrapper for GitHub-bound Code Space editing (Phase 4) — the
 * pencil's DRAFT mode when the container has no writable worktree
 * (worktreeAvailable=false) but the bound repo answers editable:true on the
 * default ref. Structurally mirrors EditorPane.tsx (same CM6 setup, same
 * lazy per-extension language loading, same Mod-s keymap) but the autosave
 * target is entirely different: every debounced edit writes to draftStore.ts
 * (IndexedDB, this browser only) and NOTHING ever reaches the network here —
 * "Propose changes…" (the drafts bar) is the only path that sends draft
 * content to the server, via githubEditApi.ts's propose endpoint.
 *
 * No drift/error banner machinery (editorSave.ts's state machine doesn't
 * apply — there's no concurrent writer to a local IndexedDB record, and no
 * PUT that can fail with drift/exists): saving a draft is just "write the
 * current buffer", always. Dirty is computed by the caller (CodeSpacePage)
 * by comparing the current draft content to the read-only file payload it
 * loaded, not tracked here.
 */
import { indentWithTab, history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { buildEditorTheme } from "./editorTheme";
import { setThreadLines, threadMarks } from "./editorThreadMarks";

const AUTOSAVE_DEBOUNCE_MS = 800;

export interface DraftEditorPaneProps {
  cid: string;
  path: string;
  initialContent: string;
  onDraftChange: (content: string) => void;
  /** 1-based lines carrying a code thread — painted as gutter dots, same as the read view. */
  threadLines?: number[];
}

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

async function languageExtensionFor(path: string) {
  const desc = LanguageDescription.matchFilename(languages, baseName(path));
  if (!desc) return null;
  try {
    return await desc.load();
  } catch {
    return null; // best-effort — plain text is a perfectly fine degrade
  }
}

export function DraftEditorPane({ cid, path, initialContent, onDraftChange, threadLines }: DraftEditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // latest thread lines, read when the CM state is (re)created
  const threadLinesRef = useRef<readonly number[]>(threadLines ?? []);
  threadLinesRef.current = threadLines ?? [];
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  // Guards a stale debounced write landing after a file/cid switch — same
  // token-guard idiom as EditorPane.tsx / useBrowseTree.ts.
  const opToken = useRef(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const myToken = ++opToken.current;

    const flush = () => {
      if (myToken !== opToken.current || !viewRef.current) return;
      onDraftChangeRef.current(viewRef.current.state.doc.toString());
    };

    const scheduleFlush = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        flush();
      }, AUTOSAVE_DEBOUNCE_MS);
    };

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      scheduleFlush();
    });

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        run: () => {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
          }
          flush();
          return true;
        },
      },
    ]);

    const extensions = [
      history(),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      saveKeymap,
      updateListener,
      buildEditorTheme(),
      // V2 (screen review S5): edit mode keeps the line numbers the read view shows
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      // V2 (screen review r1): no soft-wrap — the read view never wraps, so
      // toggling Edit must not reflow lines either.
      threadMarks(() => threadLinesRef.current),
    ];

    const state = EditorState.create({ doc: initialContent, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    languageExtensionFor(path).then((ext) => {
      if (myToken !== opToken.current || !ext) return;
      const newState = EditorState.create({ doc: view.state.doc, extensions: [...extensions, ext] });
      view.setState(newState);
    });

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        // Flush on unmount (file switch / edit-mode exit) — an edit made
        // just before navigating away must not be silently dropped.
        flush();
      }
      view.destroy();
      viewRef.current = null;
    };
    // path/cid change = a whole new buffer/draft session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, path, initialContent]);

  // thread list refreshes (3 s bump / new thread) → replace the gutter dots
  const threadKey = (threadLines ?? []).join(",");
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setThreadLines.of(threadLinesRef.current.slice()) });
  }, [threadKey]);

  return (
    <div className="cs-editor-pane">
      <div className="cs-editor-host" ref={hostRef} />
    </div>
  );
}

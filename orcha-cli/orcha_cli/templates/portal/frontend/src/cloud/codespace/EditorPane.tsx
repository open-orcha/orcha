/**
 * CM6 editor wrapper for the working-tree file editor (Edit toggle in
 * CodeSpacePage's file header — local-binding only, see worktreeApi.ts's
 * doc comment for the honest-degrade contract). Mounted lazily: CodeSpacePage
 * dynamic-imports this module only once a human actually flips Edit on, so a
 * view-only visitor never pays for the CM6 bundle (verified by the built
 * chunk split — see the report at the end of the build).
 *
 * All the save-lifecycle DECISIONS live in the pure editorSave.ts state
 * machine; this component's only job is wiring CM6 events to that machine's
 * events and rendering its states (dirty dot via onDirty, drift/error
 * banners). Language support loads lazily per-extension through
 * @codemirror/language-data's `languages` list (matched by filename) so the
 * main bundle never bundles every grammar up front.
 */
import { indentWithTab, history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { LanguageDescription } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/primitives";
import { buildEditorTheme } from "./editorTheme";
import { setThreadLines, threadMarks } from "./editorThreadMarks";
import { lessonFocus, lessonFocusSpec, type FocusRange } from "./editorLessonFocus";
import {
  initialSaveState,
  onEdit,
  onOverwrite,
  onReload,
  onSaveDrift,
  onSaveError,
  onSaveOk,
  onSaveStart,
  type EditorSaveState,
} from "./editorSave";
import { fetchWorktreeFile, saveWorktreeFile } from "./worktreeApi";

const AUTOSAVE_DEBOUNCE_MS = 800;

export interface EditorPaneProps {
  cid: string;
  path: string;
  initialContent: string;
  contentHash: string | null;
  readOnly?: boolean;
  onDirty: (dirty: boolean) => void;
  onSaved?: (hash: string) => void;
  /** 1-based lines carrying a code thread — painted as gutter dots, same as the read view. */
  threadLines?: number[];
  /** Learn: the current lesson step's cited lines — glowed, the rest dimmed, first line centred. */
  focusRanges?: FocusRange[] | null;
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

function reasonMessage(reason: string): string {
  if (reason === "exists") return "A file already exists at this path.";
  if (reason === "too_large") return "This file is too large to save through the editor.";
  if (reason === "write_failed") return "Save failed: the file couldn't be written.";
  return "Save failed: " + reason;
}

export function EditorPane({ cid, path, initialContent, contentHash, readOnly, onDirty, onSaved, threadLines, focusRanges }: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // latest thread lines, read when the CM state is (re)created
  const threadLinesRef = useRef<readonly number[]>(threadLines ?? []);
  threadLinesRef.current = threadLines ?? [];
  const focusRef = useRef<FocusRange[] | null>(focusRanges ?? null);
  focusRef.current = focusRanges ?? null;
  const [saveState, setSaveState] = useState<EditorSaveState>(() => initialSaveState(contentHash));
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a stale async save/reload landing after the component's
  // path changed (a human can switch files mid-save) — same token-guard
  // idiom used throughout this codebase (useBrowseTree.ts, WorktreeDiffPane).
  const opToken = useRef(0);

  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    onDirtyRef.current(saveState.status === "dirty" || saveState.status === "saving" || saveState.status === "drift");
  }, [saveState.status]);

  const flushSave = useRef<() => void>(() => {});

  // Reload/close while an autosave is pending or in flight would lose the
  // edit — ask the browser to confirm (its own generic dialog) only then.
  useEffect(() => {
    if (readOnly) return;
    const pending = saveState.status === "dirty" || saveState.status === "saving" || saveState.status === "drift";
    if (!pending) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState.status, readOnly]);

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    const myToken = ++opToken.current;
    setSaveState(initialSaveState(contentHash));

    const doSave = (content: string) => {
      const cur = saveStateRef.current;
      if (cur.status !== "dirty") return;
      setSaveState(onSaveStart(cur));
      saveWorktreeFile(cid, path, content, cur.baseHash).then((res) => {
        if (disposed || myToken !== opToken.current) return;
        if (res.ok) {
          setSaveState(onSaveOk(saveStateRef.current, res.content_hash));
          onSavedRef.current?.(res.content_hash);
        } else if (res.reason === "drift") {
          setSaveState(onSaveDrift(saveStateRef.current, res.current_hash ?? ""));
        } else {
          setSaveState(onSaveError(saveStateRef.current, res.reason === "http" ? res.detail : res.reason));
        }
      });
    };

    flushSave.current = () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (viewRef.current) doSave(viewRef.current.state.doc.toString());
    };

    const scheduleSave = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        if (viewRef.current) doSave(viewRef.current.state.doc.toString());
      }, AUTOSAVE_DEBOUNCE_MS);
    };

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      setSaveState((s) => onEdit(s));
      scheduleSave();
    });

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        run: () => {
          flushSave.current();
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
      lessonFocus(() => focusRef.current),
      EditorView.editable.of(!readOnly),
    ];

    const state = EditorState.create({ doc: initialContent, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    // Language support loads lazily and is appended once resolved — never
    // blocks first paint, and a slow/failed grammar load just leaves the
    // buffer as plain text.
    languageExtensionFor(path).then((ext) => {
      if (disposed || myToken !== opToken.current || !ext) return;
      // Language support arrives asynchronously; append it by re-creating
      // state over the CURRENT doc (preserves any edits made while the
      // grammar was still loading) rather than a compartment — simplest
      // correct approach for a one-shot append that only ever happens once
      // per mount.
      const newState = EditorState.create({ doc: view.state.doc, extensions: [...extensions, ext] });
      view.setState(newState);
    });

    return () => {
      // V2 (C-13, brief: "preserve unsaved drafts across navigation"): an
      // autosave still pending in its debounce window when the human switches
      // files / leaves edit mode is FLUSHED, not dropped — the same
      // flush-on-unmount DraftEditorPane already does. The PUT still carries
      // the base hash, so a concurrent agent edit is caught as drift
      // server-side rather than overwritten; the result is ignored (disposed).
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        // Direct PUT (not doSave): the dirty transition may not have re-rendered
        // into saveStateRef yet when the edit and the unmount land together.
        if (!readOnly) void saveWorktreeFile(cid, path, view.state.doc.toString(), saveStateRef.current.baseHash).catch(() => {});
      }
      disposed = true;
      view.destroy();
      viewRef.current = null;
    };
    // path change = a whole new buffer/session; cid/readOnly changing mid-life
    // is not a real-world case this pane needs to react to live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, path, initialContent]);

  // thread list refreshes (3 s bump / new thread) → replace the gutter dots
  const threadKey = (threadLines ?? []).join(",");
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setThreadLines.of(threadLinesRef.current.slice()) });
  }, [threadKey]);

  // lesson stepping → glow the cited lines, dim the rest, centre the first
  const focusKey = JSON.stringify(focusRanges ?? null);
  useEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch(lessonFocusSpec(view.state.doc, focusRef.current));
  }, [focusKey]);

  const doReload = () => {
    const myToken = ++opToken.current;
    fetchWorktreeFile(cid, path).then((data) => {
      if (myToken !== opToken.current || !data.available) return;
      const content = data.content ?? "";
      if (viewRef.current) {
        viewRef.current.dispatch({
          changes: { from: 0, to: viewRef.current.state.doc.length, insert: content },
        });
      }
      setSaveState(onReload(saveStateRef.current, data.content_hash ?? ""));
    });
  };

  const doOverwrite = () => {
    const next = onOverwrite(saveStateRef.current);
    setSaveState(next);
    if (next.status !== "saving" || !viewRef.current) return;
    const content = viewRef.current.state.doc.toString();
    const myToken = opToken.current;
    saveWorktreeFile(cid, path, content, next.baseHash).then((res) => {
      if (myToken !== opToken.current) return;
      if (res.ok) {
        setSaveState(onSaveOk(saveStateRef.current, res.content_hash));
        onSavedRef.current?.(res.content_hash);
      } else if (res.reason === "drift") {
        setSaveState(onSaveDrift(saveStateRef.current, res.current_hash ?? ""));
      } else {
        setSaveState(onSaveError(saveStateRef.current, res.reason === "http" ? res.detail : res.reason));
      }
    });
  };

  return (
    <div className="cs-editor-pane">
      {saveState.status === "drift" ? (
        <div className="cs-editor-banner cs-editor-banner-drift">
          <span>This file changed on disk (an agent may have edited it).</span>
          <span className="grow" />
          <Button size="sm" variant="secondary" icon="refresh" className="cs-editor-banner-btn" onClick={doReload}>Reload file</Button>
          <Button size="sm" variant="danger" className="cs-editor-banner-btn" onClick={doOverwrite}>Overwrite</Button>
        </div>
      ) : null}
      {saveState.status === "error" ? (
        <div className="cs-editor-banner cs-editor-banner-error">
          <span>{reasonMessage(saveState.errorReason ?? "")}</span>
        </div>
      ) : null}
      <div className="cs-editor-host" ref={hostRef} />
    </div>
  );
}

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
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { buildEditorTheme } from "./editorTheme";
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
  return "Save failed: " + reason;
}

export function EditorPane({ cid, path, initialContent, contentHash, readOnly, onDirty, onSaved }: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
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
          setSaveState(onSaveError(saveStateRef.current, res.reason));
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
      EditorView.lineWrapping,
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
      disposed = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // path change = a whole new buffer/session; cid/readOnly changing mid-life
    // is not a real-world case this pane needs to react to live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, path, initialContent]);

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
        setSaveState(onSaveError(saveStateRef.current, res.reason));
      }
    });
  };

  return (
    <div className="cs-editor-pane">
      {saveState.status === "drift" ? (
        <div className="cs-editor-banner cs-editor-banner-drift">
          <span>This file changed on disk (an agent may have edited it).</span>
          <button type="button" className="cs-editor-banner-btn" onClick={doReload}>Reload file</button>
          <button type="button" className="cs-editor-banner-btn" onClick={doOverwrite}>Overwrite</button>
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

/**
 * Pure autosave state machine for EditorPane — no DOM, no fetch, no CM6.
 * EditorPane drives this with plain events and renders off the returned
 * state; every transition is exhaustively unit-tested in editorSave.test.ts
 * without ever mounting a real editor.
 *
 * States:
 *   clean   — buffer matches what's on disk (content_hash === baseHash).
 *   dirty   — buffer has unsaved edits, no save in flight.
 *   saving  — a PUT is in flight (autosave debounce fired, or Cmd/Ctrl+S).
 *   drift   — the last save came back {ok:false, reason:"drift"}: someone
 *             else (an agent) changed the file on disk since our baseHash.
 *   error   — the last save came back {ok:false, reason:"exists"|"too_large"}
 *             (or a network/transport failure) — buffer is NOT touched, no
 *             data loss, just an inline banner until the next edit/save.
 *
 * Events:
 *   edit          — the buffer changed (clean/dirty -> dirty; also legal
 *                    from error, which just clears the banner and goes
 *                    dirty again — the user is actively fixing something).
 *   save          — a save attempt started (dirty -> saving).
 *   saveOk        — the PUT returned {ok:true, content_hash} (saving ->
 *                    clean, baseHash advances to the returned hash — the
 *                    "hash chain").
 *   saveDrift     — the PUT returned {ok:false, reason:"drift", current_hash}
 *                    (saving -> drift, remembers current_hash for the
 *                    Reload/Overwrite actions).
 *   saveError     — the PUT returned {ok:false, reason:"exists"|"too_large"}
 *                    or the request itself failed (saving -> error).
 *   reload        — user picked "Reload file" on a drift banner: caller
 *                    fetches the current content and calls this with it
 *                    (drift -> clean, buffer/baseHash adopt current_hash).
 *   overwrite     — user picked "Overwrite": caller re-PUTs with
 *                    base_hash = current_hash (drift -> saving, baseHash
 *                    advances to current_hash so the retry uses it).
 */

export type EditorSaveStatus = "clean" | "dirty" | "saving" | "drift" | "error";

export interface EditorSaveState {
  status: EditorSaveStatus;
  baseHash: string | null;
  // Only set while status === "drift" — the hash the PUT reported as
  // currently on disk, needed by both Reload (adopt it) and Overwrite
  // (re-PUT using it as the new base_hash).
  driftHash: string | null;
  // Only set while status === "error" — a short human-readable reason.
  errorReason: string | null;
}

export function initialSaveState(baseHash: string | null): EditorSaveState {
  return { status: "clean", baseHash, driftHash: null, errorReason: null };
}

export function onEdit(state: EditorSaveState): EditorSaveState {
  if (state.status === "saving") return state; // let the in-flight save finish; the next tick will re-dirty if needed
  return { ...state, status: "dirty", driftHash: null, errorReason: null };
}

export function onSaveStart(state: EditorSaveState): EditorSaveState {
  if (state.status !== "dirty") return state;
  return { ...state, status: "saving" };
}

export function onSaveOk(_state: EditorSaveState, contentHash: string): EditorSaveState {
  return { status: "clean", baseHash: contentHash, driftHash: null, errorReason: null };
}

export function onSaveDrift(state: EditorSaveState, currentHash: string): EditorSaveState {
  return { ...state, status: "drift", driftHash: currentHash, errorReason: null };
}

export function onSaveError(state: EditorSaveState, reason: string): EditorSaveState {
  return { ...state, status: "error", errorReason: reason };
}

// "Reload file" — caller has already fetched the current content and
// replaced the buffer; the state machine just adopts the new baseHash and
// goes clean (the freshly-loaded buffer, by definition, matches disk).
export function onReload(_state: EditorSaveState, currentHash: string): EditorSaveState {
  return { status: "clean", baseHash: currentHash, driftHash: null, errorReason: null };
}

// "Overwrite" — the caller is about to re-PUT with base_hash=driftHash;
// advance baseHash to that value now so the retry uses it, and move to
// saving so the UI reflects the in-flight request.
export function onOverwrite(state: EditorSaveState): EditorSaveState {
  if (state.status !== "drift" || state.driftHash == null) return state;
  return { status: "saving", baseHash: state.driftHash, driftHash: null, errorReason: null };
}

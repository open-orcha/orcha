/**
 * Pure state machine for the "Propose changes…" panel (drafts bar, Phase 4
 * GitHub-bound editing) — no DOM, no fetch. Mirrors editorSave.ts's split:
 * every transition here is exhaustively unit-tested in draftPropose.test.ts
 * without mounting the panel, and the panel component only renders off the
 * returned state and dispatches plain events.
 *
 * States:
 *   idle      — panel closed or freshly opened, no request in flight.
 *   sending   — the POST .../propose is in flight.
 *   ok        — the last propose succeeded; carries the PR to link to.
 *   drift     — {ok:false, reason:"drift"|"exists", paths}: one or more
 *               drafted files are stale against the current default-ref tree
 *               (or a file already exists there under "exists" — same
 *               per-file "Reload base" recovery either way per the spec).
 *   error     — {ok:false, reason:"github_error", detail} or a network/
 *               transport failure — drafts are untouched, message is kept so
 *               the human doesn't retype it.
 *
 * Events:
 *   open        — idle -> idle (no-op state-wise; the component owns
 *                 open/closed separately, this machine only tracks the
 *                 request lifecycle) — included for symmetry/tests only via
 *                 reset().
 *   send        — idle/drift/error -> sending.
 *   sendOk      — sending -> ok, carries the PR fields.
 *   sendDrift   — sending -> drift, carries the stale paths.
 *   sendError   — sending -> error, carries the detail (or a fallback string
 *                 for a thrown/transport failure).
 *   reset       — any -> idle (panel closed, or "propose again" after ok).
 */
import type { ProposeChangesResult } from "./githubEditApi";

export type ProposeStatus = "idle" | "sending" | "ok" | "drift" | "error";

export interface ProposeState {
  status: ProposeStatus;
  // Only set on ok.
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  // Only set on drift — the paths the server flagged as stale/pre-existing.
  staleReason: "drift" | "exists" | null;
  stalePaths: string[];
  // Only set on error.
  errorDetail: string | null;
}

export function initialProposeState(): ProposeState {
  return {
    status: "idle",
    prNumber: null,
    prUrl: null,
    branch: null,
    staleReason: null,
    stalePaths: [],
    errorDetail: null,
  };
}

export function onSend(state: ProposeState): ProposeState {
  if (state.status === "sending") return state;
  return { ...initialProposeState(), status: "sending" };
}

// Applies a resolved ProposeChangesResult, whichever shape it came back as —
// the caller (the panel) just awaits proposeChanges() and hands the raw
// result here rather than re-deriving branches itself.
export function onSendResult(state: ProposeState, result: ProposeChangesResult): ProposeState {
  if (state.status !== "sending") return state;
  if (result.ok) {
    return {
      ...initialProposeState(),
      status: "ok",
      prNumber: result.pr_number,
      prUrl: result.pr_url,
      branch: result.branch,
    };
  }
  if (result.reason === "drift" || result.reason === "exists") {
    return {
      ...initialProposeState(),
      status: "drift",
      staleReason: result.reason,
      stalePaths: result.paths ?? [],
    };
  }
  const detail = result.reason === "github_error" ? result.detail : undefined;
  return {
    ...initialProposeState(),
    status: "error",
    errorDetail: detail ?? "Something went wrong proposing these changes.",
  };
}

export function onSendThrew(state: ProposeState, detail: string): ProposeState {
  if (state.status !== "sending") return state;
  return { ...initialProposeState(), status: "error", errorDetail: detail };
}

export function onReset(_state: ProposeState): ProposeState {
  return initialProposeState();
}

/**
 * Drafts bar (Phase 4, GitHub-bound editing) — a slim strip above the content
 * pane, shown whenever this container/ref has any local drafts
 * (draftStore.ts). Lists each drafted path (click opens it) with a per-file
 * discard (✕), and a "Propose changes…" affordance that expands an inline
 * panel (no modal library — house style): a message textarea (first line
 * becomes the PR title, per BACKEND CONTRACT) + Propose button.
 *
 * Owns the propose request lifecycle via the pure draftPropose.ts state
 * machine; on ok it clears the proposed drafts from draftStore and shows a
 * success notice linking to the PR (external, target=_blank) plus an
 * "Open in hub" link to this app's own PR detail route (/github?pr=<n>,
 * confirmed by GitHubPage.tsx's own ?pr= deep-link contract). On
 * drift/exists it keeps the drafts and offers a per-file "Reload base"
 * action; on github_error it keeps the drafts and shows the detail.
 */
import { useCallback, useState } from "react";
import { deleteDraft, putDraft, type DraftListEntry } from "./draftStore";
import {
  initialProposeState,
  onReset,
  onSend,
  onSendResult,
  onSendThrew,
} from "./draftPropose";
import { fetchFile } from "../github/browse/browseApi";
import { proposeChanges } from "./githubEditApi";

export interface DraftsBarProps {
  cid: string;
  gitRef: string;
  drafts: DraftListEntry[];
  onOpenDraft: (path: string) => void;
  onDraftsChanged: () => void; // re-run listDrafts after a discard/propose/reload
}

export function DraftsBar({ cid, gitRef, drafts, onOpenDraft, onDraftsChanged }: DraftsBarProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [state, setState] = useState(initialProposeState());
  const [reloading, setReloading] = useState<string | null>(null);

  const discard = useCallback(async (path: string) => {
    await deleteDraft(cid, gitRef, path);
    onDraftsChanged();
  }, [cid, gitRef, onDraftsChanged]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setState(onReset(state));
  }, [state]);

  const send = useCallback(async () => {
    if (!message.trim() || drafts.length === 0) return;
    setState((s) => onSend(s));
    try {
      const result = await proposeChanges(cid, {
        base_ref: gitRef,
        message,
        files: drafts.map((d) => ({ path: d.path, content: d.content, base_hash: d.baseHash })),
      });
      setState((s) => onSendResult(s, result));
      if ("ok" in result && result.ok) {
        await Promise.all(drafts.map((d) => deleteDraft(cid, gitRef, d.path)));
        setMessage("");
        onDraftsChanged();
      }
    } catch (e) {
      setState((s) => onSendThrew(s, (e as Error).message || "Network error"));
    }
  }, [cid, gitRef, drafts, message, onDraftsChanged]);

  const reloadBase = useCallback(async (path: string) => {
    setReloading(path);
    try {
      const res = await fetchFile(cid, gitRef, path);
      const draft = drafts.find((d) => d.path === path);
      if (res.ok && draft) {
        // Keep the human's edited content; only the base pointer moves — the
        // fresh payload's blob_sha becomes the new claim (null on servers that
        // predate the field, which the propose contract treats as no-claim).
        await putDraft(cid, gitRef, path, { content: draft.content, baseHash: res.data.blob_sha ?? null });
        onDraftsChanged();
      }
    } finally {
      setReloading(null);
    }
  }, [cid, gitRef, drafts, onDraftsChanged]);

  if (drafts.length === 0) return null;

  return (
    <div className="cs-drafts-bar">
      <div className="cs-drafts-row">
        <span className="cs-drafts-count">{drafts.length} drafted file{drafts.length === 1 ? "" : "s"}</span>
        <div className="cs-drafts-paths">
          {drafts.map((d) => {
            const stale = state.status === "drift" && state.stalePaths.includes(d.path);
            return (
              <span key={d.path} className={"cs-drafts-chip" + (stale ? " stale" : "")}>
                <button type="button" className="cs-drafts-chip-path" onClick={() => onOpenDraft(d.path)} title={d.path}>
                  {d.path}
                </button>
                {stale ? (
                  <button
                    type="button"
                    className="cs-drafts-reload-btn"
                    onClick={() => reloadBase(d.path)}
                    disabled={reloading === d.path}
                    title={state.staleReason === "exists" ? "A file now exists at this path — reload and re-propose" : "This file changed upstream — reload and re-propose"}
                  >
                    {reloading === d.path ? "Reloading…" : "Reload base"}
                  </button>
                ) : null}
                <button type="button" className="cs-drafts-discard-btn" onClick={() => discard(d.path)} aria-label={"Discard draft for " + d.path} title="Discard this draft">
                  ✕
                </button>
              </span>
            );
          })}
        </div>
        <button type="button" className="cs-propose-open-btn" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}>
          Propose changes…
        </button>
      </div>

      {panelOpen ? (
        <div className="cs-propose-panel" role="dialog" aria-label="Propose changes">
          {state.status === "ok" ? (
            <div className="cs-propose-notice cs-propose-notice-ok">
              <span>
                Opened <a href={state.prUrl ?? "#"} target="_blank" rel="noopener noreferrer">PR #{state.prNumber}</a> on branch {state.branch}.
              </span>
              <a className="cs-propose-hub-link" href={"/github?pr=" + state.prNumber}>Open in hub</a>
              <button type="button" className="cs-propose-cancel-btn" onClick={closePanel}>Close</button>
            </div>
          ) : (
            <>
              {state.status === "drift" ? (
                <div className="cs-propose-notice cs-propose-notice-warn">
                  {state.staleReason === "exists" ? "Some files already exist at their target path — use Reload base above, then propose again." : "Some drafts are stale against the latest default branch — use Reload base above, then propose again."}
                </div>
              ) : null}
              {state.status === "error" ? (
                <div className="cs-propose-notice cs-propose-notice-error">{state.errorDetail}</div>
              ) : null}
              <textarea
                className="cs-propose-message"
                placeholder={"Short summary (PR title)\n\nOptional details…"}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
              />
              <div className="cs-propose-actions">
                <button
                  type="button"
                  className="cs-propose-send-btn"
                  onClick={send}
                  disabled={state.status === "sending" || !message.trim()}
                >
                  {state.status === "sending" ? "Proposing…" : "Propose"}
                </button>
                <button type="button" className="cs-propose-cancel-btn" onClick={closePanel}>Cancel</button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

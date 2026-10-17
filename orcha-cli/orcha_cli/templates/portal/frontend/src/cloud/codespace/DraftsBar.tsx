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
import { Button, IconButton } from "../../components/primitives";
import { Icon } from "../../components/ui";
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
import { useCodeWriteBlock } from "./writeAccess";
import { withCid } from "../../lib/scope";

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
  // viewer / non-member: propose is refused server-side (trusted_actor)
  const writeBlock = useCodeWriteBlock();

  const discard = useCallback(async (path: string) => {
    await deleteDraft(cid, gitRef, path);
    onDraftsChanged();
  }, [cid, gitRef, onDraftsChanged]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setState(onReset(state));
  }, [state]);

  const send = useCallback(async () => {
    if (writeBlock || !message.trim() || drafts.length === 0) return;
    setState((s) => onSend(s));
    try {
      const result = await proposeChanges(cid, {
        // C21: "HEAD" is the viewer's symbolic ref, not a GitHub ref — send ""
        // so the server resolves the repo's default branch (a real PR base).
        base_ref: gitRef === "HEAD" ? "" : gitRef,
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

  const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

  // CODE-062: a successful propose CLEARS the drafts it sent — the success
  // notice (PR link + Open in hub) must outlive them, so the bar stays
  // mounted with just the notice until the human closes it.
  const okNotice = state.status === "ok" ? (
    <div className="cs-propose-notice cs-propose-notice-ok" role="status">
      <Icon name="check" cls="v2-ico" />
      <span>
        {/* never "PR #undefined" / "?pr=undefined" if a response lacks the number */}
        Opened {state.prNumber != null
          ? <a href={state.prUrl ?? "#"} target="_blank" rel="noopener noreferrer">PR #{state.prNumber}</a>
          : state.prUrl ? <a href={state.prUrl} target="_blank" rel="noopener noreferrer">a pull request</a> : "a pull request"}
        {state.branch ? <> on branch <span className="mono">{state.branch}</span></> : null}.
      </span>
      {state.prNumber != null ? <a className="cs-propose-hub-link" href={withCid("/github?pr=" + state.prNumber, cid)}>Open in hub</a> : null}
      <Button size="sm" variant="ghost" className="cs-propose-cancel-btn" onClick={closePanel}>Close</Button>
    </div>
  ) : null;

  if (drafts.length === 0) {
    return okNotice ? <div className="cs-drafts-bar cs-drafts-bar-done">{okNotice}</div> : null;
  }

  // V2 (screen review S2): ONE neutral line — count + a single-line summary of
  // the drafted names + the primary Propose action. The per-file controls
  // (open / reload base / discard) live in the propose panel, which is where a
  // human reviews what's about to become a pull request.
  return (
    <div className="cs-drafts-bar">
      <div className="cs-drafts-row">
        <span className="cs-drafts-dot" aria-hidden="true" />
        <span className="cs-drafts-count" title="Drafts are stored in this browser only until you propose them">
          {drafts.length} drafted file{drafts.length === 1 ? "" : "s"} · this browser
        </span>
        <span className="cs-drafts-names mono" title={drafts.length > 1 ? drafts.map((d) => d.path).join("\n") : undefined} aria-hidden="true">
          {drafts.map((d) => fileName(d.path)).join(", ")}
        </span>
        <Button
          size="sm"
          variant={panelOpen ? "secondary" : "primary"}
          icon="git"
          className="cs-propose-open-btn"
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
        >
          Propose changes…
        </Button>
      </div>

      {panelOpen ? (
        <div className="cs-propose-panel" role="region" aria-label="Propose changes">
          <div className="cs-drafts-list">
            {drafts.map((d) => {
              const stale = state.status === "drift" && state.stalePaths.includes(d.path);
              return (
                <div key={d.path} className={"cs-drafts-item" + (stale ? " stale" : "")}>
                  <Icon name={stale ? "alert" : "pencil"} cls={"v2-ico cs-drafts-item-ico" + (stale ? " warn" : "")} />
                  <button type="button" className="cs-drafts-chip-path mono" onClick={() => onOpenDraft(d.path)} title={d.path}>
                    {d.path}
                  </button>
                  {stale ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="refresh"
                      className="cs-drafts-reload-btn"
                      onClick={() => reloadBase(d.path)}
                      busy={reloading === d.path}
                      title={state.staleReason === "exists" ? "A file now exists at this path — reload and re-propose" : "This file changed upstream — reload and re-propose"}
                    >
                      {reloading === d.path ? "Reloading…" : "Reload base"}
                    </Button>
                  ) : null}
                  <IconButton
                    size="sm"
                    icon="trash"
                    variant="danger"
                    className="cs-drafts-discard-btn"
                    onClick={() => discard(d.path)}
                    label={"Discard draft for " + d.path}
                    title="Discard this draft"
                  />
                </div>
              );
            })}
          </div>
          {okNotice ? (
            okNotice
          ) : (
            <>
              {state.status === "drift" ? (
                <div className="cs-propose-notice cs-propose-notice-warn" role="alert">
                  <Icon name="alert" cls="v2-ico" />
                  <span>{state.staleReason === "exists" ? "Some files already exist at their target path — use Reload base above, then propose again." : "Some drafts are stale against the latest default branch — use Reload base above, then propose again."}</span>
                </div>
              ) : null}
              {state.status === "error" ? (
                <div className="cs-propose-notice cs-propose-notice-error" role="alert">
                  <Icon name="alert" cls="v2-ico" />
                  <span>{state.errorDetail}</span>
                </div>
              ) : null}
              <p className="cs-propose-dest">
                Opens a <strong>new branch and pull request</strong> against the default branch with{" "}
                {drafts.length === 1 ? "this drafted file" : "these " + drafts.length + " drafted files"}.
                The default branch is never written directly, and merging stays a separate step.
              </p>
              <textarea
                aria-label="Pull request message"
                className="cs-propose-message"
                placeholder={"Short summary (PR title)\n\nOptional details…"}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
              />
              <div className="cs-propose-actions">
                <Button size="sm" variant="ghost" className="cs-propose-cancel-btn" onClick={closePanel}>Cancel</Button>
                <Button
                  size="sm"
                  variant="primary"
                  className="cs-propose-send-btn"
                  onClick={send}
                  busy={state.status === "sending"}
                  disabled={!!writeBlock || !message.trim()}
                  title={writeBlock || undefined}
                >
                  {state.status === "sending" ? "Proposing…" : "Propose"}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

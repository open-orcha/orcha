/**
 * Phase 1 — the thread composer: one-click kind templates ("How does this
 * work?" / "Why this decision?" / "Teach me this concept" / plain note),
 * @agent picker (container AI agents from the snapshot), and the POST per
 * spec (docs/orcha-code-space-design.md's Phase 1 API). Acting-human gated
 * like every mutation surface (postStart/postStop precedent).
 *
 * Also reused by Phase 2's "raise hand" flow (LivePanel.tsx): pre-tagged at
 * the run's agent, with the honest "queued — the agent addresses this at its
 * next checkpoint" caption instead of a free @agent picker.
 */
import { useEffect, useState } from "react";
import { useToast } from "../../components/ui";
import { navigateScoped } from "../../lib/scope";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { createThread } from "./codespaceApi";
import { anchorLabel, THREAD_TEMPLATES, type CreateThreadResponse, type ThreadKind } from "./codespaceTypes";

export interface ThreadComposerProps {
  cid: string;
  // NOT named "ref" — that's a reserved JSX/React prop (element refs); see
  // RepoBrowser.tsx's identical convention/comment for `gitRef`.
  gitRef: string;
  path: string;
  startLine: number;
  endLine: number;
  agents: Agent[];
  // Item 2 (rendered-markdown "Discuss this document") — a FILE-LEVEL anchor
  // (start_line=1, end_line=1) posted from Rendered mode's document-level
  // affordance, not an actual line-1 selection. The anchor line swaps its
  // "line 1" label for an explicit "whole document" one so the composer is
  // never ambiguous about which kind of anchor it's posting.
  wholeDocument?: boolean;
  // Phase 2 raise-hand: pre-tag a specific agent and lock the picker, with
  // the honest queued-caption instead of the free picker.
  preTaggedAgentId?: string | null;
  // Item 5 — the full create response (thread + opening message), not just
  // the id: lets the caller (ThreadRail) seed ThreadView optimistically
  // instead of waiting on a fresh GET /code/threads/{id}.
  onCreated?: (created: CreateThreadResponse) => void;
  onCancel?: () => void;
}

export function ThreadComposer({
  cid,
  gitRef,
  path,
  startLine,
  endLine,
  agents,
  wholeDocument,
  preTaggedAgentId,
  onCreated,
  onCancel,
}: ThreadComposerProps) {
  const { snap } = useSnapshot();
  const toast = useToast();
  const [kind, setKind] = useState<ThreadKind>("question");
  const [body, setBody] = useState(THREAD_TEMPLATES[0].starterBody);
  const [taggedAgentId, setTaggedAgentId] = useState<string>(preTaggedAgentId || "");
  const [busy, setBusy] = useState(false);

  const aiAgents = agents.filter((a) => a.kind === "ai");
  const raiseHand = !!preTaggedAgentId;

  // Composer transparency: an untagged question-like thread (question | why |
  // teach — NOT note) auto-routes server-side to the container's default AI
  // agent (code_space_routes.create_code_thread / _default_ai_agent_id — the
  // first live agent from the snapshot, same order as aiAgents[0] since the
  // snapshot query is already `terminated_at IS NULL ORDER BY created_at`).
  // Surface where an untagged question is actually headed BEFORE posting,
  // instead of leaving it a silent surprise — or the honest opposite when
  // there's no AI agent to catch it.
  const questionLike = kind === "question" || kind === "why" || kind === "teach";
  const willAutoRoute = !raiseHand && questionLike && !taggedAgentId;
  const defaultAgent = aiAgents[0];
  // No live AI agent = nobody can EVER answer a question-like thread (the
  // server-side auto-route comes up empty and the thread sits orphaned — the
  // exact silent-surprise this composer exists to prevent). Block posting
  // question|why|teach until an agent exists; `note` stays allowed, it is
  // untargeted by design.
  const questionBlocked = !raiseHand && questionLike && aiAgents.length === 0;
  const routingHint =
    willAutoRoute && defaultAgent ? `Will ask @${defaultAgent.alias}` : null;

  // Usability sweep — Escape closes the composer (papercut: this was the
  // only transient panel in Code Space WITHOUT an Escape handler; matches
  // SymbolSearch's palette and RecentFilesDropdown's convention).
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const pickTemplate = (t: (typeof THREAD_TEMPLATES)[number]) => {
    setKind(t.kind);
    setBody(t.starterBody);
  };

  const submit = () => {
    const who = actingHuman(snap);
    if (!who) { toast("Pick an acting human first", "warn"); return; }
    if (!body.trim()) { toast("Write something first", "warn"); return; }
    if (questionBlocked) { toast("Register an AI agent first — nobody can answer yet", "warn"); return; }
    setBusy(true);
    createThread(cid, {
      ref: gitRef,
      path,
      start_line: startLine,
      end_line: endLine,
      kind,
      body: body.trim(),
      tagged_agent_id: taggedAgentId || undefined,
      actor_agent_id: who.id,
    }).then((res) => {
      setBusy(false);
      if (!res.ok) {
        toast("Couldn't post thread" + (res.error.detail ? ": " + res.error.detail : ""), "danger");
        return;
      }
      toast("Thread posted", "ok");
      onCreated?.(res.data);
    });
  };

  return (
    <div className="cs-composer">
      <div className="cs-composer-anchor">
        {path} · {wholeDocument ? "whole document" : "line " + anchorLabel(startLine, endLine)}
      </div>
      {!raiseHand ? (
        <div className="cs-templates" role="group" aria-label="Question templates">
          {THREAD_TEMPLATES.map((t) => (
            <button
              key={t.kind}
              type="button"
              className={"cs-template-btn" + (kind === t.kind ? " on" : "")}
              onClick={() => pickTemplate(t)}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="cs-raise-hand-caption">queued — the agent addresses this at its next checkpoint</div>
      )}
      {routingHint ? <div className="cs-routing-hint">{routingHint}</div> : null}
      {questionBlocked ? (
        <div className="cs-no-agent-warn" role="alert">
          <span>
            <b>No AI agent in this workspace</b> — nobody can answer a question yet.
            Register an agent first, then come back and ask.
          </span>
          <button type="button" className="btn sm" onClick={() => navigateScoped("/agents")}>
            Register an agent
          </button>
        </div>
      ) : null}
      <textarea
        className="cs-composer-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write your message…"
        aria-label="Thread message"
      />
      <div className="cs-composer-row">
        {!raiseHand ? (
          <select
            className="cs-agent-select"
            value={taggedAgentId}
            aria-label="Tag an agent"
            onChange={(e) => setTaggedAgentId(e.target.value)}
          >
            <option value="">No @agent tag</option>
            {aiAgents.map((a) => (
              <option key={a.id} value={a.id}>@{a.alias}</option>
            ))}
          </select>
        ) : (
          <span className="cs-agent-select muted" aria-hidden="true">
            @{(aiAgents.find((a) => a.id === preTaggedAgentId) || { alias: "agent" }).alias}
          </span>
        )}
        {onCancel ? (
          <button type="button" className="btn ghost sm" onClick={onCancel}>Cancel</button>
        ) : null}
        <button type="button" className="btn approve sm" disabled={busy || questionBlocked} onClick={submit}>
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}

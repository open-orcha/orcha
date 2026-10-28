import { TaskMessageDelivery } from "../tasks/TaskMessageDelivery";
import { useEffect, useRef, useState } from "react";
import { getJSON, sendJSON } from "../../api/client";
import { Button, Timeline, TimelineComment } from "../../components/primitives";
import { Linkified } from "../../components/ui";
import { useActingAuthority } from "../../state/SnapshotProvider";
import type { DraftScope } from "./workflowDraft";
import { useWorkflowForm } from "./workflowFormState";

interface Message { message_id: string; author_id: string | null; author_alias: string | null; is_human: boolean; body: string; created_at: string }
interface Page { task_id: string; messages: Message[]; has_more?: boolean; next_before?: string | null; next_before_id?: string | null }

export function WorkflowDiscussion({ taskId, scope, locked = false }: { taskId: string; scope: DraftScope; locked?: boolean }) {
  const authority = useActingAuthority();
  const [draft, setDraft] = useWorkflowForm(scope, `discussion:${taskId}`, "");
  const [pending, setPending] = useWorkflowForm<{ text: string; since: string } | null>(scope, `discussion-pending:${taskId}`, null);
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [messagesSent, setMessagesSent] = useState({ taskId: taskId, count: 0 });
  const [error, setError] = useState("");
  const alive = useRef(true);
  const url = `/api/tasks/${encodeURIComponent(taskId)}/messages`;
  async function load(earlier = false) {
    if (busy) return;
    setBusy(true); setError("");
    const query = new URLSearchParams({ limit: "30" });
    if (earlier && page?.next_before && page.next_before_id) { query.set("before", page.next_before); query.set("before_id", page.next_before_id); }
    try {
      const next = await getJSON<Page>(`${url}?${query}`);
      if (next.task_id !== taskId) throw new Error("This discussion changed. Open the task again.");
      if (!alive.current) return;
      setPage((old) => ({ ...next, messages: earlier && old ? [...new Map([...next.messages, ...old.messages].map((m) => [m.message_id, m])).values()] : next.messages }));
      if (pending) {
        if (next.messages.some((m) => m.author_id === scope.identity && m.body === pending.text && Date.parse(m.created_at) >= Date.parse(pending.since))) { setPending(null); setDraft(""); }
        else setError("The earlier message is still unconfirmed. Check the discussion again before sending another copy.");
      }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Could not load this discussion."); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [taskId]);
  async function send() {
    if (sending || pending || !draft.trim() || locked || !authority.human || authority.human.id !== scope.identity) return;
    setSending(true); setError("");
    const text = draft.trim();
    setPending({ text, since: new Date(Date.now() - 5_000).toISOString() });
    try {
      await sendJSON("POST", url, { author_agent_id: scope.identity, body: text });
      if (!alive.current) return;
      setPending(null); setDraft(""); setMessagesSent((old) => ({ taskId: taskId, count: old.taskId === taskId ? old.count + 1 : 1 }));
      // Refresh does not retry the write.
      const next = await getJSON<Page>(`${url}?limit=30`);
      if (alive.current && next.task_id === taskId) setPage(next);
    } catch (e) {
      if (!alive.current) return;
      const status = (e as { status?: number }).status;
      if (status && status < 500) setPending(null);
      setError(status && status < 500 ? "The message was refused. Your draft is kept." : "Delivery is unconfirmed. Check the discussion before sending another copy.");
    } finally { if (alive.current) setSending(false); }
  }
  return <section className="wf-discussion" aria-label="Task discussion">
    <div className="wf-actionsgrid"><Button disabled={busy || sending} onClick={() => void load()}>Refresh discussion</Button>{page?.has_more && <Button disabled={busy} onClick={() => void load(true)}>Load earlier messages</Button>}</div>
    {busy && <p role="status">Loading discussion…</p>}{error && <p role="alert">{error}</p>}
    <Timeline label="Discussion messages">{page?.messages.map((m) => <TimelineComment key={m.message_id} author={m.author_alias ?? "System"} at={m.created_at}><Linkified text={m.body} /></TimelineComment>)}</Timeline>
    {page && !page.messages.length && <p>No messages yet.</p>}
    <TaskMessageDelivery key={taskId} taskId={taskId} sent={messagesSent.taskId === taskId ? messagesSent.count : 0} />
    <label>Message<textarea maxLength={4000} value={draft} disabled={sending || !!pending || locked || !authority.human} onChange={(e) => setDraft(e.target.value)} /></label>
    <p className="wf-muted">Discussion messages do not approve plans or accept finished work.</p>
    <Button variant="primary" disabled={sending || !!pending || locked || !authority.human || !draft.trim()} onClick={() => void send()}>Send message</Button>
    {pending && <Button disabled={busy || sending} onClick={() => void load()}>Check delivery</Button>}
  </section>;
}

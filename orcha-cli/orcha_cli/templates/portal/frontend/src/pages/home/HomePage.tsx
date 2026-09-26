/**
 * Home / Dashboard — React port of static/home.html (its self-contained inline
 * script), emitting the SAME class names + DOM structure so the shared
 * styles.css skins it identically. The page-scoped <style> block from
 * home.html rides along verbatim (it lived in that file, not styles.css).
 *
 * Backend UNCHANGED: every endpoint/method/body below is copied from the
 * vanilla script — POST /api/decisions (plan_approval) and
 * POST /api/tasks/{tid}/verify, both carrying the acting human's id.
 */
import { useEffect, useState } from "react";
import { navigateScoped } from "../../lib/scope";
import { sendJSON } from "../../api/client";
import { esc, relTime, trunc } from "../../lib/format";
import { reviewFor } from "../../lib/reviewer";
import {
  actingHuman,
  agentByAlias,
  attnItems,
  useSnapshot,
} from "../../state/SnapshotProvider";
import { Avatar, Icon, Linkified, Modal, Pill, useToast } from "../../components/ui";
import { Shell } from "../../shell/Shell";
import type { ActiveRun, Agent, OrchaRequest, Snapshot, Task } from "../../types";

/* ---- dashboard-specific layout (verbatim from home.html's <style>) ------- */
const PAGE_CSS = `
  .dash-grid { display: grid; grid-template-columns: minmax(0,1fr) 372px; gap: 18px; align-items: start; }
  @media (max-width: 1080px) { .dash-grid { grid-template-columns: 1fr; } }

  .ctxbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 14px 18px; margin-bottom: 22px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-sm); }
  .ctxbar .nm { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
  .ctxbar .desc { color: var(--muted); font-size: 12.5px; max-width: 60ch; }
  .ctxbar .sep { width: 1px; height: 26px; background: var(--border); }
  .ctxbar .stat { display: flex; flex-direction: column; gap: 1px; }
  .ctxbar .stat .n { font-size: 16px; font-weight: 750; font-variant-numeric: tabular-nums; line-height: 1; }
  .ctxbar .stat .l { font-size: 10.5px; color: var(--faint); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }

  /* first-run get-started CTA (empty workspace — no AI agents) */
  .onb-cta { display: flex; align-items: center; gap: 16px; padding: 18px 20px; margin-bottom: 22px; border-radius: 15px;
    background: linear-gradient(180deg, var(--accent-soft), transparent); border: 1px solid var(--accent-line); box-shadow: var(--shadow-sm); }
  .onb-cta .oic { width: 46px; height: 46px; border-radius: 13px; flex: none; display: grid; place-items: center;
    background: var(--accent); color: var(--accent-ink); }
  .onb-cta .oic svg { width: 23px; height: 23px; }
  .onb-cta .body { flex: 1; min-width: 0; }
  .onb-cta .t1 { font-size: 16px; font-weight: 740; letter-spacing: -.01em; }
  .onb-cta .t2 { color: var(--muted); font-size: 13px; margin-top: 3px; line-height: 1.5; }

  /* action queue */
  .hero-h { display: flex; align-items: center; gap: 11px; margin: 2px 2px 14px; }
  .hero-h .t { font-size: 18px; font-weight: 720; letter-spacing: -.02em; }
  .hero-h .badge { background: var(--warn); color: #1c1304; font-weight: 800; font-size: 12px; border-radius: 999px;
    min-width: 22px; height: 22px; padding: 0 7px; display: grid; place-items: center; font-variant-numeric: tabular-nums; }
  .hero-h .sub { color: var(--muted); font-size: 13px; }

  .aq-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; margin-bottom: 30px; }
  .aq-empty { color: var(--muted); font-size: 13px; padding: 14px 2px; }
  .aq { display: flex; flex-direction: column; gap: 11px; padding: 16px 17px; border-radius: 15px;
    background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow-sm); position: relative; overflow: hidden; }
  .aq::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; }
  .aq.plan::before { background: var(--amber); }
  .aq.verify::before { background: var(--warn); }
  .aq.esc::before { background: var(--danger); }
  .aq .type { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 750;
    letter-spacing: .05em; text-transform: uppercase; }
  .aq.plan .type { color: var(--amber); } .aq.verify .type { color: var(--warn); } .aq.esc .type { color: var(--danger); }
  .aq .type svg { width: 14px; height: 14px; }
  .aq .ttl { font-size: 15px; font-weight: 680; line-height: 1.3; letter-spacing: -.01em; }
  .aq .who { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
  .aq .ctx { color: var(--text-2); font-size: 12.5px; line-height: 1.5; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px; max-height: 220px; overflow: auto; white-space: pre-wrap; }
  .aq .ctx .lbl { color: var(--faint); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; font-weight: 650; display: block; margin-bottom: 3px; }
  .aq .acts { display: flex; gap: 8px; margin-top: auto; padding-top: 3px; flex-wrap: wrap; }
  /* collab v1 (cloud pages/home.css): someone-else's-review de-emphasis */
  .aq.verify.other-review { opacity: .55; }
  .aq.verify.other-review:hover { opacity: .85; }
  .aq .type .tag.review-for { margin-left: 7px; text-transform: none; letter-spacing: 0; }

  /* kanban */
  .kanban { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 13px; }
  @media (max-width: 1180px) { .kanban { grid-template-columns: repeat(2, 1fr); } }
  .kcol { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; }
  .kcol .kh { display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-bottom: 1px solid var(--border); }
  .kcol .kh .ct { margin-left: auto; font-size: 11.5px; font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; }
  .kcol .kb { padding: 9px; display: flex; flex-direction: column; gap: 8px; min-height: 50px; max-height: 460px; overflow: auto; }
  .kcard { display: flex; flex-direction: column; gap: 8px; padding: 11px 12px; border-radius: 11px; background: var(--surface-2);
    border: 1px solid var(--border); cursor: pointer; transition: border-color .12s, transform .06s; }
  .kcard:hover { border-color: var(--accent-line); transform: translateY(-1px); }
  .kcard .kt { font-size: 12.5px; font-weight: 620; line-height: 1.35; }
  .kcard .kf { display: flex; align-items: center; gap: 8px; }
  .kcard .kf .prio { margin-left: auto; }

  /* activity */
  .act-list { display: flex; flex-direction: column; max-height: 540px; overflow: auto; }
  .act { display: flex; gap: 10px; padding: 10px 4px; border-bottom: 1px solid var(--border); align-items: flex-start; }
  .act:last-child { border-bottom: 0; }
  .act .body { flex: 1; min-width: 0; }
  .act .top { display: flex; align-items: center; gap: 7px; }
  .act .nm { font-size: 12.5px; font-weight: 650; }
  .act .when { margin-left: auto; color: var(--faint); font-size: 11px; white-space: nowrap; }
  .act .ty { font-size: 9.5px; font-weight: 750; letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px; border-radius: 5px; }
  .act .txt { font-size: 12.5px; color: var(--text-2); margin-top: 2px; line-height: 1.45; }
`;

const asText = (v: unknown): string => (v == null ? "" : String(v));

/* ---- deeplink helper (port of app.js agentLink) -------------------------- */
function AgentLink({ snap, alias }: { snap: Snapshot | null; alias: string | null | undefined }) {
  const a = agentByAlias(snap, alias);
  if (!a) return <>{alias || "—"}</>;
  return (
    <a className="dlink" href={"/agents?agent=" + encodeURIComponent(alias!)}>
      <Avatar alias={alias} kind={a.kind} />
      <span>{alias}</span>
    </a>
  );
}

/* ---- ISS-68 plan text/author (thread-free via plan_message) -------------- */
function planText(t: Task): string {
  if (t.plan_message) return t.plan_message.body || "";
  const m = (t.thread || []).filter((x) => !x.is_human);
  return m.length ? m[0].body : "";
}
function planAuthor(t: Task): string | null | undefined {
  if (t.plan_message) return t.plan_message.author_alias || (t.assignees || [])[0];
  const m = (t.thread || []).filter((x) => !x.is_human);
  return m.length ? m[0].from || (t.assignees || [])[0] : (t.assignees || [])[0];
}

/* ---- #340 friendly labels for task-less live worker runs ----------------- */
const RUN_LABELS: Record<string, string> = {
  conversation_turn: "In conversation", request_answered: "Handling a reply",
  request_created: "Handling a request", request_closed: "Wrapping up a request",
  task_message: "On a task thread", checkpoint_respawn: "Checking in",
  auto_wake: "Auto-wake check", task_request_accepted: "Picked up a task",
  task_verified: "Verifying a task", live_terminal: "Live terminal",
  task_assigned: "Starting a task", decision_made: "Acting on a decision", prompt: "Working",
};
function runLabel(ar: ActiveRun): string {
  if (ar.has_conversation) return RUN_LABELS.conversation_turn;
  return RUN_LABELS[ar.wake_event || ""] || (ar.wake_event ? ar.wake_event.replace(/_/g, " ") : "Working");
}
// #340: the Activity label is driven by the LIVE worker run, falling back to
// the persistent assigned task only when no run is live.
function activityOf(a: Agent): { text: string; isTask: boolean } | null {
  const ar = a.active_run;
  if (ar) {
    if (ar.task_id) {
      const title = ar.task_title || (a.current_task && a.current_task.title) || "On a task";
      return { text: trunc(title, 32), isTask: true };
    }
    return { text: runLabel(ar), isTask: false };
  }
  const ct = a.current_task;
  if (ct && ct.task_id) return { text: trunc(ct.title || "", 32), isTask: true };
  return null;
}

/* ---- live activity: synthesized from the snapshot (SSE is escalations-only) */
const TYC: Record<string, string> = { post: "var(--text)", decision: "var(--amber)", request: "var(--info)", answer: "var(--ok)" };
const TYBG: Record<string, string> = { post: "var(--surface-2)", decision: "var(--warn-soft)", request: "var(--info-soft)", answer: "var(--ok-soft)" };
interface ActEvent { who: string; kind: "post" | "decision" | "request" | "answer"; text: string; at: string; link: string }
function activityEvents(tasks: Task[], requests: OrchaRequest[]): ActEvent[] {
  const out: ActEvent[] = [];
  // ISS-68: no full threads in the snapshot — use message_summary.last per task;
  // fall back to an expanded thread if one is present.
  tasks.forEach((t) => {
    const thread = t.thread || [];
    if (thread.length) {
      thread.forEach((m) => out.push({
        who: m.is_human ? "human" : m.from || "—", kind: m.is_human ? "decision" : "post",
        text: trunc(m.body || "", 120), at: m.at || "", link: "/tasks?task=" + encodeURIComponent(t.id),
      }));
      return;
    }
    const last = t.message_summary && t.message_summary.last;
    if (last) {
      const lastAt = (last as { created_at?: string; at?: string }).created_at ?? last.at ?? "";
      out.push({
        who: last.is_human ? "human" : last.author_alias || "—", kind: last.is_human ? "decision" : "post",
        text: trunc(last.body || "", 120), at: lastAt, link: "/tasks?task=" + encodeURIComponent(t.id),
      });
    }
  });
  requests.forEach((r) => {
    out.push({ who: r.from, kind: "request", text: trunc(asText(r.payload), 110), at: r.created_at || "", link: "/requests?req=" + encodeURIComponent(r.id) });
    if (r.responded_at) out.push({ who: r.to, kind: "answer", text: trunc(asText(r.response), 110), at: r.responded_at, link: "/requests?req=" + encodeURIComponent(r.id) });
  });
  return out
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 14);
}

/* ---- tasks-by-status kanban ---------------------------------------------- */
const COLS: { key: string; label: string; cls: string; match: (t: Task) => boolean }[] = [
  { key: "needs", label: "Needs verify", cls: "s-attn", match: (t) => t.status === "needs_verification" },
  { key: "work", label: "In progress", cls: "s-working", match: (t) => t.status === "in_progress" },
  { key: "ready", label: "Ready", cls: "s-ready", match: (t) => t.status === "ready" || t.status === "pending" },
  { key: "blocked", label: "Blocked", cls: "s-bad", match: (t) => t.status === "blocked" || t.status === "failed" },
  { key: "done", label: "Done", cls: "s-done", match: (t) => t.status === "completed" || t.status === "cancelled" },
];
// status glyph markup (verbatim from app.js glyph — not exported by ui.tsx)
function glyphHtml(cls: string): string {
  const v = (b: string) =>
    `<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`;
  switch (cls) {
    case "s-working":
      return '<svg class="gl" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="1.3"/><circle class="core" cx="6" cy="6" r="2.3" fill="currentColor"/></svg>';
    case "s-ok":
    case "s-done":
      return v('<path d="M2.6 6.4 5 8.7 9.4 3.6"/>');
    case "s-ready":
      return '<svg class="gl" viewBox="0 0 12 12" fill="currentColor"><path d="M3.6 2.6 9.6 6l-6 3.4z"/></svg>';
    case "s-attn":
    case "s-warn":
      return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M6 2 11 10.6H1z"/><path d="M6 5v2.2"/><circle cx="6" cy="9" r=".55" fill="currentColor" stroke="none"/></svg>';
    case "s-bad":
      return v('<path d="M3.3 3.3 8.7 8.7M8.7 3.3 3.3 8.7"/>');
    default:
      return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="3.6" stroke-opacity=".55"/><path d="M4.3 6h3.4" stroke-linecap="round"/></svg>';
  }
}

/* ========================================================================== */

export function HomePage() {
  const { snap } = useSnapshot();
  const toast = useToast();

  // P2: tasks acted on THIS session (plan approved/rejected, or verified) —
  // suppress their cards immediately so the 3s repaint can't re-submit before
  // the snapshot reflects the decision. Pruned the moment the id leaves the
  // actionable set, so a reject→rework cycle reappears (review P2:173).
  const [acted, setActed] = useState<Set<string>>(new Set());
  // local UI drafts survive the 3s poll (controlled inputs in React state)
  const [reasonOpen, setReasonOpen] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [approveFor, setApproveFor] = useState<{ taskId: string; authorId: string } | null>(null);
  const [answer, setAnswer] = useState("");

  const c = snap?.container ?? null;
  const agents = snap?.agents ?? [];
  const tasks = snap?.tasks ?? [];
  const requests = snap?.requests ?? [];
  const aq = attnItems(snap);

  // prune the acted-suppression set against the live actionable set
  useEffect(() => {
    const a = attnItems(snap);
    const actionable = new Set([...a.plans, ...a.verifs].map((t) => t.id));
    setActed((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => { if (actionable.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [snap]);

  /* ---- gate actions (HUMAN-GATED; endpoints/bodies verbatim) -------------- */
  const actorOrWarn = (): Agent | null => {
    const h = actingHuman(snap);
    if (!h) { toast("Pick who you are (top-right) first.", "danger"); return null; }
    return h;
  };
  const markActed = (taskId: string) => {
    setActed((p) => new Set(p).add(taskId));
    setReasonOpen((p) => ({ ...p, [taskId]: false }));
    setDrafts((p) => ({ ...p, [taskId]: "" }));
  };
  const failToast = (e: unknown) =>
    toast("Failed (" + ((e as { status?: number }).status ?? "network") + ")", "danger");

  const sendPlanDecision = async (taskId: string, authorId: string, approve: boolean, reason?: string) => {
    const h = actorOrWarn(); if (!h) return;
    try {
      await sendJSON("POST", "/api/decisions", {
        subject_type: "plan_approval", subject_id: taskId, decision: approve ? "approve" : "reject",
        reason: reason || undefined, actor_agent_id: h.id, target_agent_id: authorId || undefined,
      });
      toast(approve ? "Plan approved — routed to the agent." : "Plan rejected — reason sent.", "ok");
      markActed(taskId);
    } catch (e) { failToast(e); }
  };
  const sendVerify = async (taskId: string, approve: boolean, feedback?: string) => {
    const h = actorOrWarn(); if (!h) return;
    try {
      await sendJSON("POST", "/api/tasks/" + encodeURIComponent(taskId) + "/verify", {
        approve, actor_agent_id: h.id, feedback: approve ? undefined : feedback || "",
      });
      toast(approve ? "Accepted — task completed." : "Rejected — sent back with feedback.", "ok");
      markActed(taskId);
    } catch (e) { failToast(e); }
  };

  const openReject = (taskId: string) => {
    if (!actorOrWarn()) return;
    setReasonOpen((p) => ({ ...p, [taskId]: true }));
  };
  const cancelReject = (taskId: string) => {
    setReasonOpen((p) => ({ ...p, [taskId]: false }));
    setDrafts((p) => ({ ...p, [taskId]: "" }));
  };
  const submitReject = (taskId: string, isPlan: boolean, authorId: string) => {
    const v = (drafts[taskId] || "").trim();
    if (!v) { toast("A reason is required to reject.", "danger"); return; }
    if (isPlan) void sendPlanDecision(taskId, authorId, false, v);
    else void sendVerify(taskId, false, v);
  };

  /* ---- action-queue card pieces ------------------------------------------ */
  // the vanilla `.gate .reason` reject flow, inlined per card (the .gate
  // wrapper exists purely so the shared `.gate .reason …` selectors apply;
  // its own chrome is neutralized inline).
  const reasonBox = (taskId: string, isPlan: boolean, authorId: string) =>
    reasonOpen[taskId] ? (
      <div className="gate" style={{ border: 0, borderRadius: 0, overflow: "visible" }}>
        <div className={"reason show"} id={"reason-" + taskId}>
          <textarea
            id={"rt-" + taskId}
            placeholder={isPlan ? "Why are you rejecting? (required)" : "What needs fixing? (required)"}
            value={drafts[taskId] || ""}
            onChange={(e) => setDrafts((p) => ({ ...p, [taskId]: e.target.value }))}
          />
          <div className="hint"><Icon name="flag" cls="" /> A typed reason is required to reject.</div>
          <div style={{ display: "flex", gap: 9, marginTop: 11 }}>
            <button
              className="btn danger" type="button" id={"cr-" + taskId}
              disabled={!(drafts[taskId] || "").trim()}
              onClick={() => submitReject(taskId, isPlan, authorId)}
            >
              Submit rejection
            </button>
            <button className="btn subtle" type="button" onClick={() => cancelReject(taskId)}>Cancel</button>
          </div>
        </div>
      </div>
    ) : null;

  const plans = aq.plans.filter((t) => !acted.has(t.id));
  const verifs = aq.verifs.filter((t) => !acted.has(t.id));
  const badge = plans.length + verifs.length + aq.escs.length;

  const planCard = (t: Task) => {
    const who = planAuthor(t);
    const a = agentByAlias(snap, who);
    const authorId = a?.id || "";
    return (
      <div className="aq plan" key={"p-" + t.id}>
        <span className="type"><Icon name="shield" cls="" />Plan approval</span>
        <div className="ttl">{t.title}</div>
        <div className="who">
          <AgentLink snap={snap} alias={who} /><span>·</span>
          <span className="tag model">{a?.model || "—"}</span>
        </div>
        {/* P1: FULL plan body in the scrollable .ctx — review the whole proposal */}
        <div className="ctx">
          <span className="lbl">Proposed plan — full text</span>
          <Linkified text={planText(t)} />
        </div>
        <div className="acts" data-kind="plan" data-task={t.id} data-author={authorId}>
          <button
            className="btn sm approve" type="button"
            onClick={() => { if (actorOrWarn()) { setAnswer(""); setApproveFor({ taskId: t.id, authorId }); } }}
          >
            <Icon name="shield" cls="" />Approve plan
          </button>
          <button className="btn sm danger" type="button" onClick={() => openReject(t.id)}>Reject…</button>
          <a className="btn sm ghost" href={"/tasks?task=" + encodeURIComponent(t.id)}>Open task</a>
        </div>
        {reasonBox(t.id, true, authorId)}
      </div>
    );
  };

  const verifyCard = (t: Task) => {
    const who = (t.assignees || [])[0];
    const a = agentByAlias(snap, who);
    // Collab v1 (home-state.js): a task with an owner-assigned reviewer is
    // SOMEONE's review. The assigned reviewer (or any owner — permissive when
    // member_role is absent, i.e. open backends) sees the card normally;
    // everyone else gets it de-emphasized + labeled. Frontend-only: the
    // backend verify gate stays permissive (any human CAN verify).
    const revLabel = reviewFor(t, actingHuman(snap));
    return (
      <div className={"aq verify" + (revLabel ? " other-review" : "")} key={"v-" + t.id}>
        <span className="type">
          <Icon name="check" cls="" />Verify task
          {revLabel ? <span className="tag review-for">review: {revLabel}</span> : null}
        </span>
        <div className="ttl">{t.title}</div>
        <div className="who">
          {who ? <AgentLink snap={snap} alias={who} /> : "—"}<span>·</span>
          <span className="tag model">{a?.model || "—"}</span><span>·</span>
          <span>{relTime(t.started_at)}</span>
        </div>
        <div className="ctx">
          <span className="lbl">Definition of done</span>
          {t.definition_of_done || "—"}
        </div>
        <div className="acts" data-kind="verify" data-task={t.id}>
          <button className="btn sm approve" type="button" onClick={() => void sendVerify(t.id, true)}>
            <Icon name="check" cls="" />Accept
          </button>
          <button className="btn sm danger" type="button" onClick={() => openReject(t.id)}>Reject…</button>
          <a className="btn sm ghost" href={"/tasks?task=" + encodeURIComponent(t.id)}>Open task</a>
        </div>
        {reasonBox(t.id, false, "")}
      </div>
    );
  };

  const escCard = (r: OrchaRequest) => {
    const href = "/requests?req=" + encodeURIComponent(r.id);
    return (
      <div className="aq esc" key={"e-" + r.id}>
        <span className="type"><Icon name="flag" cls="" />Escalation</span>
        <div className="ttl">{trunc(asText(r.payload), 96)}</div>
        <div className="who">
          <AgentLink snap={snap} alias={r.from} />
          <span><Icon name="arrow" cls="" /></span><span>you</span><span>·</span>
          <span>{relTime(r.created_at)}</span>
        </div>
        <div className="ctx">
          <span className="lbl">Blocks</span>
          {r.task_link ? r.task_link.title || "—" : "—"}
        </div>
        <div className="acts">
          <a className="btn sm" href={href}><Icon name="arrow" cls="" />Resolve</a>
          <a className="btn sm ghost" href={href}>Open request</a>
        </div>
      </div>
    );
  };

  /* ---- page ---------------------------------------------------------------*/
  const paused = !!(c && (c as { wakes_enabled?: boolean }).wakes_enabled === false);
  const openReq = requests.filter((r) => r.status === "open").length;
  const noAi = agents.filter((a) => a.kind !== "human").length === 0;
  const evs = activityEvents(tasks, requests);

  return (
    <Shell page="home" title="Dashboard" ctx={c?.name}>
      <style>{PAGE_CSS}</style>
      {c && (
        <>
          {/* ---- context strip ---- */}
          <div className="ctxbar" id="ctxbar">
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <Pill status={c.status === "active" ? "working" : c.status} size="lg" />
            </div>
            <div className="sep" />
            <div style={{ minWidth: 0 }}>
              <div className="nm">{c.name}</div>
              <div className="desc">{c.description || "—"}</div>
            </div>
            <div className="grow" />
            <div className="stat"><span className="n">{agents.length}</span><span className="l">Agents</span></div>
            <div className="sep" />
            <div className="stat"><span className="n">{tasks.length}</span><span className="l">Tasks</span></div>
            <div className="sep" />
            <div className="stat"><span className="n">{openReq}</span><span className="l">Open req</span></div>
            <div className="sep" />
            <div className="stat">
              <span className="n" style={{ color: paused ? "var(--danger)" : "var(--ok)" }}>{paused ? "Paused" : "Running"}</span>
              <span className="l">Notifier</span>
            </div>
          </div>

          {/* ---- first-run CTA (no AI agents yet) ---- */}
          <div id="onbCta">
            {noAi && (
              <div className="onb-cta">
                <span className="oic"><Icon name="spark" cls="" /></span>
                <div className="body">
                  <div className="t1">Get started — set up your workspace</div>
                  <div className="t2">No AI agents yet. Create your first agent (or capture tasks) in the guided first-run flow.</div>
                </div>
                <a className="btn" href="/onboarding"><Icon name="arrow" cls="" />Get started</a>
              </div>
            )}
          </div>

          {/* ---- action queue (THE hero) ---- */}
          <section id="needs">
            <div className="hero-h">
              <span className="t">Needs your attention</span>
              <span className="badge tnum" id="aqBadge">{badge}</span>
              <span className="sub">Plans to approve and tasks to verify — one click from acting. Nothing ships on an agent&#39;s say-so.</span>
            </div>
            <div className="aq-grid" id="aqGrid">
              {badge ? (
                <>
                  {plans.map(planCard)}
                  {verifs.map(verifyCard)}
                  {aq.escs.map(escCard)}
                </>
              ) : (
                <div className="aq-empty">✓ Nothing needs you right now.</div>
              )}
            </div>
          </section>

          <div className="dash-grid">
            {/* ---- agents at a glance ---- */}
            <div className="card">
              <div className="card-h">
                <h2>Agents at a glance</h2><span className="count" id="agCount">({agents.length})</span>
                <span className="grow"></span>
                <a className="seeall" href="/onboarding?new=1">+ New agent</a>
                <a className="seeall" href="/agents" style={{ marginLeft: 12 }}>All agents ↗</a>
              </div>
              <div className="card-b flush" style={{ overflowX: "auto" }}>
                <table className="tbl" id="agTbl">
                  <thead>
                    <tr><th>Agent</th><th>Status</th><th>Activity</th><th>Model</th><th>Wake</th><th>Active</th></tr>
                  </thead>
                  <tbody>
                    {agents.map((a) => {
                      const act = activityOf(a);
                      return (
                        <tr
                          className="clickable" key={a.id}
                          onClick={() => { navigateScoped("/agents?agent=" + encodeURIComponent(a.alias)); }}
                        >
                          <td>
                            <div className="row">
                              <Avatar alias={a.alias} kind={a.kind} ghLogin={a.github_login} />
                              <div><div className="t1">{a.alias}</div><div className="t2">{a.role || "—"}</div></div>
                            </div>
                          </td>
                          <td><Pill status={a.status} /></td>
                          <td>
                            {act ? (
                              act.isTask
                                ? <span className="t1" style={{ fontWeight: 550, fontSize: 12.5 }}>{act.text}</span>
                                : <span className="t2" style={{ fontStyle: "italic" }}>{act.text}</span>
                            ) : <span className="t2">—</span>}
                          </td>
                          <td>{a.model ? <span className="tag model">{a.model}</span> : <span className="t2">—</span>}</td>
                          <td>
                            {a.kind === "human"
                              ? <span className="t2">—</span>
                              : a.wake_enabled
                                ? <span className="tag wake-on">on</span>
                                : <span className="tag wake-off">off</span>}
                          </td>
                          <td className="t2 num">{relTime(a.last_active)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ---- live activity ---- */}
            <div className="card stick">
              <div className="card-h">
                <h2>Live activity</h2>
                <span className="grow"></span>
                <span className="live accent"><span className="d"></span>live</span>
              </div>
              <div className="card-b">
                <div className="act-list" id="actList">
                  {evs.length ? evs.map((e, i) => {
                    const a = agentByAlias(snap, e.who);
                    return (
                      <a className="act" href={e.link} key={i} style={{ color: "inherit" }}>
                        <Avatar alias={e.who} kind={a ? a.kind : "human"} size="sm" />
                        <div className="body">
                          <div className="top">
                            <span className="nm">{e.who}</span>
                            <span className="ty" style={{ color: TYC[e.kind], background: TYBG[e.kind] }}>{e.kind}</span>
                            <span className="when">{relTime(e.at)}</span>
                          </div>
                          <div className="txt">{e.text}</div>
                        </div>
                      </a>
                    );
                  }) : <div className="none" style={{ padding: 14, fontSize: 12.5 }}>No activity yet.</div>}
                </div>
              </div>
            </div>
          </div>

          {/* ---- tasks by status kanban ---- */}
          <div className="section-title">
            <h2>Tasks by status</h2><span className="ln"></span>
            <a className="seeall" href="/tasks">Open tasks ↗</a>
          </div>
          <div className="kanban" id="kanban">
            {COLS.map((col) => {
              const items = tasks.filter(col.match).filter((t) => !t.is_root);
              return (
                <div className="kcol" key={col.key}>
                  <div className="kh">
                    <span
                      className={`pill ${col.cls}`}
                      style={{ border: 0, background: "transparent", padding: 0, gap: 7 }}
                      dangerouslySetInnerHTML={{
                        __html: glyphHtml(col.cls) + `<span style="font-size:12.5px;font-weight:650;color:var(--text)">${esc(col.label)}</span>`,
                      }}
                    />
                    <span className="ct">{items.length}</span>
                  </div>
                  <div className="kb">
                    {items.length ? items.map((t) => {
                      const who = (t.assignees || [])[0];
                      const a = agentByAlias(snap, who);
                      const p = Number(t.priority);
                      return (
                        <div
                          className="kcard" key={t.id}
                          onClick={() => { navigateScoped("/tasks?task=" + encodeURIComponent(t.id)); }}
                        >
                          <div className="kt">{t.title}</div>
                          <div className="kf">
                            {who ? <Avatar alias={who} kind={a ? a.kind : "ai"} size="sm" /> : null}
                            <span className="t2" style={{ fontSize: 11.5 }}>{who || "unassigned"}</span>
                            <span className={`prio ${p <= 20 ? "p-hi" : p <= 40 ? "p-md" : ""}`}>P{t.priority}</span>
                          </div>
                        </div>
                      );
                    }) : <div className="none" style={{ padding: 14, fontSize: 12 }}>None</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ISS-59: approving may carry an OPTIONAL answer/guidance for the agent */}
      {approveFor && (
        <Modal
          title="Approve plan"
          desc="Optionally answer the agent's questions or add guidance — it's sent to the agent with the approval."
          primary="Approve plan"
          approve
          onPrimary={() => {
            const p = approveFor;
            setApproveFor(null);
            void sendPlanDecision(p.taskId, p.authorId, true, answer);
          }}
          onClose={() => setApproveFor(null)}
        >
          <textarea
            id="ans" className="ta" placeholder="Answer / additional info for the agent (optional)"
            value={answer} onChange={(e) => setAnswer(e.target.value)}
            style={{ width: "100%", minHeight: 76, resize: "vertical" }}
          />
        </Modal>
      )}
    </Shell>
  );
}

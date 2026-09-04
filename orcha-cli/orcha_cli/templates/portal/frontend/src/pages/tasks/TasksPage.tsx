/**
 * Tasks page — React + TS port of static/tasks.html (list + detail + gates +
 * protocol + thread + assignment + close) and the run feed pieces of
 * static/app.js. The backend is UNCHANGED: every fetch below copies the
 * vanilla endpoint/method/body exactly.
 *
 * Parity notes:
 *  - ISS-68 PR-3: the list caps to the top-N priority-ordered tasks with
 *    "Load more"; the thread is lazy-fetched via threadOf on detail expand and
 *    rendered most-recent-first-capped with "Load earlier".
 *  - ISS-46/ISS-53: drafts (reply, reject reason, protocol edit, close reason)
 *    live in React state, so the 3s snapshot poll can never clobber typing.
 *  - Deep link: `/tasks?task=<id>` selects (useLocation().search).
 *  - The live/embedded terminal: pairing lives on the Agents page (the vanilla
 *    tasks page never docked a terminal); the thread-header affordance
 *    deep-links to `/agents?agent=<assignee>` where the real S3 §3b pairing
 *    (components/terminal/TerminalPane) is offered.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Shell } from "../../shell/Shell";
import { threadOf } from "../../api/client";
import { clockTime, relTime, shortId, trunc } from "../../lib/format";
import { resultText } from "../../lib/resultText";
import { isActingOwner, reviewerLabel, reviewerRef, reviewerSupported } from "../../lib/reviewer";
import { leaseOf, statusClass } from "../../lib/status";
import { Avatar, Icon, KindBadge, Linkified, Modal, useToast } from "../../components/ui";
import {
  actingHuman,
  agentByAlias,
  pendingPlan,
  planMessageOf,
  useSnapshot,
} from "../../state/SnapshotProvider";
import { FilesChanged } from "../../components/FilesChanged";
import { useRunStream } from "../../hooks/useRunStream";
import { nearBottom, pinToBottom } from "../../lib/logScroll";
import type { Agent, Attachment, Run, Snapshot, Task, ThreadMsg } from "../../types";
import { tasksPageCss } from "./pageCss";
import { SortCtl, sortComparator } from "../../lib/sort";

/* ---- raw POST/PATCH helpers (vanilla postJSON/patchJSON parity: the pages
   need ok + status + parsed body to drive 409-reassign and error toasts) ---- */
/* eslint-disable @typescript-eslint/no-explicit-any */
async function post(url: string, body?: unknown): Promise<{ ok: boolean; status: number; d: any }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let d: any = {};
  try {
    d = await r.json();
  } catch {
    /* empty/non-JSON body */
  }
  return { ok: r.ok, status: r.status, d };
}
async function patchReq(url: string, body?: unknown): Promise<{ ok: boolean; status: number; d: any }> {
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let d: any = {};
  try {
    d = await r.json();
  } catch {
    /* empty/non-JSON body */
  }
  return { ok: r.ok, status: r.status, d };
}
function detailText(d: any): string {
  if (!d || d.detail == null) return "";
  return typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ---- ordering / grouping (ISS-37 / ISS-331) ------------------------------- */
const ORDER: Record<string, number> = {
  needs_verification: 0,
  in_progress: 1,
  ready: 2,
  blocked: 3,
  pending: 4,
  completed: 5,
  cancelled: 6,
  failed: 3,
};
const GRP: { k: string; label: string }[] = [
  { k: "needs_verification", label: "Needs verification" },
  { k: "in_progress", label: "In progress" },
  { k: "ready", label: "Ready" },
  { k: "pending", label: "Pending (blocked on deps)" },
  { k: "blocked", label: "Blocked" },
  { k: "failed", label: "Failed" },
  { k: "completed", label: "Done" },
  { k: "cancelled", label: "Cancelled" },
];
const TASKS_PAGE = 10; // ISS-68 PR-3 list page size
const THREAD_SHOWN = 10; // ISS-68 PR-3 thread initial reveal
const THREAD_PAGE = 20; // "Load earlier" reveal step

const timeKey = (t: Task) => Date.parse(t.created_at || "") || 0;
const prioNum = (t: Task) => Number(t.priority ?? 100);
const prioCls = (t: Task) => (prioNum(t) <= 20 ? "p-hi" : prioNum(t) <= 40 ? "p-md" : "");

/* ---- ISS-331 sort (shared lib/sort — same orcha:sort:tasks key) ----------- */
const SORT_NAME = "tasks";
const taskBucket = (t: Task) => ORDER[t.status] ?? 9;

/* ---- status glyph (app.js glyph — not exported by ui.tsx, same markup) ---- */
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
    case "s-acc":
      return v('<path d="M2.6 6h6.8M6.4 3 9.4 6 6.4 9"/>');
    default:
      return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="3.6" stroke-opacity=".55"/><path d="M4.3 6h3.4" stroke-linecap="round"/></svg>';
  }
}
function Glyph({ status }: { status: string }) {
  return <span style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: glyphHtml(statusClass(status)) }} />;
}

function AgentLink({ snap, alias }: { snap: Snapshot | null; alias: string | null }) {
  if (!alias) return <>—</>;
  const a = agentByAlias(snap, alias);
  if (!a) return <>{alias}</>;
  return (
    <a className="dlink" href={"/agents?agent=" + encodeURIComponent(alias)}>
      <Avatar alias={alias} kind={a.kind} />
      <span>{alias}</span>
    </a>
  );
}

/* ---- status pill (app.js pill parity via Glyph + label) ------------------- */
const STAT_LABEL: Record<string, string> = {
  working: "Working", in_progress: "In progress", idle: "Idle", pending: "Pending",
  ready: "Ready", blocked: "Blocked", awaiting_request: "Waiting", awaiting_human: "Needs human",
  needs_verification: "Needs verify", completed: "Completed", cancelled: "Cancelled",
  failed: "Failed", terminated: "Terminated",
};
function StatusPill({ status, size }: { status: string; size?: string }) {
  const l = STAT_LABEL[status] || status || "unknown";
  return (
    <span className={`pill ${statusClass(status)}${size ? " " + size : ""}`}>
      <Glyph status={status} />
      {l}
    </span>
  );
}

/* ---- attachments (#301/#330) ---------------------------------------------- */
const ACCEPT_EXT = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "csv", "log", "json"];
const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
const extOf = (n: string) => (String(n || "").split(".").pop() || "").toLowerCase();
function fmtSize(nIn: number | undefined): string {
  const n = +(nIn || 0);
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
const FileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);
const ClipIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

interface StagedAtt {
  key: number;
  name: string;
  size: number;
  kind: string;
  status: "uploading" | "done" | "failed";
  ref?: Attachment;
}

// in-thread rendered attachment (read view): image thumb (click = lightbox) or
// a download chip.
function AttRow({ a, onLightbox }: { a: Attachment; onLightbox: (url: string) => void }) {
  const url = a.url || "";
  const nm = a.name || a.id || "file";
  if (a.kind === "image") {
    return <img className="att-img" src={url} alt={nm} title={nm} loading="lazy" onClick={() => onLightbox(url)} />;
  }
  return (
    <a className="att-file" href={url} target="_blank" rel="noopener" download>
      <FileIcon />
      <span>{nm}</span>
      <span className="sz">{fmtSize(a.size)}</span>
    </a>
  );
}

/* ---- thread message row (tasks.html msgRow) ------------------------------- */
function MsgRow({ snap, m, onLightbox }: { snap: Snapshot | null; m: ThreadMsg; onLightbox: (url: string) => void }) {
  const sys = !m.from || m.from === "system";
  const a = agentByAlias(snap, m.from);
  return (
    <div className={"msg " + (m.is_human ? "human" : sys ? "system" : "")}>
      {sys ? (
        <span className="av sm" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>
          ›
        </span>
      ) : (
        <Avatar alias={m.from} kind={a ? a.kind : "ai"} size="sm" />
      )}
      <div className="body">
        <div className="mh">
          <span className="nm">{sys ? "system" : m.from}</span>
          {a && !sys ? <KindBadge kind={a.kind} /> : null}
          <span className="when">{m.at ? relTime(m.at) : ""}</span>
        </div>
        <div className="bubble">
          <Linkified text={m.body} tasks={snap?.tasks} />
        </div>
        {(m.attachments || []).length ? (
          <div className="msg-atts">
            {m.attachments.map((a2, i) => (
              <AttRow key={a2.id || i} a={a2} onLightbox={onLightbox} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ============================================================================
   Collab v1 — the task's assigned reviewer (tasks-detail.js reviewerChip +
   tasks-actions.js doReviewer). Advisory (the verify gate stays open to any
   human): the chip shows WHO the owner asked to verify — GitHub avatar + login
   for a mapped member, letter avatar + alias otherwise, "anyone" when unset.
   Owners get a change affordance: the picker lists the container's human
   MEMBERS (snapshot roster) + an "Anyone" reset, then
   PUT /api/tasks/{tid}/reviewer {reviewer_agent_id|null, actor_agent_id};
   the backend re-validates (owner gate, human-member target).
   Open backends (reviewerSupported false): the caller renders nothing and
   this endpoint is never called.
   ========================================================================== */
function ReviewerChip({ t }: { t: Task }) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selRev, setSelRev] = useState("");
  // 200 echoes {reviewer: {...}|null} — stamp it locally so the chip
  // re-renders immediately (doReviewer's in-place update, no 3s-poll wait);
  // the next snapshot poll confirms it.
  const [override, setOverride] = useState<{ reviewer: Task["reviewer"]; reviewer_agent_id: string | null } | null>(null);
  const curId = override ? override.reviewer_agent_id : t.reviewer_agent_id;
  const r = reviewerRef({ reviewer: override ? override.reviewer : t.reviewer });
  const canEdit = isActingOwner(actingHuman(snap));
  const hs = (snap?.agents ?? []).filter((x) => x.kind === "human");

  const openPicker = () => {
    if (!actingHuman(snap)) {
      toast("Pick an acting human (top-right) first.", "danger");
      return;
    }
    setSelRev(curId != null ? String(curId) : "");
    setPickerOpen(true);
  };

  const setReviewer = async () => {
    const h = actingHuman(snap);
    if (!h) return;
    const rid = selRev || null;
    try {
      const resp = await fetch("/api/tasks/" + encodeURIComponent(t.id) + "/reviewer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewer_agent_id: rid, actor_agent_id: h.id }),
      });
      let d: { detail?: string; reviewer?: { agent_id?: string; alias?: string; github_login?: string | null } | null } = {};
      try {
        d = await resp.json();
      } catch {
        /* empty/non-JSON body */
      }
      setPickerOpen(false);
      if (!resp.ok) {
        toast("Setting reviewer failed (" + resp.status + ")" + (d.detail ? ": " + d.detail : ""), "danger");
        return;
      }
      setOverride({ reviewer: d.reviewer || null, reviewer_agent_id: d.reviewer ? d.reviewer.agent_id || null : null });
      toast(d.reviewer ? "Reviewer set — " + (d.reviewer.github_login || d.reviewer.alias) : "Reviewer cleared — anyone may verify", "ok");
      void refresh();
    } catch {
      setPickerOpen(false);
      toast("Setting reviewer failed — network error.", "danger");
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {!r ? (
        <span className="muted" style={{ fontSize: 12.5 }}>
          anyone
        </span>
      ) : (
        <>
          <Avatar alias={r.alias || r.github_login} kind="human" size="sm" ghLogin={r.github_login} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{reviewerLabel(r)}</span>
        </>
      )}
      {canEdit ? (
        <button className="iconbtn" data-act="reviewer" type="button" title="Change reviewer" style={{ width: 22, height: 22 }} onClick={openPicker}>
          <Icon name="pencil" cls="gl" />
        </button>
      ) : null}
      {pickerOpen && (
        <Modal
          title="Who should review this task?"
          desc="The reviewer is asked to verify when the task completes. Anyone may still verify — this routes attention, it doesn't lock the gate."
          primary="Set reviewer"
          approve
          onPrimary={() => void setReviewer()}
          onClose={() => setPickerOpen(false)}
        >
          <select id="revSel" className="reply-in" style={{ width: "100%" }} value={selRev} onChange={(e) => setSelRev(e.target.value)}>
            <option value="">— Anyone —</option>
            {hs.map((x) => (
              <option key={x.id} value={x.id}>
                {(x.github_login || x.alias) + (String(x.id) === String(curId) ? " (current)" : "")}
              </option>
            ))}
          </select>
        </Modal>
      )}
    </span>
  );
}

/* ============================================================================
   Gate surface — plan-approval (B10) OR verify (Epic B), gated on
   plan_decision (ISS-41). Reject REQUIRES a typed reason (same .gate .reason
   markup); plan-approve may carry an OPTIONAL answer (ISS-59).
   ========================================================================== */
function GateSurface({ t, acted, onActed }: { t: Task; acted: boolean; onActed: (id: string) => void }) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [answer, setAnswer] = useState("");

  // decided plan -> quiet decided-note, never a live re-approve
  if (t.status === "in_progress" && t.plan_decision) {
    const pd = t.plan_decision;
    const ok = pd.decision === "approve";
    return (
      <div className="card pad" style={{ marginBottom: 18, borderColor: "var(--border)" }}>
        <div className="row" style={{ gap: 11 }}>
          <span style={{ color: `var(--${ok ? "ok" : "danger"})` }}>
            <Icon name={ok ? "check" : "x"} cls="" />
          </span>
          <div className="grow">
            <div style={{ fontWeight: 680, fontSize: 14 }}>Plan {ok ? "approved" : "rejected"}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              {pd.actor ? "by " + pd.actor : ""}
              {pd.at ? " · " + relTime(pd.at) : ""}
              {pd.reason ? " — " + trunc(pd.reason, 140) : ""}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (acted) return null; // optimistic: just acted this session, snapshot catching up
  const isPlan = pendingPlan(t);
  const isVerify = t.status === "needs_verification";
  if (!isPlan && !isVerify) return null;
  const pm = isPlan ? planMessageOf(t) : null;
  const h = actingHuman(snap);
  const disabled = !h;
  const author = isPlan && pm?.from ? agentByAlias(snap, pm.from) : null;
  const whoName = t.assignee || "the assignee";

  const submit = async (approve: boolean, reasonTxt: string) => {
    const actor = actingHuman(snap);
    if (!actor) {
      toast("Pick an acting human (top-right) first.", "danger");
      return;
    }
    const r = isPlan
      ? await post("/api/decisions", {
          subject_type: "plan_approval",
          subject_id: t.id,
          decision: approve ? "approve" : "reject",
          reason: reasonTxt || undefined,
          actor_agent_id: actor.id,
          target_agent_id: author?.id || undefined,
        })
      : await post("/api/tasks/" + encodeURIComponent(t.id) + "/verify", {
          approve,
          actor_agent_id: actor.id,
          feedback: approve ? undefined : reasonTxt,
        });
    toast(
      r.ok
        ? isPlan
          ? approve
            ? "Plan approved"
            : "Changes requested"
          : approve
            ? "Accepted · completed"
            : "Rejected — returned"
        : "Failed (" + r.status + ")",
      r.ok ? "ok" : "danger",
    );
    if (r.ok) {
      setReason("");
      setReasonOpen(false);
      setAnswer("");
      onActed(t.id);
      void refresh();
    }
  };

  return (
    <div className="gate" id={"gate-" + t.id} data-task={t.id} data-kind={isPlan ? "plan" : "verify"} style={{ marginBottom: 18 }}>
      <div className="gh">
        <span className="badge">
          <Icon name={isPlan ? "shield" : "check"} cls="" />
          {isPlan ? "Plan awaiting your approval" : "Awaiting verification"}
        </span>
        <span className="grow" />
        <span className="acting-note">
          {h ? <Avatar alias={h.alias} kind="human" size="sm" /> : null}
          {h ? "acting as " + h.alias + " · " : ""}logged to the audit trail
        </span>
      </div>
      <div className="gb">
        <div className="field">
          <div className="lbl">
            <Icon name="dot" cls="" />
            {isPlan ? "Proposed plan — full text" : "Result claimed by " + whoName}
          </div>
          <div className="tx" style={{ whiteSpace: "pre-wrap", maxHeight: 300, overflowY: "auto" }}>
            {/* open-orcha#209: task.result is JSONB — normalize before render */}
            <Linkified text={isPlan ? pm?.body || "" : resultText(t.result) || "—"} tasks={snap?.tasks} />
          </div>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <div className="lbl">
            <Icon name="check" cls="" />
            Definition of done
          </div>
          <div className="dod">{t.definition_of_done || "—"}</div>
        </div>
        <div className="actions">
          <button className="btn approve" data-act="approve" disabled={disabled} onClick={() => setConfirmOpen(true)}>
            <Icon name="check" cls="" />
            {isPlan ? "Approve plan" : "Accept"}
          </button>
          <button className="btn ghost" data-act="reject" disabled={disabled} onClick={() => setReasonOpen(true)}>
            {isPlan ? "Request changes…" : "Reject…"}
          </button>
          <span className="acting-note">
            {isPlan ? "Approving lets " + whoName + " execute." : "Rejecting returns the task to " + whoName + "."}
          </span>
        </div>
        <div className={"reason" + (reasonOpen ? " show" : "")} id={"reason-" + t.id}>
          <textarea
            id={"rt-" + t.id}
            placeholder={`Why are you ${isPlan ? "requesting changes" : "rejecting"}? Required — ${whoName} sees this verbatim on the next wake.`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="hint">
            <Icon name="flag" cls="" /> A typed reason is required to {isPlan ? "reject the plan" : "reject"}.
          </div>
          <div style={{ display: "flex", gap: 9, marginTop: 11 }}>
            <button
              className="btn danger"
              data-act="confirm-reject"
              id={"cr-" + t.id}
              disabled={!reason.trim()}
              onClick={() => {
                const r = reason.trim();
                if (!r) return; // a typed reason is REQUIRED
                void submit(false, r);
              }}
            >
              Submit rejection
            </button>
            <button
              className="btn subtle"
              data-act="cancel-reject"
              onClick={() => {
                setReasonOpen(false);
                setReason("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
      {confirmOpen && (
        <Modal
          title={isPlan ? "Approve this plan?" : "Accept this task?"}
          desc={
            isPlan
              ? whoName + " will be cleared to execute. Optionally answer/guide below — it's sent with the approval."
              : "Marks the task completed and unblocks anything waiting on it. Logged with your identity."
          }
          primary={isPlan ? "Approve plan" : "Accept"}
          approve
          onPrimary={() => {
            setConfirmOpen(false);
            void submit(true, isPlan ? answer : "");
          }}
          onClose={() => setConfirmOpen(false)}
        >
          {isPlan ? (
            <textarea
              id={"ans-" + t.id}
              className="ans-in"
              style={{ minHeight: 64 }}
              placeholder="Answer / additional info for the agent (optional)"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          ) : undefined}
        </Modal>
      )}
    </div>
  );
}

/* ============================================================================
   SPEC-4 protocol panel — collapsible hand-off rules on the task itself.
   [Edit] is human-authority only -> PATCH /api/tasks/{tid}/protocol (partial
   merge; echoes the full merged protocol).
   ========================================================================== */
interface Proto {
  review_chain?: string;
  handoff_to?: string;
  autonomy?: string;
  notes?: string;
}
function protoEmpty(p: Proto | null): boolean {
  return !p || (!p.review_chain && !p.handoff_to && !p.autonomy && !p.notes);
}
function ProtocolPanel({ t }: { t: Task }) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Required<Proto> | null>(null);
  const [saving, setSaving] = useState(false);
  // 200 echoes {task_id, protocol:{full merged}} — stamp it locally so the
  // panel re-renders immediately; the next snapshot poll confirms it.
  const [override, setOverride] = useState<Proto | null>(null);
  const p: Proto = override ?? ((t.protocol as Proto | null) || {});
  const canEdit = !!actingHuman(snap);

  const startEdit = () => {
    if (!actingHuman(snap)) {
      toast("Pick an acting human (top-right) first.", "danger");
      return;
    }
    setDraft({
      review_chain: p.review_chain || "",
      handoff_to: p.handoff_to || "",
      autonomy: p.autonomy || "",
      notes: p.notes || "",
    });
    setEditing(true);
    setCollapsed(false);
  };

  const save = async () => {
    const h = actingHuman(snap);
    if (!h || !draft) return;
    setSaving(true);
    // PARTIAL merge (Ledger contract): send all four; "" clears a key.
    const r = await patchReq("/api/tasks/" + encodeURIComponent(t.id) + "/protocol", {
      actor_agent_id: h.id,
      review_chain: draft.review_chain,
      handoff_to: draft.handoff_to,
      autonomy: draft.autonomy,
      notes: draft.notes,
    });
    setSaving(false);
    if (r.ok) {
      setEditing(false);
      setDraft(null);
      if (r.d && r.d.protocol) setOverride(r.d.protocol as Proto);
      toast("Protocol saved", "ok");
      void refresh();
      return;
    }
    toast("Save failed (" + r.status + ")" + (detailText(r.d) ? ": " + detailText(r.d) : ""), "danger");
  };

  if (protoEmpty(override ?? (t.protocol as Proto | null)) && !editing) {
    return (
      <div className="proto" id={"proto-" + t.id} data-task={t.id}>
        <div className="ph">
          <span className="ttl">
            <Icon name="shield" cls="" />
            Protocol
          </span>
          <span className="grow" />
          {canEdit ? (
            <button className="btn ghost sm" data-pact="set" onClick={startEdit}>
              Set protocol
            </button>
          ) : null}
        </div>
        <div className="empty-proto">No protocol set — using container defaults.</div>
      </div>
    );
  }

  const d = editing ? draft || { review_chain: "", handoff_to: "", autonomy: "", notes: "" } : null;
  const cls = "proto" + (collapsed && !editing ? " collapsed" : "") + (editing ? " editing" : "");
  const setField = (k: keyof Proto, v: string) => setDraft((prev) => ({ ...(prev || { review_chain: "", handoff_to: "", autonomy: "", notes: "" }), [k]: v }));
  const row = (label: string, key: keyof Proto, isNotes: boolean) => {
    const display: ReactNode =
      key === "review_chain" ? (
        <span className="arrowchain">{p.review_chain || "—"}</span>
      ) : key === "handoff_to" ? (
        <>
          {p.handoff_to || "—"}
          {p.handoff_to ? (
            <>
              {" "}
              <span className="muted" style={{ fontWeight: 450 }}>
                — return here first
              </span>
            </>
          ) : null}
        </>
      ) : key === "notes" ? (
        <Linkified text={p.notes || "—"} tasks={snap?.tasks} />
      ) : (
        <>{p[key] || "—"}</>
      );
    return (
      <div className="prow">
        <span className="k">{label}</span>
        <span className={"v" + (isNotes ? " notes" : "")}>{display}</span>
        <div className="edit">
          {isNotes ? (
            <textarea data-pfield={key} value={d ? d[key] || "" : ""} onChange={(e) => setField(key, e.target.value)} />
          ) : (
            <input data-pfield={key} value={d ? d[key] || "" : ""} onChange={(e) => setField(key, e.target.value)} />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={cls} id={"proto-" + t.id} data-task={t.id}>
      <div
        className="ph"
        onClick={(e) => {
          if ((e.target as Element).closest("button")) return; // buttons handle their own action
          if (editing) return; // header is inert while editing
          setCollapsed((c) => !c);
        }}
      >
        <span className="ttl">
          <Icon name="shield" cls="" />
          Protocol
        </span>
        {!editing && (p.handoff_to || p.autonomy) ? (
          <div className="chips">
            {p.handoff_to ? (
              <span className="pchip">
                <span className="lbl">hand-off</span>
                {p.handoff_to}
              </span>
            ) : null}
            {p.autonomy ? <span className="pchip aut">{trunc(String(p.autonomy).split(" · ")[0], 28)}</span> : null}
          </div>
        ) : null}
        <span className="grow" />
        {canEdit ? (
          <button
            className="btn ghost sm editbtn"
            data-pact="edit"
            onClick={(e) => {
              e.stopPropagation();
              startEdit();
            }}
          >
            Edit
          </button>
        ) : null}
        <span className="chev" data-pact="toggle">
          <Icon name="chev" cls="" />
        </span>
      </div>
      <div className="pb">
        {row("Review chain", "review_chain", false)}
        {row("Hand-off to", "handoff_to", false)}
        {row("Autonomy", "autonomy", false)}
        {row("Notes", "notes", true)}
      </div>
      <div className="pf">
        <button
          className="btn ghost sm"
          data-pact="cancel"
          onClick={() => {
            setEditing(false);
            setDraft(null);
          }}
        >
          Cancel
        </button>
        <button className="btn sm approve" data-pact="save" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save protocol"}
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   Thread card + composer — ISS-68 lazy thread, PR-3 "Load earlier" cap, #301/
   #330 attachment staging (upload-then-reference), lease-of lock, and the
   pair-in-terminal deep link into the Agents page pairing surface.
   ========================================================================== */
function ThreadCard({
  t,
  msgs,
  loading,
  errored,
  onRetry,
}: {
  t: Task;
  msgs: ThreadMsg[];
  loading: boolean;
  errored: boolean;
  onRetry: () => void;
}) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const [shown, setShown] = useState(THREAD_SHOWN);
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<StagedAtt[]>([]);
  const [dragover, setDragover] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const seqRef = useRef(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const summaryCount = t.message_summary?.count || 0;
  const showLoading = loading && !msgs.length;
  const count = msgs.length || summaryCount;
  const h = actingHuman(snap);

  // S3 §3b vice-versa lock: while the assignee holds a `live` lease (a human
  // owns the embodiment in a terminal), the composer is read-only.
  const assignee: Agent | null = agentByAlias(snap, t.assignee);
  const locked = !!assignee && leaseOf(assignee) === "live";

  const uploadFiles = (files: FileList | File[] | null | undefined) => {
    Array.from(files || []).forEach((f) => {
      if (!ACCEPT_EXT.includes(extOf(f.name))) {
        toast("Unsupported file type: " + f.name, "danger");
        return;
      }
      const key = ++seqRef.current;
      const entry: StagedAtt = {
        key,
        name: f.name,
        size: f.size,
        kind: IMG_EXT.includes(extOf(f.name)) ? "image" : "file",
        status: "uploading",
      };
      setStaged((prev) => prev.concat(entry));
      const fd = new FormData();
      fd.append("file", f, f.name);
      fetch("/api/tasks/" + encodeURIComponent(t.id) + "/attachments", { method: "POST", body: fd })
        .then((r) =>
          r.ok
            ? (r.json() as Promise<Attachment>)
            : r.json().then((d: { detail?: string }) => Promise.reject(d.detail || "HTTP " + r.status)),
        )
        .then((ref) => {
          setStaged((prev) =>
            prev.map((s) => (s.key === key ? { ...s, status: "done", ref, size: ref.size ?? s.size, kind: ref.kind ?? s.kind } : s)),
          );
        })
        .catch((err) => {
          setStaged((prev) => prev.map((s) => (s.key === key ? { ...s, status: "failed" } : s)));
          toast("Upload failed: " + (err || f.name), "danger");
        });
    });
  };

  const postMsg = async () => {
    const v = text.trim();
    const done = staged.filter((s) => s.status === "done");
    const pending = staged.some((s) => s.status === "uploading");
    if (pending) {
      toast("Wait for uploads to finish", "danger");
      return;
    }
    if (!v && !done.length) return; // #301: allow attachment-only posts
    // #271: attribute the human comment with the acting human's id.
    if (!h) {
      toast("Pick an acting human (top-right) first.", "danger");
      return;
    }
    const atts = done.map((s) => ({ id: s.ref!.id, name: s.ref!.name }));
    const r = await post("/api/tasks/" + encodeURIComponent(t.id) + "/messages", {
      body: v,
      author_agent_id: h.id,
      attachments: atts.length ? atts : undefined,
    });
    if (r.ok) {
      toast("Comment posted", "ok");
      setText("");
      setStaged([]);
      void refresh();
    } else {
      // VB4: the 422 body-cap (and any other rejection) surfaces its explicit detail.
      const det = detailText(r.d);
      toast("Failed (" + r.status + ")" + (det ? ": " + det : ""), "danger");
    }
  };

  const startIdx = Math.max(0, msgs.length - shown);
  const visible = msgs.slice(startIdx);

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-h">
        <h3>Thread</h3>
        <span className="count">{count ? "(" + count + ")" : ""}</span>
        <span className="grow" />
        {/* S3 §3b live terminal: pairing lives on the Agents page conversation
            panel (the vanilla tasks page never docked a terminal either) —
            deep-link into the real pairing surface for this task's assignee. */}
        {assignee && assignee.kind !== "human" ? (
          <Link
            className="btn sm ghost"
            to={"/agents?agent=" + encodeURIComponent(assignee.alias)}
            title={"Pair in a live terminal as " + assignee.alias + " — opens the conversation on the Agents page"}
          >
            <Icon name="play" cls="" />
            <span>Pair in terminal</span>
          </Link>
        ) : (
          <button className="btn sm ghost" type="button" disabled title="No agent assigned — assign an agent to pair in a terminal">
            <Icon name="play" cls="" />
            <span>Pair in terminal</span>
          </button>
        )}
        <span className="muted" style={{ fontSize: 11.5 }}>
          append-only · agents + you
        </span>
      </div>
      <div className="card-b" style={{ padding: "16px 18px" }}>
        {msgs.length ? (
          <div className="thread">
            {/* GH #74: a REFRESH failed while cached messages are still shown (summary grew,
                refetch errored). The latch suppresses auto-retries, so without an explicit
                control the thread would silently stay stale until a full page reload —
                surface a small banner + retry alongside the cached messages. */}
            {errored ? (
              <div className="none thread-err" style={{ marginBottom: 12 }}>
                Couldn&#39;t refresh — showing cached messages.{" "}
                <button type="button" className="btn subtle sm" data-thread-retry={t.id} onClick={onRetry}>
                  Retry
                </button>
              </div>
            ) : null}
            {startIdx > 0 ? (
              <button
                className="btn sm ghost"
                style={{ display: "block", margin: "0 auto 12px" }}
                data-loadearlier="true"
                onClick={() => setShown((s) => s + THREAD_PAGE)}
              >
                Load earlier · {visible.length} of {msgs.length}
              </button>
            ) : null}
            {visible.map((m) => (
              <MsgRow key={m.id} snap={snap} m={m} onLightbox={setLightbox} />
            ))}
          </div>
        ) : errored ? (
          // GH #74: no cache to fall back on — an honest failure state instead of a
          // spinner/empty forever. Latches until the user clicks Retry.
          <div className="none thread-err">
            Couldn&#39;t load the thread.{" "}
            <button type="button" className="btn subtle sm" data-thread-retry={t.id} onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : showLoading || summaryCount ? (
          <div className="none">Loading thread…</div>
        ) : (
          <div className="none">No messages yet.</div>
        )}
        <div
          id="replyWrap"
          className={"reply-wrap" + (dragover ? " dragover" : "")}
          style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragover(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragover(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            if (e.target === e.currentTarget) setDragover(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragover(false);
            if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
          }}
        >
          <div className="reply-row">
            {h ? <Avatar alias={h.alias} kind="human" size="sm" /> : null}
            <button
              type="button"
              className="attach-btn"
              id="attachBtn"
              title="Attach files (or drag-drop / paste)"
              aria-label="Attach files"
              disabled={locked}
              onClick={() => fileRef.current?.click()}
            >
              <ClipIcon />
            </button>
            <input
              ref={fileRef}
              id="attachInput"
              type="file"
              multiple
              accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.log,.json"
              style={{ display: "none" }}
              onChange={(e) => {
                uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              id="reply"
              className="reply-in"
              placeholder="Add a comment… (drag, paste or attach files)"
              value={text}
              disabled={locked}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const items = e.clipboardData?.files;
                if (items && items.length) uploadFiles(items); // pasted image/file → stage
              }}
            />
            <button className="btn subtle" id="replyBtn" data-task={t.id} disabled={locked} onClick={() => void postMsg()}>
              Post
            </button>
          </div>
          <div id="attachTray" className="attach-tray">
            {staged.map((s) => (
              <span key={s.key} className={"att-chip" + (s.status === "uploading" ? " uploading" : s.status === "failed" ? " failed" : "")}>
                {s.status === "done" && s.ref && s.ref.kind === "image" ? (
                  <img className="thumb" src={s.ref.url} alt="" />
                ) : (
                  <span className="ic">
                    <FileIcon />
                  </span>
                )}
                <span className="meta">
                  <span className="nm">{s.name}</span>
                  <span className="sz">{s.status === "uploading" ? "uploading…" : s.status === "failed" ? "failed" : fmtSize(s.size)}</span>
                </span>
                <button type="button" className="rm" title="Remove" onClick={() => setStaged((prev) => prev.filter((x) => x.key !== s.key))}>
                  ×
                </button>
              </span>
            ))}
          </div>
          {locked ? (
            <div className="muted" style={{ fontSize: 12.5 }}>
              {assignee?.alias || "The agent"} is in a live terminal — the thread composer is paused.
            </div>
          ) : null}
        </div>
      </div>
      {lightbox ? (
        <div className="att-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================================
   O4 — assign-from-detail + wake (Forge B5: POST /api/tasks/{tid}/assign).
   B5 refuses root + finished tasks (409); a 409 "different active assignee"
   drives the reassign confirm (never pre-decided client-side).
   ========================================================================== */
const ASSIGN_TERMINAL = ["completed", "needs_verification", "cancelled"];
function AssignSurface({ t }: { t: Task }) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const ais = (snap?.agents ?? []).filter((a) => a.kind === "ai");
  const cur = t.assignee;
  const [selAgent, setSelAgent] = useState<string>(() => ais.find((a) => a.alias === cur)?.id || ais[0]?.id || "");
  const [confirm, setConfirm] = useState<null | { reassign: boolean; agentId: string; alias: string }>(null);
  if (t.is_root || ASSIGN_TERMINAL.indexOf(t.status) >= 0) return null;
  if (!ais.length) return null;

  const doAssign = () => {
    const h = actingHuman(snap);
    if (!h) {
      toast("Pick an acting human (top-right) first.", "danger");
      return;
    }
    if (!selAgent) return;
    const ai = ais.find((a) => a.id === selAgent);
    setConfirm({ reassign: false, agentId: selAgent, alias: ai ? ai.alias : "the agent" });
  };

  const postAssign = async (agentId: string, alias: string, reassign: boolean) => {
    const h = actingHuman(snap);
    if (!h) return;
    const { ok, status, d } = await post("/api/tasks/" + encodeURIComponent(t.id) + "/assign", {
      actor_agent_id: h.id,
      agent_id: agentId,
      reassign,
    });
    if (ok) {
      const nm = d.alias || alias;
      let msg = d.woke
        ? "Woke " + nm + " to start the task"
        : d.status === "pending"
          ? "Assigned to " + nm + " — starts when dependencies clear"
          : "Assigned to " + nm;
      if (d.released_prior && d.released_prior.length) msg += " · previous assignee released";
      toast(msg, "ok");
      void refresh();
      return;
    }
    // race: B5 sees a different active assignee -> offer reassign
    if (status === 409 && !reassign && /different active assignee/i.test(d.detail || "")) {
      setConfirm({ reassign: true, agentId, alias });
      return;
    }
    toast("Assign failed (" + status + ")" + (d.detail ? ": " + d.detail : ""), "danger");
  };

  return (
    <div className="card" style={{ marginBottom: 18 }} id="assignWrap" data-task={t.id}>
      <div className="card-h">
        <h3>Assignment</h3>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 11.5 }}>
          human authority · wakes the agent
        </span>
      </div>
      <div className="card-b" style={{ padding: "14px 16px" }}>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 11px" }}>
          Assign this task to an agent and wake them to start.{cur ? " Reassigning releases " + cur + "." : ""}
        </p>
        <div className="row" style={{ gap: 9, alignItems: "center", flexWrap: "wrap" }}>
          <select id="assignSel" className="reply-in" style={{ maxWidth: 260 }} value={selAgent} onChange={(e) => setSelAgent(e.target.value)}>
            {ais.map((a) => (
              <option key={a.id} value={a.id}>
                {a.alias}
                {a.alias === cur ? " (current)" : ""}
              </option>
            ))}
          </select>
          <button className="btn approve" data-act="assign" onClick={doAssign}>
            <Icon name="arrow" cls="" />
            Assign &amp; wake
          </button>
        </div>
      </div>
      {confirm && (
        <Modal
          title={confirm.reassign ? "Reassign task?" : "Assign task?"}
          desc={
            confirm.reassign
              ? "This task already has a different active assignee. Reassign to " + confirm.alias + "? They'll be released."
              : "Assign to " + confirm.alias + "? This wakes them to start the task."
          }
          primary={confirm.reassign ? "Reassign & wake" : "Assign & wake"}
          approve
          onPrimary={() => {
            const c = confirm;
            setConfirm(null);
            void postAssign(c.agentId, c.alias, c.reassign);
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/* ============================================================================
   B7 — force-close a non-root, non-terminal task.
   ========================================================================== */
function CloseCard({ t, onActed }: { t: Task; onActed: (id: string) => void }) {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  if (t.is_root || t.status === "completed" || t.status === "cancelled") return null;
  const who = t.assignee;

  const doCancel = async () => {
    const h = actingHuman(snap);
    if (!h) return;
    const r = await post("/api/tasks/" + encodeURIComponent(t.id) + "/cancel", {
      actor_agent_id: h.id,
      reason: reason.trim() || undefined,
    });
    toast(r.ok ? "Task closed" : "Failed (" + r.status + ")", r.ok ? "ok" : "danger");
    if (r.ok) {
      setReason("");
      onActed(t.id);
      void refresh();
    }
  };

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-h">
        <h3>Close task</h3>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 11.5 }}>
          human authority
        </span>
      </div>
      <div className="card-b" style={{ padding: "14px 16px" }} id="cancelWrap" data-task={t.id}>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 11px" }}>
          Force-close this task and unblock anything waiting on it. A reason is recorded and routed to {who || "the assignee"}.
        </p>
        <textarea
          id="cancelReason"
          className="reply-in"
          style={{ width: "100%", minHeight: 60, resize: "vertical" }}
          placeholder="Reason (recommended)…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div style={{ marginTop: 10 }}>
          <button
            className="btn danger"
            data-act="cancel"
            onClick={() => {
              const h = actingHuman(snap);
              if (!h) {
                toast("Pick an acting human (top-right) first.", "danger");
                return;
              }
              setConfirm(true);
            }}
          >
            <Icon name="x" cls="" />
            Close task…
          </button>
        </div>
      </div>
      {confirm && (
        <Modal
          title="Close this task?"
          desc="Force-closes the task and unblocks anything waiting on it. Logged with your identity."
          primary="Close task"
          onPrimary={() => {
            setConfirm(false);
            void doCancel();
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}

/* ============================================================================
   Create-task (human authority) — POST /api/containers/{cid}/tasks.
   ========================================================================== */
function NewTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: (taskId: string | null) => void }) {
  const { snap, cid, refresh } = useSnapshot();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [dod, setDod] = useState("");
  const [pri, setPri] = useState("100");
  const [assignee, setAssignee] = useState("");
  const [deps, setDeps] = useState<string[]>([]);
  // #57: create-time protocol — collapsed by default, optional; only the fields the
  // user actually filled in ride on the create POST, and only when at least one is set.
  const [pChain, setPChain] = useState("");
  const [pHandoff, setPHandoff] = useState("");
  const [pAutonomy, setPAutonomy] = useState("");
  const [pNotes, setPNotes] = useState("");
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const h = actingHuman(snap);
  const ais = (snap?.agents ?? []).filter((a) => a.kind === "ai");
  // depends_on: optional multi-select of NON-terminal tasks.
  const depOpts = (snap?.tasks ?? []).filter((t) => ["completed", "cancelled"].indexOf(t.status) < 0);

  const submit = async () => {
    const ttl = title.trim();
    const dd = dod.trim();
    if (!ttl) {
      setErr("Title is required.");
      return;
    }
    if (!dd) {
      setErr("Definition of done is required.");
      return;
    }
    const containerId = snap?.container?.id || cid;
    if (!containerId || !h) {
      setErr("No container loaded.");
      return;
    }
    let priority = parseInt(pri, 10);
    if (!Number.isFinite(priority)) priority = 100;
    // #57: send only the fields actually filled in; omit `protocol` entirely when none are set.
    const proto: Proto = {};
    if (pChain.trim()) proto.review_chain = pChain.trim();
    if (pHandoff.trim()) proto.handoff_to = pHandoff.trim();
    if (pAutonomy.trim()) proto.autonomy = pAutonomy.trim();
    if (pNotes.trim()) proto.notes = pNotes.trim();
    setCreating(true);
    const r = await post("/api/containers/" + encodeURIComponent(containerId) + "/tasks", {
      title: ttl,
      description: desc.trim() || null,
      definition_of_done: dd,
      priority,
      created_by_agent_id: h.id,
      assignee_alias: assignee || undefined,
      depends_on: deps,
      protocol: Object.keys(proto).length ? proto : undefined,
    });
    setCreating(false);
    if (r.ok) {
      const where =
        r.d.status === "pending" ? " — starts when dependencies clear" : r.d.assignee_alias ? " · assigned to " + r.d.assignee_alias : "";
      toast("Task created" + where, "ok");
      onCreated(r.d.task_id || null);
      onClose();
      void refresh();
      return;
    }
    setErr("Create failed (" + r.status + ")" + (detailText(r.d) ? ": " + detailText(r.d) : ""));
  };

  return (
    <Modal
      title="New task"
      desc={"Created by " + (h ? h.alias : "you") + " (you) and logged to the audit trail."}
      primary={creating ? "Creating…" : "Create task"}
      approve
      onPrimary={() => {
        if (!creating) void submit();
      }}
      onClose={onClose}
    >
      <div className="field">
        <div className="lbl">
          <Icon name="dot" cls="" />
          Title <span style={{ color: "var(--danger)" }}>*</span>
        </div>
        <input
          id="nt_title"
          className="reply-in"
          style={{ width: "100%" }}
          placeholder="Short, action-oriented title"
          maxLength={200}
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <div className="lbl">Description</div>
        <textarea
          id="nt_desc"
          className="reply-in"
          style={{ width: "100%", minHeight: 64, resize: "vertical" }}
          placeholder="Optional — context, links, scope"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <div className="lbl">
          <Icon name="check" cls="" />
          Definition of done <span style={{ color: "var(--danger)" }}>*</span>
        </div>
        <textarea
          id="nt_dod"
          className="reply-in"
          style={{ width: "100%", minHeight: 64, resize: "vertical" }}
          placeholder="What must be true for this task to be considered complete"
          value={dod}
          onChange={(e) => setDod(e.target.value)}
        />
      </div>
      <div className="row" style={{ gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: "0 0 120px" }}>
          <div className="lbl">Priority</div>
          <input
            id="nt_pri"
            className="reply-in"
            type="number"
            min={1}
            style={{ width: "100%" }}
            title="Lower = higher priority"
            value={pri}
            onChange={(e) => setPri(e.target.value)}
          />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 180 }}>
          <div className="lbl">Assignee</div>
          <select id="nt_assignee" className="reply-in" style={{ width: "100%" }} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">— Unassigned —</option>
            {ais.map((a) => (
              <option key={a.id} value={a.alias}>
                {a.alias}
              </option>
            ))}
          </select>
        </div>
      </div>
      {depOpts.length ? (
        <div className="field" style={{ marginTop: 12 }}>
          <div className="lbl">
            Depends on{" "}
            <span className="muted" style={{ fontWeight: 450, textTransform: "none", letterSpacing: 0 }}>
              — optional; ⌘/Ctrl-click to multi-select
            </span>
          </div>
          <select
            id="nt_deps"
            className="reply-in"
            multiple
            size={4}
            style={{ width: "100%" }}
            value={deps}
            onChange={(e) => setDeps(Array.from(e.target.selectedOptions).map((o) => o.value))}
          >
            {depOpts.map((t) => (
              <option key={t.id} value={t.id}>
                {trunc(t.title, 70)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <details className="field" style={{ marginTop: 12 }}>
        <summary
          style={{
            cursor: "pointer",
            fontSize: 11,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            fontWeight: 650,
            color: "var(--faint)",
          }}
        >
          Protocol{" "}
          <span className="muted" style={{ fontWeight: 450, textTransform: "none", letterSpacing: 0 }}>
            — optional; the multi-agent loop rules the assignee reads on its first wake
          </span>
        </summary>
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="field">
            <div className="lbl">Review chain</div>
            <textarea
              id="nt_p_chain"
              className="reply-in"
              style={{ width: "100%", minHeight: 48, resize: "vertical" }}
              placeholder="e.g. Builder → Reviewer → loop until clean → human"
              value={pChain}
              onChange={(e) => setPChain(e.target.value)}
            />
          </div>
          <div className="field">
            <div className="lbl">Hand-off to</div>
            <textarea
              id="nt_p_handoff"
              className="reply-in"
              style={{ width: "100%", minHeight: 48, resize: "vertical" }}
              placeholder="Who the assignee returns to first when done"
              value={pHandoff}
              onChange={(e) => setPHandoff(e.target.value)}
            />
          </div>
          <div className="field">
            <div className="lbl">Autonomy</div>
            <textarea
              id="nt_p_autonomy"
              className="reply-in"
              style={{ width: "100%", minHeight: 48, resize: "vertical" }}
              placeholder="Free-text — how far the assignee may go before checking in"
              value={pAutonomy}
              onChange={(e) => setPAutonomy(e.target.value)}
            />
          </div>
          <div className="field">
            <div className="lbl">Notes</div>
            <textarea
              id="nt_p_notes"
              className="reply-in"
              style={{ width: "100%", minHeight: 48, resize: "vertical" }}
              placeholder="Any other standing rules for this task"
              value={pNotes}
              onChange={(e) => setPNotes(e.target.value)}
            />
          </div>
        </div>
      </details>
      {err ? (
        <div className="hint" id="nt_err" style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>
          {err}
        </div>
      ) : null}
    </Modal>
  );
}

/* ============================================================================
   Worker runs (live feed) — GET /api/tasks/{tid}/runs, SSE via useRunStream,
   diffs via FilesChanged, graceful Stop (SPEC-2 T2) with a sticky
   "Stop requested" relabel.
   ========================================================================== */
// run_ids a human has requested a stop for THIS SESSION — module-level so the
// relabel stays sticky across polls/remounts until the run status flips.
const stopRequestedRuns = new Set<string>();
function killCause(kr: string | null | undefined): string {
  try {
    return ((JSON.parse(kr || "") as { cause?: string }) || {}).cause || "";
  } catch {
    return "";
  }
}

function RunCard({ run }: { run: Run }) {
  const { snap } = useSnapshot();
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const [, bumpLocal] = useState(0);
  const lines = useRunStream(run);
  const logRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  // appendLine parity: stick to the bottom while the reader is at the bottom.
  // pinToBottom is INSTANT — a smooth-animated pin would let the onScroll
  // handler observe a mid-animation position, flip atBottomRef false, and
  // permanently stop the feed from following its own stream.
  useEffect(() => {
    const el = logRef.current;
    if (el && atBottomRef.current) pinToBottom(el);
  }, [lines]);

  const rid = run.run_id || run.id || "";
  const live = run.status === "running";
  const statusTxt = live ? "running" : run.status;
  const started = run.started_at || run.started;
  const ended = run.ended_at || run.ended;
  const killed = run.status === "killed";
  // #299 honesty: a human-stopped run reaps as status='killed' with
  // kill_reason.cause='human_stop'; only a watchdog kill reads 'watchdog-killed'.
  const killTag = killed ? (killCause(run.kill_reason) === "human_stop" ? " ■ stopped" : " ⚠ watchdog-killed") : "";
  const stopReq = stopRequestedRuns.has(rid);

  const requestStop = () => {
    if (!rid) return;
    const h = actingHuman(snap);
    if (!h) {
      toast("Pick an acting human first.", "danger");
      return;
    }
    if (stopRequestedRuns.has(rid)) {
      toast("Stop already requested for this run.", "warn");
      return;
    }
    setConfirmStop(true);
  };
  const doStop = async () => {
    const h = actingHuman(snap);
    if (!h) return;
    try {
      const r = await fetch("/api/runs/" + encodeURIComponent(rid) + "/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor_agent_id: h.id }),
      });
      if (!r.ok) {
        toast("Stop failed (" + r.status + ").", "danger");
        return;
      }
      const d = (await r.json()) as { already_finished?: boolean; already_requested?: boolean; status?: string };
      // Three 200 shapes from POST /api/runs/{id}/stop: already_finished /
      // already_requested / fresh stop_requested.
      if (d && d.already_finished) {
        toast("Run already " + (d.status || "finished") + ".", "warn");
        return;
      }
      stopRequestedRuns.add(rid);
      bumpLocal((n) => n + 1); // instant sticky relabel
      toast(d && d.already_requested ? "Stop already requested." : "Stop requested — the worker halts on the next tick.", "ok");
    } catch (e) {
      toast("Stop failed (" + (e instanceof Error ? e.message : e) + ").", "danger");
    }
  };

  return (
    <div className="run">
      <div className="run-h">
        <span className={"rstat " + statusTxt}>
          {statusTxt}
          {run.exit_code != null && !live ? " · exit " + run.exit_code : ""}
          {killTag}
        </span>
        <span className="tag mono">{run.wake_kind === "tmux" ? "live tab" : run.wake_kind || ""}</span>
        {live ? (
          <span className="live accent">
            <span className="d" />
            live
          </span>
        ) : null}
        {live ? (
          <button
            className="btn sm stop"
            type="button"
            data-run-stop={rid}
            disabled={stopReq}
            title={stopReq ? "Stop requested — the worker halts at its next checkpoint" : "Stop this worker run"}
            onClick={requestStop}
          >
            <span className="sq" />
            {stopReq ? "Stop requested" : "Stop run"}
          </button>
        ) : null}
        <span className="when">
          {clockTime(started)}
          {ended ? " → " + clockTime(ended) : " …"}
          {started ? " · " + relTime(ended || started) : ""}
        </span>
      </div>
      {run.diff != null ? (
        <details>
          <summary style={{ cursor: "pointer", color: "var(--info)", fontSize: 12.5, padding: "0 15px 10px", fontWeight: 600 }}>code diff</summary>
          <div style={{ padding: "0 15px 14px" }}>
            <FilesChanged diff={run.diff} />
          </div>
        </details>
      ) : null}
      <details open>
        <summary
          style={{ cursor: "pointer", color: "var(--muted)", fontSize: 12.5, padding: "8px 15px", fontWeight: 600, borderTop: "1px solid var(--border)" }}
        >
          log{live ? " · streaming" : ""}
        </summary>
        <div
          className="log"
          id={"run-" + rid}
          ref={logRef}
          onScroll={(e) => {
            atBottomRef.current = nearBottom(e.currentTarget);
          }}
        >
          {lines.map((e, i) => (
            <div key={i} className={"ln t-" + e.type}>
              <span className="gut">›</span>
              <span className="ty">{e.label || e.type}</span>
              <span className="tx">
                {e.text}
                {e.detail ? <span className="det">{e.detail}</span> : null}
              </span>
            </div>
          ))}
        </div>
      </details>
      {confirmStop && (
        <Modal
          title={"Stop run " + shortId(rid) + "?"}
          desc="Requests a graceful stop — the worker halts at its next checkpoint (the daemon reaps it on the next wake-tick, not instantly). The task stays in_progress for you to reassign or rewake."
          danger
          primary="Stop run"
          onPrimary={() => {
            setConfirmStop(false);
            void doStop();
          }}
          onClose={() => setConfirmStop(false)}
        />
      )}
    </div>
  );
}

function RunsPanel({ tid }: { tid: string }) {
  const { bump } = useSnapshot();
  const [state, setState] = useState<{ runs: Run[]; failed: boolean } | null>(null);
  const sigRef = useRef("");
  const paintedRef = useRef(false);
  const tokRef = useRef(0);

  useEffect(() => {
    sigRef.current = "";
    paintedRef.current = false;
    setState(null);
  }, [tid]);

  useEffect(() => {
    const tok = ++tokRef.current;
    fetch("/api/tasks/" + encodeURIComponent(tid) + "/runs")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: Run[] | { runs?: Run[] }) => {
        if (tok !== tokRef.current) return;
        const runs = Array.isArray(d) ? d : d.runs || [];
        const sig = runs.map((x) => (x.run_id || x.id) + ":" + x.status).join("|");
        if (paintedRef.current && sig === sigRef.current) return; // unchanged — keep streams/log DOM alone
        sigRef.current = sig;
        paintedRef.current = true;
        setState({ runs, failed: false });
      })
      .catch(() => {
        if (tok === tokRef.current && !paintedRef.current) {
          paintedRef.current = true;
          setState({ runs: [], failed: true });
        }
      });
  }, [tid, bump]);

  if (!state) return null;
  if (state.failed)
    return (
      <div className="card">
        <div className="card-h">
          <h3>Runs &amp; diffs</h3>
        </div>
        <div className="card-b" style={{ padding: 14 }}>
          <div className="none">Run feed unavailable.</div>
        </div>
      </div>
    );
  const runs = state.runs;
  const live = runs.some((x) => x.status === "running");
  return (
    <div className="card">
      <div className="card-h">
        <h3>Runs &amp; diffs</h3>
        <span className="grow" />
        {live ? (
          <span className="live accent">
            <span className="d" />
            live
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 11.5 }}>
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="card-b" style={{ padding: "13px 14px" }}>
        {runs.length ? (
          runs.map((r) => <RunCard key={r.run_id || r.id} run={r} />)
        ) : (
          <div className="none">No runs yet — appears when a worker wakes for this task.</div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   The page.
   ========================================================================== */
function firstSelId(ts: Task[]): string | null {
  const t = ts.find((x) => x.status === "needs_verification") || ts.find(pendingPlan) || ts[0];
  return t ? t.id : null;
}

export function TasksPage() {
  const { snap, bump } = useSnapshot();
  const location = useLocation();
  const navigate = useNavigate();
  const urlTask = useMemo(() => new URLSearchParams(location.search).get("task"), [location.search]);
  const [sel, setSel] = useState<string | null>(urlTask);
  const [tasksShown, setTasksShown] = useState(TASKS_PAGE);
  const [sortTick, setSortTick] = useState(0);
  // optimistic one-shot: tasks acted on THIS session — suppress the gate
  // immediately so the 3s repaint can't double-submit (mirrors D2/ISS-41).
  const [acted, setActed] = useState<Set<string>>(() => new Set());
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // ISS-68: per-task FULL-thread cache (the snapshot ships only a
  // message_summary); refetched when the summary count outgrows the cache.
  const threadsRef = useRef<Record<string, ThreadMsg[]>>({});
  const threadLoadingRef = useRef<Record<string, boolean>>({});
  // GH #74: per-task thread-fetch error LATCH. Set when a fetch fails (network/non-200) OR
  // comes back empty while the snapshot says count>0 (a data inconsistency). While latched,
  // the poll-driven effect below stops auto-retrying — an explicit Retry click clears it.
  const threadErrorRef = useRef<Record<string, boolean>>({});
  const [, setThreadTick] = useState(0);
  const toast = useToast();

  // deep link (`/tasks?task=…`) — external URL changes select the task.
  useEffect(() => {
    if (urlTask) setSel(urlTask);
  }, [urlTask]);

  const tasks = snap?.tasks ?? [];
  const selValid = sel != null && tasks.some((x) => x.id === sel);
  const effSel = selValid ? sel : firstSelId(tasks);
  const t = effSel != null ? tasks.find((x) => x.id === effSel) || null : null;

  // GH #74: fetch the selected task's full thread, latching a failure so the 3s poll can't
  // hammer a persistently-failing endpoint. `manual` (from the Retry click) clears the latch
  // and forces a refetch even when nothing new is expected; auto (poll-driven) calls stay
  // suppressed while already loading, already current, OR while the latch is set.
  const loadThread = (tid: string, agents: Snapshot["agents"], manual?: boolean) => {
    const task = tasks.find((x) => x.id === tid);
    const want = task?.message_summary?.count || 0;
    const have = (threadsRef.current[tid] || []).length;
    if (threadLoadingRef.current[tid]) return;
    if (manual) {
      threadErrorRef.current[tid] = false;
    } else if (have >= want || threadErrorRef.current[tid]) {
      return; // current, or failed-awaiting-explicit-retry
    }
    threadLoadingRef.current[tid] = true;
    setThreadTick((n) => n + 1); // repaint into the loading state
    threadOf(tid, agents)
      .then((th) => {
        threadLoadingRef.current[tid] = false;
        // Inconsistency: the snapshot claims messages exist but the fetch came back empty —
        // treat it as a failure so the user gets a retry rather than a perpetual spinner/empty.
        if (!th.length && want > 0) {
          threadErrorRef.current[tid] = true;
        } else {
          threadsRef.current[tid] = th;
          threadErrorRef.current[tid] = false;
        }
        setThreadTick((n) => n + 1);
      })
      .catch(() => {
        threadLoadingRef.current[tid] = false;
        threadErrorRef.current[tid] = true;
        setThreadTick((n) => n + 1);
      });
  };

  // ISS-68: lazy-fetch the selected task's full thread when the summary count
  // outgrows the cache (auto; GH #74 latch applies).
  useEffect(() => {
    if (!t || !snap) return;
    loadThread(t.id, snap.agents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id, t?.message_summary?.count, bump]);

  const select = (id: string) => {
    if (id === effSel) return;
    setSel(id);
    navigate("/tasks?task=" + encodeURIComponent(id), { replace: true });
    window.scrollTo({ top: 0 });
  };

  const markActed = (id: string) =>
    setActed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  const canCreate = !!actingHuman(snap);
  void sortTick; // sort state lives in localStorage; the tick re-renders
  const sorted = tasks.slice().sort(sortComparator(SORT_NAME, { bucket: taskBucket, time: timeKey, prio: prioNum }));
  // ISS-68 PR-3: cap to the top-N, then group THAT subset so the groups stay
  // consistent with what's shown; "Load more" reveals the next page.
  const capped = sorted.slice(0, tasksShown);
  const grouped = new Set<string>();
  const groups = GRP.map((g) => {
    const items = capped.filter((x) => x.status === g.k);
    items.forEach((x) => grouped.add(x.id));
    return { ...g, items };
  }).filter((g) => g.items.length);
  const other = capped.filter((x) => !grouped.has(x.id)); // never silently drop a task

  const trow = (x: Task) => {
    const who = x.assignee;
    const a = agentByAlias(snap, who);
    return (
      <button key={x.id} className={"trow " + (x.id === effSel ? "sel" : "")} data-id={x.id} onClick={() => select(x.id)}>
        <Glyph status={x.status} />
        <span className="grow">
          <span className="tt">
            {x.is_root ? (
              <span className="tag root" style={{ marginRight: 5 }}>
                root
              </span>
            ) : null}
            {x.title}
          </span>
          <span className="tm">
            {who ? <Avatar alias={who} kind={a ? a.kind : "ai"} size="sm" /> : null}
            <span className="t2">{who || "unassigned"}</span>
            <span className={"prio " + prioCls(x)} style={{ marginLeft: "auto" }}>
              P{String(x.priority ?? "")}
            </span>
          </span>
        </span>
      </button>
    );
  };

  const ctx = snap?.container ? `${tasks.length} tasks · ${snap.container.name || ""}` : undefined;

  return (
    <Shell page="tasks" title="Tasks" ctx={ctx}>
      <style>{tasksPageCss}</style>
      <div className="split wide">
        <aside className="card tlist-card stick" id="tlist">
          <div className="rh">
            <span className="row" style={{ gap: 7, alignItems: "center" }}>
              <Icon name="tasks" cls="" />
              Tasks · grouped by status
            </span>
            <span className="grow" style={{ flex: 1 }} />
            <SortCtl name={SORT_NAME} onChange={() => setSortTick((n) => n + 1)} />
            <button
              className="btn approve sm"
              data-newtask="true"
              disabled={!canCreate}
              title={canCreate ? "Create a new task" : "Pick an acting human (top-right) to create tasks"}
              style={{ letterSpacing: 0, textTransform: "none", marginLeft: 7 }}
              onClick={() => {
                if (!canCreate) {
                  toast("Pick an acting human (top-right) first.", "danger");
                  return;
                }
                setNewTaskOpen(true);
              }}
            >
              <Icon name="plus" cls="" />
              New
            </button>
          </div>
          {groups.map((g) => (
            <div key={g.k}>
              <div className="tgrp">
                <span>{g.label}</span>
                <span className="ln" />
                <span>{g.items.length}</span>
              </div>
              {g.items.map(trow)}
            </div>
          ))}
          {other.length ? (
            <div>
              <div className="tgrp">
                <span>Other</span>
                <span className="ln" />
                <span>{other.length}</span>
              </div>
              {other.map(trow)}
            </div>
          ) : null}
          {sorted.length > capped.length ? (
            <button
              className="btn subtle"
              style={{ width: "calc(100% - 12px)", margin: "10px 6px 4px" }}
              data-loadmore="true"
              onClick={() => setTasksShown((n) => n + TASKS_PAGE)}
            >
              Load more · {capped.length} of {sorted.length}
            </button>
          ) : null}
        </aside>
        <main>
          <div id="detailMain">
            {!t ? (
              <div className="card pad">
                <div className="none">Task not found.</div>
              </div>
            ) : (
              <>
                <div className="card pad thead" style={{ marginBottom: 18 }}>
                  <div className="row" style={{ alignItems: "flex-start", gap: 13 }}>
                    <div className="grow">
                      <h1>
                        {t.is_root ? (
                          <span className="tag root" style={{ marginRight: 8, verticalAlign: "middle" }}>
                            root
                          </span>
                        ) : null}
                        {t.title}
                      </h1>
                      <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                        <StatusPill status={t.status} size="lg" />
                        <span className={"prio " + prioCls(t)}>Priority {String(t.priority ?? "")}</span>
                        <span className="muted" style={{ fontSize: 12.5 }}>
                          ·
                        </span>
                        <span className="muted" style={{ fontSize: 12.5 }}>
                          assignee
                        </span>{" "}
                        <AgentLink snap={snap} alias={t.assignee} />
                        {/* collab v1: assigned reviewer — rendered ONLY when the
                            snapshot speaks collab (cloud); open backends show
                            nothing and never touch the reviewer endpoint. */}
                        {reviewerSupported(snap) ? (
                          <>
                            <span className="muted" style={{ fontSize: 12.5 }}>
                              ·
                            </span>
                            <span className="muted" style={{ fontSize: 12.5 }}>
                              reviewer
                            </span>{" "}
                            <ReviewerChip key={"rev-" + t.id} t={t} />
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {t.description ? (
                    <div className="field" style={{ marginTop: 16, paddingTop: 15, borderTop: "1px solid var(--border)" }}>
                      <div className="lbl">Description</div>
                      <div className="tx">{t.description}</div>
                    </div>
                  ) : null}
                  <div className="field" style={{ marginTop: 14 }}>
                    <div className="lbl">Definition of done</div>
                    <div className="dod">{t.definition_of_done || "—"}</div>
                  </div>
                  {t.result ? (
                    <div className="field" style={{ marginTop: 14 }}>
                      <div className="lbl">Result</div>
                      <div className="tx">
                        {/* open-orcha#209: task.result is JSONB — normalize before render */}
                        <Linkified text={resultText(t.result)} tasks={snap?.tasks} />
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* gate -> protocol -> thread -> assignment -> close */}
                <GateSurface key={"gate-" + t.id} t={t} acted={acted.has(t.id)} onActed={markActed} />
                <ProtocolPanel key={"proto-" + t.id} t={t} />
                <ThreadCard
                  key={"thread-" + t.id}
                  t={t}
                  msgs={threadsRef.current[t.id] || []}
                  loading={!!threadLoadingRef.current[t.id]}
                  errored={!!threadErrorRef.current[t.id]}
                  onRetry={() => snap && loadThread(t.id, snap.agents, true)}
                />
                <AssignSurface key={"assign-" + t.id} t={t} />
                <CloseCard key={"close-" + t.id} t={t} onActed={markActed} />
              </>
            )}
          </div>
          <div id="runsWrap">{t ? <RunsPanel tid={t.id} /> : null}</div>
        </main>
      </div>
      {newTaskOpen && (
        <NewTaskModal
          onClose={() => setNewTaskOpen(false)}
          onCreated={(taskId) => {
            // the new task may not be in the local snapshot yet — set the
            // selection; the poll's snapshot pick-up preserves it once real.
            if (taskId) {
              setSel(taskId);
              navigate("/tasks?task=" + encodeURIComponent(taskId), { replace: true });
            }
          }}
        />
      )}
    </Shell>
  );
}

/**
 * Task detail (V2 "Linear issue" layout, directives D5/D8/D10/D12) — owner:
 * tasks-detail. Rendered by TasksPage as the split inspector, the narrow
 * (≤ 900 px) pushed detail and the `?full=1` full view.
 *
 *   header   ← back · status glyph · short ID · title · ⋯      1 / N ↑ ↓ · ⤢ · ✕
 *   main     large title · description · GATE CARD (plan / verification) ·
 *            definition of done · result · decided plan
 *   rail     Properties (status, priority, assignee, reviewer, creator) ·
 *            Relations (close-implications) · Protocol · Assign · Cancel
 *   acts     Activity | Runs — the activity timeline (real timestamps only:
 *            created / started / plan decision / runs / closed + the thread
 *            as comment cards) with a "Leave a comment…" composer.
 *
 * On a wide panel (container ≥ 880 px) the rail is a right column; narrower
 * it stacks as a compact key/value list between the gate and the activity.
 *
 * Every existing behaviour is kept over the UNCHANGED backend (each fetch copies
 * the endpoint/method/body exactly): plan decisions (B10/ISS-59, optional answer),
 * verify / reject with a REQUIRED reason, failed decisions keep typed input,
 * protocol panel (SPEC-4), assign + reassign 409 (O4), cancel (B7) with the
 * read-only impact, reviewer chip (collab v1), ISS-68 lazy thread + "Load
 * earlier", GH #74 error latch + Retry, #301/#330 attachments, the live-lease
 * composer lock, runs + live SSE + diffs + graceful Stop, and create-task.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { markAttentionDecided } from "../../state/attention";
import { clockTime, relTime, shortId, trunc } from "../../lib/format";
import { isActingOwner, reviewerName, reviewerRef, reviewerSupported, reviewerTitle } from "../../lib/reviewer";
import { leaseOf, statusMeta } from "../../lib/status";
import { Avatar, Icon, Linkified, Md, useToast } from "../../components/ui";
import {
  Button,
  ButtonLink,
  ConfirmDialog,
  Dialog,
  HelpTip,
  IconButton,
  Menu,
  Payload,
  Popover,
  PrChip,
  PriorityIcon,
  Skeleton,
  normalizePayload,
  StatusGlyph,
  StatusIcon,
  Tabs,
  iconButtonClass,
  trapTab,
  type MenuItemSpec,
} from "../../components/primitives";
import { Timeline, TimelineCard, TimelineEvent, TimelineMessage } from "../../components/primitives";
import { MakeRecurringDialog, RecurringLink, makeRecurringItem, useMakeRecurringGate, useTaskRoutines } from "../routines/MakeRecurring";
import { Property, PropertyRail, PropertySection } from "../../components/primitives";
import { AttachGlyph, Composer } from "../../components/primitives";
import { PageHeader, Pager } from "../../shell/PageChrome";
import {
  agentByAlias,
  autLevel,
  agentAutonomy,
  pendingPlan,
  planAwaitsHuman,
  planMessageOf,
  useActingAuthority,
  useSnapshot,
} from "../../state/SnapshotProvider";
import { FilesChanged } from "../../components/FilesChanged";
import { runBlobSource } from "../../components/filePreview/sources";
import { modeWords, useProjectMode } from "../../lib/projectMode";
import { AutofixSection, EvidencePack } from "./evidence";
import { DeliverablesEvidence, DeliverablesSection } from "./deliverables";
import { GoalChain } from "./goal";
import { pausedById, useContainerBudgets, type AgentBudgetStatus } from "../agents/budget/budgetModel";
import { BudgetPausedChip } from "../agents/budget/AgentBudgetSection";
import { logRowText } from "../agents/runlog";
import { useRunStream } from "../../hooks/useRunStream";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { nearBottom, pinToBottom } from "../../lib/logScroll";
import type { Agent, Attachment, Run, Snapshot, Task, ThreadMsg } from "../../types";
import { composerCss } from "./composerCss";
import { ManagerSentBackNote, ReviewRouteRow } from "./ReviewRoute";
import { DEFAULT_PRIORITY, PRIORITY_BUCKETS, priorityBucket, priorityValue, type TabKey } from "./taskQuery";

/** Shown whenever an action needs a human identity and none is acting. */
export const NO_HUMAN = "Pick an acting human first — actions are recorded under a human identity, and none is acting on this project.";

/** PS-29: the human the UI may act as RIGHT NOW — the connection-aware
 *  authority (offline / refused snapshot / viewer → null), so every mutation
 *  control disables itself with useNoHumanReason()'s reason instead of
 *  staying live against an unreachable backend. */
export function useActor(): Agent | null {
  return useActingAuthority().human;
}

/** Disabled-action reason: viewers / non-members / pending identity get their
 *  own authority reason ("read-only", "resolving…"), everyone else NO_HUMAN. */
export function useNoHumanReason(): string {
  const a = useActingAuthority();
  return (a.readOnly || a.pending) && a.reason ? a.reason : NO_HUMAN;
}

/* ---- raw POST/PATCH helpers (vanilla postJSON/patchJSON parity: the pages
   need ok + status + parsed body to drive 409-reassign and error toasts) ---- */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function post(url: string, body?: unknown): Promise<{ ok: boolean; status: number; d: any }> {
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
/** Human-readable server error detail — never a raw JSON dump (D4). FastAPI
 *  422s carry `detail: [{loc, msg}]`; other shapes use their message/detail. */
export function detailText(d: any): string {
  if (!d || d.detail == null) return "";
  const x = d.detail;
  if (typeof x === "string") return x;
  if (Array.isArray(x)) {
    return x
      .map((e: any) => {
        if (typeof e === "string") return e;
        const where = Array.isArray(e?.loc) ? e.loc.filter((l: unknown) => l !== "body").join(".") : "";
        const msg = e?.msg || e?.message || "";
        return msg ? (where ? where + ": " + msg : msg) : "";
      })
      .filter(Boolean)
      .join("; ");
  }
  if (typeof x === "object") return String(x.message || x.msg || x.detail || x.error || "request rejected");
  return String(x);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const THREAD_SHOWN = 10; // ISS-68 PR-3 thread initial reveal
const THREAD_PAGE = 20; // "Load earlier" reveal step

function priorityTitle(p: string | number | null | undefined): string {
  return "Priority " + priorityBucket(p).label + " · " + String(p ?? DEFAULT_PRIORITY) + " (lower number = higher priority)";
}

/** The task's creator ONLY when it resolves to a real actor in this project.
 *  api/client maps a null created_by_agent_id to the placeholder "human" — that
 *  is not an actor, so it renders nothing rather than a guess. */
export function creatorOf(t: Task, snap: Snapshot | null): string | null {
  const c = t.created_by;
  if (!c) return null;
  return agentByAlias(snap, c) ? c : null;
}

/** A GitHub pull request referenced by the task result (object `pr_url` /
 *  `pull_request_url` / `url`, or the first /pull/N URL in a text result). */
export function prOf(result: unknown): { url: string; number: string } | null {
  const RX = /https?:\/\/[^\s)"'<>]+\/pull\/(\d+)/;
  const tryStr = (s: unknown) => {
    if (typeof s !== "string") return null;
    const m = RX.exec(s);
    return m ? { url: m[0], number: m[1] } : null;
  };
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const o = result as Record<string, unknown>;
    for (const k of ["pr_url", "pull_request_url", "pr", "url"]) {
      const hit = tryStr(o[k]);
      if (hit) return hit;
    }
    return tryStr(o.summary) || tryStr(o.result);
  }
  return tryStr(result);
}

/** The latest REAL timestamp we have for the task (no updated_at on the wire). */
function lastActivityAt(t: Task): string | null {
  const c = [t.message_summary?.last?.at, t.completed_at, t.started_at, t.created_at].filter(Boolean) as string[];
  if (!c.length) return null;
  return c.reduce((a, b) => ((Date.parse(b) || 0) > (Date.parse(a) || 0) ? b : a));
}

/** A plan body whose first line is just a "Plan" heading repeats the gate's
 *  own "Plan" label — drop that heading line (the rest is untouched). */
export function stripPlanHeading(body: string): string {
  return body.replace(/^\s*#{1,6}\s*(the\s+)?plan\s*:?\s*\n+/i, "");
}

/** Long authored text (plans, results): rendered markdown, clamped with a
 *  "Show all" disclosure instead of a nested scroll box. */
function ClampedMd({ text, tasks, what = "text" }: { text: string; tasks?: Task[]; what?: string }) {
  const long = text.length > 700 || text.split("\n").length > 14;
  const [open, setOpen] = useState(false);
  return (
    <div className={"wk-clamp" + (long && !open ? " is-clamped" : "")}>
      <Md className="wk-md" text={text} tasks={tasks} />
      {long ? (
        <Button variant="link" size="sm" className="wk-clamp-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show full " + what}
        </Button>
      ) : null}
    </div>
  );
}

/** Inspector description: clamped to 3 lines with a "Show more" toggle
 *  (only when it actually overflows — measured, never guessed). */
function ClampedDesc({ text, tasks }: { text: string; tasks?: Task[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    setOver(el.scrollHeight > el.clientHeight + 2);
  }, [text, open]);
  return (
    <div className="td-desc-wrap">
      <div ref={ref} className={"td-desc-clamp" + (open ? "" : " is-clamped")}>
        <Md className="td-desc wk-text wk-md" text={text} tasks={tasks} />
      </div>
      {over || open ? (
        <Button variant="link" size="sm" className="td-desc-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}

/** task.result is JSONB (open-orcha#209): strings render as markdown; objects
 *  through the shared Payload primitive (title + fields, never raw JSON). */
/** POST /done stores `{result, by_agent_id}` — the envelope, not the result:
 *  unwrap it (the claimer is already named by the gate / activity, and a raw
 *  agent id is never shown — D4/D12). Any other object passes through. */
export function unwrapDoneResult(r: unknown): unknown {
  if (!r || typeof r !== "object" || Array.isArray(r)) return r;
  const o = r as Record<string, unknown>;
  const keys = Object.keys(o);
  if (!keys.includes("result") || !keys.every((k) => k === "result" || k === "by_agent_id")) return r;
  return o.result;
}
function ResultView({ r: raw, tasks }: { r: unknown; tasks?: Task[] }) {
  const r = unwrapDoneResult(raw);
  if (r == null || r === "") return <span className="v2-muted">No result posted.</span>;
  if (typeof r === "string" && !/^\s*[[{]/.test(r)) return <ClampedMd text={r} tasks={tasks} what="result" />;
  const inline = resultWithPr(normalizePayload(r));
  if (inline) {
    return (
      <div className="v2-payload wk-payload td-result">
        <div className="v2-payload-title td-result-line">{inline.line}</div>
        <Payload value={inline.rest} showTitle={false} tasks={tasks} />
      </div>
    );
  }
  return <Payload value={r} tasks={tasks} className="wk-payload" />;
}

/** An object result whose summary names a GitHub PR it also links: ONE line
 *  with the PR chip IN PLACE of the "PR #102" mention (or at the end of the
 *  line when the text never names it) — the same fact never shows twice
 *  (D12). Returns null when there is no summary + PR link to merge. */
export function resultWithPr(v: unknown): { line: ReactNode; rest: Record<string, unknown> } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const pr = prOf(o);
  if (!pr) return null;
  const titleKey = ["summary", "title", "headline", "message"].find((k) => typeof o[k] === "string" && (o[k] as string).trim() && (o[k] as string).length <= 240);
  if (!titleKey) return null;
  const summary = (o[titleKey] as string).trim();
  const rest: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (k === titleKey) continue;
    if (typeof x === "string" && x.includes("/pull/" + pr.number)) continue; // the PR link itself
    if (/^(pr|pull)(_?num(ber)?|_?no)?$/i.test(k) && String(x).replace(/^#/, "") === pr.number) continue; // pr_number repeat
    rest[k] = x;
  }
  const chip = <PrChip number={pr.number} href={pr.url} title={pr.url} size="sm" />;
  const m = new RegExp("(?:\\b(?:PR|pull request)\\s*)?#" + pr.number + "\\b", "i").exec(summary);
  const line = m ? (
    <>
      {summary.slice(0, m.index)}
      {chip}
      {summary.slice(m.index + m[0].length)}
    </>
  ) : (
    <>
      {summary} {chip}
    </>
  );
  return { line, rest };
}

/** Actor link: round avatar + alias, deep-linking to the agent. */
function AgentLink({ snap, alias }: { snap: Snapshot | null; alias: string | null }) {
  if (!alias) return null;
  const a = agentByAlias(snap, alias);
  if (!a) return <span className="td-actor">{alias}</span>;
  return (
    <a className="dlink td-actor" href={"/agents?agent=" + encodeURIComponent(alias)}>
      <Avatar alias={alias} kind={a.kind} size="sm" decorative />
      <span>{alias}</span>
    </a>
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
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
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
    return (
      <button type="button" className="att-imgbtn" aria-label={"Open image " + nm} onClick={() => onLightbox(url)} style={{ padding: 0, border: 0, background: "none" }}>
        <img className="att-img" src={url} alt={nm} title={nm} loading="lazy" />
      </button>
    );
  }
  return (
    <a className="att-file" href={url} target="_blank" rel="noopener" download>
      <FileIcon />
      <span>{nm}</span>
      <span className="sz">{fmtSize(a.size)}</span>
    </a>
  );
}

/* In-place people picker (Linear property popover): round avatars + alias,
   the current value checked, roving ↑/↓/Home/End focus, Enter/Space picks,
   Escape closes and returns focus to the trigger (Popover). Replaces the
   native <select>s / modal pickers in the rail. */
interface PickOpt {
  id: string;
  label: string;
  alias?: string | null;
  kind?: string;
  ghLogin?: string | null;
  hint?: string;
  /** leading glyph instead of an avatar (e.g. the priority bars) */
  icon?: ReactNode;
  /** trailing status chip (KG-6b: "Budget paused") */
  chip?: ReactNode;
}
function PeopleMenu({ anchor, open, onClose, label, options, value, onPick }: {
  anchor: MutableRefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  label: string;
  options: PickOpt[];
  value: string;
  onPick: (id: string) => void;
}) {
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    let j = -1;
    if (e.key === "ArrowDown") j = (i + 1) % items.length;
    else if (e.key === "ArrowUp") j = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = items.length - 1;
    else if (e.key === "Escape") {
      // close ONLY this menu — inside a dialog (New task) Escape must not
      // bubble (React portal) to the dialog and discard / close the draft
      e.preventDefault();
      e.stopPropagation();
      onClose();
      anchor.current?.focus();
      return;
    }
    if (j >= 0) {
      e.preventDefault();
      items[j].focus();
    }
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} role="menu" label={label} placement="bottom-start" className="v2-menu td-people">
      <div className="v2-menu-inner" onKeyDown={onKey}>
        {options.map((o) => {
          const pick = () => {
            onClose();
            onPick(o.id);
          };
          return (
            <div
              key={o.id || "none"}
              role="menuitemradio"
              aria-checked={o.id === value}
              tabIndex={-1}
              data-value={o.id}
              className="v2-menu-item td-people-item"
              onClick={pick}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick();
                }
              }}
            >
              {o.icon ? (
                <span className="td-people-ico" aria-hidden="true">{o.icon}</span>
              ) : o.alias ? (
                <Avatar alias={o.alias} kind={o.kind} size={16} ghLogin={o.ghLogin} decorative />
              ) : (
                <span className="td-people-none" aria-hidden="true" />
              )}
              <span className="v2-menu-label">{o.label}</span>
              {o.hint ? <span className="v2-menu-hint">{o.hint}</span> : null}
              {o.chip ?? null}
              {o.id === value ? <Icon name="check" cls="v2-ico v2-menu-check" /> : null}
            </div>
          );
        })}
      </div>
    </Popover>
  );
}

/* ============================================================================
   Collab v1 — the task's assigned reviewer (tasks-detail.js reviewerChip +
   tasks-actions.js doReviewer). Advisory (the verify gate stays open to any
   human): the value shows WHO the owner asked to verify — GitHub avatar +
   login for a mapped member, letter avatar + alias otherwise, "Anyone" when
   unset. Owners edit it in place: the value opens a people popover listing
   the container's human MEMBERS (snapshot roster) + an "Anyone" reset, then
   PUT /api/tasks/{tid}/reviewer {reviewer_agent_id|null, actor_agent_id};
   the backend re-validates (owner gate, human-member target).
   Open backends (reviewerSupported false): the caller renders nothing and
   this endpoint is never called.
   ========================================================================== */
/** Who may change a task's reviewer (PUT /api/tasks/{tid}/reviewer): an owner,
 *  or a member holding the `assign_reviewers` grant (mig 039 — the server
 *  accepts it). Viewers / read-only sessions never. Without a resolved
 *  identity (self-host, trust off) the acting human's member_role decides,
 *  permissive when absent (isActingOwner — the backend's trust-off fallback). */
export function canAssignReviewer(identity: { member_role?: string | null; grants?: string[] | null } | null, h: Agent | null, readOnly: boolean): boolean {
  if (readOnly || !h) return false;
  if (identity) {
    if (identity.member_role === "viewer") return false;
    if (identity.member_role === "owner") return true;
    return (identity.grants || []).includes("assign_reviewers");
  }
  return isActingOwner(h);
}

function ReviewerChip({ t }: { t: Task }) {
  const { snap, refresh } = useSnapshot();
  // PS-29: the connection-aware actor (null while offline / read-only)
  const actor = useActor();
  const toast = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // 200 echoes {reviewer: {...}|null} — stamp it locally so the chip
  // re-renders immediately (doReviewer's in-place update, no 3s-poll wait);
  // the next snapshot poll confirms it.
  const [override, setOverride] = useState<{ reviewer: Task["reviewer"]; reviewer_agent_id: string | null } | null>(null);
  const curId = override ? override.reviewer_agent_id : t.reviewer_agent_id;
  const r = reviewerRef({ reviewer: override ? override.reviewer : t.reviewer });
  const { identity } = useSnapshot();
  const authority = useActingAuthority();
  const noHuman = useNoHumanReason();
  const canEdit = canAssignReviewer(identity, actor, authority.readOnly);
  // a viewer is read-only and can't verify — the server refuses them as
  // reviewer (400), so the picker never offers one
  const hs = (snap?.agents ?? []).filter((x) => x.kind === "human" && x.member_role !== "viewer");

  const openPicker = () => {
    if (!actor) {
      toast(noHuman, "danger");
      return;
    }
    setPickerOpen((o) => !o);
  };

  const setReviewer = async (selRev: string) => {
    const h = actor;
    if (!h) return;
    const rid = selRev || null;
    if (String(rid ?? "") === String(curId ?? "")) return; // unchanged — no write
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
      if (!resp.ok) {
        toast("Setting reviewer failed (" + resp.status + ")" + (d.detail ? ": " + d.detail : ""), "danger");
        return;
      }
      setOverride({ reviewer: d.reviewer || null, reviewer_agent_id: d.reviewer ? d.reviewer.agent_id || null : null });
      toast(d.reviewer ? "Reviewer set — " + (d.reviewer.github_login || d.reviewer.alias) : "Reviewer cleared — anyone may verify", "ok");
      void refresh();
    } catch {
      toast("Setting reviewer failed — network error.", "danger");
    }
  };

  const value = !r ? (
    <span className="v2-muted">Anyone</span>
  ) : (
    <>
      <Avatar alias={r.alias || r.github_login} kind="human" size="sm" ghLogin={r.github_login} decorative />
      <span title={reviewerTitle(r)}>{reviewerName(r)}</span>
    </>
  );
  if (!canEdit) {
    return (
      <span className="td-rev" title={!r ? "No reviewer assigned — any human member may verify" : undefined}>
        {value}
      </span>
    );
  }
  return (
    <span className="td-rev">
      <button
        ref={btnRef}
        type="button"
        className="td-prop-btn"
        data-act="reviewer"
        title="Change reviewer"
        aria-label={"Change reviewer" + (r ? " (" + reviewerName(r) + ")" : " (anyone)")}
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        onClick={openPicker}
      >
        {value}
      </button>
      <PeopleMenu
        anchor={btnRef}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        label="Reviewer"
        value={curId != null ? String(curId) : ""}
        options={[
          { id: "", label: "Anyone", hint: "any member" },
          ...hs.map((x) => ({ id: String(x.id), label: x.github_login || x.alias, alias: x.alias, kind: "human", ghLogin: x.github_login })),
        ]}
        onPick={(id) => void setReviewer(id)}
      />
    </span>
  );
}

/* ============================================================================
   Runs for a task — ONE fetch per snapshot bump shared by the verification
   evidence, the activity timeline and the Runs tab
   (GET /api/tasks/{tid}/runs). Stale responses for a previous task are dropped
   (request-id ref); an unchanged run signature keeps the existing state object
   so streams/log DOM are left alone.
   ========================================================================== */
export interface RunsState {
  runs: Run[];
  failed: boolean;
}
export function useTaskRuns(tid: string | null): RunsState | null {
  const { bump } = useSnapshot();
  const [state, setState] = useState<RunsState | null>(null);
  const sigRef = useRef("");
  const paintedRef = useRef(false);
  const tokRef = useRef(0);

  useEffect(() => {
    sigRef.current = "";
    paintedRef.current = false;
    setState(null);
  }, [tid]);

  useEffect(() => {
    if (!tid) return;
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
  return state;
}

const runStart = (r: Run) => Date.parse(r.started_at || r.started || "") || 0;
function killCause(kr: string | null | undefined): string {
  try {
    return ((JSON.parse(kr || "") as { cause?: string }) || {}).cause || "";
  } catch {
    return "";
  }
}
/** The exact run label (#299 honesty: a human-stopped run reads "Stopped",
 *  only a watchdog kill reads "Watchdog-killed"). */
function runLabel(run: Run, stopReq = false): string {
  if (run.status === "running") return stopReq ? "Stopping" : "Running";
  if (run.status === "killed") return killCause(run.kill_reason) === "human_stop" ? "Stopped" : "Watchdog-killed";
  const l = statusMeta(run.status).l;
  return l ? l.charAt(0).toUpperCase() + l.slice(1) : run.status;
}
/** Run status → the shared glyph vocabulary (D8). */
function runGlyphStatus(run: Run): string {
  if (run.status === "running") return "working";
  // an exited run is only a success glyph with a clean exit — exit ≠ 0 reads failed
  if (run.status === "exited") return run.exit_code != null && run.exit_code !== 0 ? "failed" : "completed";
  if (run.status === "completed") return "completed";
  // a human stop is a cancellation, not a failure (matches activity/runModel)
  if (run.status === "killed") return killCause(run.kill_reason) === "human_stop" ? "cancelled" : "failed";
  if (run.status === "failed") return "failed";
  return run.status;
}

const EVIDENCE_CAVEAT = "A run exiting successfully is not proof the task is done — compare the result with the definition of done.";

/** Verification evidence as ONE "·"-joined line (D12):
 *  "✓ Completed · exit 0 · 42m ago · 3 runs · Open runs". The "a clean exit is
 *  not proof" caveat lives behind the gate's help mark. The code-changes
 *  disclosure is a full-view / Needs detail extra — the narrow inspector keeps
 *  the one line and reaches the diff through "Open runs". */
function VerifyEvidence({ t, runs, onOpenRuns, noDiff }: { t: Task; runs: RunsState | null | undefined; onOpenRuns?: () => void; noDiff?: boolean }) {
  // General mode words run output as changes, not code (lib/projectMode.ts)
  const words = modeWords(useProjectMode(useSnapshot().cid).mode);
  if (runs === undefined) return null;
  const openRuns = onOpenRuns ? (
    <Button variant="link" size="sm" className="td-ev-part td-ev-link" onClick={onOpenRuns}>Open runs</Button>
  ) : (
    <ButtonLink variant="link" size="sm" className="td-ev-part td-ev-link" to={"/tasks?task=" + encodeURIComponent(t.id) + "&tab=runs"}>Open runs</ButtonLink>
  );
  let body: ReactNode;
  if (runs === null) body = <span className="v2-muted">Loading run evidence…</span>;
  else if (runs.failed) body = <span className="v2-muted">Run evidence unavailable — the run feed could not be loaded.</span>;
  else if (!runs.runs.length) body = <span className="v2-muted">No runs recorded for this task.</span>;
  else {
    const sorted = runs.runs.slice().sort((a, b) => runStart(b) - runStart(a));
    const latest = sorted[0];
    const withDiff = sorted.find((r) => r.diff != null && r.diff !== "");
    const ended = latest.ended_at || latest.ended;
    const started = latest.started_at || latest.started;
    const exit = latest.exit_code != null && latest.status !== "running" ? "exit " + latest.exit_code : "";
    const when = ended ? relTime(ended) : started ? "started " + relTime(started) : "";
    const whenTitle = ended ? "Latest run ended " + clockTime(ended) : started ? "Latest run started " + clockTime(started) : undefined;
    body = (
      <>
        <span className="td-ev-line" title={"Latest run: " + runLabel(latest) + (exit ? " · " + exit : "")}>
          <span className="td-ev-part td-ev-status">
            <StatusIcon status={runGlyphStatus(latest)} size={12} decorative />
            <span>{runLabel(latest)}</span>
          </span>
          {exit ? <span className="v2-muted td-ev-part">{exit}</span> : null}
          {when ? <span className="v2-muted td-ev-part" title={whenTitle}>{when}</span> : null}
          <span className="v2-muted td-ev-part">{runs.runs.length} run{runs.runs.length === 1 ? "" : "s"}</span>
          {!withDiff ? <span className="v2-muted td-ev-part">{words.noRunChanges}</span> : null}
          {openRuns}
        </span>
        {withDiff && !noDiff ? (
          <details className="wk-evidence-diff td-ev-diff">
            <summary>
              <Icon name="chev" cls="v2-ico wk-disc-chev" />
              {withDiff === latest ? words.runChanges : words.runChanges + " (earlier run)"}
            </summary>
            <div style={{ marginTop: 8 }}>
              <FilesChanged diff={withDiff.diff} blobSource={runBlobSource(withDiff)} />
            </div>
          </details>
        ) : null}
      </>
    );
  }
  return (
    <div className="td-g-row wk-evidence" aria-label="Run evidence">
      <span className="td-g-k">Evidence</span>
      <div className="td-g-v">{body}</div>
    </div>
  );
}

/* ============================================================================
   Gate card — plan-approval (B10) OR verify (Epic B), gated on plan_decision
   (ISS-41). A compact card near the top (D10/D12): title line, result/plan +
   definition of done as two short labeled lines, run evidence as one line,
   Reject (secondary) / Accept (primary) right-aligned. Reject REQUIRES a typed
   reason; plan-approve may carry an OPTIONAL answer (ISS-59). A failed
   decision keeps every typed input and shows the server's reason inline; only
   success clears input and marks the task acted (onActed).
   ========================================================================== */
export function GateSurface({
  t,
  acted,
  onActed,
  runs,
  onOpenRuns,
  onDecision,
  compact,
  onReview,
  noDiff,
}: {
  t: Task;
  acted: boolean;
  onActed: (id: string) => void;
  runs?: RunsState | null;
  onOpenRuns?: () => void;
  /** optional: which decision succeeded (Needs-you history) — called before onActed */
  onDecision?: (outcome: string) => void;
  /** one-line reminder bar instead of the full gate */
  compact?: boolean;
  /** compact bar's "Review" action (switches to the view holding the full gate) */
  onReview?: () => void;
  /** narrow inspector: evidence stays ONE line (no code-changes disclosure) */
  noDiff?: boolean;
}) {
  const { snap, refresh } = useSnapshot();
  // PS-29: the connection-aware actor (null while offline / read-only)
  const actor = useActor();
  const toast = useToast();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const reasonBoxRef = useRef<HTMLDivElement | null>(null);
  const noHuman = useNoHumanReason();

  // mig 057: an AI manager sent the finished work back — a person may still accept it
  if (t.status === "in_progress" && t.manager_review?.status === "sent_back" && !acted) {
    return (
      <ManagerSentBackNote
        t={t}
        why={actor ? null : noHuman}
        onAccept={async () => {
          if (!actor) return false;
          let r: { ok: boolean; status: number; d: { detail?: unknown } };
          try {
            r = await post("/api/tasks/" + encodeURIComponent(t.id) + "/verify", { approve: true, actor_agent_id: actor.id });
          } catch {
            r = { ok: false, status: 0, d: { detail: "network error — the portal could not be reached" } };
          }
          if (!r.ok) {
            const det = detailText(r.d);
            toast("Not accepted — " + (r.status ? "HTTP " + r.status : "not sent") + (det ? ": " + det : ""), "danger");
            return false;
          }
          toast("Accepted", "ok");
          onDecision?.("Accepted");
          onActed(t.id);
          void refresh();
          return true;
        }}
      />
    );
  }

  // decided plan -> quiet decided-note, never a live re-approve
  if (t.status === "in_progress" && t.plan_decision) {
    const pd = t.plan_decision;
    const ok = pd.decision === "approve";
    return (
      <div className="wk-decided td-decided" data-kind="plan-decided">
        <span className={ok ? "wk-ok" : "wk-bad"}>
          <Icon name={ok ? "check" : "x"} cls="v2-ico" />
        </span>
        <div className="v2-grow">
          <span className="wk-dt">Plan {ok ? "approved" : "rejected"}</span>
          <span className="wk-dm">
            {pd.actor ? " by " + pd.actor : ""}
            {pd.at ? " · " + relTime(pd.at) : ""}
            {pd.reason ? " — " + trunc(pd.reason, 140) : ""}
          </span>
        </div>
      </div>
    );
  }
  if (acted) return null; // optimistic: just acted this session, snapshot catching up
  const isPlan = pendingPlan(t);
  const isVerify = t.status === "needs_verification";
  if (!isPlan && !isVerify) return null;
  const pm = isPlan ? planMessageOf(t) : null;
  const h = actor;
  const disabled = !h || busy;
  const author = isPlan && pm?.from ? agentByAlias(snap, pm.from) : null;
  const whoName = t.assignee || "the assignee";
  const level = autLevel(snap);
  // a plan is gated by its author's (else the assignee's) EFFECTIVE autonomy
  // — per-agent overrides included — the same rule as Needs you / Overview
  const planLevel = isPlan ? agentAutonomy(snap, author || agentByAlias(snap, t.assignee)) : level;
  const gatedOff = isPlan ? !planAwaitsHuman(snap, t) : level === "full";

  const submit = async (approve: boolean, reasonTxt: string) => {
    if (!actor) {
      toast(noHuman, "danger");
      return;
    }
    setBusy(true);
    setError(null);
    let r: { ok: boolean; status: number; d: { detail?: unknown } };
    try {
      r = isPlan
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
    } catch {
      r = { ok: false, status: 0, d: { detail: "network error — the portal could not be reached" } };
    }
    setBusy(false);
    // success toasts only: a failure is shown inline ("Decision not recorded"),
    // never twice
    if (r.ok) {
      toast(isPlan ? (approve ? "Plan approved" : "Changes requested") : approve ? "Accepted" : "Rejected — returned", "ok");
      // hide the item on every attention surface (sidebar, bell, tab counts,
      // Needs you) at once — the next snapshot confirms
      markAttentionDecided((isPlan ? "plan:" : "verify:") + t.id);
    }
    if (r.ok) {
      setReason("");
      setReasonOpen(false);
      setAnswer("");
      setConfirmOpen(false);
      onDecision?.(isPlan ? (approve ? "Plan approved" : "Changes requested") : approve ? "Accepted" : "Rejected — returned");
      onActed(t.id);
      void refresh();
    } else {
      // a failed decision keeps the typed reason / answer and stays in place
      const det = detailText(r.d);
      setError((r.status ? "HTTP " + r.status : "Not sent") + (det ? " — " + det : ""));
    }
  };

  // e2e-permissions-34: "your approval" only when the actor can give it (a viewer /
  // non-member reads the neutral title; the buttons carry the reason)
  const gateTitle = isPlan ? (h ? "Plan awaiting your approval" : "Plan awaiting approval") : "Awaiting verification";
  const glyph = isPlan ? <Icon name="flag" cls="v2-ico" /> : <StatusGlyph status="needs_verification" size={14} />;

  if (compact) {
    return (
      <div className="wk-gate wk-gate-compact gate" id={"gate-" + t.id} data-task={t.id} data-kind={isPlan ? "plan" : "verify"} role="region" aria-label={isPlan ? "Plan approval" : "Verification"}>
        <span className="wk-gate-t">
          <span className="td-g-ico" aria-hidden="true">{glyph}</span>
          {gateTitle}
        </span>
        <span className="wk-gate-sub">{isPlan ? "Approving lets " + whoName + " execute." : "Result claimed by " + whoName + "."}</span>
        <span className="v2-grow" />
        {onReview ? (
          <Button variant="secondary" size="sm" iconRight="arrow" onClick={onReview}>
            {isPlan ? (h ? "Review plan" : "View plan") : h ? "Review result" : "View result"}
          </Button>
        ) : null}
      </div>
    );
  }

  const openReject = () => {
    setError(null);
    setReasonOpen(true);
    // the inline form opens below the fold in a narrow pane: bring it into view
    // and put the caret in the (required) reason field.
    requestAnimationFrame(() => {
      reasonBoxRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      reasonRef.current?.focus({ preventScroll: true });
    });
  };

  // D12: no age here — the list row and the activity timeline already carry it
  const byLine = isPlan ? (pm?.from ? "by " + pm.from : "") : "claimed by " + whoName;
  const consequence = isPlan
    ? "Approving lets " + whoName + " execute."
    : "Accepting marks the task completed. Rejecting returns it to " + whoName + ".";
  const audit = h ? " Logged to the audit trail as " + h.alias + "." : "";
  const optionalNote = gatedOff ? "Optional at the “" + planLevel + "” autonomy level — not required, but you can still decide." : "";
  const helpText = [isVerify ? EVIDENCE_CAVEAT : "", optionalNote].filter(Boolean).join(" ");

  return (
    <div className="wk-gate gate td-gate" id={"gate-" + t.id} data-task={t.id} data-kind={isPlan ? "plan" : "verify"} role="region" aria-label={isPlan ? "Plan approval" : "Verification"}>
      <div className="wk-gate-h">
        <span className="td-g-ico" aria-hidden="true">{glyph}</span>
        <span className="wk-gate-t">{gateTitle}</span>
        {byLine ? <span className="td-g-by">{byLine}</span> : null}
        <span className="v2-grow" />
        {/* D12: the autonomy note + evidence caveat live behind ONE help mark
            (no header chip that wraps the title line) */}
        {helpText ? (
          <>
            <IconButton icon="help" size="sm" label={helpText} title={helpText} className="td-g-help" />
            <span className="v2-sr">{helpText}</span>
          </>
        ) : null}
      </div>
      <div className="td-g-rows">
        {isVerify ? <EvidencePack taskId={t.id} actorId={actor ? String(actor.id) : null} noActorReason={noHuman} defaultOpen={!noDiff} /> : null}
        <div className="td-g-row field">
          <span className="td-g-k">{isPlan ? "Plan" : "Result"}</span>
          <div className="td-g-v tx">
            {/* open-orcha#209: task.result is JSONB — normalized by ResultView, never raw JSON */}
            {isPlan ? <ClampedMd text={stripPlanHeading(pm?.body || "")} tasks={snap?.tasks} what="plan" /> : <ResultView r={t.result} tasks={snap?.tasks} />}
          </div>
        </div>
        <div className="td-g-row field">
          <span className="td-g-k">Done when</span>
          <div className="td-g-v">
            <Md className="dod wk-md" text={t.definition_of_done || "—"} tasks={snap?.tasks} />
          </div>
        </div>
        {/* mig 057: who reviews and why (manager chain) + the AI manager's pre-review */}
        {isVerify ? <ReviewRouteRow t={t} /> : null}
        {isVerify ? <VerifyEvidence t={t} runs={runs} onOpenRuns={onOpenRuns} noDiff={noDiff} /> : null}
        {isVerify ? <DeliverablesEvidence tid={t.id} noDiff={noDiff} /> : null}
      </div>
      <div className="wk-actions actions td-g-actions">
        {!h ? <span className="wk-conseq td-g-why">{noHuman}</span> : <span className="v2-grow" />}
        <Button
          variant="secondary"
          size="sm"
          data-act="reject"
          disabled={disabled}
          title={!h ? noHuman : isPlan ? "Send the plan back with the changes you want" : "Return the task to " + whoName + " with a reason"}
          aria-expanded={reasonOpen}
          aria-controls={"reason-" + t.id}
          onClick={openReject}
        >
          {isPlan ? "Request changes…" : "Reject…"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          data-act="approve"
          disabled={disabled || reasonOpen}
          title={!h ? noHuman : reasonOpen ? "Finish or cancel the rejection first" : consequence + audit}
          icon="check"
          onClick={() => {
            setError(null);
            setConfirmOpen(true);
          }}
        >
          {isPlan ? "Approve plan" : "Accept"}
        </Button>
      </div>
      {error && !confirmOpen ? (
        <div className="wk-err" role="alert">
          <b>Decision not recorded.</b> {error}. Your input is kept — fix the issue and try again.
        </div>
      ) : null}
      <div className={"reason" + (reasonOpen ? " show" : "")} id={"reason-" + t.id} ref={reasonBoxRef}>
        <label className="wk-reason-lbl" htmlFor={"rt-" + t.id}>
          {isPlan ? "What should change? (required)" : "Why are you rejecting? (required)"}
        </label>
        <textarea
          id={"rt-" + t.id}
          ref={reasonRef}
          placeholder={whoName + " sees this verbatim on the next wake."}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="wk-actions td-g-actions">
          <span className="v2-grow" />
          <Button
            variant="ghost"
            size="sm"
            data-act="cancel-reject"
            onClick={() => {
              setReasonOpen(false);
              setReason("");
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            data-act="confirm-reject"
            id={"cr-" + t.id}
            disabled={!reason.trim() || busy}
            busy={busy && reasonOpen && !confirmOpen}
            onClick={() => {
              const r = reason.trim();
              if (!r) return; // a typed reason is REQUIRED
              void submit(false, r);
            }}
          >
            {isPlan ? "Request changes" : "Submit rejection"}
          </Button>
        </div>
      </div>
      {confirmOpen && (
        <Dialog
          title={isPlan ? "Approve this plan?" : "Accept this task?"}
          description={
            isPlan
              ? whoName + " will be cleared to execute."
              : "Marks the task completed and unblocks anything waiting on it."
          }
          onClose={() => {
            if (!busy) setConfirmOpen(false);
          }}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" busy={busy} onClick={() => void submit(true, isPlan ? answer : "")}>
                {isPlan ? "Approve plan" : "Accept"}
              </Button>
            </>
          }
        >
          {isPlan ? (
            <textarea
              id={"ans-" + t.id}
              className="ans-in"
              style={{ minHeight: 64 }}
              aria-label="Answer / additional info for the agent (optional)"
              title="Sent to the agent with the approval"
              placeholder="Add guidance for the agent (optional)"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          ) : undefined}
          {error ? (
            <div className="wk-err" role="alert">
              <b>Decision not recorded.</b> {error}. {isPlan ? "Your guidance is kept." : ""}
            </div>
          ) : null}
        </Dialog>
      )}
    </div>
  );
}

/* ============================================================================
   SPEC-4 protocol panel — the hand-off rules on the task itself, as a rail
   section. [Edit] is human-authority only -> PATCH /api/tasks/{tid}/protocol
   (partial merge; echoes the full merged protocol).
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
  // PS-29: the connection-aware actor (null while offline / read-only)
  const actor = useActor();
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Required<Proto> | null>(null);
  const [saving, setSaving] = useState(false);
  // 200 echoes {task_id, protocol:{full merged}} — stamp it locally so the
  // panel re-renders immediately; the next snapshot poll confirms it.
  const [override, setOverride] = useState<Proto | null>(null);
  const p: Proto = override ?? ((t.protocol as Proto | null) || {});
  const canEdit = !!actor;
  const noHuman = useNoHumanReason();

  const startEdit = () => {
    if (!actor) {
      toast(noHuman, "danger");
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
    const h = actor;
    if (!h || !draft) return;
    setSaving(true);
    // PARTIAL merge (Ledger contract): send all four; "" clears a key.
    let r: { ok: boolean; status: number; d: { protocol?: unknown; detail?: unknown } };
    try {
      r = await patchReq("/api/tasks/" + encodeURIComponent(t.id) + "/protocol", {
        actor_agent_id: h.id,
        review_chain: draft.review_chain,
        handoff_to: draft.handoff_to,
        autonomy: draft.autonomy,
        notes: draft.notes,
      });
    } catch {
      r = { ok: false, status: 0, d: {} };
    }
    setSaving(false);
    if (r.ok) {
      setEditing(false);
      setDraft(null);
      if (r.d && r.d.protocol) setOverride(r.d.protocol as Proto);
      toast("Protocol saved", "ok");
      void refresh();
      return;
    }
    // failure keeps the edit open with the draft intact
    toast("Save failed (" + r.status + ")" + (detailText(r.d) ? ": " + detailText(r.d) : ""), "danger");
  };

  if (protoEmpty(override ?? (t.protocol as Proto | null)) && !editing) {
    return (
      <section className="v2-rail-sec td-proto is-empty" id={"proto-" + t.id} data-task={t.id} aria-label="Protocol">
        <div className="v2-rail-sec-h">
          <h3 className="v2-rail-sec-title" title="Hand-off rules the assignee reads on wake">Protocol</h3>
          {canEdit ? (
            <span className="v2-rail-sec-actions">
              <Button variant="ghost" size="sm" icon="plus" data-pact="set" onClick={startEdit}>
                Set
              </Button>
            </span>
          ) : null}
        </div>
        <p className="td-rail-note" title="No protocol set on this task — the assignee follows the project defaults.">Project defaults</p>
      </section>
    );
  }

  const d = editing ? draft || { review_chain: "", handoff_to: "", autonomy: "", notes: "" } : null;
  const cls = "proto v2-rail-sec td-proto" + (collapsed && !editing ? " collapsed" : "") + (editing ? " editing" : "");
  const setField = (k: keyof Proto, v: string) => setDraft((prev) => ({ ...(prev || { review_chain: "", handoff_to: "", autonomy: "", notes: "" }), [k]: v }));
  const row = (label: string, key: keyof Proto, isNotes: boolean) => {
    const display: ReactNode =
      key === "review_chain" ? (
        <span className="arrowchain">{p.review_chain || "—"}</span>
      ) : key === "handoff_to" ? (
        <span title={p.handoff_to ? "The assignee returns here first when done" : undefined}>{p.handoff_to || "—"}</span>
      ) : key === "notes" ? (
        <Linkified text={p.notes || "—"} tasks={snap?.tasks} />
      ) : (
        <>{p[key] || "—"}</>
      );
    return (
      <div className={"prow" + (isNotes ? " is-notes" : "")}>
        <span className="k">{label}</span>
        <span className={"v" + (isNotes ? " notes" : "")}>{display}</span>
        <div className="edit">
          {isNotes ? (
            <textarea data-pfield={key} aria-label={label} value={d ? d[key] || "" : ""} onChange={(e) => setField(key, e.target.value)} />
          ) : (
            <input data-pfield={key} aria-label={label} value={d ? d[key] || "" : ""} onChange={(e) => setField(key, e.target.value)} />
          )}
        </div>
      </div>
    );
  };

  return (
    <section className={cls} id={"proto-" + t.id} data-task={t.id} aria-label="Protocol">
      <div className="v2-rail-sec-h ph">
        <button
          type="button"
          className="td-proto-toggle"
          data-pact="toggle"
          aria-expanded={!collapsed || editing}
          title={collapsed ? "Expand protocol" : "Collapse protocol"}
          onClick={() => {
            if (!editing) setCollapsed((c) => !c);
          }}
        >
          <h3 className="v2-rail-sec-title">Protocol</h3>
          <Icon name="chev" cls="v2-ico td-chev" />
        </button>
        {/* collapsed summary: the two chips carry the protocol at a glance */}
        {collapsed && !editing && (p.handoff_to || p.autonomy) ? (
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
        {canEdit && !editing ? (
          <span className="v2-rail-sec-actions">
            <Button variant="ghost" size="sm" icon="pencil" className="editbtn" data-pact="edit" onClick={startEdit}>
              Edit
            </Button>
          </span>
        ) : null}
      </div>
      <div className="pb">
        {row("Review chain", "review_chain", false)}
        {row("Hand-off to", "handoff_to", false)}
        {row("Autonomy", "autonomy", false)}
        {row("Notes", "notes", true)}
      </div>
      <div className="pf">
        <Button
          variant="ghost"
          size="sm"
          data-pact="cancel"
          onClick={() => {
            setEditing(false);
            setDraft(null);
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" size="sm" data-pact="save" busy={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save protocol"}
        </Button>
      </div>
    </section>
  );
}

/* ============================================================================
   Activity — the Linear issue timeline + composer. Events come ONLY from real
   timestamps (created, started, plan decision, each run, closed); the thread
   renders as comment cards (consecutive messages share one card). ISS-68
   lazy thread with the PR-3 "Load earlier" cap, GH #74 error latch + Retry,
   #301/#330 attachment staging (upload-then-reference), and the live-lease
   composer lock.
   ========================================================================== */
const tms = (iso: string) => Date.parse(iso) || 0;
type ActItem =
  | { k: "event"; at: string; key: string; node: ReactNode }
  | { k: "msg"; at: string; key: string; m: ThreadMsg };

/** Backend marker messages the thread carries as plain text:
 *   decision_routing.py        "[DECISION · <subject> = APPROVED|REJECTED by <alias>]( — <reason>)"
 *   task_verification_routes   "[verification rejected] <feedback>"
 *   verdikt_autofix (mig 068)  "[Verdikt auto-fix] Verdikt failed this task on attempt N of M …"
 *                              "[Verdikt auto-fix] Stopped: <reason>"
 *  Parsed into structured timeline events (D12) instead of comment cards. */
export type ThreadMarker =
  | { kind: "decision"; subject: string; approved: boolean; actor: string | null; reason: string }
  | { kind: "verify_rejected"; feedback: string }
  | { kind: "verify_approved"; feedback: string }
  | { kind: "autofix_rework"; attempt: number; max: number; detail: string }
  | { kind: "autofix_stopped"; reason: string };
export function parseThreadMarker(body: string | null | undefined): ThreadMarker | null {
  const b = String(body || "");
  const af = /^\[Verdikt auto-fix\]\s*([\s\S]*)$/.exec(b.trim());
  if (af) {
    const rest = af[1].trim();
    const st = /^Stopped:\s*([\s\S]*)$/.exec(rest);
    if (st) return { kind: "autofix_stopped", reason: st[1].trim() };
    const n = /attempt (\d+) of (\d+)/.exec(rest);
    const fc = rest.indexOf("Failed criteria:");
    // the failed criteria (expected vs actual) — links stay in the agent's copy, not the timeline
    const detail = (fc >= 0 ? rest.slice(fc + "Failed criteria:".length) : rest.split("\n").slice(2).join("\n")).split("\n\n")[0]
      .split("\n").filter((l) => !/^\s*(Screenshot|Other screenshots):/.test(l)).join("\n").trim();
    return { kind: "autofix_rework", attempt: n ? Number(n[1]) : 0, max: n ? Number(n[2]) : 0, detail };
  }
  const d = /^\[DECISION · ([\w-]+) = (APPROVED|REJECTED) by ([^\]]+)\](?:\s+—\s+([\s\S]*))?$/.exec(b.trim());
  if (d) {
    const actor = d[3].trim();
    return { kind: "decision", subject: d[1], approved: d[2] === "APPROVED", actor: actor && actor !== "a human" ? actor : null, reason: (d[4] || "").trim() };
  }
  const v = /^\[verification rejected\]\s*([\s\S]*)$/.exec(b.trim());
  if (v) return { kind: "verify_rejected", feedback: v[1].trim() };
  const ok = /^\[verification approved\]\s*([\s\S]*)$/.exec(b.trim());
  if (ok) return { kind: "verify_approved", feedback: ok[1].trim() };
  return null;
}
/** The most recent "[verification rejected] …" message, if any. */
export function latestRejection(msgs: ThreadMsg[]): { feedback: string; at: string } | null {
  let best: { feedback: string; at: string } | null = null;
  for (const m of msgs) {
    const mk = parseThreadMarker(m.body);
    if (mk && mk.kind === "verify_rejected" && (!best || tms(m.at || "") >= tms(best.at))) best = { feedback: mk.feedback, at: m.at || "" };
  }
  return best;
}
/** A decision marker as a one-line timeline event. `author` is the message's
 *  author alias — parity r2: the backend now attributes the verification note to
 *  the verifying human (task_verification_routes), so the line names them. */
function markerEventNode(mk: ThreadMarker, at: string, author?: string | null): ReactNode {
  if (mk.kind === "autofix_rework" || mk.kind === "autofix_stopped") {
    // the system identity (system:verdikt), never a person
    const who = <span className="td-tl-who">Verdikt auto-fix</span>;
    if (mk.kind === "autofix_stopped") {
      return <TimelineEvent icon={/^Verdikt passed/.test(mk.reason) ? "check" : "alert"} actor={who} at={at} body={mk.reason} bodyLines={2}>stopped</TimelineEvent>;
    }
    return (
      <TimelineEvent icon="x" actor={who} at={at} body={mk.detail || undefined} bodyLines={2}>
        sent it back to the agent — Verdikt failed attempt {mk.attempt || "?"} of {mk.max || "?"}
      </TimelineEvent>
    );
  }
  if (mk.kind === "verify_rejected" || mk.kind === "verify_approved") {
    const by = author && author !== "system" ? author : null;
    const rej = mk.kind === "verify_rejected";
    const verb = rej ? (by ? "rejected the verification — changes requested" : "Verification rejected — changes requested") : by ? "accepted the work" : "Verification accepted";
    return (
      <TimelineEvent icon={rej ? "x" : "check"} actor={by ? <span className="td-tl-who">{by}</span> : null} at={at} body={mk.feedback ? "“" + trunc(mk.feedback, 240) + "”" : undefined} bodyLines={2}>
        {verb}
      </TimelineEvent>
    );
  }
  const plan = mk.subject === "plan_approval";
  const verb = plan ? (mk.approved ? "approved the plan" : "requested changes to the plan") : (mk.approved ? "approved" : "rejected") + " " + mk.subject.replace(/_/g, " ");
  return (
    <TimelineEvent icon={mk.approved ? "check" : "x"} actor={mk.actor ? <span className="td-tl-who">{mk.actor}</span> : null} at={at}>
      {mk.actor ? verb : verb.charAt(0).toUpperCase() + verb.slice(1)}
      {mk.reason ? <> — “{trunc(mk.reason, 120)}”</> : null}
    </TimelineEvent>
  );
}

function taskEvents(t: Task, runs: Run[], snap: Snapshot | null, opts: { planMarkers?: boolean } = {}): ActItem[] {
  const out: ActItem[] = [];
  // Linear: ONE icon per event line — the event's glyph sits on the connector,
  // so the actor is its name only (no second inline avatar)
  const who = (alias: string | null | undefined) =>
    alias ? (
<span className="td-tl-who">{alias}</span>
    ) : null;
  if (t.created_at) {
    const creator = creatorOf(t, snap);
    out.push({
      k: "event",
      at: t.created_at,
      key: "created",
      node: (
        <TimelineEvent icon="plus" actor={who(creator)} at={t.created_at}>
          {creator ? "created the task" : "Task created"}
        </TimelineEvent>
      ),
    });
  }
  if (t.started_at) {
    out.push({
      k: "event",
      at: t.started_at,
      key: "started",
      node: (
        <TimelineEvent glyph={<StatusGlyph status="in_progress" size={14} />} at={t.started_at}>
          Work started
        </TimelineEvent>
      ),
    });
  }
  const pd = t.plan_decision;
  // the thread's own "[DECISION · plan_approval …]" markers carry the full
  // decision history — then the snapshot's latest decision would repeat one
  if (pd && pd.at && !opts.planMarkers) {
    const ok = pd.decision === "approve";
    out.push({
      k: "event",
      at: pd.at,
      key: "plan",
      node: (
        <TimelineEvent icon={ok ? "check" : "x"} actor={who(pd.actor)} at={pd.at}>
          {ok ? "approved the plan" : "requested changes to the plan"}
          {pd.reason ? <> — “{trunc(pd.reason, 120)}”</> : null}
        </TimelineEvent>
      ),
    });
  }
  for (const r of runs) {
    const at = r.started_at || r.started;
    if (!at) continue;
    const runner = r.agent || (r.agent_id ? (snap?.agents ?? []).find((a) => String(a.id) === String(r.agent_id))?.alias : null) || null;
    const exit = r.exit_code != null && r.status !== "running" ? " · exit " + r.exit_code : "";
    out.push({
      k: "event",
      at,
      key: "run-" + (r.run_id || r.id || at),
      node: (
        <TimelineEvent glyph={<StatusGlyph status={runGlyphStatus(r)} size={14} />} actor={who(runner)} at={at}>
          {runner ? "started a run" : "A run started"} — <b>{runLabel(r, stopRequestedRuns.has(r.run_id || r.id || ""))}</b>
          {exit}
        </TimelineEvent>
      ),
    });
  }
  if (t.completed_at && (t.status === "completed" || t.status === "cancelled")) {
    out.push({
      k: "event",
      at: t.completed_at,
      key: "closed",
      node: (
        <TimelineEvent glyph={<StatusGlyph status={t.status} size={14} />} at={t.completed_at}>
          {t.status === "cancelled" ? "Cancelled" : "Marked "}
          {t.status === "cancelled" ? null : <b>Completed</b>}
        </TimelineEvent>
      ),
    });
  }
  return out;
}
/** sessionStorage key prefix for a task's unsent comment draft. */
export const TASK_DRAFT_PREFIX = "orcha:v2:taskDraft:";

function ThreadCard({
  t,
  msgs,
  loading,
  errored,
  onRetry,
  runs,
  planAbove = false,
}: {
  t: Task;
  msgs: ThreadMsg[];
  loading: boolean;
  errored: boolean;
  onRetry: () => void;
  runs: RunsState | null;
  /** the plan message is already rendered above (gate card / plan disclosure) */
  planAbove?: boolean;
}) {
  const { snap, refresh } = useSnapshot();
  // PS-29: the connection-aware actor (null while offline / read-only)
  const actor = useActor();
  const toast = useToast();
  const [shown, setShown] = useState(THREAD_SHOWN);
  // an unsent comment survives a project switch / navigation (per task,
  // this browser tab only); cleared once it posts
  const draftKey = TASK_DRAFT_PREFIX + t.id;
  const [text, setTextState] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) || "";
    } catch {
      return "";
    }
  });
  const setText = (v: string | ((cur: string) => string)) =>
    setTextState((cur) => {
      const next = typeof v === "function" ? v(cur) : v;
      try {
        if (next.trim()) sessionStorage.setItem(draftKey, next);
        else sessionStorage.removeItem(draftKey);
      } catch {
        /* private mode */
      }
      return next;
    });
  const [posting, setPosting] = useState(false);
  const [staged, setStaged] = useState<StagedAtt[]>([]);
  const [dragover, setDragover] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const seqRef = useRef(0);
  const postingRef = useRef(false);
  const noHuman = useNoHumanReason();

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
  const h = actor;

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
    if (postingRef.current) return;
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
      toast(noHuman, "danger");
      return;
    }
    const atts = done.map((s) => ({ id: s.ref!.id, name: s.ref!.name }));
    // Match the Conversation composer: move the submitted draft out of the
    // editable controls before awaiting the network. A person can immediately
    // begin a follow-up without the older request later clearing that new work.
    const submittedStaged = staged;
    setText("");
    setStaged([]);
    postingRef.current = true;
    setPosting(true);
    try {
      const r = await post("/api/tasks/" + encodeURIComponent(t.id) + "/messages", {
        body: v,
        author_agent_id: h.id,
        attachments: atts.length ? atts : undefined,
      });
      if (r.ok) {
        toast("Comment posted", "ok");
        void refresh();
      } else {
        setText((current) => current.trim() ? current : v);
        setStaged((current) => current.length ? current : submittedStaged);
        // VB4: the 422 body-cap (and any other rejection) surfaces its explicit detail.
        const det = detailText(r.d);
        toast("Failed (" + r.status + ")" + (det ? ": " + det : ""), "danger");
      }
    } catch {
      setText((current) => current.trim() ? current : v);
      setStaged((current) => current.length ? current : submittedStaged);
      toast("Couldn't reach the portal — your comment is still in the composer.", "danger");
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  };

  const startIdx = Math.max(0, msgs.length - shown);
  const visible = msgs.slice(startIdx);
  // events older than the first revealed message stay behind "Load earlier" too
  const cutoff = startIdx > 0 && visible.length ? tms(visible[0].at) : -Infinity;
  const planMarkers = msgs.some((m) => {
    const mk = parseThreadMarker(m.body);
    return !!mk && mk.kind === "decision" && mk.subject === "plan_approval";
  });
  const pmAbove = planAbove ? planMessageOf(t) : null;
  const isPlanMsg = (m: ThreadMsg) => !!pmAbove && !m.is_human && m.from === pmAbove.from && m.body === pmAbove.body;
  const msgItem = (m: ThreadMsg, i: number): ActItem => {
    const key = m.id || "m" + (startIdx + i);
    const at = m.at || "";
    const mk = parseThreadMarker(m.body);
    if (mk) return { k: "event", at, key: "mk-" + key, node: markerEventNode(mk, at, m.from) };
    if (isPlanMsg(m)) {
      // the plan is shown above — one muted line here, never the text twice (D12)
      return {
        k: "event",
        at,
        key: "plan-" + key,
        node: (
          <TimelineEvent icon="flag" actor={<span className="td-tl-who">{m.from}</span>} at={at || null}>
            posted the plan <span className="v2-muted">· shown above</span>
          </TimelineEvent>
        ),
      };
    }
    return { k: "msg", at, key, m };
  };
  const items: ActItem[] = taskEvents(t, runs?.runs ?? [], snap, { planMarkers })
    .filter((e) => tms(e.at) >= cutoff)
    .concat(visible.map(msgItem))
    .sort((a, b) => tms(a.at) - tms(b.at));
  // consecutive messages share one bordered card (Linear karri + jori)
  const blocks: (ActItem | { k: "card"; key: string; ms: ThreadMsg[] })[] = [];
  for (const it of items) {
    const last = blocks[blocks.length - 1];
    if (it.k === "msg") {
      if (last && last.k === "card") last.ms.push(it.m);
      else blocks.push({ k: "card", key: "card-" + it.key, ms: [it.m] });
    } else blocks.push(it);
  }

  const doneN = staged.filter((s) => s.status === "done").length;
  // no acting human (a viewer, a non-member, offline…) → the composer is
  // disabled with that reason instead of failing on Post
  const disabledReason = locked ? (assignee?.alias || "The agent") + " is in a live terminal — the thread composer is paused." : !h ? noHuman : undefined;

  return (
    <section className="wk-thread td-activity" aria-label="Activity">
      {startIdx > 0 ? (
        <Button variant="ghost" size="sm" className="td-earlier" data-loadearlier="true" onClick={() => setShown((s) => s + THREAD_PAGE)}>
          Load earlier · {visible.length} of {msgs.length}
        </Button>
      ) : null}
      {blocks.length ? (
        <Timeline label="Task activity" className="thread td-tl">
          {blocks.map((b) =>
            b.k === "event" ? (
              <FragmentLi key={b.key}>{b.node}</FragmentLi>
            ) : b.k === "card" ? (
              <TimelineCard key={b.key} label="Comments">
                {b.ms.map((m, i) => {
                  const sys = !m.from || m.from === "system";
                  const a = agentByAlias(snap, m.from);
                  return (
                    <TimelineMessage
                      key={m.id || b.key + "-" + i}
                      className={"td-msg" + (m.is_human ? " is-human" : sys ? " is-system" : "")}
                      author={sys ? "system" : m.from}
                      avatar={<Avatar alias={sys ? "system" : m.from} kind={sys ? "system" : a ? a.kind : m.is_human ? "human" : "ai"} size="sm" decorative />}
                      at={m.at || null}
                    >
                      <Md className="bubble wk-md" text={m.body} tasks={snap?.tasks} />
                      {(m.attachments || []).length ? (
                        <div className="msg-atts">
                          {m.attachments.map((a2, j) => (
                            <AttRow key={a2.id || j} a={a2} onLightbox={setLightbox} />
                          ))}
                        </div>
                      ) : null}
                    </TimelineMessage>
                  );
                })}
              </TimelineCard>
            ) : null,
          )}
        </Timeline>
      ) : null}
      {/* thread states: GH #74 latched failure (with or without a cache), lazy load, empty */}
      {msgs.length && errored ? (
        // a REFRESH failed while cached messages are still shown (summary grew,
        // refetch errored). The latch suppresses auto-retries, so without an explicit
        // control the thread would silently stay stale until a full page reload.
        <div className="none thread-err td-thread-note" role="status">
          Couldn&#39;t refresh — showing cached messages.{" "}
          <Button variant="link" size="sm" icon="refresh" data-thread-retry={t.id} onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      {!msgs.length ? (
        errored ? (
          // no cache to fall back on — an honest failure state instead of a
          // spinner/empty forever. Latches until the user clicks Retry.
          <div className="none thread-err td-thread-note" role="alert">
            Couldn&#39;t load the thread.{" "}
            <Button variant="link" size="sm" icon="refresh" data-thread-retry={t.id} onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : showLoading || summaryCount ? (
          <div className="none td-thread-note">Loading thread…</div>
        ) : (
          <div className="none td-thread-note">No messages yet.</div>
        )
      ) : null}
      <div
        id="replyWrap"
        className={"reply-wrap td-reply" + (dragover ? " dragover" : "")}
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
          if (!locked && e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          const files = e.clipboardData?.files;
          if (!locked && files?.length) uploadFiles(files);
        }}
      >
        <Composer
          id="reply"
          attachButtonId="attachBtn"
          submitButtonId="replyBtn"
          className="task-thread-composer"
          label="Task thread comment"
          placeholder="Leave a comment…"
          value={text}
          onChange={setText}
          onSubmit={() => void postMsg()}
          // PS-12: a disabled attach button says WHY on hover — the shared
          // Composer's attach button is a fixed "Attach files", so while the
          // composer is locked this pane renders its own with the reason
          onFiles={locked || !h ? undefined : uploadFiles}
          tools={
            locked || !h ? (
              <IconButton
                id="attachBtn"
                glyph={<AttachGlyph />}
                label="Attach files"
                title={"Attach files — " + (disabledReason || noHuman)}
                disabled
              />
            ) : undefined
          }
          accept={ACCEPT_EXT.map((x) => "." + x).join(",")}
          busy={posting}
          disabled={locked || !h}
          disabledReason={disabledReason}
          allowEmpty={doneN > 0}
          submitLabel="Post comment"
          minRows={2}
          maxHeight={160}
          attachments={
            staged.length ? (
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
                    <button type="button" className="rm" title="Remove" aria-label={"Remove " + s.name} onClick={() => setStaged((prev) => prev.filter((x) => x.key !== s.key))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null
          }
        />
      </div>
      {lightbox ? (
        <div className="att-lightbox" role="dialog" aria-label="Image preview — press Escape to close" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      ) : null}
    </section>
  );
}
/** TimelineEvent already renders its own <li>; this keeps a stable key slot. */
function FragmentLi({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/* ============================================================================
   O4 — assign-from-detail + wake (Forge B5: POST /api/tasks/{tid}/assign).
   B5 refuses root + finished tasks (409); a 409 "different active assignee"
   drives the reassign confirm when the snapshot is stale; a known different
   assignee pre-selects reassign (TG-20).
   ========================================================================== */
const ASSIGN_TERMINAL = ["completed", "needs_verification", "cancelled"];
/** B5 accepts the assign: not the root, not finished, and an AI agent to pick. */
function canAssign(t: Task, snap: Snapshot | null): boolean {
  return !t.is_root && ASSIGN_TERMINAL.indexOf(t.status) < 0 && (snap?.agents ?? []).some((a) => a.kind === "ai");
}
/** Linear-style in-place assignee editor: the Assignee VALUE itself (rail in the
 *  full view, the meta line in the inspector) opens the agent picker; picking
 *  asks "Assign & wake?" before POSTing. Not assignable (root / finished / no
 *  AI agents) → the value renders as-is. */
/** KG-6b: the honest line for assigning a budget-paused agent — the server refuses
 *  the wake, so never promise one. */
export function budgetPausedAssignCopy(alias: string): string {
  return alias + " is budget-paused — the task is queued and starts when the budget resets or an override is granted.";
}

function AssignControl({ t, children, className, paused = {} }: {
  t: Task;
  children: ReactNode;
  className?: string;
  /** KG-6b: budget-paused agents by id (pausedById) — the menu + confirm say so */
  paused?: Record<string, AgentBudgetStatus>;
}) {
  const { snap, refresh } = useSnapshot();
  // PS-29: the connection-aware actor (null while offline / read-only)
  const actor = useActor();
  const toast = useToast();
  const ais = (snap?.agents ?? []).filter((a) => a.kind === "ai");
  const noHuman = useNoHumanReason();
  const cur = t.assignee;
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | { reassign: boolean; agentId: string; alias: string }>(null);
  if (!canAssign(t, snap)) return <>{children}</>;
  const h = actor;
  const curAgent = cur ? agentByAlias(snap, cur) : null;

  const openPicker = () => {
    if (!actor) {
      toast(noHuman, "danger");
      return;
    }
    setPickOpen((o) => !o);
  };
  const pickAgent = (agentId: string) => {
    const ai = ais.find((a) => a.id === agentId);
    if (!ai) return;
    // TG-20: a task already held by someone else is a REASSIGN — ask once,
    // with the reassign copy, and send reassign:true (no guaranteed 409 +
    // second confirm). B5's 409 still drives it when the snapshot is stale.
    setConfirm({ reassign: !!cur && cur !== ai.alias, agentId, alias: ai.alias });
  };

  const postAssign = async (agentId: string, alias: string, reassign: boolean) => {
    const h = actor;
    if (!h) return;
    let res: { ok: boolean; status: number; d: { alias?: string; woke?: boolean; status?: string; released_prior?: unknown[]; detail?: string } };
    try {
      res = await post("/api/tasks/" + encodeURIComponent(t.id) + "/assign", {
        actor_agent_id: h.id,
        agent_id: agentId,
        reassign,
      });
    } catch {
      toast("Assign failed — the portal could not be reached.", "danger");
      return;
    }
    const { ok, status, d } = res;
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

  const tip = h ? (cur ? "Reassign & wake — reassigning releases " + cur : "Assign & wake an agent to start") : noHuman;
  return (
    <span className={"td-assign" + (className ? " " + className : "")} id="assignWrap" data-task={t.id}>
      <button
        ref={btnRef}
        type="button"
        className="td-prop-btn td-assign-btn"
        data-act="assign"
        aria-haspopup="menu"
        aria-expanded={pickOpen}
        aria-label={(cur ? "Assignee: " + cur + ". Reassign & wake" : "Unassigned. Assign & wake") + (h ? "" : " — " + noHuman)}
        title={tip}
        onClick={openPicker}
      >
        {children}
      </button>
      {/* the value is the picker (Linear) — the agent itself stays one click
          away (old detail: assignee → /agents?agent=<alias>) */}
      {curAgent ? (
        <a
          className="td-assign-open"
          href={"/agents?agent=" + encodeURIComponent(curAgent.alias)}
          aria-label={"Open agent " + curAgent.alias}
          title={"Open " + curAgent.alias}
          data-open-agent={curAgent.alias}
        >
          <Icon name="arrow" cls="v2-ico" />
        </a>
      ) : null}
      <PeopleMenu
        anchor={btnRef}
        open={pickOpen}
        onClose={() => setPickOpen(false)}
        label="Agent to assign"
        value={ais.find((a) => a.alias === cur)?.id || ""}
        options={ais.map((a) => ({
          id: a.id,
          label: a.alias,
          alias: a.alias,
          kind: "ai",
          hint: a.alias === cur ? "current" : undefined,
          chip: paused[String(a.id)] ? <BudgetPausedChip status={paused[String(a.id)]} /> : undefined,
        }))}
        onPick={pickAgent}
      />
      {confirm && (
        <Dialog
          title={confirm.reassign ? "Reassign task?" : "Assign task?"}
          description={
            (confirm.reassign
              ? (cur && cur !== confirm.alias ? cur + " is assigned to this task" : "This task already has a different active assignee") + ". Reassign to " + confirm.alias + "? " + (cur && cur !== confirm.alias ? cur + " will be released." : "They'll be released.")
              : "Assign to " + confirm.alias + "?" + (paused[confirm.agentId] ? "" : " This wakes them to start the task."))
            + (paused[confirm.agentId] ? " " + budgetPausedAssignCopy(confirm.alias) : "")
          }
          size="sm"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  // reassign comes from the known assignee (TG-20); a stale
                  // snapshot still falls back to B5's 409 → reassign confirm
                  void postAssign(c.agentId, c.alias, c.reassign);
                }}
              >
                {(confirm.reassign ? "Reassign" : "Assign") + (paused[confirm.agentId] ? "" : " & wake")}
              </Button>
            </>
          }
        />
      )}
    </span>
  );
}

/* ============================================================================
   Relations — GET /api/tasks/{tid}/close-implications (read-only, pure
   SELECTs): downstream tasks waiting on this one, the request that spawned it.
   Fetched once per task (not per poll); stale responses for a previous task are
   dropped. Only real data — no dependency claims derived from status.
   ========================================================================== */
interface Implications {
  downstream_tasks: { task_id: string; title: string; status: string; would_unblock: boolean }[];
  /** TG-05: tasks THIS one depends on (task_dependencies.task_id = this) —
   *  why a pending task is pending. Optional: older backends omit it. */
  upstream_tasks?: { task_id: string; title: string; status: string; satisfied?: boolean }[];
  in_flight_agents: { agent_id: string; alias: string; assignment_status: string }[];
  spawned_from_request: { request_id: string; requester_alias: string | null; status: string } | null;
  open_requests_from_assignees: { request_id: string; status: string; requester_alias: string | null; target_alias: string | null; preview: string }[];
  summary: { downstream_total: number; would_unblock: number; still_blocked: number; in_flight_agents: number; open_requests: number; completes_container: boolean };
}
function useImplications(tid: string, enabled = true): { data: Implications | null; failed: boolean; loading: boolean } {
  const [st, setSt] = useState<{ tid: string; data: Implications | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch("/api/tasks/" + encodeURIComponent(tid) + "/close-implications")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: Implications) => {
        if (live) setSt({ tid, data: d && d.summary ? d : null, failed: !(d && d.summary) });
      })
      .catch(() => {
        if (live) setSt({ tid, data: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [tid, enabled]);
  if (!enabled || !st || st.tid !== tid) return { data: null, failed: false, loading: enabled };
  return { data: st.data, failed: st.failed, loading: false };
}

type Upstream = NonNullable<Implications["upstream_tasks"]>[number];
function UpstreamList({ items, rel }: { items: Upstream[]; rel: string }) {
  return (
    <span className="td-rels" data-rel={rel}>
      {items.map((d) => (
        <span key={d.task_id} className="wk-rel td-rel">
          <StatusIcon status={d.status} size={12} />
          <Link className="dlink" to={"/tasks?task=" + encodeURIComponent(d.task_id)} title={d.title}>{d.title}</Link>
          {d.status !== "completed" ? <span className="v2-muted td-rel-note" title={"Status: " + statusMeta(d.status).l}>{statusMeta(d.status).l.toLowerCase()}</span> : null}
        </span>
      ))}
    </span>
  );
}

function Relationships({ t }: { t: Task }) {
  const { snap } = useSnapshot();
  const imp = useImplications(t.id);
  const down = imp.data?.downstream_tasks ?? [];
  const up = imp.data?.upstream_tasks ?? [];
  // TG-05b: a cancelled upstream is satisfied too — trust the backend's flag,
  // fall back to status for older backends that omit it
  const upSatisfied = (u: { status: string; satisfied?: boolean }) => u.satisfied ?? (u.status === "completed" || u.status === "cancelled");
  const upOpen = up.filter((u) => !upSatisfied(u));
  const upDone = up.filter(upSatisfied);
  const spawned = imp.data?.spawned_from_request ?? null;
  if (!imp.loading && !down.length && !up.length && !spawned && !t.is_root) return null;
  return (
    <PropertySection title="Relations">
      {!imp.loading && up.length ? (
        // TG-05: the owner sees WHY a task is pending — its unfinished
        // upstream work under "Blocked by"; satisfied upstreams (completed,
        // or cancelled — TG-05b) read "Depends on" and never claim to block
        <>
          {upOpen.length ? (
            <Property
              label="Blocked by"
              layout="stack"
              hint={"Starts when " + (upOpen.length === 1 ? "this task completes" : "these tasks complete")}
            >
              <UpstreamList items={upOpen} rel="upstream" />
            </Property>
          ) : null}
          {upDone.length ? (
            <Property label="Depends on" layout="stack" hint="Tasks this one depends on">
              <UpstreamList items={upDone} rel={upOpen.length ? "upstream-done" : "upstream"} />
            </Property>
          ) : null}
        </>
      ) : null}
      {imp.loading ? (
        <Property label="Blocking">
          <span className="v2-muted">Loading…</span>
        </Property>
      ) : down.length ? (
        <Property label="Blocking" layout="stack" hint="Tasks waiting on this one">
          <span className="td-rels">
            {down.map((d) => (
              <span key={d.task_id} className="wk-rel td-rel">
                <StatusIcon status={d.status} size={12} />
                <Link className="dlink" to={"/tasks?task=" + encodeURIComponent(d.task_id)} title={d.title}>{d.title}</Link>
                {d.would_unblock ? <span className="v2-muted td-rel-note" title="Unblocks when this task completes">unblocks</span> : null}
              </span>
            ))}
          </span>
        </Property>
      ) : null}
      {spawned ? (
        <Property label="Spawned from">
          {/* ONE line: "Request from lead" (+ " · closed" etc. when the request moved on) */}
          <span className="td-spawned" title={"Request " + (spawned.requester_alias ? "from " + spawned.requester_alias : shortId(spawned.request_id)) + " · " + statusMeta(spawned.status).l}>
            <Link className="dlink" to={"/requests?req=" + encodeURIComponent(spawned.request_id)}>
              Request {spawned.requester_alias ? "from " + spawned.requester_alias : shortId(spawned.request_id)}
            </Link>
            {/* a task spawned from a request IS its conversion — only a
                different (later) request state is a new fact worth a word */}
            {/^converted/.test(spawned.status) ? null : <span className="v2-muted td-spawned-st"> · {statusMeta(spawned.status).l.toLowerCase()}</span>}
          </span>
        </Property>
      ) : null}
      {t.is_root ? (
        <Property label="Root task" hint={"Verifying the root task completes the whole project" + (snap?.container?.name ? " (" + snap.container.name + ")" : "") + "."}>
          <span title={"Verifying the root task completes the whole project" + (snap?.container?.name ? " (" + snap.container.name + ")" : "") + "."}>
            Completes the project
          </span>
        </Property>
      ) : null}
    </PropertySection>
  );
}

/** "1 task" / "2 tasks" — never "task(s)". */
function plural(n: number, one: string, many: string): string {
  return n + " " + (n === 1 ? one : many);
}

/** The cancel confirm's read-only impact: at most TWO short facts on the line
 *  (dependents, then who holds it); anything further sits behind an ⓘ. */
function CancelImpact({ imp }: { imp: { data: Implications | null; failed: boolean; loading: boolean } }) {
  let facts: string[];
  if (imp.loading) facts = ["Checking impact…"];
  else if (imp.failed || !imp.data) facts = ["Impact summary unavailable."];
  else {
    const s = imp.data.summary;
    facts = [
      s.downstream_total
        ? plural(s.downstream_total, "task depends", "tasks depend") + " on this" + (s.would_unblock ? " (" + s.would_unblock + " would unblock)" : "")
        : "No tasks depend on this",
      s.in_flight_agents ? plural(s.in_flight_agents, "agent holds", "agents hold") + " it" : "",
      s.open_requests ? plural(s.open_requests, "open request", "open requests") + " from its assignees " + (s.open_requests === 1 ? "stays" : "stay") + " open" : "",
    ].filter(Boolean);
  }
  const shown = facts.slice(0, 2);
  const more = facts.slice(2);
  return (
    <div className="wk-lbl td-impact" aria-live="polite">
      <span>{shown.join(" · ") + (imp.loading || imp.failed || !imp.data ? "" : ".")}</span>
      {more.length ? <HelpTip tip={more.map((m) => m.charAt(0).toUpperCase() + m.slice(1) + ".").join(" ")} label={"More impact: " + more.join("; ")} className="td-impact-more" /> : null}
    </div>
  );
}

/* ============================================================================
   B7 — cancel (force-close) a non-root, non-terminal task. The confirm shows
   the read-only impact (close-implications) before the human acts. The
   header ⋯ menu opens the same confirm through `openRef`.
   ========================================================================== */
function CloseCard({ t, onActed, openRef }: { t: Task; onActed: (id: string) => void; openRef?: MutableRefObject<(() => void) | null> }) {
  const { refresh } = useSnapshot();
  // PS-29: the connection-aware actor (null while offline / read-only)
  const actor = useActor();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imp = useImplications(t.id, confirm);
  const closable = !(t.is_root || t.status === "completed" || t.status === "cancelled");
  const who = t.assignee;

  const noHuman = useNoHumanReason();
  const canAct = !!actor;
  const open = () => {
    const h = actor;
    if (!h) {
      toast(noHuman, "danger");
      return;
    }
    setError(null);
    setConfirm(true);
  };
  useEffect(() => {
    if (!openRef) return;
    openRef.current = closable ? open : null;
    return () => {
      openRef.current = null;
    };
  });
  if (!closable) return null;

  const doCancel = async () => {
    const h = actor;
    if (!h) return;
    setBusy(true);
    setError(null);
    let r: { ok: boolean; status: number; d: { detail?: unknown } };
    try {
      r = await post("/api/tasks/" + encodeURIComponent(t.id) + "/cancel", {
        actor_agent_id: h.id,
        reason: reason.trim() || undefined,
      });
    } catch {
      r = { ok: false, status: 0, d: {} };
    }
    setBusy(false);
    toast(r.ok ? "Task cancelled" : "Failed (" + r.status + ")", r.ok ? "ok" : "danger");
    if (r.ok) {
      setReason("");
      setConfirm(false);
      onActed(t.id);
      void refresh();
    } else {
      setError((r.status ? "HTTP " + r.status : "Not sent") + (detailText(r.d) ? " — " + detailText(r.d) : ""));
    }
  };

  return (
    <div id="cancelWrap" data-task={t.id} className="wk-cancel td-cancel">
      <Button
        variant="ghost"
        size="sm"
        data-act="cancel"
        icon="x"
        className="td-cancel-btn"
        disabled={!canAct}
        title={canAct ? "Force-close this task and unblock anything waiting on it. Doesn't stop a run that is already executing — stop it from the Runs tab." : noHuman}
        onClick={open}
      >
        Cancel task…
      </Button>
      {confirm && (
        <Dialog
          title="Cancel this task?"
          description="Closes it as cancelled and unblocks anything waiting on it. A running worker isn't stopped."
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
          size="sm"
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
                Keep task
              </Button>
              <Button variant="danger" busy={busy} onClick={() => void doCancel()}>
                Cancel task
              </Button>
            </>
          }
        >
          <label className="wk-reason-lbl" htmlFor="cancelReason" title={"Recommended — sent to " + (who || "the assignee")}>Reason</label>
          <textarea
            id="cancelReason"
            className="wk-textarea"
            style={{ minHeight: 64 }}
            placeholder={"Why is this being cancelled? " + (who ? who + " sees it." : "")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <CancelImpact imp={imp} />
          {error ? (
            <div className="wk-err" role="alert">
              <b>Not cancelled.</b> {error}. Your reason is kept.
            </div>
          ) : null}
        </Dialog>
      )}
    </div>
  );
}

/** Searchable multi-select for depends_on (touch-friendly: checkbox rows,
 *  never a ⌘/Ctrl-click native <select multiple>). The selected tasks sit in
 *  the composer's chip row; the "Depends on · N" chip opens an ANCHORED
 *  popover (portaled above the dialog) with the search + list, so opening it
 *  never reflows the chip row. The chip keeps its label while open.
 *  Tab stays inside the popover; Escape NEVER reaches the dialog: it clears
 *  the search first, then closes the popover and returns focus to the chip. */
function DepsPicker({ options, value, onChange }: { options: Task[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const byId = new Map(options.map((t) => [t.id, t]));
  const matches = options.filter((t) => matchesDep(t, q)).slice(0, 50);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : value.concat(id));
  const panelId = "nt_deps_panel";
  const close = () => {
    setOpen(false);
    setQ("");
    requestAnimationFrame(() => btnRef.current?.focus());
  };
  // Popover ignores clicks inside a dialog (its opener lives there) — a click
  // anywhere else in the composer still closes THIS picker.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      if (boxRef.current?.contains(el) || btnRef.current?.contains(el)) return;
      setOpen(false);
      setQ("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <>
      {value.map((id) => {
        const t = byId.get(id);
        return (
          <span key={id} className="wk-chip nt-chip is-dep" title={t?.title}>
            {t ? <StatusIcon status={t.status} size={12} /> : null}
            <span className="wk-chip-t">{t ? t.title : shortId(id)}</span>
            <button type="button" className="wk-chip-x" aria-label={"Remove dependency " + (t ? t.title : id)} onClick={() => toggle(id)}>
              <Icon name="x" cls="v2-ico" />
            </button>
          </span>
        );
      })}
      <button
        ref={btnRef}
        type="button"
        className="nt-chip"
        data-deps-btn="true"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Starts when these tasks complete"
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        <Icon name="plus" cls="v2-ico" />
        {value.length ? "Depends on · " + value.length : "Depends on"}
      </button>
      <Popover
        anchor={btnRef}
        open={open}
        onClose={() => {
          setOpen(false);
          setQ("");
        }}
        role="dialog"
        label="Depends on"
        id={panelId}
        className="nt-deps-pop"
      >
        <div
          ref={boxRef}
          className="wk-deps-panel nt-deps-panel"
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              // the popover is portaled outside the dialog: keep Tab here and
              // never let the dialog's trap yank focus back to its first field
              trapTab(e, boxRef.current);
              e.stopPropagation();
              return;
            }
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            if (q) setQ("");
            else close();
          }}
        >
          <div className="wk-deps-search">
            <Icon name="search" cls="v2-ico" />
            <input
              className="wk-deps-q"
              type="search"
              aria-label="Search open tasks"
              placeholder="Search open tasks or #id…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="wk-deps-list" role="group" aria-label="Open tasks">
            {matches.length ? (
              matches.map((t) => (
                <label key={t.id} className={"wk-deps-opt" + (value.includes(t.id) ? " is-on" : "")} title={t.title}>
                  {/* real checkbox semantics, drawn as the list-filter trailing check (no native blue box) */}
                  <input className="v2-sr wk-deps-in" type="checkbox" checked={value.includes(t.id)} onChange={() => toggle(t.id)} />
                  <StatusIcon status={t.status} size={12} />
                  <span className="wk-deps-t">{t.title}</span>
                  <span className="wk-id">{shortId(t.id)}</span>
                  <span className="wk-deps-check" aria-hidden="true">{value.includes(t.id) ? <Icon name="check" cls="v2-ico" /> : null}</span>
                </label>
              ))
            ) : (
              <div className="wk-deps-none">{q ? "No open tasks match “" + q + "”." : "No open tasks."}</div>
            )}
          </div>
        </div>
      </Popover>
    </>
  );
}
function matchesDep(t: Task, q: string): boolean {
  const s = q.trim().toLowerCase().replace(/^#/, "");
  if (!s) return true;
  return t.title.toLowerCase().includes(s) || String(t.id).toLowerCase().startsWith(s);
}

/** Shortcut glyph for the composer's submit hint — the app's ⌘K convention. */
const MOD_KEY = "⌘";

/** Grow a textarea with its content (Linear composer), capped by CSS max-height. */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

/* ============================================================================
   Create-task (human authority) — POST /api/containers/{cid}/tasks, as a
   Linear composer: "project › New task", a borderless title + auto-grow
   description, a compact required "Done when…" line, then a rounded-full
   property-chip row (priority · assignee · depends on · protocol) opening
   popovers. Validation errors sit inline under their field (focus moves
   there, the error clears as soon as the field changes); server errors keep
   every typed field. Closing a dirty draft asks before discarding it.
   ========================================================================== */
export function NewTaskModal({ onClose, onCreated, initialAssignee }: {
  onClose: () => void; onCreated: (taskId: string | null) => void;
  /** `?new=1&for=<alias>` pre-fill (Agents board "+"); used only if it names a real AI agent */
  initialAssignee?: string | null;
}) {
  const { snap, cid, refresh } = useSnapshot();
  // PS-29: the connection-aware actor (null while offline / read-only)
  const actor = useActor();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [dod, setDod] = useState("");
  const [pri, setPri] = useState<string>("normal");
  // "Custom…": the exact backend integer (min 1; lower = higher) — the buckets
  // are presets, numeric priorities stay fully settable (brief §3)
  const [priCustom, setPriCustom] = useState<string>(String(DEFAULT_PRIORITY));
  const priCustomRef = useRef<HTMLInputElement | null>(null);
  const [assigneePick, setAssignee] = useState(initialAssignee || "");
  const [deps, setDeps] = useState<string[]>([]);
  // #57: create-time protocol — collapsed by default, optional; only the fields the
  // user actually filled in ride on the create POST, and only when at least one is set.
  const [protoOpen, setProtoOpen] = useState(false);
  const [pChain, setPChain] = useState("");
  const [pHandoff, setPHandoff] = useState("");
  const [pAutonomy, setPAutonomy] = useState("");
  const [pNotes, setPNotes] = useState("");
  const [err, setErr] = useState("");
  const [errField, setErrField] = useState<"title" | "dod" | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const dodRef = useRef<HTMLTextAreaElement | null>(null);
  const priRef = useRef<HTMLButtonElement | null>(null);
  const asgRef = useRef<HTMLButtonElement | null>(null);
  const [priOpen, setPriOpen] = useState(false);
  const [asgOpen, setAsgOpen] = useState(false);
  const h = actor;
  const noHuman = useNoHumanReason();
  const ais = (snap?.agents ?? []).filter((a) => a.kind === "ai");
  // never submit an alias that isn't an AI agent in this project (stale/foreign ?for=)
  const assignee = ais.some((a) => a.alias === assigneePick) ? assigneePick : "";
  // depends_on: optional multi-select of NON-terminal tasks.
  // The project root is never a dependency (it completes the whole project).
  const depOpts = (snap?.tasks ?? []).filter((t) => !t.is_root && ["completed", "cancelled"].indexOf(t.status) < 0);
  const customN = Math.floor(Number(priCustom));
  const customOk = pri !== "custom" || (priCustom.trim() !== "" && Number.isFinite(customN) && customN >= 1 && String(customN) === priCustom.trim());
  const bucket = pri === "custom" ? priorityBucket(customOk ? customN : DEFAULT_PRIORITY) : PRIORITY_BUCKETS.find((b) => b.k === pri) || PRIORITY_BUCKETS[2];
  const projectName = snap?.container?.name || "";
  const dirty = !!(title.trim() || desc.trim() || dod.trim() || deps.length || pChain.trim() || pHandoff.trim() || pAutonomy.trim() || pNotes.trim());
  const protoN = [pChain, pHandoff, pAutonomy, pNotes].filter((x) => x.trim()).length;

  const requestClose = () => {
    if (creating) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const clearErr = (f: "title" | "dod") => {
    if (errField === f) {
      setErr("");
      setErrField(null);
    }
  };
  const fieldErr = (f: "title" | "dod", msg: string) => {
    setErr(msg);
    setErrField(f);
    requestAnimationFrame(() => (f === "title" ? titleRef.current : dodRef.current)?.focus());
  };

  const submit = async () => {
    const ttl = title.trim();
    const dd = dod.trim();
    if (!ttl) {
      fieldErr("title", "Title is required.");
      return;
    }
    if (!dd) {
      fieldErr("dod", "Definition of done is required.");
      return;
    }
    const containerId = snap?.container?.id || cid;
    if (!containerId || !h) {
      setErrField(null);
      setErr(!h ? noHuman : "No container loaded.");
      return;
    }
    if (!customOk) {
      setErrField(null);
      setErr("Priority must be a whole number of 1 or more (lower = higher priority).");
      requestAnimationFrame(() => priCustomRef.current?.focus());
      return;
    }
    const priority = pri === "custom" ? customN : priorityValue(pri);
    // #57: send only the fields actually filled in; omit `protocol` entirely when none are set.
    const proto: Proto = {};
    if (pChain.trim()) proto.review_chain = pChain.trim();
    if (pHandoff.trim()) proto.handoff_to = pHandoff.trim();
    if (pAutonomy.trim()) proto.autonomy = pAutonomy.trim();
    if (pNotes.trim()) proto.notes = pNotes.trim();
    setCreating(true);
    setErr("");
    setErrField(null);
    let r: { ok: boolean; status: number; d: { status?: string; assignee_alias?: string; task_id?: string; detail?: unknown } };
    try {
      r = await post("/api/containers/" + encodeURIComponent(containerId) + "/tasks", {
        title: ttl,
        description: desc.trim() || null,
        definition_of_done: dd,
        priority,
        created_by_agent_id: h.id,
        assignee_alias: assignee || undefined,
        depends_on: deps,
        protocol: Object.keys(proto).length ? proto : undefined,
      });
    } catch {
      setCreating(false);
      setErr("Create failed — the portal could not be reached. Your task is still here; try again.");
      return;
    }
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

  const errLine = (f: "title" | "dod") =>
    err && errField === f ? (
      <div className="nt-err" id="nt_err" role="alert">
        <Icon name="alert" cls="v2-ico" />
        {err}
      </div>
    ) : null;

  return (
    <>
      <style>{composerCss}</style>
      <Dialog
        title={(projectName ? projectName + " › " : "") + "New task"}
        size="md"
        className="wk-newtask nt-composer"
        initialFocus={titleRef}
        closeOnBackdrop={false}
        onClose={requestClose}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={requestClose}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              busy={creating}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              title={"Create task (" + MOD_KEY + "↵) — created by " + (h ? h.alias : "you") + " and logged to the audit trail"}
              onClick={() => {
                if (!creating) void submit();
              }}
            >
              <span>{creating ? "Creating…" : "Create task"}</span>
              {!creating ? <kbd className="nt-kbd" aria-hidden="true">{MOD_KEY}↵</kbd> : null}
            </Button>
          </>
        }
      >
        <IconButton icon="x" label="Close" size="sm" className="nt-x" onClick={requestClose} />
        <div
          className="nt-body"
          onKeyDown={(e) => {
            // ⌘↵ / Ctrl↵ creates from any field (Linear composer)
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!creating) void submit();
            }
          }}
        >
          <input
            id="nt_title"
            ref={titleRef}
            className="nt-title"
            aria-label="Title"
            placeholder="Task title"
            maxLength={200}
            required
            aria-invalid={errField === "title" || undefined}
            aria-describedby={errField === "title" ? "nt_err" : undefined}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              clearErr("title");
            }}
          />
          {errLine("title")}
          <textarea
            id="nt_desc"
            className="nt-desc"
            aria-label="Description"
            placeholder="Add description… (markdown)"
            rows={2}
            value={desc}
            onChange={(e) => {
              setDesc(e.target.value);
              autoGrow(e.currentTarget);
            }}
          />
          <div className={"nt-dod" + (errField === "dod" ? " is-invalid" : "")}>
            <label htmlFor="nt_dod" className="nt-dod-l" title="What must be true for this task to be considered complete — the reviewer checks the result against it">
              <StatusGlyph status="completed" size={14} />
              Done when
            </label>
            <textarea
              id="nt_dod"
              ref={dodRef}
              className="nt-dod-in"
              rows={1}
              required
              aria-invalid={errField === "dod" || undefined}
              aria-describedby={errField === "dod" ? "nt_err" : undefined}
              placeholder="What must be true for this to be complete (required)"
              value={dod}
              onChange={(e) => {
                setDod(e.target.value);
                clearErr("dod");
                autoGrow(e.currentTarget);
              }}
            />
          </div>
          {errLine("dod")}
          <div className="nt-props" role="group" aria-label="Task properties">
            <button
              ref={priRef}
              id="nt_pri"
              type="button"
              className="nt-chip"
              data-value={pri}
              aria-haspopup="menu"
              aria-expanded={priOpen}
              aria-label={"Priority: " + bucket.label + (pri === "custom" ? " (" + (customOk ? customN : "invalid") + ")" : "")}
              title="Priority"
              onClick={() => setPriOpen((o) => !o)}
            >
              <PriorityIcon priority={bucket.value} decorative />
              {bucket.label}
            </button>
            {pri === "custom" ? (
              <input
                id="nt_pri_n"
                ref={priCustomRef}
                className="nt-pri-n"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                aria-label="Priority number (1 or more, lower = higher priority)"
                title="Priority number — lower = higher priority (default 100)"
                aria-invalid={!customOk || undefined}
                value={priCustom}
                onChange={(e) => {
                  setPriCustom(e.target.value);
                  if (err && !errField) setErr("");
                }}
              />
            ) : null}
            <PeopleMenu
              anchor={priRef}
              open={priOpen}
              onClose={() => setPriOpen(false)}
              label="Priority"
              value={pri}
              options={[
                ...PRIORITY_BUCKETS.map((b) => ({ id: b.k, label: b.label, icon: <PriorityIcon priority={b.value} decorative /> })),
                { id: "custom", label: "Custom…", icon: <Icon name="pencil" cls="v2-ico" /> },
              ]}
              onPick={(v) => {
                if (v === "custom" && pri !== "custom") {
                  // start from the current preset's value
                  setPriCustom(String(priorityValue(pri)));
                  requestAnimationFrame(() => priCustomRef.current?.select());
                }
                setPri(v);
              }}
            />
            <button
              ref={asgRef}
              id="nt_assignee"
              type="button"
              className={"nt-chip" + (assignee ? "" : " is-empty")}
              data-value={assignee}
              aria-haspopup="menu"
              aria-expanded={asgOpen}
              aria-label={"Assignee: " + (assignee || "Unassigned")}
              title="Assignee"
              onClick={() => setAsgOpen((o) => !o)}
            >
              {assignee ? <Avatar alias={assignee} kind="ai" size={16} decorative /> : <Icon name="person" cls="v2-ico" />}
              {assignee || "Assignee"}
            </button>
            <PeopleMenu
              anchor={asgRef}
              open={asgOpen}
              onClose={() => setAsgOpen(false)}
              label="Assignee"
              value={assignee}
              options={[{ id: "", label: "Unassigned" }, ...ais.map((a) => ({ id: a.alias, label: a.alias, alias: a.alias, kind: "ai" }))]}
              onPick={(v) => setAssignee(v)}
            />
            {depOpts.length ? <DepsPicker options={depOpts} value={deps} onChange={setDeps} /> : null}
            <button
              type="button"
              className="nt-chip"
              data-proto-toggle="true"
              aria-expanded={protoOpen}
              aria-controls="nt_proto"
              title="Hand-off rules the assignee reads on its first wake (optional)"
              onClick={() => setProtoOpen((o) => !o)}
            >
              <Icon name="shield" cls="v2-ico" />
              {protoN ? "Protocol · " + protoN : "Protocol"}
            </button>
          </div>
          {/* borderless lines under one hairline, placeholder-as-label (Linear composer);
              each keeps an accessible name */}
          <div className="nt-proto" id="nt_proto" role="group" aria-label="Protocol" hidden={!protoOpen}>
            {([
              ["nt_p_chain", "Review chain", "Review chain — e.g. Builder → Reviewer → loop until clean → human", pChain, setPChain],
              ["nt_p_handoff", "Hand-off to", "Hand-off to — who the assignee returns to first when done", pHandoff, setPHandoff],
              ["nt_p_autonomy", "Autonomy", "Autonomy — how far the assignee may go before checking in", pAutonomy, setPAutonomy],
              ["nt_p_notes", "Notes", "Notes — any other standing rules for this task", pNotes, setPNotes],
            ] as const).map(([id, label, ph, v, set]) => (
              <label key={id} className="nt-proto-row" htmlFor={id}>
                <span className="v2-sr">{label}</span>
                <textarea
                  id={id}
                  className="nt-proto-in"
                  rows={1}
                  placeholder={ph}
                  value={v}
                  onChange={(e) => {
                    set(e.target.value);
                    autoGrow(e.currentTarget);
                  }}
                />
              </label>
            ))}
          </div>
          {err && !errField ? (
            <div className="nt-err" id="nt_err" role="alert">
              <Icon name="alert" cls="v2-ico" />
              {err}
            </div>
          ) : null}
        </div>
      </Dialog>
      {confirmDiscard ? (
        <ConfirmDialog
          title="Discard this task?"
          description="What you typed will be lost."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          danger
          onClose={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}

/* ============================================================================
   Worker runs (live feed) — runs from useTaskRuns (GET /api/tasks/{tid}/runs),
   SSE via useRunStream, diffs via FilesChanged, graceful Stop (SPEC-2 T2) with
   a sticky "Stop requested" relabel. Stopping one run never stops the project.
   ========================================================================== */
// run_ids a human has requested a stop for THIS SESSION — module-level so the
// relabel stays sticky across polls/remounts until the run status flips.
const stopRequestedRuns = new Set<string>();

/** The run whose "Code changes" section opens by default in the Runs tab:
 *  the most recent run that carries a non-empty diff (r2 parity: the old UI's
 *  "code diff" toggle was one click from the task; keep it zero clicks for
 *  the newest diff, without expanding every historical run). */
export function newestDiffRunKey(runs: Run[]): string | null {
  let best: Run | null = null;
  for (const r of runs) {
    if (!r.diff || !String(r.diff).trim()) continue;
    if (!best || runStart(r) > runStart(best)) best = r;
  }
  return best ? best.run_id || best.id || null : null;
}

function RunCard({ run, diffOpen = false }: { run: Run; diffOpen?: boolean }) {
  const words = modeWords(useProjectMode(useSnapshot().cid).mode);
  // PS-29: the connection-aware actor (null while offline / read-only)
  const actor = useActor();
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const [, bumpLocal] = useState(0);
  const lines = useRunStream(run);
  const logRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const noHuman = useNoHumanReason();

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
  const started = run.started_at || run.started;
  const ended = run.ended_at || run.ended;
  // #299 honesty: a human-stopped run reaps as status='killed' with
  // kill_reason.cause='human_stop'; only a watchdog kill reads 'watchdog-killed'.
  const stopReq = stopRequestedRuns.has(rid);

  const requestStop = () => {
    if (!rid) return;
    const h = actor;
    if (!h) {
      toast(noHuman, "danger");
      return;
    }
    if (stopRequestedRuns.has(rid)) {
      toast("Stop already requested for this run.", "warn");
      return;
    }
    setConfirmStop(true);
  };
  const doStop = async () => {
    const h = actor;
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

  // "watchdog-killed" (runLabel) vs "Stopped": never conflate a human stop with a watchdog kill
  const label = runLabel(run, stopReq);
  const kindLabel = run.wake_kind === "tmux" ? "live tab" : run.wake_kind || "";

  return (
    <div className="run">
      <div className="run-h">
        <StatusIcon
          status={runGlyphStatus(run)}
          showLabel
          label={label + (run.exit_code != null && !live ? " · exit " + run.exit_code : "")}
        />
        {kindLabel ? <span className="wk-lbl">{kindLabel}</span> : null}
        {run.agent ? <span className="wk-lbl">· {run.agent}</span> : null}
        <span className="when" title={(started || "") + (ended ? " → " + ended : "")}>
          {clockTime(started)}
          {ended ? " → " + clockTime(ended) : ""}
          {started ? " · " + relTime(ended || started) : ""}
        </span>
        {live ? (
          <Button
            variant="secondary"
            size="sm"
            icon="stop"
            className="run-stop"
            data-run-stop={rid}
            disabled={stopReq}
            title={stopReq ? "Stop requested — the worker halts at its next checkpoint" : "Stop this worker run (the project keeps running)"}
            onClick={requestStop}
          >
            {stopReq ? "Stop requested" : "Stop run"}
          </Button>
        ) : null}
      </div>
      {run.diff != null ? (
        <details className="wk-run-sec" open={diffOpen || undefined} data-run-diff={rid}>
          <summary>
            <Icon name="chev" cls="v2-ico wk-disc-chev" />
            {words.runChanges}
          </summary>
          <div className="wk-run-sec-b">
            <FilesChanged diff={run.diff} blobSource={runBlobSource(run)} />
          </div>
        </details>
      ) : null}
      <details open className="wk-run-sec">
        <summary>
          <Icon name="chev" cls="v2-ico wk-disc-chev" />
          Log
          {lines.length ? <span className="wk-lbl"> · {lines.length} line{lines.length === 1 ? "" : "s"}</span> : null}
        </summary>
        <div
          className="log"
          id={"run-" + rid}
          ref={logRef}
          aria-live={live ? "polite" : undefined}
          onScroll={(e) => {
            atBottomRef.current = nearBottom(e.currentTarget);
            setAwayFromEnd(!atBottomRef.current);
          }}
        >
          {lines.length ? (
            lines.map((e, i) => {
              const lbl = e.label || e.type;
              const plain = !lbl || lbl === "log";
              // a killed / failed run's final line is not a success (QA: RUN-COMPLETE killed read green)
              const bad = e.type === "done" && (run.status === "killed" || run.status === "failed");
              return (
                <div key={i} className={"ln t-" + e.type + (plain ? " is-plain" : "") + (bad ? " is-bad" : "")}>
                  {plain ? null : <span className="ty">{lbl}</span>}
                  <span className="tx">
                    {logRowText(e)}
                    {/* tool input / output stays behind "Details" — never raw
                        JSON inline (D4), same as Agents › Runs */}
                    {e.detail ? (
                      <details className="det-x">
                        <summary>Details</summary>
                        <span className="det">{e.detail}</span>
                      </details>
                    ) : null}
                  </span>
                </div>
              );
            })
          ) : (
            <div className="wk-log-empty">
              {live ? "Connecting to the live log — output appears as the worker writes it…" : "No output was captured for this run."}
            </div>
          )}
        </div>
        {live && awayFromEnd ? (
          <div style={{ padding: "6px 12px" }}>
            <Button
              variant="ghost"
              size="sm"
              icon="arrow-down"
              onClick={() => {
                const el = logRef.current;
                if (el) pinToBottom(el);
                atBottomRef.current = true;
                setAwayFromEnd(false);
              }}
            >
              Jump to latest
            </Button>
          </div>
        ) : null}
      </details>
      {confirmStop && (
        <Dialog
          title={"Stop run " + shortId(rid) + "?"}
          description="The worker halts at its next checkpoint; the task stays in progress. Other runs keep going."
          size="sm"
          onClose={() => setConfirmStop(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmStop(false)}>Keep running</Button>
              <Button
                variant="danger"
                icon="stop"
                onClick={() => {
                  setConfirmStop(false);
                  void doStop();
                }}
              >
                Stop run
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

function RunsPanel({ state }: { state: RunsState | null }) {
  if (!state) return <Skeleton lines={3} label="Loading runs" />;
  if (state.failed)
    return (
      <section className="wk-runs" aria-label="Runs and diffs">
        <div className="none" role="alert">Run feed unavailable.</div>
      </section>
    );
  const runs = state.runs;
  const diffKey = newestDiffRunKey(runs);
  // the count lives on the "Runs N" tab — no repeated "N runs" line (D12)
  return (
    <section className="wk-runs" aria-label="Runs and diffs">
      {runs.length ? (
        runs.map((r) => <RunCard key={r.run_id || r.id} run={r} diffOpen={!!diffKey && (r.run_id || r.id) === diffKey} />)
      ) : (
        <div className="none">No runs yet — appears when a worker wakes for this task.</div>
      )}
    </section>
  );
}

/* ============================================================================
   Task detail body — main column (title, description, gate, DoD/result/plan),
   the property rail and the Activity | Runs section. Inactive panels stay
   mounted (hidden) so a half-typed comment survives switching to Runs; Runs
   mounts lazily on first visit (its SSE streams open only when looked at).
   ========================================================================== */
export interface ThreadCache {
  msgs: ThreadMsg[];
  loading: boolean;
  errored: boolean;
  retry: () => void;
}

/** "overview" (the default) and "activity" both show the Activity panel. */
const actsTab = (tab: TabKey): "activity" | "runs" => (tab === "runs" ? "runs" : "activity");

/** Mig 068: the Verdikt auto-fix loop on the task — status, attempts timeline, Stop. Shown
 *  while a loop of the current review cycle exists (also while the task is back with its agent). */
function TaskAutofix({ t }: { t: Task }) {
  const actor = useActor();
  const noHuman = useNoHumanReason();
  return <AutofixSection taskId={t.id} status={t.status} actorId={actor ? String(actor.id) : null} noActorReason={noHuman} />;
}

function TaskDetail({
  t,
  tab,
  onTab,
  acted,
  onActed,
  thread,
  runs,
  cancelRef,
  mode,
}: {
  t: Task;
  tab: TabKey;
  onTab: (k: TabKey) => void;
  acted: boolean;
  onActed: (id: string) => void;
  thread: ThreadCache;
  runs: RunsState | null;
  cancelRef: MutableRefObject<(() => void) | null>;
  mode: "inspector" | "narrow" | "full";
}) {
  const { snap } = useSnapshot();
  const cur = actsTab(tab);
  const [runsSeen, setRunsSeen] = useState(cur === "runs");
  const [propsOpen, setPropsOpen] = useState(false);
  useEffect(() => {
    if (cur === "runs") setRunsSeen(true);
  }, [cur]);
  const pre = "task-" + t.id;
  const pm = planMessageOf(t);
  const gated = (t.status === "needs_verification" || pendingPlan(t)) && !acted;
  const all = (t.assignees || []).length ? t.assignees : t.assignee ? [t.assignee] : [];
  // KG-6b: a budget-paused assignee explains a stalled task right on the meta line
  const budgets = useContainerBudgets(snap?.container?.id ?? null);
  const paused = pausedById(budgets.data);
  const budgetStop = all.map((a) => agentByAlias(snap, a)?.id).map((id) => (id ? paused[String(id)] : undefined)).find(Boolean) ?? null;
  const runCount = runs && !runs.failed ? runs.runs.length : t.runs_summary?.count ?? null;
  const tabs = [
    { key: "activity", label: "Activity", count: t.message_summary?.count || null },
    { key: "runs", label: "Runs", count: runCount || null },
  ];
  const panel = (k: "activity" | "runs", body: ReactNode) => (
    <div role="tabpanel" id={`${pre}-panel-${k}`} aria-labelledby={`${pre}-tab-${k}`} className="wk-tabpanel td-tabpanel" hidden={cur !== k} tabIndex={-1}>
      {body}
    </div>
  );
  const full = mode === "full";
  const description = t.description ? (
    full ? (
      <Md className="td-desc wk-text wk-md" text={t.description} tasks={snap?.tasks} />
    ) : (
      <ClampedDesc text={t.description} tasks={snap?.tasks} />
    )
  ) : (
    <p className="td-desc is-empty">No description.</p>
  );
  const gate = (
    <GateSurface
      key={"gate-" + t.id}
      t={t}
      acted={acted}
      onActed={onActed}
      runs={runs}
      onOpenRuns={() => onTab("runs")}
      noDiff={!full}
    />
  );
  const last = lastActivityAt(t);
  // After a verification reject the task is back in progress: the previous
  // attempt's result is marked as rejected and the feedback sits near the top
  // (it was only reachable deep in Activity).
  const rejection = ["in_progress", "ready", "blocked", "pending"].includes(t.status)
    ? latestRejection(thread.msgs.length ? thread.msgs : t.thread || [])
    : null;
  // phone: Properties collapse to ONE "Properties ▸" line so Activity stays
  // near the top (the rail would otherwise push the timeline ~2 screens down)
  const phone = useMediaQuery("(max-width: 560px)");
  const railCollapsed = phone && !propsOpen;
  return (
    <div className="wk-detail td-body" data-task={t.id}>
      {/* full: title · description · gate (Linear issue).
          inspector / narrow: title · ONE meta line · gate · description (3 lines) */}
      <div className="td-main">
        <GoalChain taskId={t.id} />
        <h1 className="td-title v2-t-display" title={full ? undefined : t.title}>
          {t.title}
        </h1>
        {!full ? (
          <div className="td-meta" aria-label="Summary">
            <StatusIcon status={t.status} size={14} showLabel />
            <span className="td-meta-sep" aria-hidden="true" />
            <span className="td-prio" title={priorityTitle(t.priority)}>
              <PriorityIcon priority={t.priority} showLabel />
            </span>
            <span className="td-meta-sep" aria-hidden="true" />
            <AssignControl key={"assign-" + t.id} t={t} className="td-meta-asg" paused={paused}>
              {all.length ? (
                <span className="td-meta-who" title={(all.length > 1 ? "Assignees: " : "Assignee: ") + all.join(", ")}>
                  <span className="td-stack">
                    {all.slice(0, 3).map((a) => (
                      <Avatar key={a} alias={a} kind={agentByAlias(snap, a)?.kind || "ai"} size={16} decorative />
                    ))}
                  </span>
                  <span className="td-meta-names">{all.length > 2 ? all[0] + " +" + (all.length - 1) : all.join(", ")}</span>
                </span>
              ) : (
                <span className="v2-muted">Unassigned</span>
              )}
            </AssignControl>
            {budgetStop ? <BudgetPausedChip status={budgetStop} /> : null}
            {last ? (
              <>
                <span className="td-meta-sep" aria-hidden="true" />
                <span className="v2-muted td-meta-age" title={"Last activity " + new Date(last).toLocaleString()}>
                  {relTime(last)}
                </span>
              </>
            ) : null}
          </div>
        ) : null}
        {full ? (
          // stacked full view (< 860 px container): the rail is below the fold,
          // so the compact meta line carries status / priority / assignee (hidden
          // by CSS once the rail is a right column)
          <div className="td-meta td-meta-full" aria-label="Summary">
            <StatusIcon status={t.status} size={14} showLabel />
            <span className="td-meta-sep" aria-hidden="true" />
            <span className="td-prio" title={priorityTitle(t.priority)}>
              <PriorityIcon priority={t.priority} showLabel />
            </span>
            <span className="td-meta-sep" aria-hidden="true" />
            <span className="td-meta-who" title={all.length ? (all.length > 1 ? "Assignees: " : "Assignee: ") + all.join(", ") : "Unassigned"}>
              {all.length ? (
                <>
                  <span className="td-stack">
                    {all.slice(0, 3).map((a) => (
                      <Avatar key={a} alias={a} kind={agentByAlias(snap, a)?.kind || "ai"} size={16} decorative />
                    ))}
                  </span>
                  <span className="td-meta-names">{all.length > 2 ? all[0] + " +" + (all.length - 1) : all.join(", ")}</span>
                </>
              ) : (
                <span className="v2-muted">Unassigned</span>
              )}
            </span>
            {budgetStop ? <BudgetPausedChip status={budgetStop} /> : null}
          </div>
        ) : null}
        {full ? description : gate}
        {full ? gate : description}
        {rejection ? (
          <div className="td-changes" role="note" data-changes-requested="true">
            <div className="td-changes-h">
              <Icon name="x" cls="v2-ico" />
              <b>Changes requested</b>
              {rejection.at ? <span className="v2-muted" title={new Date(rejection.at).toLocaleString()}>· {relTime(rejection.at)}</span> : null}
            </div>
            {rejection.feedback ? <Md className="wk-text wk-md td-changes-b" text={rejection.feedback} tasks={snap?.tasks} /> : null}
          </div>
        ) : null}
        {t.status !== "completed" && t.status !== "cancelled" ? <TaskAutofix key={"af-" + t.id} t={t} /> : null}
        {!gated ? (
          <div className="td-block">
            <div className="td-block-k">Definition of done</div>
            <Md className="wk-text wk-md" text={t.definition_of_done || "—"} tasks={snap?.tasks} />
          </div>
        ) : null}
        {t.result && !(t.status === "needs_verification" && !acted) ? (
          <div className={"td-block" + (rejection ? " is-rejected" : "")} data-result-rejected={rejection ? "true" : undefined}>
            <div className="td-block-k">{rejection ? "Previous result · rejected" : "Result"}</div>
            <div className="wk-text">
              {/* open-orcha#209: task.result is JSONB — ResultView normalizes it (never raw JSON) */}
              <ResultView r={t.result} tasks={snap?.tasks} />
            </div>
          </div>
        ) : null}
        {/* a DECIDED plan keeps its disclosure; an undecided opening message
            (often just a progress note) is not labelled a plan — it reads in
            Activity, never twice (D12) */}
        {pm && !pendingPlan(t) && t.plan_decision ? (
          <details className="wk-disclosure td-plan">
            <summary className="v2-btn v2-btn-ghost v2-btn-sm">
              <Icon name="chev" cls="v2-ico wk-disc-chev" />
              {t.plan_decision ? "Plan " + (t.plan_decision.decision === "approve" ? "approved" : "rejected") + (t.plan_decision.actor ? " by " + t.plan_decision.actor : "") : "Plan"}
              <span className="v2-muted">{pm.from ? " · " + pm.from : ""}{pm.at ? " · " + relTime(pm.at) : ""}</span>
            </summary>
            <Md className="wk-text wk-md" text={pm.body} tasks={snap?.tasks} />
          </details>
        ) : null}
        {/* non-code deliverables (reports, tables, images, PDFs) + version history */}
        <DeliverablesSection key={"dlv-" + t.id} task={t} full={full} />
      </div>
      <div className="td-rail">
        {phone ? (
          <button type="button" className="td-rail-toggle" aria-expanded={propsOpen} aria-controls={pre + "-props"} onClick={() => setPropsOpen((o) => !o)}>
            <Icon name="chev" cls="v2-ico td-rail-chev" />
            Properties
          </button>
        ) : null}
        <div id={pre + "-props"} className={"td-rail-body" + (phone ? " is-collapsible" : "")} hidden={railCollapsed}>
        <PropertyRail label="Task properties" className="td-railbox">
          {full || reviewerSupported(snap) || creatorOf(t, snap) ? (
          <PropertySection title={phone ? undefined : "Properties"}>
            {/* status / priority / assignees sit in the inspector's meta line —
                only the full view repeats them here as the Linear rail (D12) */}
            {full ? (
              <Property label="Status">
                <StatusIcon status={t.status} showLabel />
              </Property>
            ) : null}
            {full ? (
            <Property label="Priority">
              {/* the bucket only — the raw value lives in the tooltip (D12: one fact once) */}
              <span className="td-prio" title={priorityTitle(t.priority)} data-priority-value={String(t.priority ?? DEFAULT_PRIORITY)}>
                <PriorityIcon priority={t.priority} showLabel decorative={false} />
              </span>
            </Property>
            ) : null}
            {full ? (
              <Property label={all.length > 1 ? "Assignees" : "Assignee"}>
                {/* the value IS the editor (Linear): opens the agent picker → "Assign & wake" */}
                {!canAssign(t, snap) ? (
                  all.length ? <span className="td-assignees">{all.map((a) => <AgentLink key={a} snap={snap} alias={a} />)}</span> : <span className="v2-muted">Unassigned</span>
                ) : (
                <AssignControl key={"assign-" + t.id} t={t} className="td-assign-rail" paused={paused}>
                  {all.length ? (
                    <span className="td-assignees">
                      {all.map((a) => (
                        <span key={a} className="td-actor">
                          <Avatar alias={a} kind={agentByAlias(snap, a)?.kind || "ai"} size="sm" decorative />
                          <span>{a}</span>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="v2-muted">Unassigned</span>
                  )}
                </AssignControl>
                )}
                {budgetStop ? <BudgetPausedChip status={budgetStop} /> : null}
              </Property>
            ) : null}
            {/* collab v1: assigned reviewer — rendered ONLY when the snapshot
                speaks collab (cloud); open backends show nothing and never
                touch the reviewer endpoint. */}
            {reviewerSupported(snap) ? (
              <Property label="Reviewer">
                <ReviewerChip key={"rev-" + t.id} t={t} />
              </Property>
            ) : null}
            {/* only a creator we can resolve — the client falls back to the word
                "human" when created_by_agent_id is null; never guess the actor */}
            {creatorOf(t, snap) ? (
              <Property label="Created by">
                <AgentLink snap={snap} alias={creatorOf(t, snap)} />
              </Property>
            ) : null}
          </PropertySection>
          ) : null}
          <RecurringProperty t={t} />
          <Relationships t={t} />
          <ProtocolPanel key={"proto-" + t.id} t={t} />
          <CloseCard key={"close-" + t.id} t={t} onActed={onActed} openRef={cancelRef} />
        </PropertyRail>
        </div>
      </div>
      <div className="td-acts">
        <Tabs tabs={tabs} value={cur} onChange={(k) => onTab(k as TabKey)} label="Task sections" idPrefix={pre} className="td-tabs" />
        {panel(
          "activity",
          <ThreadCard
            key={"thread-" + t.id}
            t={t}
            msgs={thread.msgs}
            loading={thread.loading}
            errored={thread.errored}
            onRetry={thread.retry}
            runs={runs}
            planAbove={!!pm && (pendingPlan(t) ? gated : !!t.plan_decision)}
          />,
        )}
        {panel("runs", runsSeen ? <RunsPanel state={runs} /> : null)}
      </div>
    </div>
  );
}

/** The task's small "Recurring" link to the routine(s) made from it — nothing when none. */
function RecurringProperty({ t }: { t: Task }) {
  const { cid } = useSnapshot();
  const routines = useTaskRoutines(cid, t.id);
  if (!routines || !routines.length) return null;
  return (
    <PropertySection>
      <Property label="Routine">
        <RecurringLink routines={routines} />
      </Property>
    </PropertySection>
  );
}

/* ============================================================================
   The detail pane — the Linear header row (← · glyph · ID · title · ⋯ …
   1 / N ↑ ↓ · ⤢ · ✕) over the detail body. One component for the split
   inspector (`mode="inspector"`), the narrow pushed detail (`"narrow"`) and
   the full view (`"full"`). `t` null + `children` = the not-found state.
   ========================================================================== */
export interface DetailPager {
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
}

export function TaskDetailPane({
  t,
  mode,
  onClose,
  onExpand,
  onBack,
  backLabel = "Back to tasks",
  pager,
  tab,
  onTab,
  acted,
  onActed,
  thread,
  children,
}: {
  t: Task | null;
  mode: "inspector" | "narrow" | "full";
  onClose?: () => void;
  onExpand?: () => void;
  onBack?: () => void;
  backLabel?: string;
  pager?: DetailPager | null;
  tab: TabKey;
  onTab: (k: TabKey) => void;
  acted: boolean;
  onActed: (id: string) => void;
  thread: ThreadCache | null;
  /** body for the not-found state (t null) */
  children?: ReactNode;
}) {
  const { snap, refresh } = useSnapshot();
  // PS-29: the connection-aware actor (null while offline / read-only)
  const actor = useActor();
  const toast = useToast();
  const noHuman = useNoHumanReason();
  const runs = useTaskRuns(t ? t.id : null);
  const cancelRef = useRef<(() => void) | null>(null);
  const [unassignOpen, setUnassignOpen] = useState(false);
  // "Make recurring…": a routine pre-filled as a COPY of this task (the task is never changed)
  const recurGate = useMakeRecurringGate();
  const [recurOpen, setRecurOpen] = useState(false);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  // TG-50: hold / release / unassign — the human dispatch controls
  // (POST /api/tasks/{tid}/readiness and /unassign, both human-authority)
  const dispatch = async (kind: "hold" | "release" | "unassign") => {
    if (!t) return;
    if (!actor) {
      toast(noHuman, "danger");
      return;
    }
    setDispatchBusy(true);
    let r: { ok: boolean; status: number; d: { status?: string; detail?: unknown } };
    try {
      r =
        kind === "unassign"
          ? await post("/api/tasks/" + encodeURIComponent(t.id) + "/unassign", { actor_agent_id: actor.id })
          : await post("/api/tasks/" + encodeURIComponent(t.id) + "/readiness", { actor_agent_id: actor.id, ready: kind === "release" });
    } catch {
      r = { ok: false, status: 0, d: {} };
    }
    setDispatchBusy(false);
    if (r.ok) {
      const st = r.d.status;
      toast(
        kind === "hold"
          ? "Task on hold — agents won't pick it up"
          : kind === "release"
            ? st === "pending"
              ? "Released — starts when its dependencies complete"
              : "Released — ready for an agent"
            : "Unassigned — back in the queue",
        "ok",
      );
      setUnassignOpen(false);
      void refresh();
      return;
    }
    const why = detailText(r.d);
    toast((kind === "hold" ? "Hold" : kind === "release" ? "Release" : "Unassign") + " failed" + (r.status ? " (" + r.status + ")" : " — the portal could not be reached") + (why ? ": " + why : ""), "danger");
  };
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const paneRef = useRef<HTMLElement | null>(null);
  // full view: the header shows glyph + ID only while the H1 is on screen and
  // fades the title in once the H1 scrolls under the header (never twice)
  const [h1Visible, setH1Visible] = useState(true);
  const tid = t ? t.id : null;
  useEffect(() => {
    if (mode !== "full" || !tid) return;
    const h1 = paneRef.current?.querySelector(".td-title");
    if (!h1 || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => setH1Visible(es[es.length - 1].isIntersecting), { rootMargin: "-96px 0px 0px 0px", threshold: 0 });
    io.observe(h1);
    return () => io.disconnect();
  }, [mode, tid]);

  const copy = (text: string, what: string) => {
    try {
      void navigator.clipboard?.writeText(text).then(
        () => toast(what + " copied", "ok"),
        () => toast("Couldn't copy — select and copy it manually: " + text, "danger"),
      );
    } catch {
      toast("Couldn't copy — select and copy it manually: " + text, "danger");
    }
  };

  const back = onBack ? <IconButton icon="arrow-left" label={backLabel} variant="outline" className="td-back" onClick={onBack} /> : null;

  const pr = t ? prOf(t.result) : null;
  const taskLink = t ? (typeof window !== "undefined" ? window.location.origin : "") + "/tasks?task=" + encodeURIComponent(t.id) : "";
  let menu: (MenuItemSpec | "separator")[] = [];
  if (t) {
    const assignee = agentByAlias(snap, t.assignee);
    const aiAssignee = assignee && assignee.kind !== "human" ? assignee : null;
    menu = [
      { label: "Copy link", icon: "link", onSelect: () => copy(taskLink, "Link") },
      { label: "Copy task ID", icon: "copy", hint: shortId(t.id), onSelect: () => copy(String(t.id), "Task ID") },
      ...(pr ? [{ label: "Open pull request", icon: "pr", hint: "#" + pr.number, onSelect: () => void window.open(pr.url, "_blank", "noopener") } as MenuItemSpec] : []),
      "separator",
      { label: "Open runs", icon: "live", onSelect: () => onTab("runs") },
      ...(assignee ? [{ label: "Open " + (assignee.kind === "human" ? "assignee" : "agent"), icon: "agents", href: "/agents?agent=" + encodeURIComponent(assignee.alias), hint: assignee.alias } as MenuItemSpec] : []),
      // S3 §3b live terminal: pairing lives on the Agents page conversation panel —
      // deep-link into the real pairing surface for this task's assignee.
      // e2e-permissions-21: gated like Cancel task… — pairing is a human-authority
      // action (the Agents page's Pair button is disabled for a viewer too)
      aiAssignee && actor
        ? { label: "Pair in terminal", icon: "play", href: "/agents?agent=" + encodeURIComponent(aiAssignee.alias), hint: aiAssignee.alias }
        : aiAssignee
          ? { label: "Pair in terminal", icon: "play", hint: aiAssignee.alias, disabled: true, disabledReason: noHuman }
          : { label: "Pair in terminal", icon: "play", disabled: true, disabledReason: "No agent assigned — assign an agent to pair in a terminal" },
    ];
    const recurItem = makeRecurringItem(recurGate, () => setRecurOpen(true), t);
    if (recurItem) menu.push("separator", recurItem);
    // TG-50: readiness + unassign (the server refuses root / finished tasks)
    const finished = ["completed", "needs_verification", "cancelled"].indexOf(t.status) >= 0;
    const dispatchItems: MenuItemSpec[] = [];
    if (!t.is_root && !finished) {
      const gate = (spec: MenuItemSpec): MenuItemSpec => (actor ? spec : { ...spec, onSelect: undefined, disabled: true, disabledReason: noHuman });
      if (t.status === "not_ready") {
        dispatchItems.push(gate({ label: "Release hold", icon: "play", hint: "make it ready", disabled: dispatchBusy, onSelect: () => void dispatch("release") }));
      } else if (t.status === "ready" || t.status === "pending") {
        dispatchItems.push(gate({ label: "Put on hold", icon: "clock", hint: "agents skip it", disabled: dispatchBusy, onSelect: () => void dispatch("hold") }));
      }
      if (t.assignee) {
        dispatchItems.push(gate({ label: "Unassign…", icon: "x", hint: t.assignee, disabled: dispatchBusy, onSelect: () => setUnassignOpen(true) }));
      }
    }
    if (dispatchItems.length) menu.push("separator", ...dispatchItems);
    const closable = !(t.is_root || t.status === "completed" || t.status === "cancelled");
    if (closable) {
      menu.push(
        "separator",
        actor
          ? { label: "Cancel task…", icon: "x", danger: true, onSelect: () => cancelRef.current?.() }
          : { label: "Cancel task…", icon: "x", danger: true, disabled: true, disabledReason: noHuman },
      );
    }
  }

  const header = (
    <div className="td-head">
      {back}
      <PageHeader
        className="td-pagehead"
        titleAs="div"
        glyph={t ? <StatusIcon status={t.status} size={14} /> : undefined}
        id={t ? <span className="v2-t-id td-id" title={"Task " + t.id}>{shortId(t.id)}</span> : undefined}
        // the inspector's title lives in the body (D12: never twice); the
        // full view keeps Linear's "ID  Title ☆ ⋯" header row
        title={t ? (mode === "full" ? t.title : null) : "Task"}
        trailing={
          t ? (
            <>
              <IconButton ref={moreRef} icon="more" label="Task actions" size="sm" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)} />
              <Menu anchor={moreRef} open={moreOpen} onClose={() => setMoreOpen(false)} items={menu} label="Task actions" placement="bottom-start" />
            </>
          ) : undefined
        }
        actions={
          <>
            {t && mode === "full" ? (
              <span className="td-head-acts">
                <IconButton icon="link" label="Copy link" variant="outline" size="sm" onClick={() => copy(taskLink, "Link")} />
                <IconButton icon="copy" label={"Copy task ID (" + shortId(t.id) + ")"} variant="outline" size="sm" onClick={() => copy(String(t.id), "Task ID")} />
                {pr ? (
                  <a
                    className={iconButtonClass({ size: "sm", variant: "outline" }, "td-pr-btn")}
                    href={pr.url}
                    target="_blank"
                    rel="noopener"
                    aria-label={"Open pull request #" + pr.number}
                    title={"Open pull request #" + pr.number}
                  >
                    <Icon name="pr" cls="v2-ico" />
                  </a>
                ) : null}
              </span>
            ) : null}
            {pager && pager.total > 1 ? <Pager index={pager.index} total={pager.total} onPrev={pager.onPrev} onNext={pager.onNext} noun="task" /> : null}
            {onExpand ? <IconButton icon="maximize" label="Open full view" size="sm" onClick={onExpand} /> : null}
            {onClose ? <IconButton icon="x" label="Close details" size="sm" onClick={onClose} /> : null}
          </>
        }
      />
    </div>
  );

  return (
    <section ref={paneRef} className={"td-pane is-" + mode} aria-label={t ? "Task: " + t.title : "Task"} data-v2-surface="panel" data-h1-visible={mode === "full" ? String(h1Visible) : undefined}>
      <style>{composerCss}</style>
      {header}
      {t && recurOpen ? <MakeRecurringDialog task={t} onClose={() => setRecurOpen(false)} /> : null}
      {t && unassignOpen ? (
        <Dialog
          title="Unassign this task?"
          description={
            (t.assignee ? t.assignee + " is released" : "The assignee is released") +
            (t.status === "in_progress" ? " and the task goes back to the queue. A run that is already executing isn't stopped." : ". The task stays " + statusMeta(t.status).l.toLowerCase() + ".")
          }
          size="sm"
          onClose={() => {
            if (!dispatchBusy) setUnassignOpen(false);
          }}
          footer={
            <>
              <Button variant="ghost" disabled={dispatchBusy} onClick={() => setUnassignOpen(false)}>
                Keep assignee
              </Button>
              <Button variant="primary" busy={dispatchBusy} disabled={!actor} onClick={() => void dispatch("unassign")}>
                Unassign
              </Button>
            </>
          }
        />
      ) : null}
      {t && thread ? (
        <TaskDetail
          key={t.id}
          t={t}
          tab={tab}
          onTab={onTab}
          acted={acted}
          onActed={onActed}
          thread={thread}
          runs={runs}
          cancelRef={cancelRef}
          mode={mode}
        />
      ) : (
        <div className="td-missing">{children}</div>
      )}
    </section>
  );
}

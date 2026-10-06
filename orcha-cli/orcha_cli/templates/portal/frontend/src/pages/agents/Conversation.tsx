/**
 * S1 conversation panel (+ S4 slash autocomplete, S5 presence, #337
 * attachments) — React port of static/conversation.js for one agent. The
 * component is remounted per agent (key={agent.id}) which mirrors the vanilla
 * mount()/teardown() lifecycle; all composer state lives in useState so the 3s
 * poll never clobbers typing.
 *
 * Contracts (Vault conv-store #115 — STABLE, copied exactly):
 *   POST /api/agents/{aid}/conversations {actor_agent_id}        get-or-create
 *   GET  /api/agents/{aid}/conversation?limit=N                  {conversation, turns}
 *   GET  /api/conversations/{cid}/turns?after_seq=S&limit=N      {turns} (oldest->newest)
 *   GET  /api/conversations/{cid}                                 presence refresh
 *   POST /api/conversations/{cid}/turns {role,author_agent_id,content,attachments?}
 *   POST /api/conversations/{cid}/attachments                     multipart upload
 *
 * The live terminal ("Pair in terminal", S3 §3b) is the React port of the
 * conversation.js pairing half — see components/terminal/TerminalPane
 * (usePairing) on top of the OrchaTerm engine port (terminal.js contract,
 * UNCHANGED).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { registerTestReset } from "../../lib/testResets";
import { getJSON } from "../../api/client";
import { MessageComposer } from "../../components/MessageComposer";
import { usePairing } from "../../components/terminal/TerminalPane";
import { Icon, Md, useToast } from "../../components/ui";
import { Avatar, Button, HelpTip, IconButton, RelTime, WorkedFor, formatDuration } from "../../components/primitives";
import { ChatBubble, ChatThread } from "../../components/primitives";
import { ContextChip } from "../../components/primitives";
import { humanKey } from "../requests/requestPayload";
import { mdText, relTime } from "../../lib/format";
import { leaseOf } from "../../lib/status";
import { actingHuman, OFFLINE_REASON, useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Run, Snapshot } from "../../types";
import { useLiveChangesCtx } from "./liveChangesContext";
import { LiveChangesButton } from "./LiveChangesPanel";
import { formatElapsed, RunChanges, WorkLogDetails, WorkLogStream, useLiveTurn, useStopRun, type LiveTurnStep } from "./runlog";
import { runEnded, runOutcome, runStarted } from "../activity/runModel";
import { projectServed, RUNTIME_REASON, type ConvPresence } from "./presence";
import { NO_ACTING_HUMAN } from "./agentModel";

interface ConvAtt {
  id?: string;
  url?: string;
  name?: string;
  size?: number;
  kind?: string;
}
interface ConvTurn {
  id?: string;
  seq: number;
  role: string;
  author_agent_id?: string | null;
  content?: string;
  created_at?: string;
  run_id?: string | null;
  meta?: any;
  attachments?: ConvAtt[];
}
interface Staged {
  key: number;
  name: string;
  size: number;
  kind: string;
  status: "uploading" | "done" | "failed";
  ref?: any;
}
// the optimistic just-sent turn: the composer's text + staged refs live here
// until the server owns the turn (vanilla conversation-composer.js pendingLocal).
interface PendingLocal {
  content: string;
  atts: { id: string; name: string }[];
  keepStaged: Staged[];
  authorId: string;
  at: number;
  status: "sending" | "failed";
  err: string | null;
}

// the /-palette mirrors the CLI work skills (presentational; sends as turn content)
const SKILL_DESC: Record<string, string> = {
  "/orcha-status": "Project and task status",
  "/orcha-next": "Pick up the next ready task",
  "/orcha-task-new": "Create a task",
  "/orcha-post": "Post a message on a task",
  "/orcha-done": "Mark the current task done",
  "/orcha-ask": "Ask another agent or a human",
  "/orcha-inbox": "Requests waiting on this agent",
  "/orcha-outbox": "Requests this agent sent",
  "/orcha-respond": "Answer a request",
  "/orcha-close": "Close a request",
  "/orcha-escalate": "Escalate a request to a human",
  "/orcha-convert": "Turn a request into a task",
  "/orcha-accept-task": "Accept a task in verification",
  "/orcha-reject-task": "Send a task back with a reason",
};
const SKILLS = Object.keys(SKILL_DESC);

const ACCEPT_EXT = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "csv", "log", "json"];
const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp"];
const extOf = (n: unknown) => (String(n || "").split(".").pop() || "").toLowerCase();
const FILE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
function fmtSize(n: unknown): string {
  const v = +(n as number) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + " KB";
  return (v / (1024 * 1024)).toFixed(1) + " MB";
}

const PRES_LABEL: Record<string, string> = { idle: "idle", waking: "waking", working: "working", busy: "busy", replied: "replied", stopped: "offline" };

/* ---- D4: a tool_input / payload as readable fields, never a raw JSON dump ---- */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) => v == null || ["string", "number", "boolean"].includes(typeof v);
function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return "";
  }
}
function FieldValue({ v }: { v: unknown }) {
  if (v == null || v === "") return <span className="muted">—</span>;
  if (typeof v === "boolean") return <span>{v ? "Yes" : "No"}</span>;
  if (typeof v === "number") return <span className="mono">{v}</span>;
  if (typeof v === "string") {
    // commands, paths and multi-line text read best as wrapped monospace
    return v.length > 60 || /\n|[/\\$|&;<>]/.test(v) ? <pre className="gval">{v}</pre> : <span>{v}</span>;
  }
  if (Array.isArray(v) && v.every(isScalar)) return <span>{v.map((x) => (x == null ? "—" : String(x))).join(", ") || "none"}</span>;
  return (
    <details className="graw">
      <summary>{Array.isArray(v) ? v.length + " items" : Object.keys(v as Obj).length + " fields"}</summary>
      <pre className="gval">{prettyJson(v)}</pre>
    </details>
  );
}
export function ToolInput({ value }: { value: unknown }) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    // a string tool_input may itself be JSON — parse it so it reads as fields
    let parsed: unknown = null;
    if (/^\s*[{[]/.test(value)) {
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = null;
      }
    }
    if (parsed != null && typeof parsed === "object") return <ToolInput value={parsed} />;
    return <pre className="gval">{value}</pre>;
  }
  if (!isObj(value)) return <FieldValue v={value} />;
  const entries = Object.entries(value);
  if (!entries.length) return null;
  return (
    <dl className="gkv">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt title={k}>{humanKey(k)}</dt>
          <dd>
            <FieldValue v={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ---- multi-project: is a HOST-SIDE notifier serving this container? ----
 * The daemon's per-tick wake-scan poll stamps containers.last_wake_scan_at
 * (mig 037, throttled to one write/15s), so a stamp within the last ~2 minutes
 * means "an `orcha init`-bound workspace's daemon serves THIS project's
 * wakes". NULL/stale ⇒ portal-only: full CRUD works, but nothing wakes agents
 * until host-side glue binds a workspace. Absent data reads as SERVED so the
 * chat never false-alarms while booting. (./presence — shared with the header.) */
const convWakesServed = (snap: Snapshot | null) => projectServed(snap);

// ISS-68: per-agent conversation cache so switching agent tabs and back does
// NOT reload the thread from scratch. Module-level, mirrors the vanilla cache.
const convCache: Record<
  string,
  { convId: string | null; convStatus: string | null; turns: ConvTurn[]; lastSeq: number; presence: string | null; presenceReason: string | null; at: number }
> = {};
const CONV_CACHE_TTL_MS = 60000;
registerTestReset(() => { for (const k of Object.keys(convCache)) delete convCache[k]; });
const CONV_PAGE = 20;

/* ---------- ISS-64: persist the composer draft across navigation ---------- */
const draftKey = (aid: string) => "orcha:convdraft:" + aid;
function saveDraft(aid: string, v: string): void {
  try {
    if (v) sessionStorage.setItem(draftKey(aid), v);
    else sessionStorage.removeItem(draftKey(aid));
  } catch { /* private mode */ }
}
function loadDraft(aid: string): string {
  try {
    return sessionStorage.getItem(draftKey(aid)) || "";
  } catch {
    return "";
  }
}

function presenceOf(
  presence: string | null,
  presenceReason: string | null,
  convStatus: string | null,
  agent: Agent,
): { k: string; l: string; reason?: string | null } {
  if (presence != null) { // backend is talking — trust it
    const known = Object.prototype.hasOwnProperty.call(PRES_LABEL, presence);
    const l = known ? PRES_LABEL[presence] : "idle"; // forward-compat: unknown -> idle
    const k = known && presence === "stopped" ? "offline" : known ? presence : "idle";
    return { k, l, reason: presenceReason || null };
  }
  if (convStatus === "ended") return { k: "offline", l: "offline" };
  // V2 honesty: with no presence from the backend, an agent holding a TASK lease
  // (ephemeral worker) is busy elsewhere — its "working" status is not work on this chat.
  if (leaseOf(agent) === "ephemeral") return { k: "busy", l: "busy" };
  switch (agent.status) {
    case "working":
    case "in_progress":
      return { k: "working", l: "working" };
    case "awaiting_human":
    case "awaiting_request":
      return { k: "waking", l: "waiting" };
    case "needs_verification":
      return { k: "replied", l: "replied" };
    case "terminated":
      return { k: "offline", l: "offline" };
    case "failed":
      return { k: "failed", l: "failed" };
    default:
      return { k: "idle", l: "idle" };
  }
}

function AttRow({ a, onZoom }: { a: ConvAtt; onZoom: (url: string) => void }) {
  const url = a.url || "";
  const nm = a.name || a.id || "file";
  if (a.kind === "image") {
    return (
      <figure className="att-fig">
        <img className="att-img" src={url} alt={nm} title={nm} loading="lazy" onClick={() => onZoom(url)} />
        <figcaption title={nm}>
          <span className="nm">{nm}</span>
          {a.size ? <span className="sz">{fmtSize(a.size)}</span> : null}
        </figcaption>
      </figure>
    );
  }
  return (
    <a className="att-file" href={url} target="_blank" rel="noopener" download title={nm}>
      <span className="att-ic" dangerouslySetInnerHTML={{ __html: FILE_ICON }} />
      <span className="nm">{nm}</span>
      {a.size ? <span className="sz">{fmtSize(a.size)}</span> : null}
    </a>
  );
}

// PR2/E4 will make these interactive; render the affordance forward-compatibly.
function GateCardBubble({ meta, onPair }: { meta: any; onPair?: () => void }) {
  if (meta.type === "permission_request") {
    return (
      <div className="gcard perm">
        <div className="gh">
          <Icon name="shield" cls="" />
          Permission requested{meta.tool_name ? " · " + meta.tool_name : ""}
        </div>
        {meta.tool_input ? (
          <div className="gpre">
            <ToolInput value={meta.tool_input} />
          </div>
        ) : null}
        <div className="gfoot">
          <span className="gnote">Allow or deny from a live terminal session.</span>
          {onPair ? (
            <Button variant="secondary" size="sm" icon="play" onClick={onPair}>
              Pair in terminal
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="gcard ask">
      <div className="gh">
        <Icon name="spark" cls="" />
        {meta.question || "Needs an answer"}
      </div>
      <div className="gnote">Answer by replying in this conversation.</div>
    </div>
  );
}

// V2 truthful delivery: a durable human turn is SAVED (the server owns it) — that is
// all the backend can confirm; there is no per-turn "agent picked it up" ack. While no
// agent turn follows it, it reads "sent · awaiting reply", or "queued" when nothing can
// pick it up right now (no runtime / wakes paused / agent busy). The agent's own turn is
// the only "response".
type Delivery = "sent" | "delivered" | "saved" | "queued" | "unknown" | null;
const DELIVERY_TEXT: Record<Exclude<Delivery, null>, string> = {
  sent: "sent · awaiting reply",
  // D16: a run started on this conversation after the turn was saved — the agent has it
  delivered: "delivered",
  // the tail note right under the turn already says queued / unknown and why (D12)
  saved: "saved",
  queued: "saved · queued",
  unknown: "saved · reply status unknown",
};

const runIdOf = (r: Run | null | undefined) => (r ? String(r.run_id || r.id || "") : "");
const turnKey = (t: ConvTurn) => "t:" + (t.id != null ? String(t.id) : "s" + t.seq);

/* ---------- thread motion (CSS + Web Animations API only) ---------- */
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)"; // ease-out-quint: fast start, soft landing
function reducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
/** The enter motion for one new thread item: a user bubble springs up from its corner, an
 *  agent block rises and fades in. A turn that REPLACES the live stream (it lands right under
 *  the live block, which already shows the same text in the same place) gets NO animation —
 *  the swap must be invisible, so already-visible text never dims. transform/opacity only. */
export function enterMotion(el: Element): { frames: Keyframe[]; duration: number } | null {
  if (el.previousElementSibling?.classList.contains("conv-live")) return null;
  const user = el.classList.contains("v2-msg-user");
  return user
    ? { frames: [{ opacity: 0, transform: "translateY(10px) scale(0.97)" }, { opacity: 1, transform: "none" }], duration: 220 }
    : { frames: [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], duration: 240 };
}
function animateEnter(el: HTMLElement): void {
  if (reducedMotion() || typeof el.animate !== "function") return;
  const m = enterMotion(el);
  if (m) el.animate(m.frames, { duration: m.duration, easing: EASE_OUT });
}

/** Re-render every second while `on` (the live elapsed timer). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [on]);
  return now;
}

/** Mid-stream, an unclosed "**" / "`" would flash as a literal marker until it closes:
 *  hold the dangling one back (the next frame usually closes it). */
function balanceMarkers(t: string): string {
  let s = t.replace(/\s+$/, "");
  if ((s.match(/\*\*/g) || []).length % 2) { const i = s.lastIndexOf("**"); s = s.slice(0, i) + s.slice(i + 2); }
  if ((s.replace(/```/g, "").match(/`/g) || []).length % 2) { const i = s.lastIndexOf("`"); s = s.slice(0, i) + s.slice(i + 1); }
  return s;
}
const CHUNK_FADE_MS = 320;
/**
 * The streamed reply, rendered with the SAME markdown renderer as the durable turn
 * (so the swap at the end changes nothing on screen). Each frame's new characters are
 * wrapped in their own fading span; a chunk still fading when the next frame lands keeps
 * its place in the fade (negative animation-delay), and a soft caret trails the live edge.
 * Imperative on purpose: one innerHTML write per animation frame, no React diff of text.
 */
const StreamText = memo(function StreamText({ text, live, tasks }: { text: string; live: boolean; tasks: Snapshot["tasks"] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const st = useRef<{ len: number; chunks: { start: number; at: number }[] }>({ len: 0, chunks: [] });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = mdText(balanceMarkers(text), tasks ?? []);
    const now = performance.now();
    const s = st.current;
    const L = (el.textContent || "").length;
    if (L < s.len) s.chunks = []; // text restarted (a new reply segment): no fade replay
    else if (L > s.len && s.len > 0 && !reducedMotion()) s.chunks.push({ start: s.len, at: now });
    s.len = L;
    s.chunks = s.chunks.filter((c) => now - c.at < CHUNK_FADE_MS);
    if (s.chunks.length) {
      // walk the text nodes once; wrap each still-fading chunk's characters
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
      let off = 0;
      for (const node of nodes) {
        const len = node.data.length;
        const nodeStart = off;
        off += len;
        let cur: Text = node;
        let curStart = nodeStart;
        for (let ci = 0; ci < s.chunks.length; ci++) {
          const c = s.chunks[ci];
          const end = ci + 1 < s.chunks.length ? s.chunks[ci + 1].start : Infinity;
          const a = Math.max(c.start, curStart);
          const b = Math.min(end, curStart + cur.data.length);
          if (b <= a) continue;
          if (a > curStart) { cur = cur.splitText(a - curStart); curStart = a; }
          const rest = b < curStart + cur.data.length ? cur.splitText(b - curStart) : null;
          const span = document.createElement("span");
          span.className = "lt-chunk";
          span.style.animationDelay = -Math.round(now - c.at) + "ms";
          cur.parentNode?.insertBefore(span, cur);
          span.appendChild(cur);
          if (!rest) break;
          cur = rest;
          curStart = b;
        }
      }
    }
    if (live) {
      const caret = document.createElement("span");
      caret.className = "lt-caret";
      caret.setAttribute("aria-hidden", "true");
      // right after the last character (inside its paragraph / list item). The caret is an
      // EMPTY inline with zero layout width (its bar is an absolutely positioned ::after), so
      // it can never wrap onto a line of its own: the streamed block lays out exactly like
      // the durable turn's text (same height, same line breaks).
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.trim()) last = n;
      if (last && last.parentNode) last.parentNode.insertBefore(caret, last.nextSibling);
      else el.appendChild(caret);
    }
  }, [text, live, tasks]);
  return <div ref={ref} className={"tx md lt-text" + (live ? " is-live" : "")} />;
});

function StepGlyph({ state }: { state: "done" | "current" }) {
  return state === "done" ? (
    <svg className="lt-glyph" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6.2 5 8.2 9 3.8" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" /></svg>
  ) : (
    <span className="lt-glyph lt-pulse" aria-hidden="true" />
  );
}

/** The live step rail: the last three real steps (tool calls, thinking); each new one
 *  slides in, the one it pushes out collapses away, the rest fold into "N earlier". */
const StepRail = memo(function StepRail({ steps, activity, live, onGone }: { steps: LiveTurnStep[]; activity: string | null; live: boolean; onGone?: () => void }) {
  // every real step: tool calls, thinking bursts and the narration the agent wrote
  // before its last tool (the reply itself is the text below the rail)
  const rail = steps.map((s, i) => ({ ...s, i }));
  const [all, setAll] = useState(false);
  const VIS = 3;
  const win = all ? rail : rail.slice(-(VIS + 1));
  const leaving = !all && rail.length > VIS ? win[0]?.i : -1;
  const earlier = all ? 0 : Math.max(0, rail.length - VIS);
  if (!rail.length) return null;
  return (
    <div className={"lt-railwrap" + (live ? "" : " is-gone")} onTransitionEnd={(e) => { if (!live && e.target === e.currentTarget) onGone?.(); }}>
      <ol className="lt-rail" aria-label="Steps so far">
        {earlier > 0 ? (
          <li className="lt-more">
            <button type="button" onClick={() => setAll(true)}>{earlier} earlier {earlier === 1 ? "step" : "steps"}</button>
          </li>
        ) : null}
        {win.map((s, j) => {
          const current = live && j === win.length - 1;
          return (
            <li
              key={s.i}
              className={"lt-step k-" + s.kind + (current ? " is-current" : "") + (s.i === leaving ? " is-leaving" : "") + (current && activity === s.label ? " conv-activity" : "")}
              title={s.label}
            >
              <StepGlyph state={current ? "current" : "done"} />
              <span className="lt-label">{s.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
});

/**
 * D16 live turn — the reply in progress, streamed from the run's own output: the
 * "Working… 12s ▸" line (shimmer; expands the live work log), the step rail, then the
 * reply text as it is written. When the run ends it FREEZES in place as "Worked for
 * 18 sec": the rail collapses, and once the durable turn is on screen the parent swaps
 * this block for that turn in the same position (same line, same text).
 */
function LiveTurn({ agentId, alias, run, tasks, settling, owned, onEnded, onSettled }: {
  agentId: string;
  tasks: Snapshot["tasks"];
  alias: string;
  run: Run;
  /** the run already ended (frozen, waiting for its durable turn) */
  settling: boolean;
  /** the run's durable turn is already on screen right after this block (text hidden here) */
  owned: boolean;
  onEnded: (runId: string, status: string | null) => void;
  onSettled: (runId: string) => void;
}) {
  const rid = runIdOf(run);
  const live = useLiveTurn(agentId, rid);
  const lc = useLiveChangesCtx();
  const ended = settling || live.done;
  const now = useNow(!ended);
  const endAt = useRef<number | null>(null);
  if (ended && endAt.current == null) endAt.current = Date.now();
  useEffect(() => {
    if (live.done) onEnded(rid, live.status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.done]);
  const hasRail = live.steps.length > 0;
  const [railGone, setRailGone] = useState(false);
  // no rail to collapse (or no motion): it is "gone" as soon as the run ends
  useEffect(() => {
    if (!ended) return;
    if (!hasRail || reducedMotion()) { setRailGone(true); return; }
    const t = setTimeout(() => setRailGone(true), 400); // transitionend backstop
    return () => clearTimeout(t);
  }, [ended, hasRail]);
  useEffect(() => {
    if (ended && owned && railGone) onSettled(rid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, owned, railGone]);
  const started = Date.parse(runStarted(run) || "") || live.startedAt || null;
  const ms = started ? Math.max(0, (ended ? (endAt.current as number) : now) - started) : null;
  const elapsed = formatElapsed(ms);
  const startedTitle = started ? "Started " + new Date(started).toLocaleString() : undefined;
  // C9b: a run that ended without finishing cleanly (stopped / failed / rate limited)
  // freezes with its real outcome — "Stopped after 3 sec" — never "Worked for".
  const endStatus = live.status || (run.status !== "running" ? run.status : null);
  const outcome = ended && endStatus ? runOutcome({ status: endStatus, exit_code: run.exit_code, kill_reason: run.kill_reason }) : null;
  const dur = formatDuration(ms);
  const label = ended ? (
    <>{outcome && outcome.bucket === "failed" ? (dur ? outcome.label + " after " + dur : outcome.label) : dur ? "Worked for " + dur : "Worked"}</>
  ) : (
    <>
      <span className="conv-shimmer" aria-hidden="true">Working…</span>
      {elapsed ? <span className="conv-elapsed" title={startedTitle} aria-hidden="true">{elapsed}</span> : null}
      <span className="ag-sr">{alias} is working{elapsed ? " · " + elapsed : ""} — show the live work log</span>
    </>
  );
  const text = owned ? "" : live.text;
  return (
    <div className={"conv-live" + (ended ? " is-settled" : " conv-working") + (owned ? " is-owned" : "")} data-run={rid} data-k={"live:" + rid}>
      {!ended ? <span className="ag-sr" role="status">{alias} is working</span> : null}
      <WorkedFor
        running={!ended}
        label={label}
        lazy
        meta={lc && !ended && lc.live && lc.runId === rid ? (
          <LiveChangesButton live summary={lc.summary} open={lc.isOpen} className="conv-live-changes" onClick={lc.open} />
        ) : undefined}
      >
        <WorkLogStream agentId={agentId} runId={rid} run={run} />
      </WorkedFor>
      <StepRail steps={live.steps} activity={live.activity} live={!ended} onGone={() => setRailGone(true)} />
      {text ? <StreamText text={text} live={!ended} tasks={tasks} /> : null}
    </div>
  );
}

// D9 (Linear agent panel, images 10/16): the human's turns are right-aligned
// bubbles with their time + honest delivery line under them; the agent's turns
// are plain text on the panel — "Worked for … ▸" (its run) above the reply, and
// a "Changed N files" card below it only when the run captured a real diff.
// Consecutive agent turns drop the repeated author line.
interface BubbleProps { t: ConvTurn; tasks: Snapshot["tasks"]; agentId: string; onZoom: (url: string) => void; delivery?: Delivery; deliveryWhy?: string; onPair?: () => void; run?: Run | null; grouped?: boolean; liveRunId?: string | null; swap?: boolean }
function BubbleImpl({ t, tasks, agentId, onZoom, delivery, deliveryWhy, onPair, run, grouped, liveRunId }: BubbleProps) {
  const human = t.role === "human";
  const meta = t.meta || {};
  const card = !human && (meta.type === "permission_request" || meta.type === "ask_human");
  const atts = t.attachments || [];
  const body = card ? <GateCardBubble meta={meta} onPair={onPair} /> : <Md className="tx md" text={t.content || ""} tasks={tasks ?? []} />;
  const attEls =
    atts.length > 0 ? (
      <div className="msg-atts">
        {atts.map((att, i) => (
          <AttRow key={att.id || i} a={att} onZoom={onZoom} />
        ))}
      </div>
    ) : null;
  if (human) {
    return (
      <ChatBubble
        from="user"
        compact
        className="turn human"
        dataKey={turnKey(t)}
        status={
          <span className="tmeta">
            <span className="tt" title={t.created_at ? new Date(t.created_at).toLocaleString() : undefined}>{t.created_at ? relTime(t.created_at) : ""}</span>
            {delivery ? <span key={delivery} className={"dlv " + delivery} title={deliveryWhy || undefined}>{DELIVERY_TEXT[delivery]}</span> : null}
          </span>
        }
      >
        {body}
        {attEls}
      </ChatBubble>
    );
  }
  // D16 (Linear agent panel): no author line — the panel is this agent's. Each turn
  // leads with how long its run worked ("Worked for 2 min 27 sec ▸ · 40m ago"); a
  // turn whose run is still live defers its work log to the ONE live block above it.
  const rid = t.run_id ? String(t.run_id) : "";
  const showWorked = !!rid && rid !== liveRunId;
  return (
    <ChatBubble from="agent" className={"turn agent" + (card ? " has-card" : "")} compact dataKey={turnKey(t)}>
      {showWorked ? (
        <WorkLogDetails agentId={agentId} runId={rid} run={run} at={t.created_at || null} />
      ) : !grouped && !rid && t.created_at ? (
        <div className="turn-time"><RelTime at={t.created_at} className="tt" /></div>
      ) : null}
      {body}
      {attEls}
      {t.run_id ? <RunChanges run={run} /> : null}
    </ChatBubble>
  );
}
/**
 * C9b: conversation runs that ended without an agent reply. A run belongs to the last
 * human turn saved before it started (2 s clock slack); it is reply-less when no turn
 * references it (run_id) AND no agent turn follows that human turn before the next
 * human turn (legacy replies without a run_id still count as the reply). One row per
 * human turn — the newest run wins. `afterIdx` is the turn index the row sits after.
 */
export function endedReplylessRuns(turns: ConvTurn[], runs: Run[], skipId: string | null): { run: Run; afterIdx: number }[] {
  const referenced = new Set(turns.map((t) => (t.run_id ? String(t.run_id) : "")).filter(Boolean));
  const byHuman = new Map<number, { run: Run; afterIdx: number; started: number }>();
  for (const r of runs) {
    const id = runIdOf(r);
    if (!id || id === skipId || referenced.has(id) || r.status === "running") continue;
    const started = Date.parse(runStarted(r) || "");
    if (!Number.isFinite(started)) continue;
    let h = -1;
    for (let i = 0; i < turns.length; i++) {
      const c = Date.parse(turns[i].created_at || "");
      if (turns[i].role === "human" && Number.isFinite(c) && c <= started + 2000) h = i;
    }
    if (h < 0) continue;
    let next = turns.length;
    for (let i = h + 1; i < turns.length; i++) if (turns[i].role === "human") { next = i; break; }
    let replied = false;
    for (let i = h + 1; i < next; i++) if (turns[i].role === "agent") { replied = true; break; }
    if (replied) continue;
    const prev = byHuman.get(h);
    if (!prev || started > prev.started) byHuman.set(h, { run: r, afterIdx: next - 1, started });
  }
  return Array.from(byHuman.values()).sort((a, b) => a.afterIdx - b.afterIdx).map(({ run, afterIdx }) => ({ run, afterIdx }));
}

/** A run that ended without a reply: its outcome ("Stopped after 3 sec ▸") IS the turn. */
function EndedRunRow({ agentId, run }: { agentId: string; run: Run }) {
  const rid = runIdOf(run);
  return (
    <ChatBubble from="agent" className="turn agent conv-ended-run" compact dataKey={"ended:" + rid}>
      <WorkLogDetails agentId={agentId} runId={rid} run={run} at={runEnded(run) || runStarted(run) || null} />
      <div className="tx conv-ended-note">{endedRunNote(run)}</div>
    </ChatBubble>
  );
}
export function endedRunNote(run: Run): string {
  const o = runOutcome(run);
  if (o.bucket !== "failed") return "Finished without a reply.";
  return "No reply — " + (o.reason || o.label.toLowerCase()) + ".";
}

// the run fields a turn actually renders (its duration, outcome, diff, captured log)
const runSig = (r: Run | null | undefined) =>
  r ? [r.status, runStarted(r), (r as any).ended_at, (r as any).exit_code, (r as any).kill_reason, (r.diff || "").length, (r.output || "").length, r.status === "running" ? Math.floor(Date.now() / 5000) : 0].join("|") : "";
/** Memoized: a poll / runs refresh / snapshot tick re-renders only the turns it changed. */
const Bubble = memo(BubbleImpl, (a, b) =>
  a.t === b.t && a.tasks === b.tasks && a.agentId === b.agentId && a.onZoom === b.onZoom && a.delivery === b.delivery &&
  a.deliveryWhy === b.deliveryWhy && !!a.onPair === !!b.onPair && a.grouped === b.grouped && a.liveRunId === b.liveRunId &&
  runSig(a.run) === runSig(b.run));

/* ---------- composer (isolated: typing never re-renders the thread) ---------- */
interface ComposerApi {
  /** Edit on a failed bubble: its text (before any newer draft) + staged files come back */
  restore: (content: string, keep: Staged[]) => void;
  addFiles: (files: FileList | File[]) => void;
}
interface ConvComposerProps {
  agentId: string;
  alias: string;
  placeholder: string;
  disabled: boolean;
  skillsDisabled: boolean;
  sending: boolean;
  stopShown: boolean;
  stopRequested: boolean;
  onStop: () => void;
  /** returns true when the turn was accepted (the composer then clears optimistically) */
  onSend: (v: string, done: Staged[], all: Staged[]) => boolean;
  ensureConv: () => Promise<{ ok: boolean; status?: number; noHuman?: boolean }>;
  getConvId: () => string | null;
  noHumanMsg: string;
}
const ConvComposer = memo(forwardRef<ComposerApi, ConvComposerProps>(function ConvComposer(
  { agentId, alias, placeholder, disabled, skillsDisabled, sending, stopShown, stopRequested, onStop, onSend, ensureConv, getConvId, noHumanMsg },
  ref,
) {
  const toast = useToast();
  const [draft, setDraftRaw] = useState(() => loadDraft(agentId)); // ISS-64 rehydrate
  const [staged, setStaged] = useState<Staged[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashClosed, setSlashClosed] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const stagedSeqRef = useRef(0);
  const setDraft = (v: string) => {
    setDraftRaw(v);
    saveDraft(agentId, v); // ISS-64: persist on every keystroke
  };

  /* #337 attachments */
  const uploadConvFiles = (files: FileList | File[] | null | undefined) => {
    const valid = Array.from(files || []).filter((f) => {
      if (f && ACCEPT_EXT.includes(extOf(f.name))) return true;
      toast("Unsupported file type: " + ((f && f.name) || "file"), "danger");
      return false;
    });
    if (!valid.length) return;
    void ensureConv().then((res) => {
      if (!res.ok) {
        toast(res.noHuman ? noHumanMsg : "Couldn't open conversation (" + (res.status || "") + ")", "danger");
        return;
      }
      const cid = getConvId() as string; // pin the conversation each file uploads to
      valid.forEach((f) => {
        const key = ++stagedSeqRef.current;
        setStaged((s) => [...s, { key, name: f.name, size: f.size, kind: IMG_EXT.includes(extOf(f.name)) ? "image" : "file", status: "uploading" }]);
        const fd = new FormData();
        fd.append("file", f, f.name);
        fetch("/api/conversations/" + encodeURIComponent(cid) + "/attachments", { method: "POST", body: fd })
          .then((r) => (r.ok ? r.json() : r.json().then((d: any) => Promise.reject(d.detail || "HTTP " + r.status))))
          .then((ref: any) => setStaged((s) => s.map((x) => (x.key === key ? { ...x, status: "done", ref, size: ref.size, kind: ref.kind } : x))))
          .catch((err) => {
            setStaged((s) => s.map((x) => (x.key === key ? { ...x, status: "failed" } : x)));
            toast("Upload failed: " + (err || f.name), "danger");
          });
      });
    });
  };
  const uploadRef = useRef(uploadConvFiles);
  uploadRef.current = uploadConvFiles;

  useImperativeHandle(ref, () => ({
    restore: (content, keep) => {
      setDraftRaw((cur) => {
        const next = (cur || "").trim() ? content + "\n\n" + cur : content;
        saveDraft(agentId, next);
        return next;
      });
      setStaged((cur) => (keep && keep.length ? [...keep, ...cur] : cur));
      setTimeout(() => taRef.current?.focus(), 0);
    },
    addFiles: (files) => uploadRef.current(files),
  }), [agentId]);

  const send = () => {
    const v = draft.trim();
    const done = staged.filter((s) => s.status === "done");
    if (!onSend(v, done, staged)) return;
    // optimistic: the composer clears in the same frame the pending bubble paints
    setSlashClosed(true);
    setDraft("");
    setStaged([]);
  };

  /* S4 slash palette (derived) */
  const slashQuery = draft.startsWith("/") && !draft.includes(" ") ? draft : null;
  const slashItems = slashQuery ? SKILLS.filter((s) => s.startsWith(slashQuery)) : [];
  const slashOpen = !!slashQuery && slashItems.length > 0 && !slashClosed;
  const pickSlash = (s: string) => {
    setDraft(s + " ");
    setSlashClosed(true);
    taRef.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashItems.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashItems.length) % slashItems.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashItems[slashIdx % slashItems.length]); return; }
      if (e.key === "Escape") { setSlashClosed(true); return; }
    }
  };
  const showStop = stopShown && !sending && !draft.trim() && !staged.length;

  return (
    <MessageComposer
      className={"conv-composer" + (showStop ? " has-stop" : "")}
      textareaClassName="conv-in"
      attachClassName="conv-attach"
      sendClassName="conv-send"
      sendLabel=""
      sendingLabel=""
      sendButtonData={{ "aria-label": sending ? "Sending…" : "Send message", title: "Send (Enter) · Shift+Enter for a new line" }}
      value={draft}
      onValueChange={(value) => {
        setDraft(value);
        setSlashClosed(false);
        setSlashIdx(0);
      }}
      onSend={send}
      onFiles={uploadConvFiles}
      placeholder={placeholder}
      ariaLabel={`Message ${alias}`}
      textareaId="convInput"
      attachButtonId="convAttach"
      fileInputId="convAttachInput"
      sendButtonId="convSend"
      disabled={disabled}
      sending={sending}
      textareaRef={(node) => { taRef.current = node; }}
      onTextareaKeyDown={onKeyDown}
      onTextareaBlur={() => setTimeout(() => setSlashClosed(true), 120)}
      leading={
        <>
          <div className="conv-tray" id="convTray">
            {staged.map((s) => (
              <span key={s.key} className={"att-chip" + (s.status === "uploading" ? " uploading" : s.status === "failed" ? " failed" : "")}>
                <ContextChip
                  icon={
                    s.status === "done" && s.ref && s.ref.kind === "image" ? (
                      <img className="thumb" src={s.ref.url} alt="" />
                    ) : (
                      <span className="ic" dangerouslySetInnerHTML={{ __html: FILE_ICON }} />
                    )
                  }
                  onRemove={() => setStaged((cur) => cur.filter((x) => x.key !== s.key))}
                  removeLabel={"Remove " + s.name}
                >
                  <span className="nm" title={s.name}>{s.name}</span>
                  <span className="sz">{s.status === "uploading" ? "uploading…" : s.status === "failed" ? "failed" : fmtSize(s.size)}</span>
                </ContextChip>
              </span>
            ))}
          </div>
          <button
            type="button"
            className="conv-skills"
            title={draft.trim() && !draft.startsWith("/") ? "Skills start a message — clear the draft or type / at the start" : "Embodent skills — or type / at the start of a message"}
            aria-label="Insert a Embodent skill"
            disabled={skillsDisabled || (!!draft.trim() && !draft.startsWith("/"))}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (!draft.startsWith("/")) setDraft("/");
              setSlashClosed(false);
              setSlashIdx(0);
              taRef.current?.focus();
            }}
          >
            <Icon name="spark" cls="v2-ico" />
            Skills
            <Icon name="chev" cls="v2-ico conv-skills-chev" />
          </button>
          {/* D16: while the turn's run is live and there is nothing to send, the
              circular send becomes a circular STOP (confirm-first, human-gated) */}
          {showStop ? (
            <IconButton
              glyph={<StopGlyph />}
              label={stopRequested ? "Stop requested" : "Stop run"}
              title={stopRequested ? "Stop requested — the worker halts at its next checkpoint" : `Stop ${alias}'s current run (the project keeps going)`}
              size="sm"
              shape="circle"
              variant="outline"
              className="conv-stop"
              id="convStop"
              disabled={stopRequested}
              onClick={onStop}
            />
          ) : null}
        </>
      }
      overlay={slashOpen ? (
        <div className="slash" id="convSlash">
          {slashItems.map((s, i) => (
            <div
              key={s}
              className={"si" + (i === slashIdx % slashItems.length ? " on" : "")}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(s);
              }}
            >
              <span className="si-cmd">{s}</span>
              <span className="si-desc">{SKILL_DESC[s]}</span>
            </div>
          ))}
        </div>
      ) : undefined}
    />
  );
}));

export function Conversation({
  agent,
  onPresence,
  runRunning,
  statusShown,
  liveRun: hostLiveRun,
}: {
  agent: Agent;
  /** the conversation's presence, lifted to the ONE workspace status pill */
  onPresence?: (p: ConvPresence) => void;
  /** a worker run is RUNNING right now (the host's /runs list): something serves this
   *  agent, so a stale wake scan is not "no runtime" (r2: "Working" beside "No agent runtime yet") */
  runRunning?: boolean;
  /** the host header's status key — when it already says "No runtime", the
   *  in-thread line would repeat that one fact (D12) */
  statusShown?: string | null;
  /** the host's running run for this agent (its one /runs read), when it has it — saves
   *  the conversation a second /runs read to find the live turn's run */
  liveRun?: Run | null;
}) {
  const { snap, connection, stale, bump } = useSnapshot();
  const toast = useToast();
  // why this person can't send: a viewer / non-member gets their role reason (they ARE
  // signed in — "pick an acting human" would mislead), else the pick-a-human hint
  const authority = useActingAuthority();
  const noHumanMsg = (authority.reason !== OFFLINE_REASON && authority.reason) || NO_ACTING_HUMAN;
  // viewer / non-member / unconfirmed identity: the composer is disabled with the reason.
  // Offline is NOT read-only here — a send then fails honestly with Retry (nothing lost).
  const readOnly = authority.readOnly && authority.reason !== OFFLINE_REASON;

  // ISS-68: rehydrate a fresh cache instantly (no flicker on tab switch).
  const cached = convCache[agent.id];
  const freshCache = cached && Date.now() - cached.at < CONV_CACHE_TTL_MS ? cached : null;
  const [convId, setConvId] = useState<string | null>(freshCache ? freshCache.convId : null);
  const [convStatus, setConvStatus] = useState<string | null>(freshCache ? freshCache.convStatus : null);
  const [turns, setTurns] = useState<ConvTurn[]>(freshCache ? freshCache.turns.slice() : []);
  const [loaded, setLoaded] = useState(!!freshCache);
  const [unavailable, setUnavailable] = useState(false);
  const [shown, setShown] = useState(10); // ISS-68 PR-3: most-recent 10 first; "Load earlier" reveals more
  const [awaiting, setAwaiting] = useState(false); // optimistic until the reply lands
  const [presence, setPresence] = useState<string | null>(freshCache ? freshCache.presence : null);
  const [presenceReason, setPresenceReason] = useState<string | null>(freshCache ? freshCache.presenceReason : null);
  // dup-send guard + optimistic pending bubble (vanilla conversation-composer.js)
  const [sending, setSending] = useState(false);
  const [pendingLocal, setPendingLocalRaw] = useState<PendingLocal | null>(null);
  const [dragover, setDragover] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  // S3 §3b live terminal pairing — owns paired/termConnected, the docked
  // terminal pane, the preempt/not-installed modals, and the ISS-65 maximize
  // state (exclusive across conv/term, mirroring the vanilla `maxed`).
  const pairing = usePairing(agent);
  const maxed = pairing.maxed === "conv"; // this panel's maximized state

  const convIdRef = useRef<string | null>(freshCache ? freshCache.convId : null);
  const lastSeqRef = useRef<number>(freshCache ? freshCache.lastSeq : 0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ComposerApi | null>(null);
  const atBottomRef = useRef(true);
  // V2: once the reader scrolls up, new turns never move the view — offer "Jump to latest"
  const [away, setAway] = useState(false);
  // wave-4: the thread fades in under its top edge once scrolled (no hard-clipped card)
  const [scrolled, setScrolled] = useState(false);
  const [unseen, setUnseen] = useState(false);
  // `sending` mirrored in a ref so a second Enter/click in the SAME tick (before
  // React re-renders) is still a no-op — the vanilla in-flight guard, race-proof.
  const sendingRef = useRef(false);
  const pendingLocalRef = useRef<PendingLocal | null>(null);
  // thread motion: keys already on screen (null until the first load paints — that
  // first paint never animates), and keys that must NOT animate (a durable turn that
  // replaces its own optimistic bubble in place)
  const seenKeysRef = useRef<Set<string> | null>(null);

  const setPendingLocal = (p: PendingLocal | null) => {
    pendingLocalRef.current = p;
    setPendingLocalRaw(p);
  };

  /* ---------- load + poll ---------- */
  const load = useCallback(async () => {
    try {
      const d: any = await getJSON("/api/agents/" + encodeURIComponent(agent.id) + "/conversation?limit=50");
      convIdRef.current = d.conversation ? d.conversation.id : null;
      setConvId(convIdRef.current);
      setConvStatus(d.conversation ? d.conversation.status || null : null);
      setPresence(d.presence || null);
      setPresenceReason(d.presence_reason || null); // top-level (Vault)
      const t: ConvTurn[] = d.turns || [];
      setTurns(t);
      lastSeqRef.current = t.length ? t[t.length - 1].seq : 0;
      setLoaded(true);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
      setLoaded(true);
    }
  }, [agent.id]);

  const [retrying, setRetrying] = useState(false);
  const retryLoad = () => {
    setRetrying(true);
    void load().finally(() => setRetrying(false));
  };

  const refreshPresence = useCallback((cid: string) => {
    // presence + presence_reason ride on GET /api/conversations/{id}; if the
    // endpoint/field isn't live yet this no-ops and we fall back to agent.status.
    getJSON<any>("/api/conversations/" + encodeURIComponent(cid))
      .then((d) => {
        setPresence(d.presence || null);
        setPresenceReason(d.presence_reason || null);
      })
      .catch(() => { /* not live yet -> keep status-derived */ });
  }, []);

  const poll = useCallback(async (turnsOnly = false) => {
    const cid = convIdRef.current;
    if (!cid) {
      void load();
      return;
    }
    if (!turnsOnly) refreshPresence(cid);
    try {
      const d: any = await getJSON("/api/conversations/" + encodeURIComponent(cid) + "/turns?after_seq=" + lastSeqRef.current + "&limit=50");
      const fresh: ConvTurn[] = d.turns || [];
      if (!fresh.length) return;
      if (fresh.some((t) => t.role === "agent")) setAwaiting(false); // reply landed -> stop "thinking"
      setTurns((prev) => {
        // dedupe the append by id/seq so an overlapped response (or the turn the
        // send POST already reconciled via settleSend) can never paint twice.
        const seen = new Set(prev.map((x) => (x.id != null ? "i:" + x.id : "q:" + x.seq)));
        const add = fresh.filter((t) => !seen.has(t.id != null ? "i:" + t.id : "q:" + t.seq));
        const next = add.length ? prev.concat(add) : prev;
        const tail = fresh[fresh.length - 1];
        if (typeof tail.seq === "number" && tail.seq > lastSeqRef.current) lastSeqRef.current = tail.seq;
        return next;
      });
    } catch { /* transient */ }
  }, [load, refreshPresence]);

  useEffect(() => {
    if (freshCache) void poll(); // background top-up via after_seq (append, not reload)
    else void load();
    const iv = setInterval(() => void poll(), 3000);
    return () => clearInterval(iv);
    // per-mount: the component is keyed by agent.id upstream
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // lift the conversation presence to the workspace header (one status, not two)
  useEffect(() => {
    onPresence?.({ presence, reason: presenceReason });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence, presenceReason]);

  // keep the ISS-68 cache current
  useEffect(() => {
    convCache[agent.id] = {
      convId: convIdRef.current,
      convStatus,
      turns: turns.slice(),
      lastSeq: lastSeqRef.current,
      presence,
      presenceReason,
      at: Date.now(),
    };
  }, [agent.id, convId, convStatus, turns, presence, presenceReason]);

  // D9: the runs behind agent turns ("Worked for …", "Changed N files") — fetched
  // only when the thread references a run or the host says a run is live (D16: the
  // live turn's run has no turn yet); re-read while one is still running.
  const runKey = Array.from(new Set(turns.map((t) => (t.run_id ? String(t.run_id) : "")).filter(Boolean))).join(",");
  const [runsById, setRunsById] = useState<Record<string, Run>>({});
  const [runsTick, setRunsTick] = useState(0);
  const hostLiveId = runIdOf(hostLiveRun);
  const tailIsHuman = turns.length > 0 && turns[turns.length - 1].role === "human";
  const wantRuns = !!runKey || !!runRunning || !!hostLiveId || awaiting || tailIsHuman;
  useEffect(() => {
    if (!wantRuns) return;
    let live = true;
    getJSON<any>("/api/agents/" + encodeURIComponent(agent.id) + "/runs")
      .then((d) => {
        if (!live) return;
        const list: Run[] = Array.isArray(d) ? d : (d && d.runs) || [];
        const m: Record<string, Run> = {};
        list.forEach((r) => {
          const id = runIdOf(r);
          if (id) m[id] = r;
        });
        setRunsById(m);
      })
      .catch(() => { /* no run detail: the turn keeps a plain "Work log" line */ });
    return () => {
      live = false;
    };
  }, [agent.id, runKey, runsTick, wantRuns, !!runRunning, hostLiveId]);
  // D16: the run live on THIS conversation right now (its own conversation_id, or a
  // conversation-lane run when the row predates that column). A task run is not a
  // turn: the thread never shows "Working…" for it. `endedRuns` drops a run the
  // instant its stream reports it finished (before the next runs read lands).
  const [endedRuns, setEndedRuns] = useState<Record<string, number>>({});
  const endedStatusRef = useRef<Record<string, string>>({});
  const ofThisConv = (r: Run | null | undefined): r is Run => {
    if (!r) return false;
    const x = r as Run & { conversation_id?: string | null; lane?: string | null; wake_event?: string | null };
    if (x.conversation_id) return !!convId && String(x.conversation_id) === String(convId);
    return x.lane === "conversation" || x.wake_event === "conversation_turn";
  };
  const onThisConv = (r: Run | null | undefined): r is Run => !!r && r.status === "running" && ofThisConv(r);
  // this panel's own runs read wins over the host's copy of the same run (fresher)
  const runPool: Record<string, Run> = hostLiveId && hostLiveRun ? { [hostLiveId]: hostLiveRun, ...runsById } : runsById;
  const liveRun: Run | null = Object.values(runPool).find((r) => onThisConv(r) && !endedRuns[runIdOf(r)]) || null;
  const liveRunId = liveRun ? runIdOf(liveRun) : null;
  // the run that just ended stays on screen, frozen, until its durable turn replaces it
  const [settle, setSettle] = useState<{ id: string; run: Run } | null>(null);
  // the finished run's own row (fresh from the runs read) wins over the frozen copy:
  // it carries the real outcome (kill_reason → "Stopped")
  const settleFresh = settle && runPool[settle.id] && runPool[settle.id].status !== "running" ? { ...settle.run, ...runPool[settle.id] } : null;
  const shownRun: Run | null = liveRun || (settle ? settleFresh || settle.run : null);
  const shownRunId = liveRunId || (settle ? settle.id : null);
  // re-read while the live turn (or a referenced run) runs, and while a sent message
  // waits (its turn's run may start any moment: a 2 s read so "Working…" follows fast)
  const lastIsHuman = tailIsHuman;
  // C9b: conversation runs that ENDED without posting a reply (stopped / failed / a
  // clean exit that said nothing). A stopped worker writes no turn, so the thread
  // shows the run's outcome as the turn's terminal state instead of "thinking" dots.
  const endedCands: Run[] = [];
  Object.values(runPool).forEach((r) => {
    if (!ofThisConv(r)) return;
    const id = runIdOf(r);
    if (r.status !== "running") endedCands.push(r);
    else if (endedRuns[id]) endedCands.push({ ...r, status: endedStatusRef.current[id] || "exited", ended_at: new Date(endedRuns[id]).toISOString() } as Run);
  });
  const endedOrphans = endedReplylessRuns(turns, endedCands, settle ? settle.id : null);
  const tailOrphan = lastIsHuman && endedOrphans.length > 0 && endedOrphans[endedOrphans.length - 1].afterIdx === turns.length - 1 ? endedOrphans[endedOrphans.length - 1] : null;
  const waitingForRun = !liveRun && !tailOrphan && (awaiting || lastIsHuman) && !!convId;
  const anyRunLive = !!liveRun || runKey.split(",").some((id) => runsById[id]?.status === "running") || (!!runRunning && (awaiting || lastIsHuman));
  useEffect(() => {
    if (!anyRunLive && !waitingForRun) return;
    const iv = setInterval(() => setRunsTick((n) => n + 1), waitingForRun && awaiting ? 2000 : 5000);
    return () => clearInterval(iv);
  }, [anyRunLive, waitingForRun, awaiting]);
  const liveRunRef = useRef<Run | null>(null);
  liveRunRef.current = liveRun;
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const onLiveEnded = useCallback((rid: string, status: string | null) => {
    const r = liveRunRef.current && runIdOf(liveRunRef.current) === rid ? liveRunRef.current : null;
    const at = Date.now();
    if (status && status !== "running") endedStatusRef.current[rid] = status;
    setEndedRuns((m) => (m[rid] ? m : { ...m, [rid]: at }));
    // the stream's own terminal status (killed / failed / …) — "exited" only when it said nothing
    if (r) setSettle({ id: rid, run: { ...r, status: status && status !== "running" ? status : "exited", ended_at: new Date(at).toISOString() } as Run });
    setRunsTick((n) => n + 1); // pick up the finished run's duration + diff now
    void pollRef.current(); // …and its durable turn, without waiting for the 3 s poll
  }, []);
  const onLiveSettled = useCallback((rid: string) => {
    setSettle((s) => (s && s.id === rid ? null : s));
  }, []);
  // while frozen, look for its durable turn every second (it is posted as the run
  // finishes); never hold the block forever: no durable turn within 12 s → let it go
  useEffect(() => {
    if (!settle) return;
    const iv = setInterval(() => void pollRef.current(), 1000);
    const t = setTimeout(() => setSettle(null), 12000);
    return () => { clearInterval(iv); clearTimeout(t); };
  }, [settle]);
  // container events (conversation_reply / worker_run_started / worker_run_finished)
  // refresh the snapshot ~150 ms after they land: read the new turns at once, and
  // look for the just-started run while a sent message waits for it
  const waitingRef = useRef(false);
  waitingRef.current = waitingForRun;
  useEffect(() => {
    if (!bump || !convIdRef.current) return; // unresolved: the 3 s poll owns load()
    void pollRef.current(true); // turns only: presence keeps its own cadence
    if (waitingRef.current) setRunsTick((n) => n + 1);
  }, [bump]);
  const stopLive = useStopRun(liveRun);
  const frozenRuns = useRef<Record<string, { src: Run; run: Run }>>({});

  // autoscroll: stick to the bottom while the reader is at the bottom
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && atBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [turns, awaiting, presence, pendingLocal, runsById, shownRunId]);
  // "New messages" only when a message actually arrived while the reader was
  // scrolled up — never for run refreshes / presence changes (no new content).
  const lastTurnKey = turns.length ? String(turns[turns.length - 1].id ?? turns.length) + ":" + turns.length : "";
  const seenTurnKeyRef = useRef(lastTurnKey);
  useEffect(() => {
    if (lastTurnKey === seenTurnKeyRef.current) return;
    seenTurnKeyRef.current = lastTurnKey;
    if (listRef.current && !atBottomRef.current) setUnseen(true);
  }, [lastTurnKey]);
  // D16: content that grows WITHOUT a new turn (the streamed reply, a work log opening,
  // an image loading) keeps a reader who is at the bottom pinned there
  const threadShown = loaded && !unavailable && (turns.length > 0 || !!pendingLocal);
  useEffect(() => {
    const list = listRef.current;
    const inner = list?.firstElementChild;
    if (!list || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) list.scrollTop = list.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [threadShown]);
  const scrollToLatest = (smooth: boolean) => {
    const list = listRef.current;
    if (!list) return;
    if (smooth && !reducedMotion() && typeof list.scrollTo === "function") list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    else list.scrollTop = list.scrollHeight;
  };
  const jumpToLatest = () => {
    atBottomRef.current = true;
    setAway(false);
    setUnseen(false);
    scrollToLatest(true);
  };

  // thread motion: every item that arrives after the first paint enters once (WAAPI —
  // transform/opacity only). The first load and "Load earlier" never animate.
  const shownRef = useRef(shown);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const els = list.querySelectorAll<HTMLElement>("[data-k]");
    const seen = seenKeysRef.current;
    const quiet = !seen || shownRef.current !== shown;
    shownRef.current = shown;
    if (!seen) {
      if (!loaded) return;
      seenKeysRef.current = new Set();
    }
    const set = seenKeysRef.current as Set<string>;
    els.forEach((el) => {
      const k = el.dataset.k as string;
      if (set.has(k)) return;
      set.add(k);
      if (!quiet) animateEnter(el);
    });
  });

  // #337 lightbox: Escape closes
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  /* ---------- get-or-create ---------- */
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const ensureConv = useCallback(async (): Promise<{ ok: boolean; status?: number; noHuman?: boolean }> => {
    if (convIdRef.current) return { ok: true };
    const h = actingHuman(snapRef.current);
    if (!h) return { ok: false, noHuman: true };
    const r = await fetch("/api/agents/" + encodeURIComponent(agent.id) + "/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor_agent_id: h.id }),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const c: any = await r.json();
    convIdRef.current = (c.conversation || c).id || convIdRef.current;
    setConvId(convIdRef.current);
    return { ok: true };
  }, [agent.id]);
  const getConvId = useCallback(() => convIdRef.current, []);

  /* ---------- send ----------
     Dup-send root cause #1 (vanilla conversation-composer.js): send() had NO
     in-flight guard and only cleared the input after the POST resolved — a
     second Enter (or held-key repeat, or a "did it go through?" click while
     the portal is slow/restarting) re-read the same text and POSTed the same
     turn again. Everything now funnels through ONE guarded path: `sending`
     makes the second activation a no-op, the button is down with a spinner,
     and the composer is cleared optimistically (restored on failure — nothing
     is ever silently lost). The optimistic bubble paints in the SAME frame. */
  const latest = useRef<{ trySend: (v: string, done: Staged[], all: Staged[]) => boolean }>({ trySend: () => false });
  latest.current.trySend = (v, done, all) => {
    if (sendingRef.current) return false; // in flight: Enter/click/key-repeat are no-ops until it settles
    if (unavailable) {
      toast("The conversation couldn't load — use Retry above, then send.", "warn");
      return false;
    }
    if (all.some((s) => s.status === "uploading")) {
      toast("Wait for uploads to finish", "danger");
      return false;
    }
    if (!v && !done.length) return false; // #337: allow attachment-only turns (no text required)
    // one unsent message at a time: the failed bubble owns its text until the
    // human retries, edits or discards it (never two copies → no double-send)
    if (pendingLocalRef.current && pendingLocalRef.current.status === "failed") {
      toast("Retry, edit or discard the unsent message first.", "warn");
      return false;
    }
    const h = actingHuman(snap);
    if (!h) {
      toast(noHumanMsg, "danger");
      return false;
    }
    const atts = done.map((s) => ({ id: s.ref.id, name: s.ref.name }));
    // your own message always brings the thread to the latest (smoothly when scrolled up)
    const wasAway = !atBottomRef.current;
    atBottomRef.current = true;
    setAway(false);
    setUnseen(false);
    if (wasAway) requestAnimationFrame?.(() => scrollToLatest(true));
    void submitTurn(v, atts, all, h);
    return true;
  };
  const onComposerSend = useCallback((v: string, done: Staged[], all: Staged[]) => latest.current.trySend(v, done, all), []);
  // the ONE place a turn is POSTed (fresh sends and Retry both land here).
  const submitTurn = async (v: string, atts: { id: string; name: string }[], keepStaged: Staged[], h: Agent) => {
    sendingRef.current = true;
    setSending(true);
    setPendingLocal({ content: v, atts, keepStaged, authorId: h.id, at: Date.now(), status: "sending", err: null });
    try {
      const res = await ensureConv();
      if (!res.ok) {
        failSend(res.noHuman ? noHumanMsg : "Couldn't open the conversation" + (res.status ? " (error " + res.status + ")" : "") + ".");
        return;
      }
      const r = await fetch("/api/conversations/" + encodeURIComponent(convIdRef.current as string) + "/turns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "human", author_agent_id: h.id, content: v, attachments: atts.length ? atts : undefined }),
      });
      if (!r.ok) {
        failSend(r.status >= 500 ? "Embodent couldn't save this message (error " + r.status + ")." : "The message was rejected (error " + r.status + ").");
        return;
      }
      const d: any = await r.json().catch(() => ({}));
      settleSend(d && d.turn);
    } catch {
      failSend("Couldn't reach Embodent — it may be restarting.");
    }
  };
  // success: the server owns the turn. Reconcile the optimistic bubble with the
  // durable row the POST returned (append by turn id; the poll's id/seq dedupe
  // drops the copy IT fetches), then raise the honest awaiting-reply indicator.
  // The durable turn takes the optimistic bubble's place WITHOUT re-animating.
  const settleSend = (t: ConvTurn | undefined) => {
    sendingRef.current = false;
    setSending(false);
    if (t) {
      seenKeysRef.current?.add(turnKey(t));
      setTurns((prev) => {
        if (prev.some((x) => String(x.id) === String(t.id))) return prev;
        if (typeof t.seq === "number" && t.seq > lastSeqRef.current) lastSeqRef.current = t.seq;
        return prev.concat([t]);
      });
    }
    setPendingLocal(null);
    setAwaiting(true); // show the "thinking…" indicator until the reply lands
    setRunsTick((n) => n + 1); // look for the turn's run right away
    void poll();
  };
  // failure: nothing is lost and nothing auto-repeats. The text + staged refs stay
  // on the failed bubble ONLY (the composer stays clear, so a follow-up Enter can
  // never double-post it); the bubble offers Retry / Edit / Discard.
  const failSend = (msg: string) => {
    sendingRef.current = false;
    setSending(false);
    const p = pendingLocalRef.current;
    if (!p) return; // a poll already reconciled this turn (it DID land server-side)
    setPendingLocal({ ...p, status: "failed", err: msg });
  };
  // Retry on the failed bubble: re-submit EXACTLY the failed content through the
  // same guarded path.
  const retrySend = () => {
    if (sendingRef.current) return;
    const p = pendingLocalRef.current;
    if (!p || p.status !== "failed") return;
    const h = actingHuman(snap);
    if (!h) {
      toast(noHumanMsg, "danger");
      return;
    }
    void submitTurn(p.content, p.atts, p.keepStaged, h);
  };
  // Edit: move the unsent text + attachments back into the composer (after any
  // newer draft) and drop the bubble — the text lives in exactly one place.
  const editFailed = () => {
    const p = pendingLocalRef.current;
    if (!p || p.status !== "failed") return;
    setPendingLocal(null);
    composerRef.current?.restore(p.content, p.keepStaged || []);
  };
  const discardFailed = () => {
    const p = pendingLocalRef.current;
    if (!p || p.status !== "failed") return;
    setPendingLocal(null);
  };

  /* ---------- derived render state ---------- */
  const served = convWakesServed(snap) || !!runRunning;
  const p0 = presenceOf(presence, presenceReason, convStatus, agent);
  // V2 honesty: with no agent runtime bound, nothing can be "working" on this chat —
  // the pill says so instead of echoing a stale status.
  const p = !served && (p0.k === "working" || p0.k === "waking" || p0.k === "idle") ? { k: "noruntime", l: "no runtime · queued", reason: p0.reason } : p0;
  const awaitingReply = awaiting || (turns.length > 0 && turns[turns.length - 1].role === "human");
  // §3b vice-versa lock: while a `live` lease is held — our OWN connected pair
  // session, or another embodiment (from the read payload) — the conversation
  // is READ-ONLY. NOT while the panel is merely connecting/errored, so a
  // bridge-down panel doesn't wrongly freeze the composer.
  const locked = (pairing.paired && pairing.termConnected) || leaseOf(agent) === "live";
  const startIdx = Math.max(0, turns.length - shown);
  const visible = turns.slice(startIdx);
  // D16: the live block sits right ABOVE the run's first turn when the agent already
  // posted one from it (where "Worked for …" lands), else at the tail of the thread.
  const ownerIdx = shownRunId ? visible.findIndex((t) => String(t.run_id ?? "") === shownRunId) : -1;
  const liveEl = shownRun && shownRunId && !locked
    ? (
      <LiveTurn
        key={"live:" + shownRunId}
        agentId={agent.id}
        alias={agent.alias}
        run={shownRun}
        tasks={snap?.tasks ?? EMPTY_TASKS}
        settling={!liveRun}
        owned={ownerIdx >= 0}
        onEnded={onLiveEnded}
        onSettled={onLiveSettled}
      />
    )
    : null;
  let lastAgentSeq = -1;
  turns.forEach((t) => {
    if (t.role === "agent" && typeof t.seq === "number" && t.seq > lastAgentSeq) lastAgentSeq = t.seq;
  });

  const wakesPaused = !!(snap?.container && snap.container.wakes_enabled === false);
  const offline = connection === "offline" || stale;
  // ONE decision for both the indicator and the human turn's delivery label.
  const replyState = (): { kind: "thinking" | "queued" | "unknown"; reason?: string } => {
    // lost the project connection: we cannot know whether the agent is working
    if (offline) return { kind: "unknown", reason: "Connection to the project was lost — reply status is unknown until it reconnects." };
    // §3b lock: the agent is in a live terminal and the conversation is paused — no
    // thinking dots (brief §5: never suggest a live reply that isn't coming)
    if (locked) return { kind: "queued", reason: agent.alias + " is in a live terminal — the conversation is paused. Your message is saved and answered after the terminal session ends." };
    // portal-only project (no host workspace bound): NOTHING serves this
    // project's wakes, so thinking dots would be a lie — the only honest state
    // is "queued until a runtime exists" (same signal as the banner).
    if (!served) {
      return { kind: "queued", reason: "Message queued — this project has no agent runtime yet. It is delivered once a workspace binds on the host." };
    }
    // resident actively working the human's turn → thinking dots; busy on another
    // (task) lease → an honest "queued" notice (never fake "thinking…").
    if (p.k === "busy") return { kind: "queued" };
    if (p.k === "working" || p.k === "waking") return { kind: "thinking" };
    // the notifier is paused: nothing wakes an idle agent until it resumes
    if (wakesPaused) {
      return { kind: "queued", reason: "Wakes are paused for this project — your message is saved and is delivered when wakes resume." };
    }
    if (awaiting && p.k === "idle") return { kind: "thinking" };
    return { kind: "queued" };
  };
  const indicator = () => {
    const r = replyState();
    if (r.kind === "unknown") return queued(r.reason, true);
    // no runtime: the one-line notice above the thread + the turn's "saved · queued"
    // already say it — a third "queued" note would repeat the same fact (D12)
    if (!served) return null;
    if (r.kind === "thinking") return thinking();
    return queued(r.reason);
  };
  // Cold-start honesty: when the thread has NO agent turn yet, this reply rides
  // a full agent session boot — say so instead of letting "thinking…" read as
  // seconds-away.
  // r3: ONE typing indicator — the animated dots ride the author line ("lead ···");
  // the words "thinking…" used to repeat them on a second row.
  const thinking = () => {
    const cold = !turns.some((t) => t.role === "agent");
    return (
      <ChatBubble
        key="ind:thinking"
        dataKey="ind:thinking"
        from="agent"
        className="turn agent conv-indicator"
        author={
          <>
            {agent.alias}
            {cold ? <span className="tt"> starting…</span> : null}
            <span className="conv-thinking" role="status" aria-label={agent.alias + (cold ? " is starting" : " is thinking")} title={cold ? "Starting the agent’s session" : agent.alias + " is thinking"}>
              <span />
              <span />
              <span />
            </span>
          </>
        }
      >
        {cold ? <div className="conv-coldnote">starting the agent’s session — the first reply can take a minute</div> : null}
      </ChatBubble>
    );
  };
  const queued = (reason?: string, unknown?: boolean) => {
    // busy (another lease) keeps the original copy; an idle agent is never called busy
    const fallback =
      p.k === "busy"
        ? agent.alias + " is busy with another task — your message is queued and will be answered when it's free."
        : "Your message is saved — " + agent.alias + " hasn't picked it up yet. It is answered on the agent's next wake.";
    const msg = reason ? reason : p.reason ? p.reason : fallback;
    return (
      <ChatBubble
        key="ind:queued"
        dataKey="ind:queued"
        from="agent"
        className="turn agent conv-indicator"
        author={
          <>
            {agent.alias} <span className="tt">{unknown ? "status unknown" : "queued"}</span>
          </>
        }
      >
        <div className={"conv-queued" + (unknown ? " conv-unknown" : "")}>
          <Icon name="clock" cls="" />
          <span>{msg}</span>
        </div>
      </ChatBubble>
    );
  };
  // the optimistic human bubble: the just-sent text, painted in the send's own frame
  // and reconciled IN PLACE by the durable turn (same look, no re-animation); on
  // failure it carries an inline danger note + Retry / Edit / Discard — a failed send
  // is never silently dropped and never auto-reposted. PLAIN text (no md): the bubble
  // is transient and must mirror the composer verbatim.
  const pendingBubbleEl = (pl: PendingLocal) => {
    const failed = pl.status === "failed";
    return (
      <ChatBubble
        key={"pending:" + pl.at}
        dataKey={"pending:" + pl.at}
        from="user"
        compact
        className={"turn human pending" + (failed ? " failed" : "")}
        statusTone={failed ? "danger" : "muted"}
        status={
          failed ? (
            // the failure is announced ONCE (the ChatBubble status is role=alert for danger)
            <div className="conv-sendfail">
              <Icon name="alert" cls="" />
              <span>
                <b>Not sent.</b> {pl.err || "Couldn't send."}
              </span>
              <span className="conv-sendfail-acts">
                <Button variant="secondary" size="sm" icon="refresh" data-retrysend onClick={retrySend} disabled={sending}>
                  Retry
                </Button>
                <Button variant="ghost" size="sm" icon="pencil" data-editsend onClick={editFailed}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" icon="trash" data-discardsend onClick={discardFailed}>
                  Discard
                </Button>
              </span>
            </div>
          ) : (
            <span className="tmeta">
              <span className="tt">{relTime(new Date(pl.at).toISOString())}</span>
              <span className="dlv sending">sending…</span>
            </span>
          )
        }
      >
        <div className="tx">{pl.content || ""}</div>
        {pl.atts.length > 0 && (
          <div className="msg-atts">
            {pl.atts.map((att) => (
              <span key={att.id} className="att-file" title={att.name || att.id}>
                <span className="att-ic" dangerouslySetInnerHTML={{ __html: FILE_ICON }} />
                <span className="nm">{att.name || att.id}</span>
              </span>
            ))}
          </div>
        )}
      </ChatBubble>
    );
  };

  // stable handlers so memoized turns / composer skip re-rendering
  const pairRef = useRef(pairing.togglePair);
  pairRef.current = pairing.togglePair;
  const onPairStable = useCallback(() => pairRef.current(), []);
  const stopRef = useRef(stopLive.request);
  stopRef.current = stopLive.request;
  const onStopStable = useCallback(() => stopRef.current(), []);

  // ONE keyed list: turns, the live block (it moves above its own turn without
  // remounting) and the tail indicator / optimistic bubble.
  // a run its own stream already reported finished reads as finished even before the
  // next runs read lands (so the turn never flips back to "Working…")
  const turnRun = (id: string): Run | null => {
    const r = runPool[id];
    if (!r) return null;
    if (r.status === "running" && endedRuns[id]) {
      const cached = frozenRuns.current[id];
      if (cached && cached.src === r) return cached.run;
      const run = { ...r, status: "exited", ended_at: new Date(endedRuns[id]).toISOString() } as Run;
      frozenRuns.current[id] = { src: r, run };
      return run;
    }
    return r;
  };
  const items: ReactNode[] = [];
  const tasks = snap?.tasks ?? EMPTY_TASKS;
  visible.forEach((t, i) => {
    let delivery: Delivery = null;
    let deliveryWhy: string | undefined;
    if (t.role === "human" && typeof t.seq === "number" && t.seq > lastAgentSeq) {
      const rs = replyState();
      // a queued/unknown tail note (shown whenever a runtime serves the
      // project, or the status is unknown) carries the word + the reason —
      // the turn then only says "saved"; with no runtime there is no tail
      // note, so the turn keeps "saved · queued" (reason in its tooltip)
      const tailNote = !pendingLocal && (rs.kind === "unknown" || (rs.kind === "queued" && served));
      delivery = rs.kind === "thinking" ? "sent" : tailNote ? "saved" : rs.kind;
      deliveryWhy = tailNote ? undefined : rs.reason;
      // D16: a run that started on this conversation after the turn was saved has it
      const ls = shownRun ? Date.parse(shownRun.started_at || shownRun.started || "") : NaN;
      const tc = Date.parse(t.created_at || "");
      if (!shownRun && tailOrphan && startIdx + i === tailOrphan.afterIdx && !offline) {
        // C9b: its run already ended without a reply — the row below says how
        delivery = "delivered";
        deliveryWhy = agent.alias + " picked this up — its run ended (" + runOutcome(tailOrphan.run).label.toLowerCase() + ").";
      }
      if (shownRun && !locked && !offline) {
        // the live block replaces the queued/thinking note, so the turn states it itself
        const picked = Number.isFinite(ls) && Number.isFinite(tc) && ls >= tc - 2000;
        delivery = picked ? "delivered" : "sent";
        deliveryWhy = picked
          ? agent.alias + " picked this up — its run started " + new Date(ls).toLocaleTimeString() + "."
          : agent.alias + " is still on its current turn — this message is saved for it.";
      }
    }
    const prev = i > 0 ? visible[i - 1] : null;
    // consecutive turns from the same agent within 10 minutes share one author line
    const grouped =
      t.role === "agent" && !!prev && prev.role === "agent" && prev.author_agent_id === t.author_agent_id &&
      Math.abs((Date.parse(t.created_at || "") || 0) - (Date.parse(prev.created_at || "") || 0)) < 10 * 60 * 1000;
    if (i === ownerIdx && liveEl) items.push(liveEl);
    items.push(
      <Bubble
        key={turnKey(t)}
        t={t}
        tasks={tasks}
        agentId={agent.id}
        onZoom={setLightbox}
        delivery={delivery}
        deliveryWhy={deliveryWhy}
        onPair={pairing.paired || readOnly ? undefined : onPairStable}
        run={t.run_id ? turnRun(String(t.run_id)) : null}
        grouped={grouped}
        liveRunId={shownRunId}
      />,
    );
    for (const o of endedOrphans) if (o.afterIdx === startIdx + i) items.push(<EndedRunRow key={"ended:" + runIdOf(o.run)} agentId={agent.id} run={o.run} />);
  });
  // the optimistic pending bubble suppresses the reply indicator — one honest state
  // at a time (sending… / failed+Retry first; the indicator returns once the turn lands)
  if (pendingLocal) items.push(pendingBubbleEl(pendingLocal));
  // D16: a run live on this conversation IS the reply in progress — the one truthful
  // live block (timer, steps, the streamed text) replaces the dots. Without a live run,
  // the presence-based thinking / queued indicator stays the honest fallback.
  if (liveEl) {
    if (ownerIdx < 0) items.push(liveEl);
  } else if (!pendingLocal && awaitingReply && !tailOrphan) {
    const ind = indicator();
    if (ind) items.push(ind);
  }

  return (
    <div className={"conv-wrap" + (pairing.paired ? " paired" : "")} id="convPairWrap">
      <div
        className={"conv" + (dragover ? " dragover" : "") + (maxed ? " maximized" : "")}
        onDragEnter={(e) => { e.preventDefault(); setDragover(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragover(true); }}
        onDragLeave={(e) => { e.preventDefault(); if (e.target === e.currentTarget) setDragover(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragover(false);
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) composerRef.current?.addFiles(e.dataTransfer.files);
        }}
      >
        {/* D16 panel header (Linear agent panel, images 10/16): avatar · name · role on
            the left; the "turn-based" explainer (help icon), Pair in terminal and
            maximize as compact icon buttons on the right. The status pill lives ONCE in
            the workspace header — it shows here only while maximized (the page header is
            covered then); otherwise the reply state stays screen-reader only. */}
        <div className="conv-head">
          <Avatar alias={agent.alias} kind="ai" size={20} decorative />
          <span className="conv-head-nm">{agent.alias}</span>
          {agent.role ? <span className="conv-head-role" title={agent.role}>{agent.role}</span> : null}
          <span className={"presence p-" + p.k + (maxed ? "" : " ag-sr")} id="convPresence" role="status">
            {maxed ? <span className="d" aria-hidden="true" /> : null}
            {maxed ? p.l.charAt(0).toUpperCase() + p.l.slice(1) : agent.alias + " " + p.l}
          </span>
          <span className="grow" />
          <HelpTip
            className="conv-help"
            placement="bottom"
            label="How this conversation works"
            tip={`${agent.alias} wakes, works and replies in turns. While it works, its reply streams in here from the run's own output — expand "Working…" for the full live log, or stop the run.`}
          />
          {/* S3 §3b: dock a live xterm session (Forge PTY ws bridge) beside the
              thread; lease-guarded + ISS-84 preflight-gated (usePairing). */}
          <IconButton
            glyph={<TerminalGlyph />}
            label={pairing.paired ? "Terminal paired — unpair" : "Pair in terminal"}
            title={pairing.paired ? "Terminal paired — click to unpair" : readOnly ? noHumanMsg : `Pair in terminal — a live session as ${agent.alias}`}
            size="sm"
            shape="circle"
            className="conv-pair"
            id="convPair"
            pressed={pairing.paired}
            // parity r2 (e2e-permissions-30): a viewer / non-member can't open a live
            // session — disabled up front with the reason, like Send / Skills / Attach
            // (unpairing an already-paired terminal always stays possible).
            disabled={readOnly && !pairing.paired}
            aria-disabled={readOnly && !pairing.paired ? true : undefined}
            onClick={pairing.togglePair}
          />
          <IconButton
            icon={maxed ? "minimize" : "maximize"}
            label={maxed ? "Restore conversation" : "Maximize conversation"}
            size="sm"
            shape="circle"
            className="conv-max"
            id="convMax"
            onClick={() => pairing.toggleMax("conv")}
          />
        </div>
        {/* No host-side notifier serves this project (portal-only New-project flow):
            ONE muted line over the thread — the full explanation is its tooltip.
            Not dismissible (as long as sends only queue, the chat must say so);
            re-checked every snapshot poll, so it self-clears once a workspace binds. */}
        <div id="convWakes">
          {!served && statusShown !== "noruntime" && (
            <div className="conv-wakes" title={RUNTIME_REASON} tabIndex={0} role="note" aria-label={"No agent runtime yet. " + RUNTIME_REASON}>
              <Icon name="clock" cls="" />
              <span className="t1">No agent runtime yet</span>
              <span className="t2">messages queue until a workspace binds</span>
            </div>
          )}
        </div>
        <div className={"conv-listwrap" + (away ? " is-away" : "")}>
        <div
          className="conv-list"
          id="convList"
          ref={listRef}
          data-scrolled={scrolled ? "true" : undefined}
          onScroll={(e) => {
            const el = e.currentTarget;
            const top = el.scrollTop > 0;
            setScrolled((prev) => (prev === top ? prev : top));
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            atBottomRef.current = bottom;
            setAway((prev) => (prev === !bottom ? prev : !bottom));
            if (bottom) setUnseen(false);
          }}
        >
          {unavailable ? (
            <div className="conv-empty conv-err" role="alert">
              <Icon name="alert" cls="v2-ico" />
              <span className="grow">
                <b>Conversation unavailable.</b> Sending is paused until it loads — it retries automatically.
              </span>
              <Button variant="secondary" size="sm" icon="refresh" onClick={retryLoad} busy={retrying}>
                Retry
              </Button>
            </div>
          ) : !loaded ? (
            <div className="conv-empty">Loading conversation…</div>
          ) : !turns.length && !pendingLocal ? (
            <div className="conv-empty">No messages yet — say hello to start the conversation.</div>
          ) : (
            <ChatThread label={"Conversation with " + agent.alias} className={visible.length > 30 ? "is-long" : undefined}>
              {startIdx > 0 && (
                <Button variant="ghost" size="sm" className="conv-earlier" onClick={() => setShown((n) => n + CONV_PAGE)}>
                  Load earlier · {visible.length} of {turns.length}
                </Button>
              )}
              {items}
            </ChatThread>
          )}
        </div>
        {away && (
          <Button variant="secondary" size="sm" icon="arrow-down" className="conv-jump" onClick={jumpToLatest}>
            {unseen ? "New messages" : "Jump to latest"}
          </Button>
        )}
        </div>
        <div className="conv-lock" id="convLock" hidden={!locked}>
          <Icon name="shield" cls="" />
          <span>{locked ? agent.alias + " is in a live terminal — conversation paused." : ""}</span>
        </div>
        {/* D9 composer: one rounded field — "added to context" chips (staged
            attachments) above the text, the skills picker bottom-left, attach +
            a circular send bottom-right. Its state lives in ConvComposer, so
            typing re-renders only the composer — never the thread. */}
        <ConvComposer
          ref={composerRef}
          agentId={agent.id}
          alias={agent.alias}
          placeholder={readOnly ? noHumanMsg : unavailable ? "Sending is paused — the conversation couldn't load" : `Reply to ${agent.alias}…`}
          disabled={locked || unavailable || readOnly}
          skillsDisabled={locked || unavailable || readOnly}
          sending={sending}
          stopShown={!!liveRun && !readOnly && !locked}
          stopRequested={stopLive.stopRequested}
          onStop={onStopStable}
          onSend={onComposerSend}
          ensureConv={ensureConv}
          getConvId={getConvId}
          noHumanMsg={noHumanMsg}
        />
      </div>
      <div className="term-slot" id="convTermSlot">{pairing.termSlot}</div>
      {stopLive.dialog}
      {pairing.overlays}
      {lightbox && (
        <div className="att-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}
const EMPTY_TASKS: Snapshot["tasks"] = [];

function StopGlyph() {
  return (
    <svg viewBox="0 0 20 20" width={12} height={12} aria-hidden="true" focusable="false">
      <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

/** "Pair in terminal" glyph: a ">_" prompt (the Activity page's terminal mark) — the
 *  play triangle it replaced read as run/send beside the send arrow (wave-4). */
function TerminalGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2.5 4.5 5 7 2.5 9.5" />
      <path d="M7 10.5h6.5" />
    </svg>
  );
}

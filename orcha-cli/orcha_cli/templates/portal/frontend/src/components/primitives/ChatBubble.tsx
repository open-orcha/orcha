/**
 * ChatBubble / WorkedFor / ChatNote — Linear agent-panel conversation
 * (directive D9, images 10/16).
 *
 *   <ChatThread label="Conversation with lead">
 *     <ChatBubble from="user" author="hussein" at={m.at}>Fix the dimmed rows and open a PR</ChatBubble>
 *     <ChatNote icon={<StatusGlyph …/>}><b>T-364</b> added to context</ChatNote>
 *     <WorkedFor ms={run.duration_ms} running={run.status === "running"}>…run detail…</WorkedFor>
 *     <ChatBubble from="agent" author="lead">Pushed and opened a draft PR…</ChatBubble>
 *     <ChangesCard files={2} additions={22} deletions={10} pr={{ number: 55, title: "Reset rows", state: "draft" }} />
 *   </ChatThread>
 *
 * User messages are right-aligned raised bubbles; agent replies are plain
 * text on the panel (no bubble), exactly like Linear. `status` renders a
 * small honest delivery line under the message ("Sending…", "Not delivered")
 * — never hide a failed delivery. WorkedFor is a disclosure button
 * ("Worked for 10 sec ▸") that reveals the run detail; while `running` it
 * reads "Working… 12 sec" and the duration is the live value you pass.
 */
import { useId, useState, type ReactNode } from "react";
import { RelTime } from "./Timeline";

export function ChatThread({ label, children, className }: { label: string; children?: ReactNode; className?: string }) {
  return (
    <div className={`v2-chat${className ? " " + className : ""}`} role="log" aria-label={label}>
      {children}
    </div>
  );
}

export interface ChatBubbleProps {
  from: "user" | "agent" | "system";
  author?: ReactNode;
  avatar?: ReactNode;
  at?: string | null;
  /** Delivery / state line under the message ("Sending…", "Not delivered — Retry"). */
  status?: ReactNode;
  statusTone?: "muted" | "danger" | "warn";
  /** Hide the author header (consecutive messages from the same sender). */
  compact?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Stable identity for thread motion (enter animations key off `data-k`). */
  dataKey?: string;
}

export function ChatBubble({ from, author, avatar, at, status, statusTone = "muted", compact, actions, children, className, dataKey }: ChatBubbleProps) {
  const showHead = !compact && (author || avatar || at);
  return (
    <article className={`v2-msg v2-msg-${from}${className ? " " + className : ""}`} data-k={dataKey}>
      {showHead ? (
        <header className="v2-msg-h">
          {avatar ? <span className="v2-msg-av">{avatar}</span> : null}
          {author ? <span className="v2-msg-author">{author}</span> : null}
          {at ? <RelTime at={at} className="v2-msg-time" /> : null}
          {actions ? <span className="v2-msg-actions">{actions}</span> : null}
        </header>
      ) : null}
      <div className="v2-msg-body">{children}</div>
      {status ? <div className={`v2-msg-status v2-msg-status-${statusTone}`} role={statusTone === "danger" ? "alert" : undefined}>{status}</div> : null}
    </article>
  );
}

/** Right-aligned muted note: "T-364 added to context". */
export function ChatNote({ icon, children, align = "end" }: { icon?: ReactNode; children: ReactNode; align?: "start" | "end" }) {
  return (
    <p className={`v2-chatnote v2-chatnote-${align}`}>
      {icon ? <span className="v2-chatnote-ico" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </p>
  );
}

/** "10 sec", "2 min 5 sec", "1 h 4 min". Unknown → null (render nothing, never "0 sec"). */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  // C1b: a sub-second run is real work, not "0 sec".
  if (s === 0) return "less than 1 sec";
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} sec` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export interface WorkedForProps {
  /** Run duration in ms (live value while running). */
  ms?: number | null;
  running?: boolean;
  /** Override the label entirely. */
  label?: ReactNode;
  defaultOpen?: boolean;
  /** The run detail revealed by the disclosure (tool calls, log, diff). */
  children?: ReactNode;
  /** Quiet trailing meta on the same line (e.g. the turn's time: "· 40m ago"). */
  meta?: ReactNode;
  /** Mount the detail only while open (a live log opens its stream on first expand). */
  lazy?: boolean;
}

export function WorkedFor({ ms, running, label, defaultOpen = false, children, meta, lazy }: WorkedForProps) {
  const [open, setOpen] = useState(defaultOpen);
  const rid = `v2-worked-${useId().replace(/:/g, "")}`;
  const d = formatDuration(ms);
  const text = label ?? (running ? (d ? `Working… ${d}` : "Working…") : d ? `Worked for ${d}` : "Run details");
  const hasDetail = children != null && children !== false;
  const toggle = (
    <button
      type="button"
      className="v2-worked-toggle"
      aria-expanded={hasDetail ? open : undefined}
      aria-controls={hasDetail ? rid : undefined}
      disabled={!hasDetail}
      onClick={() => setOpen((o) => !o)}
    >
      <span className="v2-worked-label">{text}</span>
      {hasDetail ? (
        <svg className="v2-worked-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2.5v5L7 5z" fill="currentColor" /></svg>
      ) : null}
    </button>
  );
  return (
    <div className={`v2-worked${open ? " is-open" : ""}${running ? " is-running" : ""}`}>
      {meta ? <div className="v2-worked-row">{toggle}<span className="v2-worked-meta">{meta}</span></div> : toggle}
      {hasDetail ? (
        <div id={rid} className="v2-worked-body" hidden={!open}>
          {lazy && !open ? null : children}
        </div>
      ) : null}
    </div>
  );
}

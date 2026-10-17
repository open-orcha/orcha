/**
 * Timeline — Linear issue "Activity" (directive D10).
 *
 *   <Timeline label="Task activity">
 *     <TimelineEvent icon="plus" actor="lead" at={t.created_at}>created the task</TimelineEvent>
 *     <TimelineEvent glyph={<StatusGlyph status="in_progress"/>} actor="frontend-dev" at={ev.at}>
 *       moved from <b>Todo</b> to <b>In progress</b>
 *     </TimelineEvent>
 *     <TimelineComment author="karri" avatar={<Avatar …/>} at={c.at}>{c.body}</TimelineComment>
 *     <TimelineCard>                       ← one bordered card, several entries
 *       <TimelineMessage author="karri" …>…</TimelineMessage>
 *       <TimelineMessage author="jori" …>…</TimelineMessage>
 *       <TimelineCardEvent icon="spark">Changed 2 files · Draft PR awaiting review</TimelineCardEvent>
 *     </TimelineCard>
 *   </Timeline>
 *
 * Events are single muted lines — small icon + "actor verb object · time" —
 * joined by a thin continuous vertical connector (icon to icon, whatever the
 * event height) between consecutive events. Comments
 * and messages break the connector and sit in bordered cards. Wrap the
 * important nouns in <b> (rendered text-2 weight 500, not bold white).
 * Times: pass `at` (ISO) for a relative label with the absolute time as the
 * tooltip, or `time` (ReactNode) to render your own.
 */
import type { ReactNode } from "react";
import { relTime } from "../../lib/format";
import { Icon } from "../ui";

/** <time> with a relative label ("5m ago") and the absolute local time as tooltip. */
export function RelTime({ at, className }: { at: string | null | undefined; className?: string }) {
  if (!at) return null;
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return null;
  return (
    <time className={className} dateTime={d.toISOString()} title={d.toLocaleString()}>
      {relTime(at)}
    </time>
  );
}

function When({ at, time }: { at?: string | null; time?: ReactNode }) {
  if (time != null && time !== "") return <span className="v2-tl-time">{time}</span>;
  if (!at) return null;
  return <RelTime at={at} className="v2-tl-time" />;
}

function Glyph({ icon, glyph }: { icon?: string; glyph?: ReactNode }) {
  return (
    <span className="v2-tl-icon" aria-hidden="true">
      {glyph ?? (icon ? <Icon name={icon} cls="v2-ico" /> : <span className="v2-tl-dot" />)}
    </span>
  );
}

export function Timeline({ label, children, className }: { label: string; children?: ReactNode; className?: string }) {
  return (
    <ol className={`v2-tl${className ? " " + className : ""}`} aria-label={label}>
      {children}
    </ol>
  );
}

export interface TimelineEventProps {
  /** Icon name from components/ui … */
  icon?: string;
  /** … or any glyph node (StatusGlyph, Avatar 16). Default: a small dot. */
  glyph?: ReactNode;
  /** The actor, rendered emphasised before the sentence. */
  actor?: ReactNode;
  /** The rest of the sentence ("moved from <b>Todo</b> to <b>In progress</b>"). */
  children?: ReactNode;
  at?: string | null;
  time?: ReactNode;
  /** Optional trailing node (e.g. a ShortId or a link). */
  trailing?: ReactNode;
  /** A muted line under the sentence (message preview). Max 2 lines per item. */
  body?: ReactNode;
  /** How many lines the body may use before it ellipsizes (1 default, max 2). */
  bodyLines?: 1 | 2;
  /** Keep the sentence on ONE line: the text ellipsizes, the time never wraps away. */
  oneLine?: boolean;
  className?: string;
}

export function TimelineEvent({ icon, glyph, actor, children, at, time, trailing, body, bodyLines = 1, oneLine, className }: TimelineEventProps) {
  const hasTime = (time != null && time !== "") || !!at;
  const text = (
    <>
      {actor ? <span className="v2-tl-actor">{actor}</span> : null}
      {actor && children ? " " : null}
      {children}
    </>
  );
  const line = (
    <span className={"v2-tl-line" + (oneLine ? " is-one-line" : "")}>
      {oneLine ? <span className="v2-tl-text">{text}</span> : text}
      {hasTime ? <span className="v2-tl-sep" aria-hidden="true"> · </span> : null}
      <When at={at} time={time} />
      {trailing ? <span className="v2-tl-trailing">{trailing}</span> : null}
    </span>
  );
  return (
    <li className={`v2-tl-event${className ? " " + className : ""}`}>
      <Glyph icon={icon} glyph={glyph} />
      {body != null && body !== "" ? (
        <span className="v2-tl-stack">
          {line}
          <span className={"v2-tl-body" + (bodyLines === 2 ? " is-2" : "")}>{body}</span>
        </span>
      ) : line}
    </li>
  );
}

/** A bordered card in the timeline; holds TimelineMessage / TimelineCardEvent entries. */
export function TimelineCard({ children, className, label }: { children?: ReactNode; className?: string; label?: string }) {
  return (
    <li className={`v2-tl-card${className ? " " + className : ""}`} aria-label={label}>
      {children}
    </li>
  );
}

export interface TimelineMessageProps {
  author: ReactNode;
  /** Round avatar (16–20 px) shown before the author. */
  avatar?: ReactNode;
  /** Muted text after the author ("connected by Jori", "commented"). */
  meta?: ReactNode;
  at?: string | null;
  time?: ReactNode;
  /** Right-aligned actions (⋯ menu, reactions). */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** One message inside a TimelineCard: "avatar author · 4 min ago" + body. */
export function TimelineMessage({ author, avatar, meta, at, time, actions, children, className }: TimelineMessageProps) {
  const hasTime = (time != null && time !== "") || !!at;
  return (
    <article className={`v2-tl-msg${className ? " " + className : ""}`}>
      <header className="v2-tl-msg-h">
        {avatar ? <span className="v2-tl-msg-av">{avatar}</span> : null}
        <span className="v2-tl-msg-author">{author}</span>
        {meta ? <span className="v2-tl-msg-meta">{meta}</span> : null}
        {hasTime ? <span className="v2-tl-sep" aria-hidden="true">·</span> : null}
        <When at={at} time={time} />
        {actions ? <span className="v2-tl-msg-actions">{actions}</span> : null}
      </header>
      {children != null && children !== "" ? <div className="v2-tl-msg-body">{children}</div> : null}
    </article>
  );
}

/** A compact event line inside a TimelineCard (e.g. "Changed 2 files · Draft PR awaiting review"). */
export function TimelineCardEvent({ icon, glyph, children, at, time }: Omit<TimelineEventProps, "actor" | "trailing" | "className">) {
  const hasTime = (time != null && time !== "") || !!at;
  return (
    <div className="v2-tl-cardevent">
      <Glyph icon={icon} glyph={glyph} />
      <span className="v2-tl-line">
        {children}
        {hasTime ? <span className="v2-tl-sep" aria-hidden="true"> · </span> : null}
        <When at={at} time={time} />
      </span>
    </div>
  );
}

/** Convenience: a single-message comment card. */
export function TimelineComment(props: TimelineMessageProps) {
  return (
    <TimelineCard>
      <TimelineMessage {...props} />
    </TimelineCard>
  );
}

/** Day divider for feeds ("Today", "Yesterday") — Linear Pulse style. */
export function TimelineDivider({ children }: { children: ReactNode }) {
  return (
    <li className="v2-tl-divider" role="presentation">
      <span>{children}</span>
    </li>
  );
}

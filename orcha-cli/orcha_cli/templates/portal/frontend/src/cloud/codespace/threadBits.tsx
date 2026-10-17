/**
 * Small shared pieces for Code Space thread rows (rail list, landing / rail
 * "Recent", Learn) and the thread view — D7 round avatars + the D8 status
 * glyph set, so every thread surface reads the same way (Linear Inbox rows:
 * round avatar · bold first line · muted second line · glyph + age right).
 *
 * Truthful by construction: an author with no alias gets the thread-kind
 * icon in a neutral circle (never an invented initial), and an avatar's AI /
 * human kind is only claimed when the snapshot actually knows that actor.
 */
import { Avatar, Chip, StatusIcon, type ChipTone } from "../../components/primitives";
import { Icon } from "../../components/ui";
import type { Agent } from "../../types";
import { kindIcon, kindLabel, type ThreadKind, type ThreadStatus } from "./codespaceTypes";

/** Thread status → the ONE glyph set (resolved reads as a grey closed check). */
const THREAD_GLYPH: Record<ThreadStatus, string> = { open: "open", answered: "answered", resolved: "closed" };
const THREAD_WORD: Record<ThreadStatus, string> = { open: "Open", answered: "Answered", resolved: "Resolved" };

export function threadStatusWord(status: ThreadStatus | string): string {
  return THREAD_WORD[status as ThreadStatus] ?? String(status || "");
}

export function ThreadStatusIcon({ status, showLabel }: { status: ThreadStatus | string; showLabel?: boolean }) {
  const glyph = THREAD_GLYPH[status as ThreadStatus] ?? String(status || "");
  return <StatusIcon status={glyph} label={threadStatusWord(status)} showLabel={showLabel} className="cs-thread-status" />;
}

/** Kind of a known actor (snapshot agents) — undefined when we don't know. */
export function actorKind(agents: Agent[] | undefined, id?: string | null, alias?: string | null): "ai" | "human" | undefined {
  if (!agents || (!id && !alias)) return undefined;
  const a = agents.find((x) => (id && x.id === id) || (!id && alias && x.alias === alias));
  return a ? (a.kind === "ai" ? "ai" : "human") : undefined;
}

/**
 * Round avatar for a thread's author (24 px default); falls back to the kind
 * icon in a neutral circle when the author isn't known.
 */
export function ThreadAuthorAvatar({ alias, id, kind, agents, size = 24 }: {
  alias?: string | null;
  id?: string | null;
  kind: ThreadKind;
  agents?: Agent[];
  size?: 16 | 20 | 24 | 32;
}) {
  if (!alias) {
    return (
      <span className={"cs-kind-ico cs-kind-circle " + kind} style={{ width: size, height: size }} aria-hidden="true">
        <Icon name={kindIcon(kind)} cls="v2-ico" />
      </span>
    );
  }
  return <Avatar alias={alias} kind={actorKind(agents, id, alias)} size={size} decorative />;
}

/** Thread kind → the D8 label-dot tone (colour is never the only signal: the word is always shown). */
export const KIND_TONE: Record<ThreadKind, ChipTone> = { question: "accent", why: "info", teach: "ok", note: "neutral" };

/**
 * D8 metadata chip for a thread's kind — rounded-full, 1px border, small
 * coloured dot + neutral text ("● Question"). The inner `.kind-tag` span keeps
 * the long-standing hook tests and styles select on.
 */
export function KindChip({ kind, title }: { kind: ThreadKind; title?: string }) {
  return (
    <Chip size="sm" dot={KIND_TONE[kind] ?? "neutral"} className={"cs-kind-chip kind-" + kind} title={title}>
      <span className={"kind-tag " + kind}>{kindLabel(kind)}</span>
    </Chip>
  );
}

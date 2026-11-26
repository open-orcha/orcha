/**
 * Reply style (mig 102): the small chip by a composer that shows how agents write on THIS
 * thread, and switches it for this conversation / task only.
 *
 *   GET /api/{conversations|tasks}/{id}/reply-style → {override, project_reply_style, effective_reply_style}
 *   PUT … {reply_style: "normal" | "caveman" | "asd_ste100" | null, actor_agent_id}
 *
 * "Project default" sends null, so the thread follows Project settings again. The project
 * setting itself lives in Settings › Execution › Agent replies (ReplyStyleRow). Agents read the
 * new style on their next wake. Older backends (404) render nothing.
 */
import { useEffect, useState } from "react";
import { getJSON, sendJSON } from "../api/client";
import { useActingAuthority } from "../state/SnapshotProvider";
import { useToast } from "./ui";
import "./replyStyleChip.css";

export type ReplyStyle = "normal" | "caveman" | "asd_ste100";

export const REPLY_STYLE_LABEL: Record<ReplyStyle, string> = {
  normal: "Normal",
  caveman: "Caveman",
  asd_ste100: "ASD-STE100",
};

export const REPLY_STYLE_DESC: Record<ReplyStyle, string> = {
  normal: "Agents write as usual.",
  caveman: "Terse, no filler, fragments OK. Plans use ASD-STE100 instead.",
  asd_ste100: "Simplified Technical English: active voice, short sentences, numbered steps.",
};

export const REPLY_STYLES = Object.keys(REPLY_STYLE_LABEL) as ReplyStyle[];

export interface ThreadReplyStyle {
  override: ReplyStyle | null;
  project_reply_style: ReplyStyle;
  effective_reply_style: ReplyStyle;
}

/** The chip's text (pure, tested): the style in use, marked when it comes from the project. */
export function replyStyleChipText(s: ThreadReplyStyle): string {
  return "Style: " + REPLY_STYLE_LABEL[s.effective_reply_style] + (s.override ? "" : " (project)");
}

function threadUrl(kind: "conversation" | "task", id: string): string {
  return "/api/" + (kind === "conversation" ? "conversations" : "tasks") + "/" + encodeURIComponent(id) + "/reply-style";
}

export function ReplyStyleChip({ kind, id }: { kind: "conversation" | "task"; id: string | null }) {
  const auth = useActingAuthority();
  const toast = useToast();
  const [style, setStyle] = useState<ThreadReplyStyle | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStyle(null);
    if (!id) return;
    const ac = new AbortController();
    getJSON<ThreadReplyStyle>(threadUrl(kind, id), ac.signal)
      .then((d) => setStyle(d))
      .catch(() => { /* older backend or no access: show nothing */ });
    return () => ac.abort();
  }, [kind, id]);

  if (!id || !style) return null;
  const locked = !auth.human || busy;
  const where = kind === "conversation" ? "this conversation" : "this task";
  const title = locked && !busy
    ? (auth.reason || "Pick an acting human to change the reply style")
    : "How agents write to people on " + where + ". Changes apply from the agent's next reply.";

  const change = async (value: string) => {
    if (!auth.human) return;
    const next = value === "" ? null : (value as ReplyStyle);
    setBusy(true);
    try {
      const d = await sendJSON<ThreadReplyStyle>("PUT", threadUrl(kind, id), {
        reply_style: next,
        actor_agent_id: auth.human.id,
      });
      setStyle(d);
      toast(next ? "Reply style for " + where + ": " + REPLY_STYLE_LABEL[next] + "." : "This thread now follows the project reply style.", "ok");
    } catch {
      toast("Couldn't change the reply style.", "danger");
    }
    setBusy(false);
  };

  return (
    <label className={"reply-style-chip" + (style.override ? " is-override" : "")} title={title} data-testid="reply-style-chip">
      <span className="reply-style-chip__text" aria-hidden="true">{replyStyleChipText(style)}</span>
      <select
        className="reply-style-chip__select"
        aria-label={"Reply style for " + where}
        value={style.override ?? ""}
        disabled={locked}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="">Project default ({REPLY_STYLE_LABEL[style.project_reply_style]})</option>
        {REPLY_STYLES.map((k) => (
          <option key={k} value={k}>{REPLY_STYLE_LABEL[k]}</option>
        ))}
      </select>
    </label>
  );
}

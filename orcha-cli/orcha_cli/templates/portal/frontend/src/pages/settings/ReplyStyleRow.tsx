/**
 * Settings → Execution › Agent replies (mig 102): the project's reply style — how agents
 * write every message to a person (conversations, task threads, plans, verification requests).
 *
 *   Reply style   Normal · Caveman · ASD-STE100
 *
 * Reads GET /api/containers/{cid}/reply-style; writes PUT … {reply_style, actor_agent_id}
 * (owner or manage_agents; without it the control is disabled and says why). A conversation or
 * task can override it from the chip by its composer (ReplyStyleChip). Older backends (404)
 * render nothing.
 */
import { useEffect, useState } from "react";
import { getJSON, sendJSON } from "../../api/client";
import { Segmented, Tooltip } from "../../components/primitives";
import {
  REPLY_STYLE_DESC,
  REPLY_STYLE_LABEL,
  REPLY_STYLES,
  type ReplyStyle,
} from "../../components/ReplyStyleChip";
import { useToast } from "../../components/ui";
import { useGrantAuthority } from "./grantAuthority";
import { SettingRow, settingsErrText } from "./settingsUi";

/** The row's description line (pure, tested). */
export function replyStyleDesc(style: ReplyStyle): string {
  return (
    REPLY_STYLE_DESC[style] +
    " Applies to conversations, task threads, plans and verification requests. Code, commands," +
    " errors, file paths and quotes stay exact; GitHub posts stay normal. Ask an agent to" +
    " elaborate for one normal reply, or change one thread with the style chip by its message box."
  );
}

export function ReplyStyleRow({ cid }: { cid: string | null }) {
  const toast = useToast();
  const auth = useGrantAuthority("manage_agents");
  const [style, setStyle] = useState<ReplyStyle | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStyle(null);
    if (!cid) return;
    const ac = new AbortController();
    getJSON<{ reply_style: ReplyStyle }>("/api/containers/" + encodeURIComponent(cid) + "/reply-style", ac.signal)
      .then((d) => setStyle(d.reply_style))
      .catch(() => { /* older backend: nothing honest to show */ });
    return () => ac.abort();
  }, [cid]);

  if (!cid || !style) return null;
  const locked = !auth.can;

  const save = async (next: ReplyStyle) => {
    if (busy || locked || !auth.human || next === style) return;
    const before = style;
    setBusy(true);
    setStyle(next); // optimistic
    try {
      const d = await sendJSON<{ reply_style: ReplyStyle }>(
        "PUT",
        "/api/containers/" + encodeURIComponent(cid) + "/reply-style",
        { reply_style: next, actor_agent_id: auth.human.id },
      );
      setStyle(d.reply_style);
      toast("Agents now reply in " + REPLY_STYLE_LABEL[d.reply_style] + " style.", "ok");
    } catch (e) {
      setStyle(before);
      toast("Couldn't change the reply style — " + settingsErrText(e) + ".", "danger");
    }
    setBusy(false);
  };

  const seg = (
    <Segmented
      size="sm"
      label="Reply style"
      value={style}
      className="set-reply-style"
      items={REPLY_STYLES.map((k) => ({ key: k, label: REPLY_STYLE_LABEL[k], disabled: locked || busy }))}
      onChange={(k) => void save(k as ReplyStyle)}
    />
  );
  const why = locked && auth.reason && !auth.pending ? auth.reason : null;
  return (
    <SettingRow
      label="Reply style"
      id="setReplyStyleL"
      desc={
        <span id="setReplyStyleD">
          {replyStyleDesc(style)}
          {why ? <> · <span data-testid="reply-style-reason">{why}</span></> : null}
        </span>
      }
    >
      {locked && auth.reason ? <Tooltip label={auth.reason} placement="left">{seg}</Tooltip> : seg}
    </SettingRow>
  );
}

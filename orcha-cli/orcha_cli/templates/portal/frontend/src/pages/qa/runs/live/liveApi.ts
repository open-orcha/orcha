/** The live view's writes: a person only (`qa_live_routes.py`); the server enforces it. */
import { sendJSON } from "../../../../api/client";
import type { Json, RecordingCommandKind } from "./recording";
import type { LiveTakeover } from "./recording-live";

const enc = encodeURIComponent;

/** `on: true` holds the agent and gives this person the device. `still`: the page is still there. */
export const setTakeover = (sid: string, actor: string | null, on: boolean, still = false) =>
  sendJSON<{ takeover: LiveTakeover | null }>("POST", `/api/qa/sessions/${enc(sid)}/live/takeover`, { on, still, actor_agent_id: actor });

export const sendInput = (sid: string, actor: string | null, kind: RecordingCommandKind, args: Record<string, Json>) =>
  sendJSON<{ seq: number; kind: RecordingCommandKind; args: Record<string, Json>; status: "pending"; result: null }>(
    "POST",
    `/api/qa/sessions/${enc(sid)}/live/input`,
    { kind, args, actor_agent_id: actor },
  );

/** The line a session nothing runs any more ends with. */
export const markSessionFailed = (sid: string, actor: string | null) =>
  sendJSON("PATCH", `/api/qa/sessions/${enc(sid)}`, { status: "failed", actor_agent_id: actor });

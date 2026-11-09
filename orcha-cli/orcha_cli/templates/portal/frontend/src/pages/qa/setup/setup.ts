/** What a project needs before QA can run: an AI agent, and the QA tools on. */
import { getJSON, sendJSON } from "../../../api/client";

export interface QaSetup { tools_on: boolean; can_enable: boolean; ai_agents: number }

const enc = encodeURIComponent;
const C = (cid: string) => `/api/containers/${enc(cid)}/qa`;

export const getQaSetup = (cid: string, signal?: AbortSignal) => getJSON<QaSetup>(`${C(cid)}/setup`, signal);

export const enableQaTools = (cid: string, actor: string | null) => sendJSON<QaSetup>("POST", `${C(cid)}/setup/tools`, { actor_agent_id: actor });

export const disableQaTools = (cid: string, actor: string | null) => sendJSON<QaSetup>("POST", `${C(cid)}/setup/tools/off`, { actor_agent_id: actor });

export const QA_AGENT_PROMPT = "You are the project's QA agent. You test the app on a device or in a browser with the QA tools, and report what you find with screenshots. You judge the work; you do not fix it. A person verifies every task.";

export const addQaAgent = (cid: string) =>
  sendJSON<{ agent_id: string }>("POST", `/api/containers/${enc(cid)}/agents`, { alias: "QA", role: "QA", kind: "ai", prompt: QA_AGENT_PROMPT });

export const assignTask = (tid: string, agentId: string, actor: string | null) =>
  sendJSON<unknown>("POST", `/api/tasks/${enc(tid)}/assign`, { agent_id: agentId, actor_agent_id: actor });

/** Does anything stop a run from starting? A portal that cannot see the project folder cannot tell about the tools. */
export const setupMissing = (s: QaSetup | null): "agent" | "tools" | null =>
  !s ? null : s.ai_agents === 0 ? "agent" : !s.tools_on && s.can_enable ? "tools" : null;

/** `blocked_reason` of a task nobody can pick up. */
export const NO_AGENT = "no agent";

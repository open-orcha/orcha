/** Where a request's links go. Everything links through: request, session, run page, workflow. */
import { qaHref } from "../parts";
import type { QaRequest } from "./api";

/** Quality reads iOS when the address names no platform. */
const plat = (p: string | null | undefined) => (p && p !== "ios" ? p : null);

export const requestHref = (r: Pick<QaRequest, "id" | "status">) => qaHref({ view: "requests", request: r.id });

export const requestIdHref = (id: string) => qaHref({ view: "requests", request: id });

export const sessionHref = (id: string, platform?: string | null) => qaHref({ view: "sessions", platform: plat(platform), session: id });

/** The run page, with its embedded device while the session runs. */
export const runPageHref = (id: string, platform?: string | null) => qaHref({ view: "sessions", platform: plat(platform), session: id, sub: "run" });

export const workflowHref = (id: string, cid?: string | null) => `/workflows/${encodeURIComponent(id)}${cid ? `?${new URLSearchParams({ cid })}` : ""}`;

/** A workflow step, opened in its workflow. */
export const workflowStepHref = (workflowId: string, taskId: string, cid?: string | null) => `${workflowHref(workflowId, cid)}#workflow-task-${encodeURIComponent(taskId)}`;

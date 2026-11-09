/**
 * A task's own "Send to Quality when finished" (`PUT /api/tasks/{tid}/qa/on-done`): when its agent
 * finishes it, Quality tests it on the platform and device chosen here. A person chooses; it beats
 * the project's trigger either way, and clearing it (`enabled` null) leaves the trigger to decide.
 */
import { cleanConditions, conditionWords, type Conditions } from "../conditions/conditions";
import { sendJSON } from "../../../api/client";
import { PLATFORMS, type Platform } from "../qaApi";
import { platformWord } from "../qaWords";
import { prettyAvd } from "../onboarding/device-picker";

export interface QaOnDone {
  enabled: boolean;
  platform: Platform | null;
  device: string | null;
  kind: "check" | "explore" | null;
  /** What the run must be under. */
  conditions?: Conditions | null;
}

const isPlatform = (v: unknown): v is Platform => PLATFORMS.includes(v as Platform);

/** The stored choice, or null when the task has none. */
export function readOnDone(raw: unknown): QaOnDone | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return null;
  return {
    enabled: r.enabled,
    platform: isPlatform(r.platform) ? r.platform : null,
    device: typeof r.device === "string" && r.device ? r.device : null,
    kind: r.kind === "check" || r.kind === "explore" ? r.kind : null,
    conditions: cleanConditions(r.conditions as Conditions | null),
  };
}

export async function setTaskOnDone(tid: string, actor: string | null, choice: Omit<QaOnDone, "enabled"> & { enabled: boolean | null }) {
  const out = await sendJSON<{ on_done?: unknown }>("PUT", `/api/tasks/${encodeURIComponent(tid)}/qa/on-done`, {
    actor_agent_id: actor, enabled: choice.enabled, platform: choice.platform, device: choice.device, kind: choice.kind,
    conditions: cleanConditions(choice.conditions),
  });
  return readOnDone(out?.on_done);
}

/** "iOS · iPhone 17 Pro", or "iOS · any device" when the agent picks. */
export function onDoneWords(o: Pick<QaOnDone, "platform" | "device"> & { conditions?: Conditions | null }, fallback: Platform | null): string {
  const platform = o.platform ?? fallback;
  const device = o.device ? (platform === "web" ? `${o.device[0].toUpperCase()}${o.device.slice(1)} browser` : prettyAvd(o.device)) : "any device";
  return [platform ? platformWord(platform) : "Default platform", device, ...conditionWords(o.conditions, platform)].join(" · ");
}

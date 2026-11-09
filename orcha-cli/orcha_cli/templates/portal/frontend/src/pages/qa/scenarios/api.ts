/** Scenario calls qaApi.ts does not have yet: every platform's list, a person's edit, a new
 * draft, and the markdown export. Writes carry the acting human, as qaApi's do. */
import type { Conditions } from "../conditions/conditions";
import { getJSON, sendJSON } from "../../../api/client";
import { listOf, normalizeScenario, type Platform, type QaScenario, type ScenarioStatus } from "../qaApi";
import type { CheckFixDismissal } from "./check-fixes";
import { rowResult, type RowResult } from "./example-results";
import type { HealthAudit } from "./health/types";
import type { ReplayTrace } from "./replay-trace";
import type { EffectiveStatus } from "./scenario-status";

const C = (cid: string) => `/api/containers/${encodeURIComponent(cid)}/qa`;

/** Every platform's scenarios, for the platform filter's All and its counts. */
export const listAllScenarios = async (cid: string, signal?: AbortSignal) =>
  listOf<QaScenario>(await getJSON<unknown>(`${C(cid)}/scenarios`, signal), "scenarios").map(normalizeScenario);

export interface ScenarioEdit {
  name?: string;
  category?: string | null;
  persona?: string | null;
  description?: string | null;
  criteria?: string[];
  checks?: { criterion_index: number | null; line: string }[];
  data?: Record<string, unknown>;
  needs?: string[];
  tags?: string[];
  depends_on?: string[];
  fresh?: boolean | null;
  conditions?: Conditions | null;
  permissions?: "ask" | null;
  session?: string | null;
  shared?: boolean;
  platform?: Platform;
  examples?: unknown;
  seed?: string[];
  cleanup?: string[];
  events?: string[];
}

export const patchScenario = async (id: string, actor: string | null, edit: ScenarioEdit) =>
  normalizeScenario(await sendJSON<unknown>("PATCH", `/api/qa/scenarios/${encodeURIComponent(id)}`, { ...edit, actor_agent_id: actor }));

/** A new draft of this platform (a scenario of the same name and not a draft gets a suggestion). */
export const proposeScenario = async (cid: string, actor: string | null, platform: Platform, body: ScenarioEdit & { name: string; criteria: string[] }) =>
  normalizeScenario(await sendJSON<unknown>("POST", `${C(cid)}/scenarios`, { ...body, platform, actor_agent_id: actor }));

const STATUSES: ScenarioStatus[] = ["validated", "draft", "paused", "retired"];

/** Scenario markdown of every status, from `GET C/scenarios/export.md` (one status at a time). */
export async function exportMarkdown(cid: string, platform: Platform | null): Promise<string> {
  const parts = await Promise.all(
    STATUSES.map(async (status) => {
      const p = new URLSearchParams({ status });
      if (platform) p.set("platform", platform);
      const res = await fetch(`${C(cid)}/scenarios/export.md?${p.toString()}`);
      if (!res.ok) throw new Error(`Request failed (${res.status}).`);
      return (await res.text()).trim();
    }),
  );
  return parts.filter(Boolean).join("\n\n");
}

// ---------- beyond the record: history, quarantine, corrections, the recorded path, files ----------

const S = (id: string) => `/api/qa/scenarios/${encodeURIComponent(id)}`;
const actorQuery = (actor: string | null) => (actor ? `actor_agent_id=${encodeURIComponent(actor)}` : "");

export interface ScenarioVersion {
  id: string;
  scenario_id: string;
  version: number;
  saved_at: string;
  saved_by_agent_id: string | null;
  snapshot: Record<string, unknown>;
}

export const listVersions = async (id: string) => (await getJSON<{ versions: ScenarioVersion[] }>(`${S(id)}/versions`)).versions ?? [];

export const restoreVersion = async (id: string, actor: string | null, version: number) =>
  normalizeScenario((await sendJSON<{ scenario: unknown }>("POST", `${S(id)}/restore`, { version, actor_agent_id: actor })).scenario);

export const deleteScenario = (id: string, actor: string | null) => sendJSON<unknown>("DELETE", `${S(id)}?${actorQuery(actor)}`);

export const releaseQuarantine = async (id: string, actor: string | null) =>
  normalizeScenario((await sendJSON<{ scenario: unknown }>("DELETE", `${S(id)}/quarantine?${actorQuery(actor)}`)).scenario);

export interface StatusChange {
  status: EffectiveStatus;
  reason?: string | null;
  until?: string | null;
  issue?: string | null;
  replaced_by?: string | null;
}

/** The changed rows. A person only. */
export const changeStatus = async (cid: string, actor: string | null, ids: readonly string[], body: StatusChange) =>
  listOf<QaScenario>(await sendJSON<unknown>("POST", `${C(cid)}/scenarios/status`, { ids, ...body, actor_agent_id: actor }), "scenarios").map(normalizeScenario);

export const listCheckFixes = async (id: string) => {
  const got = await getJSON<{ rows?: { run_id: string; criteria: unknown }[]; dismissed?: CheckFixDismissal[] }>(`${S(id)}/check-fixes`);
  return { rows: got.rows ?? [], dismissed: got.dismissed ?? [] };
};

export const dismissCheckFix = (id: string, actor: string | null, fix: CheckFixDismissal) =>
  sendJSON<unknown>("POST", `${S(id)}/check-fixes`, { ...fix, actor_agent_id: actor });

export const loadTraces = async (id: string) => (await getJSON<{ traces: ReplayTrace[] }>(`${S(id)}/trace`)).traces ?? [];

export const forgetTrace = (id: string, kind: string, actor: string | null) =>
  sendJSON<unknown>("DELETE", `${S(id)}/trace?target_kind=${encodeURIComponent(kind)}&${actorQuery(actor)}`);

export interface ScenarioFile {
  id: string;
  file_name: string;
  size_bytes: number | null;
}

export const listScenarioFiles = async (id: string) => (await getJSON<{ files: ScenarioFile[] }>(`${S(id)}/files`)).files ?? [];

export async function addScenarioFile(id: string, actor: string | null, file: File): Promise<void> {
  const res = await fetch(`${S(id)}/files?name=${encodeURIComponent(file.name)}&${actorQuery(actor)}`, { method: "POST", body: file });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? `Request failed (${res.status}).`);
}

export const removeScenarioFile = (fileId: string, actor: string | null) =>
  sendJSON<unknown>("DELETE", `/api/qa/scenario-files/${encodeURIComponent(fileId)}?${actorQuery(actor)}`);

/** One sealed cell of this scenario's own table (`ref` is the cell, `secret:sec_...`). */
export const revealExample = async (id: string, actor: string | null, ref: string) =>
  (await sendJSON<{ value: string }>("POST", `${S(id)}/examples/reveal`, { ref: ref.replace(/^secret:/, ""), actor_agent_id: actor })).value;

export const exampleRows = async (id: string): Promise<RowResult[]> =>
  (await getJSON<{ rows: Parameters<typeof rowResult>[0][] }>(`${S(id)}/rows`)).rows?.map(rowResult) ?? [];

// ---------- the audit ----------

export const scenarioAudit = (cid: string) => getJSON<HealthAudit>(`${C(cid)}/scenario-health`);

export const scenarioFlags = async (cid: string, ids: readonly string[]) =>
  (await getJSON<{ flags: unknown[] }>(`${C(cid)}/scenario-health/flags?ids=${encodeURIComponent(ids.join(","))}`)).flags;

export const scenarioHealthAction = (cid: string, actor: string | null, body: { action: string; ids: string[]; kind?: string; name?: string; into?: string }) =>
  sendJSON<unknown>("POST", `${C(cid)}/scenario-health/actions`, { ...body, actor_agent_id: actor });

// ---------- coverage growth ----------

export const coverageGrowth = (cid: string) => getJSON<unknown>(`${C(cid)}/coverage/growth`);

export const takeBaseline = (cid: string, actor: string | null, body: { action: "baseline" | "rebaseline"; reason?: string }) =>
  sendJSON<unknown>("POST", `${C(cid)}/coverage/growth`, { ...body, actor_agent_id: actor });

export const growthVariations = (cid: string, actor: string | null, body: Record<string, unknown>) =>
  sendJSON<Record<string, unknown>>("POST", `${C(cid)}/coverage/growth/variations`, { ...body, actor_agent_id: actor });

export interface CoverageLink {
  scenario_id: string;
  feature_key: string;
  state: "linked" | "confirmed" | "rejected";
}

export const coverageLinks = async (cid: string, signal?: AbortSignal) => (await getJSON<{ links: CoverageLink[] }>(`${C(cid)}/coverage/links`, signal)).links ?? [];

export const setCoverageLink = (cid: string, actor: string | null, body: { action: "link" | "unlink" | "confirm" | "reject"; scenario_id: string; feature_key: string }) =>
  sendJSON<unknown>("POST", `${C(cid)}/coverage/links`, { ...body, actor_agent_id: actor });

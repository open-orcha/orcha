/**
 * "Run check" → a normal Orcha task (POST /api/containers/{cid}/tasks, TaskCreateBody) whose
 * description is the instruction its agent follows: one of the orcha-qa-* skills
 * (templates/skills/orcha-qa-{map,explore,draft,check}.md) with the platform and options.
 * The person's click approves its plan; a person still verifies the result.
 */
import { cleanConditions, conditionWords, conditionsJson, type Conditions } from "./conditions/conditions";
import { sendJSON } from "../../api/client";
import type { Platform } from "./qaApi";
import type { DraftChoice } from "./sessions/drafting/lib/draft-sources";

export type QaRunKind = "map" | "explore" | "draft" | "check";

export const QA_RUN_KINDS: { key: QaRunKind; label: string; hint: string }[] = [
  { key: "map", label: "Map the app", hint: "Reads the code for features and screens, then walks the app and marks each screen seen or blocked." },
  { key: "explore", label: "Explore", hint: "Briefs a charter, walks the app's flows and reports findings with screenshots." },
  { key: "draft", label: "Draft scenarios", hint: "Writes test scenarios from the code, the map and walked flows, for you to approve." },
  { key: "check", label: "Check scenarios", hint: "Runs the approved scenarios and gives each criterion a verdict with a screenshot." },
];

/** Kinds that run against a time budget. */
export const TIMED_KINDS: QaRunKind[] = ["map", "explore"];
export const DEFAULT_MINUTES = 20;

const SKILL: Record<QaRunKind, string> = { map: "orcha-qa-map", explore: "orcha-qa-explore", draft: "orcha-qa-draft", check: "orcha-qa-check" };

/** "iOS app", "Android app", "web app". */
function appWord(p: Platform): string {
  return p === "ios" ? "iOS app" : p === "android" ? "Android app" : "web app";
}

const DOD: Record<QaRunKind, string> = {
  map: "The app is mapped; its features and screens (seen, not reached yet, or blocked with why) are in Quality.",
  explore: "The app is explored; findings, walked flows and draft scenarios are in Quality for review.",
  draft: "Draft scenarios that meet the test-design bar are in Quality for a person to approve.",
  check: "Every approved scenario has a verdict per criterion with screenshots; failures are reported as findings.",
};

export interface QaRunInput {
  kind: QaRunKind;
  platform: Platform;
  /** Map / Explore only */
  minutes?: number | null;
  focus?: string | null;
  /** Draft only: what to read (the source picker). A new exploration takes `minutes`. */
  sources?: DraftChoice | null;
  /** Check only: run exactly these scenarios. */
  scenarioIds?: readonly string[] | null;
  /** A map session's pass: `overview` one look at each main area, `deeper` a platform's unseen screens. */
  pass?: "overview" | "deeper" | null;
  /** The device a session runs on (a simulator's or emulator's name, a web viewport). */
  device?: string | null;
  /** What the run must be under (`conditions/conditions.ts`). */
  conditions?: Conditions | null;
  /** The task's title, when the view knows a better one. */
  passTitle?: string | null;
  /** the agent's alias (assignee_alias) */
  agentAlias: string | null;
  /** the acting human (created_by_agent_id) */
  humanId: string | null;
}

/** The skill's flags and the plain line that states what a drafting reads. */
const DRAFT_SOURCE: Record<DraftChoice, { flags: string; line: string }> = {
  code: { flags: "--sources code", line: "Read the code only: routes, screens, forms and auth flows." },
  past: { flags: "--sources both", line: "Read the code and the project's newest three completed explorations (read_screens lists their screens)." },
  new: { flags: "--sources code --explore", line: "Read the code and explore the app first in this same task, then draft from what you saw." },
};

export interface QaTaskBody {
  title: string;
  description: string;
  definition_of_done: string;
  created_by_agent_id: string | null;
  assignee_alias: string | null;
}

const quoted = (s: string) => `"${s.replace(/\s+/g, " ").replace(/"/g, "'").trim()}"`;

/** The task a "Run check" creates (pure; tested). */
export function qaTaskBody(i: QaRunInput): QaTaskBody {
  const focus = (i.focus ?? "").trim();
  const sources = i.kind === "draft" ? (i.sources ?? null) : null;
  const timed = TIMED_KINDS.includes(i.kind) || sources === "new";
  const minutes = timed ? Math.max(1, Math.round(i.minutes || DEFAULT_MINUTES)) : null;
  const app = appWord(i.platform);
  const base = {
    map: `Map the ${app}`,
    explore: `Explore the ${app}`,
    draft: `Draft QA scenarios for the ${app}`,
    check: `Check the ${app} against its approved scenarios`,
  }[i.kind];
  const title = i.passTitle || (focus ? `${base}: ${focus.length > 60 ? focus.slice(0, 59).trimEnd() + "…" : focus}` : base);

  // the skill's own flags: map takes --feature, explore / draft take --focus; check has neither
  let cmd = `Run /${SKILL[i.kind]} for this task on ${i.platform}`;
  if (sources) cmd += ` ${DRAFT_SOURCE[sources].flags}`;
  if (minutes != null) cmd += ` --minutes ${minutes}`;
  if (focus && i.kind === "map") cmd += ` --feature ${quoted(focus)}`;
  if (focus && (i.kind === "explore" || i.kind === "draft")) cmd += ` --focus ${quoted(focus)}`;
  if (i.pass && i.kind === "map") cmd += ` --pass ${i.pass}`;
  if (i.device) cmd += ` --device ${quoted(i.device)}`;
  const lines = [cmd];
  if (sources) lines.push("", DRAFT_SOURCE[sources].line);
  if (focus && i.kind === "check") lines.push("", `Focus on: ${focus}`);
  const asked = cleanConditions(i.conditions);
  if (asked) lines.push("", `Run it under these conditions: ${conditionWords(asked, i.platform).join("; ")}.`, `Conditions: pass conditions=${conditionsJson(asked)} to start_session.`);
  const picked = i.kind === "check" ? [...(i.scenarioIds ?? [])] : [];
  if (picked.length) lines.push("", `Run exactly these scenarios, drafts and paused ones too: a person picked them. ${picked.map((id) => `--scenario ${id}`).join(" ")}`);
  lines.push("", "Results land in the project's Quality tab; a person reviews them there.");

  return {
    title,
    description: lines.join("\n"),
    definition_of_done: DOD[i.kind],
    created_by_agent_id: i.humanId,
    assignee_alias: i.agentAlias,
  };
}

/** The task "Revise with Orcha" creates: a person's feedback on one draft, for its agent. */
export function qaReviseTaskBody(i: { scenarioId: string; name: string; feedback: string; platform: Platform; agentAlias: string | null; humanId: string | null }): QaTaskBody {
  const name = i.name.length > 60 ? i.name.slice(0, 59).trimEnd() + "…" : i.name;
  return {
    title: `Revise the draft: ${name}`,
    description: [
      `Run /${SKILL.draft} for this task on ${i.platform}: revise the one draft below, nothing else.`,
      "",
      `Scenario: ${i.scenarioId} (${i.name})`,
      `A person's feedback: ${quoted(i.feedback)}`,
      "",
      "Make that change with revise_scenario, passing the feedback as its reason. A person reviews it in Quality.",
    ].join("\n"),
    definition_of_done: "The draft says what the feedback asked for and is back for a person to review.",
    created_by_agent_id: i.humanId,
    assignee_alias: i.agentAlias,
  };
}

export const createQaTask = (cid: string, body: QaTaskBody) =>
  sendJSON<{ task_id: string }>("POST", `/api/containers/${encodeURIComponent(cid)}/tasks`, body);

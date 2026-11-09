/**
 * Quality workflows as blocks: ready-made steps with their routing wired, from the server's one
 * catalogue (`GET C/workflow-blocks`). Inserting one is a pure draft edit (tested), the same wiring as
 * the server's `qa_blocks.splice` for a draft still being typed: its steps go in after the chosen
 * step, wired to that step and to what followed it, and stay normal steps a person can change.
 * Removing a block takes its steps out together and joins up what they sat between.
 *
 * A block's draft may name two steps that are not its own: `build`, the step before it and where work
 * goes back to, and `next`, what follows it. When nothing follows and a pass needs somewhere to go,
 * the block brings its `closing` step.
 */
import type { QaWorkflowBlock } from "../qa/requests/api";
import { newDraftTask, type DraftOutcome, type DraftRepeatGroup, type DraftTask, type WorkflowDraft } from "./workflowDraft";
import { buildOf, chain, inOtherLoop, qualityWord, readWireSteps } from "./workflowQa";

const BUILD = "build";
const NEXT = "next";
const BUILD_DONE = "The change is built and ready to test.";

interface WireStep { client_key?: string; title?: string; depends_on?: string[]; qa?: { kind?: string } | null; routes?: { destination_task?: string | null }[] }
interface WireGroup { max_rounds?: number; member_tasks?: string[] }

const wireSteps = (b: QaWorkflowBlock) => ((b.draft as { tasks?: WireStep[] }).tasks ?? []);
const wireGroups = (b: QaWorkflowBlock) => ((b.draft as { repeat_groups?: WireGroup[] }).repeat_groups ?? []);

/** Work goes back to a step before the block. */
const sendsBack = (b: QaWorkflowBlock) => wireGroups(b).some((g) => g.member_tasks?.includes(BUILD)) || wireSteps(b).some((t) => t.routes?.some((r) => r.destination_task === BUILD));

/** What the picker's small preview shows. */
export function blockPreview(b: QaWorkflowBlock): { steps: { key: string; title: string; tone: "" | "quality" | "triage" }[]; rounds: number | null; loopsBack: boolean } {
  const steps = wireSteps(b).map((t, i) => ({ key: t.client_key ?? String(i), title: qualityWord(t.title ?? ""), tone: (t.qa?.kind === "triage" ? "triage" : t.qa ? "quality" : "") as "" | "quality" | "triage" }));
  return { steps, rounds: wireGroups(b)[0]?.max_rounds ?? null, loopsBack: sendsBack(b) };
}

export interface InsertInput {
  /** The step it goes after. Null only on an empty draft. */
  after: string | null;
  assignees?: { quality?: string; build?: string };
}

/** Outcomes that lead to `from` lead to `to` instead; with nowhere to go, the next steps proceed. */
const retarget = (outcomes: DraftOutcome[] | undefined, from: readonly string[], to: string | null) =>
  outcomes?.map((o) => (o.destinationTask && from.includes(o.destinationTask)
    ? (to ? { ...o, destination: "step" as const, destinationTask: to } : { name: o.name, kind: o.kind, destination: "next" as const })
    : o));

function uniqueLoopName(groups: readonly DraftRepeatGroup[], name: string): string {
  const taken = new Set(groups.map((g) => g.name.trim().toLowerCase()));
  let title = name;
  for (let n = 2; taken.has(title.toLowerCase()); n++) title = `${name} ${n}`;
  return title;
}

export function insertBlock(draft: WorkflowDraft, block: QaWorkflowBlock, { after, assignees = {} }: InsertInput): { draft: WorkflowDraft; keys: string[] } {
  const id = crypto.randomUUID();
  const name = qualityWord(block.name);
  const anchor = draft.tasks.find((t) => t.key === after) ?? null;
  const followers = anchor ? draft.tasks.filter((t) => t.dependsOn.includes(anchor.key)) : [];

  // Where work goes back to: the chosen step, or the nearest real step above a Quality one. With no
  // step at all, a Build step comes with the block: a whole workflow is a Build step plus a block.
  let buildKey = anchor ? (anchor.qa ? buildOf(draft, anchor) : anchor.key) : null;
  const added: DraftTask[] = [];
  if (sendsBack(block) && !buildKey) {
    const task: DraftTask = { ...newDraftTask(), title: "Build", doneWhen: BUILD_DONE, assignee: assignees.build ?? "" };
    added.push(task);
    buildKey = task.key;
  }
  const before = anchor?.key ?? buildKey;

  const closing = !followers.length && block.closing ? block.closing as WireStep : null;
  const own = [...wireSteps(block), ...(closing ? [closing] : [])];
  const keys = new Map<string, string>(own.map((t) => [String(t.client_key), crypto.randomUUID()]));
  const nextKey = followers[0]?.key ?? keys.get(NEXT) ?? "";
  const toDraft = (k: string) => keys.get(k) ?? (k === BUILD ? buildKey ?? "" : k === NEXT ? nextKey : k);
  const read = readWireSteps({ ...block.draft, tasks: own }, toDraft, { quality: assignees.quality, build: anchor?.assignee || assignees.build });

  // A loop back needs a real step in no other loop. Without one, a person decides instead.
  const looped = !sendsBack(block) || (!!buildKey && !inOtherLoop(draft, buildKey));
  const ownKeys = new Set<string>(keys.values());
  const tails = (block.tails ?? []).map((k) => keys.get(k)).filter((k): k is string => !!k);
  const steps = read.tasks.map((t): DraftTask => {
    const inside = t.dependsOn.filter((k) => ownKeys.has(k));
    const isClosing = closing && t.key === keys.get(String(closing.client_key));
    return {
      ...t,
      block: { id, key: block.key, name },
      // The block's own order holds inside it; the steps that start it wait for the chosen step.
      dependsOn: isClosing ? tails : inside.length ? inside : before ? [before] : [],
      outcomes: t.outcomes?.map((o): DraftOutcome => {
        if (o.destination === "return" && !looped) return { name: o.name, kind: o.kind, destination: "ask_owner" };
        if (o.destination === "exit_group" && !looped) return { name: o.name, kind: o.kind, destination: "next" };
        if (o.destination === "step" && !o.destinationTask) return { name: o.name, kind: o.kind, destination: "stop" };
        return o;
      }),
    };
  });
  const members = (g: DraftRepeatGroup) => (g.members.includes(buildKey ?? "")
    ? [...new Set([...chain([...draft.tasks, ...added], buildKey!, before ?? buildKey!), ...g.members.filter((k) => ownKeys.has(k))])]
    : g.members);
  const groups: DraftRepeatGroup[] = looped ? read.groups.map((g) => ({ ...g, name: uniqueLoopName(draft.repeatGroups ?? [], name), members: members(g) })) : [];

  const entry = steps[0]?.key ?? null;
  const rest = draft.tasks.map((t) => {
    if (t.key === anchor?.key) return { ...t, outcomes: retarget(t.outcomes, followers.map((f) => f.key), entry) };
    if (followers.includes(t)) return { ...t, dependsOn: [...new Set([...t.dependsOn.filter((k) => k !== anchor!.key), ...tails])] };
    return t;
  });
  const at = anchor ? rest.findIndex((t) => t.key === anchor.key) + 1 : 0;
  return {
    keys: steps.map((t) => t.key),
    draft: {
      ...draft,
      ...(draft.tasks.length ? {} : { name: draft.name || qualityWord(String(block.draft.title ?? "")), goal: draft.goal || qualityWord(String(block.draft.goal ?? "")) }),
      tasks: [...rest.slice(0, at), ...added, ...steps, ...rest.slice(at)],
      ...(groups.length || draft.repeatGroups ? { repeatGroups: [...(draft.repeatGroups ?? []), ...groups] } : {}),
    },
  };
}

/** Take a block's steps out together; what waited for them waits for what they waited for. */
export function removeBlock(draft: WorkflowDraft, id: string): WorkflowDraft {
  const gone = draft.tasks.filter((t) => t.block?.id === id);
  const keys = gone.map((t) => t.key);
  const before = [...new Set(gone.flatMap((t) => t.dependsOn.filter((k) => !keys.includes(k))))];
  const followers = draft.tasks.filter((t) => !keys.includes(t.key) && t.dependsOn.some((k) => keys.includes(k)));
  const first = followers[0]?.key ?? null;
  return {
    ...draft,
    tasks: draft.tasks.filter((t) => !keys.includes(t.key)).map((t) => ({
      ...t,
      ...(followers.includes(t) ? { dependsOn: [...new Set([...t.dependsOn.filter((k) => !keys.includes(k)), ...before])] } : {}),
      outcomes: retarget(t.outcomes, keys, first),
    })),
    repeatGroups: (draft.repeatGroups ?? []).filter((g) => !keys.includes(g.review)).map((g) => ({ ...g, members: g.members.filter((k) => !keys.includes(k)) })),
  };
}

/** Each block in the draft, once, with how many of its steps are left. */
export function blocksIn(draft: WorkflowDraft): { id: string; name: string; steps: number }[] {
  const out = new Map<string, { id: string; name: string; steps: number }>();
  for (const t of draft.tasks) if (t.block) out.set(t.block.id, { id: t.block.id, name: t.block.name, steps: (out.get(t.block.id)?.steps ?? 0) + 1 });
  return [...out.values()];
}

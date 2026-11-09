import { Link } from "../../map/kit";
import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ListPlus } from "../../map/kit/icons";
import { Button, buttonVariants, type ButtonVariant } from "../../map/kit";
import { useToast } from "../../map/kit";
import { errText, qaHref } from "../../parts";
import type { Platform } from "../../qaApi";
import { draftScenarioFromFinding, proposeNextStep } from "../api";
import { draftFromFinding, findingSourceKey, type FindingInput } from "./finding-scenario";
import { cn } from "../../map/kit";

/**
 * "Create scenario" on a finding: one click drafts one real scenario from the finding, shows
 * "Drafted" with an Open link in a toast, and the button becomes "Open scenario". A stored finding
 * keeps its draft, so a reload still shows Open and a second click never makes a second draft.
 */

export interface DraftedRef {
  id: string;
  name: string;
  href: string;
}

export interface FindingScenarios {
  drafted: Record<string, DraftedRef>;
  create: (input: FindingInput) => Promise<DraftedRef | null>;
}

export type DraftOutcome = { ok: true; ref: DraftedRef; created: boolean } | { ok: false; error: string };

export function scenarioHref(platform: string | null, id: string): string {
  return qaHref({ view: "scenarios", platform: platform === "ios" ? null : platform, scenario: id });
}

/** Draft the scenario of `input`. Never throws: a failed request comes back as `{ ok: false, error }`. */
export async function draftFindingScenario(cid: string, actor: string | null, input: FindingInput): Promise<DraftOutcome> {
  try {
    const d = draftFromFinding(input);
    const body = { name: d.name, description: d.description, criteria: d.criteria, category: d.category };
    const platform = input.platform ?? d.target_kind;
    const fid = input.source.finding_id;
    if (fid) {
      const got = await draftScenarioFromFinding(fid, actor, body);
      return { ok: true, ref: { id: got.scenario.id, name: got.scenario.name, href: scenarioHref(platform, got.scenario.id) }, created: got.created };
    }
    if (!platform) return { ok: false, error: "This finding is on no platform, so there is nowhere to draft it." };
    const got = await proposeNextStep(cid, { ...body, platform: platform as Platform, actor_agent_id: actor });
    return { ok: true, ref: { id: got.id, name: got.name, href: scenarioHref(platform, got.id) }, created: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** `start()` once per `key` at a time: a call while one is on its way gets that one's promise. */
export function joinInFlight<T>(pending: Map<string, Promise<T>>, key: string | null, start: () => Promise<T>): Promise<T> {
  if (!key) return start();
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const job = start();
  pending.set(key, job);
  const clear = () => {
    if (pending.get(key) === job) pending.delete(key);
  };
  job.then(clear, clear);
  return job;
}

/** The button's face: idle ("Create scenario"), loading (the spinner) or drafted ("Open scenario"). */
export function scenarioButtonState(key: string | null, drafted: Record<string, DraftedRef> | undefined, busy: boolean): "idle" | "loading" | "drafted" {
  if (key && drafted?.[key]) return "drafted";
  return busy ? "loading" : "idle";
}

export function keyOf(input: FindingInput): string | null {
  try {
    return findingSourceKey(input.source);
  } catch {
    return null;
  }
}

/** The findings' drafted scenarios (`known`, by source key), and `create` for one more. */
export function useFindingScenarios(cid: string, actor: string | null, known: Readonly<Record<string, DraftedRef>>, onDrafted?: () => void): FindingScenarios {
  const { toast } = useToast();
  const [made, setMade] = useState<Record<string, DraftedRef>>({});
  const drafted = useMemo(() => ({ ...known, ...made }), [known, made]);

  // One request per finding at a time: a double click, or the same finding's button on the card
  // and in the sheet, waits for the draft already on its way instead of asking again.
  const pending = useRef(new Map<string, Promise<DraftedRef | null>>());
  const create = useCallback(
    (input: FindingInput): Promise<DraftedRef | null> => {
      const key = keyOf(input);
      return joinInFlight(pending.current, key, () => draftFindingScenario(cid, actor, input).then((out) => {
        if (!out.ok) {
          toast({ title: "Could not draft the scenario", description: out.error, variant: "error" });
          return null;
        }
        const ref = out.ref;
        if (key) setMade((d) => ({ ...d, [key]: ref }));
        toast({
          title: out.created ? "Scenario drafted" : "Already drafted",
          description: out.created ? `“${ref.name}” is a draft in Scenarios, ready to review.` : `This finding already has “${ref.name}”.`,
          variant: "success",
          actions: [{ label: "Open", href: ref.href }],
        });
        onDrafted?.();
        return ref;
      }));
    },
    [cid, actor, toast, onDrafted],
  );
  return { drafted, create };
}

/** The button: "Create scenario" → spinner → "Open scenario" (a link to the draft). */
export function FindingScenarioButton({
  input,
  scenarios,
  variant = "default",
  className,
}: {
  input: FindingInput;
  scenarios: FindingScenarios | undefined;
  variant?: ButtonVariant;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const key = keyOf(input);
  const state = scenarioButtonState(key, scenarios?.drafted, busy);
  const done = key && state === "drafted" ? scenarios?.drafted[key] : undefined;
  if (done) {
    const open = (
      <Link
        href={done.href}
        className={cn(buttonVariants({ size: "sm", variant }), className)}
        title={done.name}
        data-open-scenario
        data-scenario-state="drafted"
      >
        <ArrowUpRight /> Open scenario
      </Link>
    );
    return open;
  }
  return (
    <Button
      size="sm"
      variant={variant}
      className={className}
      loading={state === "loading"}
      disabled={!scenarios}
      onClick={async () => {
        // A second click before the spinner shows joins the same request (`create` keeps one
        // per finding), so it never makes a second draft.
        if (!scenarios || busy) return;
        setBusy(true);
        try {
          await scenarios.create(input);
        } finally {
          setBusy(false);
        }
      }}
      data-create-scenario
      data-scenario-state={state}
    >
      <ListPlus /> Create scenario
    </Button>
  );
}
